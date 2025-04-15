# Mero MCP Scripts

This directory contains utility scripts for managing and testing the Mero MCP server.

## Scripts Overview

### Docker Testing

- **docker-test.sh**: Verifies that the Docker setup is working correctly
- **docker-test.js**: Node.js script executed by docker-test.sh that tests all API endpoints

### SSE Testing

- **test-sse.sh**: Tests the Server-Sent Events (SSE) functionality
- **test-sse.js**: Node.js script executed by test-sse.sh that tests SSE connections and event broadcasting

### Validation

- **validate.sh**: Runs validation checks on the codebase (build, lint, test)

## Usage

All shell scripts (.sh) are executable and can be run directly:

```bash
./scripts/docker-test.sh
./scripts/test-sse.sh
./scripts/validate.sh
```

## Notes on JavaScript Files

The JavaScript files in this directory are ES modules (they use `import` instead of `require`).
They are not meant to be executed directly but are called by their corresponding shell scripts
which handle dependency installation and environment setup first. 