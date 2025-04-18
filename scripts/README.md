# Mero MCP Scripts

This directory contains utility scripts for managing and testing the Mero MCP server.

## Scripts Overview

### MCP Compatibility Testing

- **docker-test.sh**: Verifies that the Docker setup is MCP-compatible using the official MCP Inspector CLI
- **docker-test.js**: Node.js script executed by docker-test.sh that tests MCP compatibility, including SSE functionality

### Validation

- **validate.sh**: Runs validation checks on the codebase (build, lint, test)

## About MCP Inspector

These scripts use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) CLI tool to test compatibility with the Model Context Protocol. The Inspector is the official tool for testing and debugging MCP servers.

The MCP Inspector CLI supports the following methods:
- `tools/list` - List available tools
- `tools/call` - Call a specific tool
- `resources/list` - List available resources
- `resources/read` - Read a specific resource
- `resources/templates/list` - List available resource templates
- `prompts/list` - List available prompts
- `prompts/get` - Get prompt details
- `logging/setLevel` - Set the logging level

Our scripts also test the standard health endpoint using direct HTTP requests.

## Usage

All shell scripts (.sh) are executable and can be run directly:

```bash
./scripts/docker-test.sh
./scripts/validate.sh
```

## Notes on JavaScript Files

The JavaScript files in this directory are ES modules (they use `import` instead of `require`).
They are not meant to be executed directly but are called by their corresponding shell scripts
which handle dependency installation and environment setup first. 