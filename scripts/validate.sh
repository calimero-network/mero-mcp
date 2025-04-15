#!/bin/bash

# Exit on error
set -e

echo "🔍 Validating Mero MCP Server codebase..."

# Step 1: Check for syntax errors
echo "⚙️  Checking TypeScript compilation..."
npm run build:check || { echo "❌ TypeScript compilation failed!"; exit 1; }
echo "✅ TypeScript compilation successful!"

# Step 2: Run linting
echo "⚙️  Running ESLint..."
npm run lint || { echo "❌ Linting failed!"; exit 1; }
echo "✅ Linting successful!"

# Step 3: Run tests
echo "⚙️  Running tests..."
npm test || { echo "❌ Tests failed!"; exit 1; }
echo "✅ All tests passed!"

# Step 4: Check test coverage
echo "⚙️  Checking test coverage..."
npm run test:coverage || { echo "❌ Coverage check failed!"; exit 1; }
echo "✅ Test coverage requirements met!"

echo "🎉 All validation checks passed successfully!"
exit 0 