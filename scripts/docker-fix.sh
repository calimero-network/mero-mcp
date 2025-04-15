#!/bin/bash

# Exit on error
set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Get the project root directory (one level up from the script)
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

echo "🛠️  Fixing Docker build issues..."

# Ensure bin directory exists
if [ ! -d "$PROJECT_ROOT/bin" ]; then
  echo "Creating bin directory..."
  mkdir -p "$PROJECT_ROOT/bin"
fi

# Ensure mero-cli file exists
if [ ! -f "$PROJECT_ROOT/bin/mero-cli" ]; then
  echo "Creating mero-cli file..."
  cat > "$PROJECT_ROOT/bin/mero-cli" << 'EOF'
#!/bin/bash

# Exit on error
set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Get the project root directory (one level up from the script)
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Change to the project root directory
cd "$PROJECT_ROOT"

# Use NPM from node_modules for portability
NPM="$PROJECT_ROOT/node_modules/.bin/npm"

# Function to check if npm is installed in node_modules
check_npm() {
  if [ ! -f "$NPM" ]; then
    echo "⚠️  NPM not found in node_modules. Using system npm instead."
    NPM="npm"
  fi
}

# Function to run commands with the appropriate npm
run_command() {
  check_npm
  echo "🚀 Running: $NPM $@"
  $NPM "$@"
}

# Display help
show_help() {
  echo "Mero MCP Server CLI"
  echo ""
  echo "Usage: $(basename $0) <command>"
  echo ""
  echo "Commands:"
  echo "  start             Start the server in production mode"
  echo "  dev               Start the server in development mode"
  echo "  build             Build the project"
  echo "  type-check        Run TypeScript type checking"
  echo "  test              Run tests"
  echo "  coverage          Run tests with coverage"
  echo "  lint              Run ESLint"
  echo "  format            Run Prettier"
  echo "  validate          Run all checks (build, lint, test, coverage)"
  echo "  help              Show this help message"
  echo ""
}

# Main command switch
case "$1" in
  start)
    run_command run start
    ;;
  dev)
    run_command run dev
    ;;
  build)
    run_command run build
    ;;
  type-check)
    run_command run build:check
    ;;
  test)
    run_command test
    ;;
  coverage)
    run_command run test:coverage
    ;;
  lint)
    run_command run lint
    ;;
  format)
    run_command run format
    ;;
  validate)
    "$PROJECT_ROOT/scripts/validate.sh"
    ;;
  help|"")
    show_help
    ;;
  *)
    echo "Unknown command: $1"
    show_help
    exit 1
    ;;
esac

exit 0
EOF

  # Make the file executable
  chmod +x "$PROJECT_ROOT/bin/mero-cli"
  echo "✅ Created executable mero-cli file"
fi

# Ensure data directory exists
if [ ! -d "$PROJECT_ROOT/data" ]; then
  echo "Creating data directory..."
  mkdir -p "$PROJECT_ROOT/data"
  echo "✅ Created data directory"
fi

echo "🎉 Docker setup fixes applied successfully!"
echo "You can now run 'docker-compose up --build' to start the server." 