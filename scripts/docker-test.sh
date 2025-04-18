#!/bin/bash

# Docker MCP Compatibility Test Script
# 
# This script verifies that the MCP server running in Docker is compatible
# with the Model Context Protocol by using the MCP Inspector CLI tool.

set -e  # Exit on error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🔧 Setting up MCP compatibility test environment..."

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

# Check using docker command directly
if ! docker ps | grep -q "$CONTAINER_NAME"; then
    echo "❌ Docker container '$CONTAINER_NAME' is not running."
    echo "   Please start the container with: docker compose up -d"
    exit 1
fi

# Run the test script
echo "🚀 Running MCP compatibility tests..."
cd "$PROJECT_ROOT"
node "$SCRIPT_DIR/docker-test.js"

exit_code=$?

if [ $exit_code -eq 0 ]; then
    echo "🎉 MCP compatibility verification completed successfully!"
else
    echo "❌ MCP compatibility verification failed."
    echo "   Please check that your server implements the Model Context Protocol correctly."
fi

exit $exit_code 