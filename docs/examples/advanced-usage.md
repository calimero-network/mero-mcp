# Advanced Usage Examples

This document provides advanced examples for using the Mero MCP Server in more complex scenarios.

## Custom Middleware

```typescript
import { createServer } from '@calimero/mero-mcp';
import { expressjwt } from 'express-jwt';

const server = createServer();

// Add authentication middleware
server.useMiddleware(
  expressjwt({
    secret: process.env.JWT_SECRET || 'your-secret-key',
    algorithms: ['HS256']
  })
);

// Add rate limiting middleware
import rateLimit from 'express-rate-limit';
server.useMiddleware(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later'
  })
);

server.start();
```

## Custom Error Handling

```typescript
import { createServer } from '@calimero/mero-mcp';
import { Request, Response, NextFunction } from 'express';

const server = createServer();

// Add custom error handling middleware
server.useErrorHandler((err: any, req: Request, res: Response, next: NextFunction) => {
  // Log error
  console.error('Error occurred:', err);
  
  // Handle different types of errors
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Invalid input', details: err.details });
  }
  
  // Default error response
  res.status(500).json({ error: 'Internal server error' });
});

server.start();
```

## Resource with Complex Authentication

```typescript
import { createServer } from '@calimero/mero-mcp';
import { verifyToken } from './auth';

const server = createServer();

// Register a resource that requires authentication
server.registerResource(
  'secure-resource',
  'secure-resource://{id}',
  async (uri, variables, context) => {
    // Check for authorization header
    const authHeader = context.request.headers.authorization;
    if (!authHeader) {
      throw new Error('Authentication required');
    }
    
    // Verify token
    const token = authHeader.split(' ')[1];
    const user = await verifyToken(token);
    
    // Check if user has access to the requested resource
    const hasAccess = await checkResourceAccess(user.id, variables.id);
    if (!hasAccess) {
      throw new Error('Access denied');
    }
    
    // Fetch and return the resource
    const resourceData = await fetchSecureResource(variables.id);
    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify(resourceData)
      }]
    };
  }
);

server.start();
```

## Streaming Tool Response

```typescript
import { createServer } from '@calimero/mero-mcp';
import { z } from 'zod';
import { Readable } from 'stream';

const server = createServer();

// Register a tool that streams data
server.registerTool(
  'stream-data',
  { 
    query: z.string(),
    limit: z.number().optional().default(10)
  },
  async (args, { signal, onProgress }) => {
    // Initialize streaming source
    const dataStream = new Readable({
      read() {}
    });
    
    // Set up stream processing
    let count = 0;
    const processStream = async () => {
      try {
        while (count < args.limit && !signal.aborted) {
          // Simulate fetching data
          const chunk = await fetchDataChunk(args.query, count);
          
          // Send progress update
          onProgress({
            content: [{
              type: 'text',
              text: `Processing item ${count + 1}/${args.limit}`
            }]
          });
          
          // Pause between chunks
          await new Promise(resolve => setTimeout(resolve, 500));
          count++;
        }
        
        // Return final result
        return {
          content: [{
            type: 'text',
            text: `Completed processing ${count} items for query: ${args.query}`
          }]
        };
      } catch (error) {
        throw new Error(`Stream processing failed: ${error.message}`);
      }
    };
    
    // Start processing
    return processStream();
  }
);

server.start();
```

## Custom Transport

```typescript
import { createServer } from '@calimero/mero-mcp';
import { WebSocketServer } from 'ws';

const server = createServer();

// Set up WebSocket server
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket connections
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      // Process message based on type
      if (data.type === 'tool') {
        handleToolRequest(data, ws);
      } else if (data.type === 'resource') {
        handleResourceRequest(data, ws);
      } else if (data.type === 'prompt') {
        handlePromptRequest(data, ws);
      }
    } catch (error) {
      ws.send(JSON.stringify({ error: error.message }));
    }
  });
  
  // Send welcome message
  ws.send(JSON.stringify({ message: 'Connected to MCP WebSocket server' }));
});

// Register WebSocket upgrade handler
server.getExpressApp().on('upgrade', (request, socket, head) => {
  if (request.url === '/mcp/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

// Helper functions for handling WebSocket requests
async function handleToolRequest(data, ws) {
  try {
    const result = await server.executeTool(data.name, data.parameters);
    ws.send(JSON.stringify({ type: 'tool_result', id: data.id, result }));
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', id: data.id, error: error.message }));
  }
}

async function handleResourceRequest(data, ws) {
  try {
    const result = await server.getResource(data.name, data.parameters);
    ws.send(JSON.stringify({ type: 'resource_result', id: data.id, result }));
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', id: data.id, error: error.message }));
  }
}

async function handlePromptRequest(data, ws) {
  try {
    const result = await server.processPrompt(data.name, data.parameters);
    ws.send(JSON.stringify({ type: 'prompt_result', id: data.id, result }));
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', id: data.id, error: error.message }));
  }
}

server.start();
```

## Integration with External Services

```typescript
import { createServer } from '@calimero/mero-mcp';
import { z } from 'zod';
import axios from 'axios';

const server = createServer();

// Register a tool that calls an external API
server.registerTool(
  'weather',
  { 
    location: z.string(),
    units: z.enum(['metric', 'imperial']).optional().default('metric')
  },
  async (args) => {
    try {
      const apiKey = process.env.WEATHER_API_KEY;
      if (!apiKey) {
        throw new Error('Weather API key not configured');
      }
      
      // Call external weather API
      const response = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
        params: {
          q: args.location,
          units: args.units,
          appid: apiKey
        }
      });
      
      // Extract relevant data
      const { main, weather, wind, name } = response.data;
      
      return {
        content: [{
          type: 'text',
          text: `Weather in ${name}: ${weather[0].description}, Temperature: ${main.temp}°${args.units === 'metric' ? 'C' : 'F'}, Humidity: ${main.humidity}%, Wind: ${wind.speed} ${args.units === 'metric' ? 'm/s' : 'mph'}`
        }]
      };
    } catch (error) {
      if (error.response && error.response.status === 404) {
        throw new Error(`Location not found: ${args.location}`);
      }
      throw new Error(`Weather service error: ${error.message}`);
    }
  }
);

server.start();
```

## Dynamic Resource Loading

```typescript
import { createServer } from '@calimero/mero-mcp';
import fs from 'fs/promises';
import path from 'path';

const server = createServer();

// Dynamically load resources from a directory
async function loadResourcesFromDirectory(directoryPath) {
  try {
    // Read directory contents
    const files = await fs.readdir(directoryPath);
    
    // Process each resource file
    for (const file of files) {
      if (file.endsWith('.js') || file.endsWith('.ts')) {
        const resourcePath = path.join(directoryPath, file);
        console.log(`Loading resource from: ${resourcePath}`);
        
        // Import resource module
        const resourceModule = await import(resourcePath);
        
        // Register resource if it has the required properties
        if (resourceModule.name && resourceModule.uriTemplate && resourceModule.handler) {
          server.registerResource(
            resourceModule.name,
            resourceModule.uriTemplate,
            resourceModule.handler
          );
          console.log(`Registered resource: ${resourceModule.name}`);
        } else {
          console.warn(`Skipping invalid resource file: ${file}`);
        }
      }
    }
  } catch (error) {
    console.error(`Error loading resources: ${error.message}`);
  }
}

// Load resources, tools, and prompts
async function loadAllComponents() {
  await loadResourcesFromDirectory('./src/resources');
  await loadToolsFromDirectory('./src/tools');
  await loadPromptsFromDirectory('./src/prompts');
}

// Initialize and start server
async function start() {
  await loadAllComponents();
  await server.start();
  console.log('MCP Server running with dynamically loaded components');
}

start().catch(console.error);
``` 