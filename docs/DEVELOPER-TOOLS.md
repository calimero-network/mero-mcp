# Developer Tools for MCP Server

## MCP Inspector

The MCP Inspector is the recommended tool for working with MCP servers. It provides a comprehensive developer tool for testing and debugging MCP servers with a web UI, CLI interface, and proxy mode. The tool supports authentication, configuration, and various interaction modes to suit different development workflows.

For installation instructions, usage details, and more information, visit the official [MCP Inspector repository](https://github.com/modelcontextprotocol/inspector).

## Project CLI Tool

The Mero MCP Server includes its own CLI tool for common development operations:

```bash
# Show available commands
./bin/mero-cli help

# Start the server in development mode
./bin/mero-cli dev

# Run tests
./bin/mero-cli test
```

For testing utilities and strategies, see the [TESTING.md](./TESTING.md) document. 