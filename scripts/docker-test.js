#!/usr/bin/env node

/**
 * Docker Setup Test Script
 * 
 * This script tests that the MCP service in Docker is running correctly
 * by making requests to all API endpoints and validating responses.
 * 
 * Note: This is an ES module (uses import instead of require).
 */

import fetch from 'node-fetch';
import { setTimeout } from 'timers/promises';

// Configuration
const HOST = process.env.MCP_HOST || 'http://localhost';
const PORT = process.env.MCP_PORT || '3000';
const BASE_URL = `${HOST}:${PORT}`;
const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 5;

// Main test function
async function runTests() {
  console.log(`🔍 Testing MCP Docker setup at ${BASE_URL}`);
  
  // Wait for service to be ready
  await waitForService(MAX_RETRIES);
  
  // Run tests for all endpoints
  await testHealthEndpoint();
  await testSSEEndpoint();
  await testResourceEndpoint();
  await testToolEndpoint();
  await testPromptEndpoint();
  await testLoggingEndpoint();
  
  console.log('\n✅ All tests completed successfully. Docker setup is working correctly!');
}

async function waitForService(retries) {
  console.log('\n🔄 Waiting for service to be ready...');
  
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        console.log('✅ Service is ready');
        return;
      }
    } catch (error) {
      console.log(`⏳ Attempt ${i + 1}/${retries}: Service not ready yet. Retrying in ${RETRY_DELAY_MS}ms...`);
    }
    await setTimeout(RETRY_DELAY_MS);
  }
  throw new Error('Service not available after maximum retries');
}

async function testHealthEndpoint() {
  console.log('\n🔄 Testing health endpoint...');
  
  try {
    const response = await fetch(`${BASE_URL}/health`);
    const data = await response.json();
    
    if (response.ok && data.status === 'ok') {
      console.log('✅ Health endpoint is working');
    } else {
      throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
    }
  } catch (error) {
    console.error('❌ Health endpoint test failed:', error.message);
    process.exit(1);
  }
}

async function testSSEEndpoint() {
  console.log('\n🔄 Testing SSE endpoint...');
  
  try {
    // We don't actually open an SSE connection, just check if it's accessible
    const response = await fetch(`${BASE_URL}/mcp/sse`, { method: 'HEAD' });
    
    if (response.ok) {
      console.log('✅ SSE endpoint is accessible');
    } else {
      throw new Error(`Unexpected status: ${response.status}`);
    }
  } catch (error) {
    console.error('❌ SSE endpoint test failed:', error.message);
    process.exit(1);
  }
}

async function testResourceEndpoint() {
  console.log('\n🔄 Testing resource endpoint...');
  
  try {
    // Create a test file first
    const testContent = 'Test content for Docker setup verification';
    const writeResponse = await fetch(`${BASE_URL}/mcp/tool/write_file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parameters: {
          filePath: 'docker-test.txt',
          content: testContent
        }
      })
    });
    
    if (!writeResponse.ok) {
      throw new Error(`Failed to create test file: ${await writeResponse.text()}`);
    }
    
    // Now try to access it as a resource
    const response = await fetch(`${BASE_URL}/mcp/resource/file?path=docker-test.txt`);
    
    if (response.ok) {
      const data = await response.json();
      if (data.contents && data.contents[0] && data.contents[0].text === testContent) {
        console.log('✅ Resource endpoint is working');
      } else {
        throw new Error(`Unexpected resource content: ${JSON.stringify(data)}`);
      }
    } else {
      throw new Error(`Unexpected status: ${response.status}`);
    }
  } catch (error) {
    console.error('❌ Resource endpoint test failed:', error.message);
    process.exit(1);
  }
}

async function testToolEndpoint() {
  console.log('\n🔄 Testing tool endpoint...');
  
  try {
    // Test the list_directory tool
    const response = await fetch(`${BASE_URL}/mcp/tool/list_directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parameters: {
          dirPath: '/'
        }
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.content && data.content[0] && data.content[0].type === 'text') {
        console.log('✅ Tool endpoint is working');
      } else {
        throw new Error(`Unexpected tool response: ${JSON.stringify(data)}`);
      }
    } else {
      throw new Error(`Unexpected status: ${response.status}`);
    }
  } catch (error) {
    console.error('❌ Tool endpoint test failed:', error.message);
    process.exit(1);
  }
}

async function testPromptEndpoint() {
  console.log('\n🔄 Testing prompt endpoint...');
  
  try {
    // This may return a 404 if no prompts are registered, which is okay
    const response = await fetch(`${BASE_URL}/mcp/prompt/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parameters: {
          input: 'test'
        }
      })
    });
    
    // We consider either 200 or 404 acceptable (404 if no prompt named "test" exists)
    if (response.ok || response.status === 404) {
      console.log('✅ Prompt endpoint is accessible');
    } else {
      throw new Error(`Unexpected status: ${response.status}`);
    }
  } catch (error) {
    console.error('❌ Prompt endpoint test failed:', error.message);
    process.exit(1);
  }
}

async function testLoggingEndpoint() {
  console.log('\n🔄 Testing logging endpoint...');
  
  try {
    const response = await fetch(`${BASE_URL}/mcp/logging/setLevel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        params: {
          level: 'info'
        }
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.result === true) {
        console.log('✅ Logging endpoint is working');
      } else {
        throw new Error(`Unexpected logging response: ${JSON.stringify(data)}`);
      }
    } else {
      throw new Error(`Unexpected status: ${response.status}`);
    }
  } catch (error) {
    console.error('❌ Logging endpoint test failed:', error.message);
    process.exit(1);
  }
}

// Run tests and handle errors
runTests().catch(error => {
  console.error('❌ Tests failed:', error.message);
  process.exit(1);
}); 