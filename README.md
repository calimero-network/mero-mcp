# Mero MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A robust Express-based server implementation of the [Model Context Protocol (MCP)](https://modelcontextprotocol.ai/), designed to provide a standardized interface for AI model integrations.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Variables](#environment-variables)
- [Usage](#usage)
  - [Running in Development](#running-in-development)
  - [Building for Production](#building-for-production)
  - [Docker Deployment](#docker-deployment)
- [API Documentation](#api-documentation)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

## Overview

The Mero MCP Server implements the Model Context Protocol, which defines a standard interface for AI models to interact with tools, resources, and context. This server provides endpoints for resource fetching, tool execution, and prompt handling according to the MCP specification.

## Features

- **MCP Compliance**: Full implementation of the Model Context Protocol specification
- **Resource Management**: API for registering and accessing external resources
- **Tool Integration**: Standardized interface for tool registration and execution
- **Prompt Handling**: Structured prompt management with schema validation
- **SSE Connections**: Server-Sent Events for real-time communication
- **Robust Error Handling**: Comprehensive error management and logging
- **TypeScript**: Type-safe implementation with modern JavaScript features

## Getting Started

### Prerequisites

- Node.js 16.x or higher
- npm or yarn

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-username/mero-mcp.git
cd mero-mcp
npm install
```

### Environment Variables

Create a `.env` file in the root directory with the following variables:

```
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
```

## Usage

### Running in Development

```bash
npm run dev
```

This starts the server in development mode with hot reloading.

### Building for Production

```bash
npm run build
npm start
```

### Docker Deployment

```bash
docker build -t mero-mcp .
docker run -p 3000:3000 -e NODE_ENV=production mero-mcp
```

## API Documentation

The server exposes the following MCP endpoints:

- GET `/mcp/sse` - Establishes an SSE connection for real-time communication
- GET `/mcp/resource/:name` - Accesses registered resources
- POST `/mcp/tool/:name` - Executes registered tools
- POST `/mcp/prompt/:name` - Processes registered prompts

For detailed API documentation, see the [API.md](docs/API.md) file.

## Testing

The project includes comprehensive tests for all components:

```bash
# Run tests
npm test

# Check test coverage
npm test -- --coverage
```

## Contributing

Contributions are welcome! Please see our [Contributing Guidelines](CONTRIBUTING.md) for more details.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. 