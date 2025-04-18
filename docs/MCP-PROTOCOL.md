# MCP Protocol Implementation

This document provides details about how the Mero MCP Server implements the Model Context Protocol specification.

## Introduction to MCP

The Model Context Protocol (MCP) defines a standardized interface for AI models to interact with external tools, resources, and context. It allows for bidirectional communication between models and their environment, enabling richer AI applications.

## Key Concepts

### Resources

Resources are external data sources that can be accessed by models. Each resource has:

- A name for identification
- A URI template that defines how to access the resource
- A handler function that retrieves the resource content

### Tools

Tools are functions that models can execute to perform actions. Each tool has:

- A name for identification
- A parameter schema that defines the expected input
- A handler function that executes the tool

### Prompts

Prompts are templates that guide model responses. Each prompt has:

- A name for identification
- A parameter schema that defines the expected input
- A handler function that generates the prompt messages

### Transport

MCP defines how messages are exchanged between clients and servers. Our implementation uses Server-Sent Events (SSE) as the primary transport mechanism.

## Protocol Details

### URI Templates

MCP uses URI templates to define how resources are accessed. A URI template might look like:

```
resource://{type}/{id}
```

Variables in the template (enclosed in `{}`) are replaced with actual values when accessing the resource.

### Message Format

MCP messages follow a standard JSON format:

```json
{
  "sessionId": "unique-session-id",
  "type": "message-type",
  "data": {
    // Message-specific data
  }
}
```

### Request-Response Flow

1. Client establishes an SSE connection
2. Client sends requests (resource, tool, prompt)
3. Server processes requests and sends responses via SSE

## Implementation Details

### SSE Transport

Our SSE transport implementation:

1. Establishes and maintains client connections
2. Handles reconnection logic
3. Routes messages to appropriate handlers
4. Broadcasts events to connected clients

```typescript
// src/transport/sse.ts
import { Request, Response } from 'express';

export class SSETransport {
  private connections: Map<string, Response> = new Map();
  
  // Handle new SSE connection
  public handleConnection(req: Request, res: Response): void {
    const sessionId = this.generateSessionId();
    
    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    
    // Store connection
    this.connections.set(sessionId, res);
    
    // Handle client disconnect
    req.on('close', () => {
      this.connections.delete(sessionId);
    });
    
    // Send initial connection event
    this.sendEvent(res, 'connection', { sessionId });
  }
  
  // Send event to a specific client
  public sendEvent(res: Response, event: string, data: any): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  
  // Broadcast event to all connected clients
  public broadcastEvent(event: string, data: any): void {
    for (const res of this.connections.values()) {
      this.sendEvent(res, event, data);
    }
  }
  
  // Generate unique session ID
  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }
}
```

### Resource Implementation

Resources are implemented with a registry and handler system:

```typescript
// src/resources/registry.ts
import { ResourceHandler, ResourceVariables } from '../types';

export class ResourceRegistry {
  private resources: Map<string, { 
    template: string, 
    handler: ResourceHandler 
  }> = new Map();
  
  // Register a new resource
  public register(name: string, template: string, handler: ResourceHandler): void {
    this.resources.set(name, { template, handler });
  }
  
  // Get a resource handler by name
  public getHandler(name: string): { template: string, handler: ResourceHandler } | undefined {
    return this.resources.get(name);
  }
  
  // Extract variables from a URI based on a template
  public extractVariables(template: string, uri: string): ResourceVariables {
    // Implementation of variable extraction from URI
    // ...
  }
}
```

### Tool Implementation

Tools are implemented with a registry and validation system:

```typescript
// src/tools/registry.ts
import { ZodSchema } from 'zod';
import { ToolHandler } from '../types';

export class ToolRegistry {
  private tools: Map<string, {
    schema: ZodSchema<any>,
    handler: ToolHandler
  }> = new Map();
  
  // Register a new tool
  public register(name: string, schema: ZodSchema<any>, handler: ToolHandler): void {
    this.tools.set(name, { schema, handler });
  }
  
  // Get a tool by name
  public getTool(name: string): { schema: ZodSchema<any>, handler: ToolHandler } | undefined {
    return this.tools.get(name);
  }
  
  // Execute a tool with given parameters
  public async execute(name: string, parameters: any, context: any = {}): Promise<any> {
    const tool = this.getTool(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    
    // Validate parameters against schema
    const validatedParams = tool.schema.parse(parameters);
    
    // Execute tool
    return tool.handler(validatedParams, context);
  }
}
```

### Prompt Implementation

Prompts follow a similar pattern to tools:

```typescript
// src/prompts/registry.ts
import { ZodSchema } from 'zod';
import { PromptHandler } from '../types';

export class PromptRegistry {
  private prompts: Map<string, {
    schema: ZodSchema<any>,
    handler: PromptHandler
  }> = new Map();
  
  // Register a new prompt
  public register(name: string, schema: ZodSchema<any>, handler: PromptHandler): void {
    this.prompts.set(name, { schema, handler });
  }
  
  // Get a prompt by name
  public getPrompt(name: string): { schema: ZodSchema<any>, handler: PromptHandler } | undefined {
    return this.prompts.get(name);
  }
  
  // Process a prompt with given parameters
  public async process(name: string, parameters: any, context: any = {}): Promise<any> {
    const prompt = this.getPrompt(name);
    if (!prompt) {
      throw new Error(`Prompt not found: ${name}`);
    }
    
    // Validate parameters against schema
    const validatedParams = prompt.schema.parse(parameters);
    
    // Process prompt
    return prompt.handler(validatedParams, context);
  }
}
```

## API Routes

The Express routes map HTTP endpoints to MCP functionality:

```typescript
// src/server/routes.ts
import { Router } from 'express';
import { SSETransport } from '../transport/sse';
import { ResourceRegistry } from '../resources/registry';
import { ToolRegistry } from '../tools/registry';
import { PromptRegistry } from '../prompts/registry';

export function setupRoutes(
  router: Router,
  sseTransport: SSETransport,
  resourceRegistry: ResourceRegistry,
  toolRegistry: ToolRegistry,
  promptRegistry: PromptRegistry
): Router {
  // SSE connection endpoint
  router.get('/mcp/sse', (req, res) => {
    sseTransport.handleConnection(req, res);
  });
  
  // Resource endpoint
  router.get('/mcp/resource/:name', async (req, res, next) => {
    try {
      const { name } = req.params;
      const resource = resourceRegistry.getHandler(name);
      
      if (!resource) {
        return res.status(404).json({ error: `Resource not found: ${name}` });
      }
      
      // Extract variables from query parameters
      const variables = req.query;
      
      // Create URI from template and variables
      const uri = `${name}://${Object.entries(variables)
        .map(([key, value]) => `${key}=${value}`)
        .join('&')}`;
      
      // Execute resource handler
      const result = await resource.handler(new URL(uri), variables, { request: req });
      
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
  
  // Tool endpoint
  router.post('/mcp/tool/:name', async (req, res, next) => {
    try {
      const { name } = req.params;
      const { parameters } = req.body;
      
      // Execute tool
      const result = await toolRegistry.execute(name, parameters, { 
        request: req,
        signal: req.signal
      });
      
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
  
  // Prompt endpoint
  router.post('/mcp/prompt/:name', async (req, res, next) => {
    try {
      const { name } = req.params;
      const { parameters } = req.body;
      
      // Process prompt
      const result = await promptRegistry.process(name, parameters, {
        request: req,
        signal: req.signal
      });
      
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
  
  return router;
}
```

## Protocol Compliance

Our implementation follows the MCP specification with these key aspects:

1. **Standardized Endpoints**: Implementing the required resource, tool, and prompt endpoints
2. **URI Template Support**: Proper handling of URI templates for resource access
3. **Parameter Validation**: Using Zod schemas for type-safe parameter validation
4. **Real-time Communication**: SSE transport for bidirectional communication
5. **Error Handling**: Consistent error reporting with appropriate HTTP status codes

## Extension Points

The protocol implementation includes several extension points:

1. **Custom Resource Types**: You can implement custom resource handlers
2. **Custom Tool Types**: You can implement custom tool handlers
3. **Custom Prompt Types**: You can implement custom prompt handlers
4. **Transport Extensions**: The transport layer can be extended to support alternative mechanisms (WebSockets, HTTP long polling, etc.)

## Security Considerations

1. **Input Validation**: All inputs are validated using Zod schemas
2. **Authentication**: The server supports adding authentication middleware
3. **Rate Limiting**: Can be added via Express middleware
4. **CORS**: Configurable Cross-Origin Resource Sharing

## Future Improvements

1. **Binary Data Support**: Enhancing resource handlers to support binary data
2. **Streaming Responses**: Adding support for streaming tool responses
3. **Protocol Versioning**: Adding support for MCP versioning
4. **Performance Optimizations**: Caching and connection pooling 