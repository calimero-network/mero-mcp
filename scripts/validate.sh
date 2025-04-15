#!/bin/bash

# Exit on error
set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Get the project root directory (one level up from the script)
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
# Path to CLI script
CLI="$PROJECT_ROOT/bin/mero-cli"

echo "🔍 Validating Mero MCP Server codebase..."

# Step 1: Check for syntax errors
echo "⚙️  Checking TypeScript compilation..."
$CLI build || { echo "❌ TypeScript compilation failed!"; exit 1; }
echo "✅ TypeScript compilation successful!"

# Step 2: Run linting
echo "⚙️  Running ESLint..."
$CLI lint || { echo "❌ Linting failed!"; exit 1; }
echo "✅ Linting successful!"

# Step 3: Run tests
echo "⚙️  Running tests..."
$CLI test || { echo "❌ Tests failed!"; exit 1; }
echo "✅ All tests passed!"

# Step 4: Check test coverage
echo "⚙️  Checking test coverage..."
$CLI coverage || { echo "❌ Coverage check failed!"; exit 1; }
echo "✅ Test coverage requirements met!"

echo "🎉 All validation checks passed successfully!"
exit 0 