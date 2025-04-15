#!/bin/bash

# Docker Setup Test Script
# 
# This script ensures dependencies are installed and then runs the Node.js
# test script to verify that all MCP endpoints are working in Docker.

set -e  # Exit on error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🔧 Setting up Docker test environment..."

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js to run this test."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm to run this test."
    exit 1
fi

# Install required Node.js packages
echo "📦 Installing required packages..."
cd "$PROJECT_ROOT"

# Check if node-fetch is installed and install it if not
if ! npm list node-fetch &> /dev/null; then
    npm install --no-save node-fetch@3 # Using version 3 for ESM support
fi

# Check if Docker is running
echo "🔍 Checking if Docker is running..."
if ! docker info &> /dev/null; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

# Check if container is running
echo "🔍 Checking if Docker container is running..."

# Get the container name/ID if provided as an argument, otherwise use default
CONTAINER_NAME=${1:-"mero-mcp"}

if ! docker ps | grep -q "$CONTAINER_NAME"; then
    echo "❌ Docker container '$CONTAINER_NAME' is not running."
    echo "   Please start the container with: docker-compose up -d"
    exit 1
fi

# Run the test script
echo "🚀 Running Docker tests..."
node "$SCRIPT_DIR/docker-test.js"

exit_code=$?

if [ $exit_code -eq 0 ]; then
    echo "🎉 Docker setup verification completed successfully!"
    
    # Clean up test file
    echo "🧹 Cleaning up test files..."
    curl -s -X POST http://localhost:3000/mcp/tool/delete_file \
        -H "Content-Type: application/json" \
        -d '{"parameters":{"filePath":"docker-test.txt"}}' > /dev/null
else
    echo "❌ Docker setup verification failed."
fi

exit $exit_code 