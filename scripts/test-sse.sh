#!/bin/bash

# SSE Functionality Test Script
# 
# This script ensures dependencies are installed and then runs the Node.js
# test script to verify that the SSE functionality works correctly.

set -e  # Exit on error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🔧 Setting up SSE test environment..."

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

# Check if dependencies are installed
if ! npm list node-fetch &> /dev/null; then
    npm install --no-save node-fetch@3 # Using version 3 for ESM support
fi

if ! npm list eventsource &> /dev/null; then
    npm install --no-save eventsource
fi

# Check if server is running
echo "🔍 Checking if MCP server is running..."

# Try to connect to the health endpoint to see if the server is running
if ! curl -s http://localhost:3000/health > /dev/null; then
    echo "❌ MCP server is not running at http://localhost:3000."
    echo "   Please start the server before running this test."
    exit 1
fi

# Run the test script
echo "🚀 Running SSE tests..."
node "$SCRIPT_DIR/test-sse.js"

exit_code=$?

if [ $exit_code -eq 0 ]; then
    echo "🎉 SSE functionality verification completed successfully!"
else
    echo "❌ SSE functionality verification failed."
    echo "   This could be because the SSE broadcasting feature is not implemented,"
    echo "   or because the server doesn't expose the necessary endpoints."
fi

exit $exit_code 