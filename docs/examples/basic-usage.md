# Basic Usage Examples

This document provides basic examples of how to use the Mero MCP Server in different scenarios.

## Starting the Server

```typescript
import { createServer } from '@calimero/mero-mcp';

// Create and start server with default configuration
const server = createServer();
server.start().then(() => {
  console.log('MCP Server running on port 3000');
});
```

## Custom Configuration

```typescript
import { createServer } from '@calimero/mero-mcp';

const server = createServer({
  port: 4000,
  logLevel: 'debug',
  corsOptions: {
    origin: 'https://example.com',
    methods: ['GET', 'POST']
  }
});

server.start().then(() => {
  console.log('MCP Server running on port 4000');
});
```

## Registering a Resource

```typescript
import { createServer } from '@calimero/mero-mcp';
import { z } from 'zod';

const server = createServer();

// Register a simple resource that returns text
server.registerResource(
  'text-resource',
  'text-resource://{id}',
  async (uri, variables) => ({
    contents: [{
      uri: uri.href,
      text: `This is resource ${variables.id}`
    }]
  })
);

// Register a resource that fetches content from a database
server.registerResource(
  'database-resource',
  'database-resource://{table}/{id}',
  async (uri, variables) => {
    const { table, id } = variables;
    const data = await db.query(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    
    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify(data)
      }]
    };
  }
);

server.start();
```

## Registering a Tool

```typescript
import { createServer } from '@calimero/mero-mcp';
import { z } from 'zod';

const server = createServer();

// Register a simple echo tool
server.registerTool(
  'echo',
  { message: z.string() },
  async (args) => ({
    content: [{
      type: 'text',
      text: `Echo: ${args.message}`
    }]
  })
);

// Register a calculator tool
server.registerTool(
  'calculator',
  {
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    a: z.number(),
    b: z.number()
  },
  async (args) => {
    let result;
    switch (args.operation) {
      case 'add':
        result = args.a + args.b;
        break;
      case 'subtract':
        result = args.a - args.b;
        break;
      case 'multiply':
        result = args.a * args.b;
        break;
      case 'divide':
        if (args.b === 0) {
          throw new Error('Division by zero');
        }
        result = args.a / args.b;
        break;
    }
    
    return {
      content: [{
        type: 'text',
        text: `Result: ${result}`
      }]
    };
  }
);

server.start();
```

## Registering a Prompt

```typescript
import { createServer } from '@calimero/mero-mcp';
import { z } from 'zod';

const server = createServer();

// Register a simple greeting prompt
server.registerPrompt(
  'greeting',
  { name: z.string() },
  (args) => ({
    messages: [{
      role: 'system',
      content: {
        type: 'text',
        text: `You are a friendly assistant.`
      }
    }, {
      role: 'user',
      content: {
        type: 'text',
        text: `Hello, my name is ${args.name}.`
      }
    }, {
      role: 'assistant',
      content: {
        type: 'text',
        text: `Hello ${args.name}! How can I help you today?`
      }
    }]
  })
);

server.start();
```

## Using SSE Connection

### Server Side

```typescript
import { createServer } from '@calimero/mero-mcp';

const server = createServer();

// Broadcast event to all connected clients
setInterval(() => {
  server.broadcastEvent('heartbeat', { timestamp: Date.now() });
}, 30000);

server.start();
```

### Client Side

```javascript
// Create SSE connection
const eventSource = new EventSource('/mcp/sse');

// Listen for heartbeat events
eventSource.addEventListener('heartbeat', (event) => {
  const data = JSON.parse(event.data);
  console.log('Received heartbeat:', data.timestamp);
});

// Handle connection errors
eventSource.onerror = (error) => {
  console.error('SSE connection error:', error);
  // Attempt to reconnect after delay
  setTimeout(() => {
    eventSource.close();
    // Reconnect logic
  }, 5000);
};
```

## Complete Example

```typescript
import { createServer } from '@calimero/mero-mcp';
import { z } from 'zod';

async function main() {
  // Create server
  const server = createServer({
    port: 3000,
    logLevel: 'info'
  });
  
  // Register resources
  server.registerResource(
    'example',
    'example://{id}',
    async (uri, variables) => ({
      contents: [{
        uri: uri.href,
        text: `Example resource with ID: ${variables.id}`
      }]
    })
  );
  
  // Register tools
  server.registerTool(
    'echo',
    { message: z.string() },
    async (args) => ({
      content: [{
        type: 'text',
        text: `Echo: ${args.message}`
      }]
    })
  );
  
  // Register prompts
  server.registerPrompt(
    'greeting',
    { name: z.string() },
    (args) => ({
      messages: [{
        role: 'system',
        content: {
          type: 'text',
          text: 'You are a friendly assistant.'
        }
      }, {
        role: 'assistant',
        content: {
          type: 'text',
          text: `Hello ${args.name}! How can I help you today?`
        }
      }]
    })
  );
  
  // Start server
  await server.start();
  console.log('MCP Server running on port 3000');
}

main().catch(console.error);
``` 