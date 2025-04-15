#!/bin/bash

# SSE Functionality Test Script for Docker Environment
# 
# This script tests the SSE functionality within the Docker container

set -e  # Exit on error

echo "🔧 Setting up Docker SSE test environment..."

# Check if Docker is running
echo "🔍 Checking if Docker is running..."
if ! docker info &> /dev/null; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

# Check if container is running
echo "🔍 Checking if Docker container is running..."
if ! docker ps | grep -q "mero-mcp"; then
    echo "❌ Docker container mero-mcp is not running."
    echo "   Please start the container with: docker-compose up -d"
    exit 1
fi

# Install required dependencies in container
echo "📦 Installing required packages in container..."
docker exec -i mero-mcp npm install --no-save node-fetch@2 eventsource

# Create test script
echo "🔧 Creating test script..."
cat > test-sse-docker.js << 'EOF'
#!/usr/bin/env node

const { EventSource } = require('eventsource');
const fetch = require('node-fetch');

// Configuration
const BASE_URL = 'http://localhost:3000';

async function runTest() {
  console.log(`🔍 Testing SSE functionality at ${BASE_URL}`);
  
  return new Promise((resolve, reject) => {
    // Set a timeout
    const timeoutId = setTimeout(() => {
      reject(new Error('Test timed out after 10 seconds'));
    }, 10000);
    
    try {
      // Connect to SSE
      console.log('Connecting to SSE endpoint...');
      const es = new EventSource(`${BASE_URL}/mcp/sse`);
      
      es.onopen = () => {
        console.log('✅ SSE connection established');
      };
      
      es.onerror = (err) => {
        clearTimeout(timeoutId);
        es.close();
        reject(new Error(`SSE connection error: ${err.message || 'Unknown error'}`));
      };
      
      // Listen for connected event
      es.addEventListener('connected', async (event) => {
        console.log(`✅ Received connected event: ${event.data}`);
        
        try {
          // Send broadcast request
          console.log('Sending broadcast request...');
          const res = await fetch(`${BASE_URL}/mcp/broadcast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              eventName: 'test-event',
              data: { message: 'Test from Docker', timestamp: new Date().toISOString() }
            })
          });
          
          const data = await res.json();
          console.log(`✅ Broadcast sent to ${data.connectionsCount} connection(s)`);
        } catch (error) {
          clearTimeout(timeoutId);
          es.close();
          reject(error);
        }
      });
      
      // Listen for the test event
      es.addEventListener('test-event', (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log(`✅ Received test event: ${JSON.stringify(data)}`);
          
          // Clean up and resolve
          clearTimeout(timeoutId);
          es.close();
          resolve();
        } catch (error) {
          clearTimeout(timeoutId);
          es.close();
          reject(error);
        }
      });
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

// Run the test
runTest()
  .then(() => {
    console.log('✅ SSE test completed successfully!');
    process.exit(0);
  })
  .catch(error => {
    console.error(`❌ SSE test failed: ${error.message}`);
    process.exit(1);
  });
EOF

# Copy and run test script in container
echo "🚀 Running SSE test in container..."
docker cp test-sse-docker.js mero-mcp:/app/
docker exec -i mero-mcp node /app/test-sse-docker.js

# Clean up
echo "🧹 Cleaning up..."
rm -f test-sse-docker.js 