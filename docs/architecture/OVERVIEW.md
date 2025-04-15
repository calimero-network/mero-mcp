# Mero MCP Server Architecture

This document provides an overview of the Mero MCP Server architecture, explaining the key components and their interactions.

## System Architecture

Mero MCP Server is built on Express.js and implements the Model Context Protocol (MCP) specification. The system consists of several layers:

```
┌─────────────────────────────────────────────────────────┐
│                    Client Applications                   │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                     Express Server                       │
│                                                         │
│  ┌─────────────────┐  ┌─────────────────┐               │
│  │   HTTP Routes   │  │   Middleware    │               │
│  └────────┬────────┘  └────────┬────────┘               │
│           │                    │                        │
│           ▼                    ▼                        │
│  ┌─────────────────────────────────────────────────┐    │
│  │              MCPExpressServer                   │    │
│  │                                                 │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────┐  │    │
│  │  │  Resources  │  │    Tools    │  │ Prompts │  │    │
│  │  └─────────────┘  └─────────────┘  └─────────┘  │    │
│  │                                                 │    │
│  │  ┌─────────────────────────────────────────┐    │    │
│  │  │           MCP SDK Integration           │    │    │
│  │  └─────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │                   Utilities                     │    │
│  │                                                 │    │
│  │  ┌─────────────┐  ┌─────────────┐               │    │
│  │  │   Logging   │  │  Config     │               │    │
│  │  └─────────────┘  └─────────────┘               │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Key Components

### MCPExpressServer

The core component that integrates the MCP SDK with Express. It handles:

- Resource registration and access
- Tool registration and execution
- Prompt registration and processing
- SSE connections for real-time communication

### HTTP Routes

Express routes that map HTTP endpoints to MCP functionality:

- `GET /mcp/sse`: Establishes SSE connections
- `GET /mcp/resource/:name`: Accesses resources
- `POST /mcp/tool/:name`: Executes tools
- `POST /mcp/prompt/:name`: Processes prompts

### MCP SDK Integration

Leverages the `@modelcontextprotocol/sdk` package to implement the Model Context Protocol, ensuring compliance with the specification.

### Middleware

Express middleware for request processing:

- JSON body parsing
- Error handling
- Authentication (if configured)
- Logging

### Utilities

Supporting components:

- **Logger**: Winston-based logging
- **Config**: Environment configuration management

## Data Flow

1. Client sends a request to one of the MCP endpoints
2. Express routes the request to the appropriate handler
3. MCPExpressServer processes the request using the MCP SDK
4. The result is returned to the client

### SSE Connection Flow

For Server-Sent Events:

1. Client establishes an SSE connection via `/mcp/sse`
2. Server keeps the connection open for real-time updates
3. Client can send messages via `/mcp/messages?sessionId=X`
4. Server processes these messages and responds via the SSE stream

## Directory Structure

```
src/
├── index.ts                      # Application entry point
├── mcp/
│   └── server.ts                 # MCP Server implementation
├── routes/
│   └── index.ts                  # Express routes
├── middleware/
│   └── index.ts                  # Express middleware
└── utils/
    ├── logger.ts                 # Logging utility
    └── config.ts                 # Configuration management
```

## Extension Points

The architecture supports several extension points:

1. **Custom Resources**: Register new resources via `server.registerResource()`
2. **Custom Tools**: Register new tools via `server.registerTool()`
3. **Custom Prompts**: Register new prompts via `server.registerPrompt()`
4. **Middleware Extension**: Add custom middleware to the Express app

## Security Considerations

- Authentication can be added via Express middleware
- All inputs are validated using Zod schemas
- Error handling prevents information leakage 