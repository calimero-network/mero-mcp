# API Documentation for Mero MCP Server

This document provides detailed specifications for the Mero MCP Server API endpoints, following the Model Context Protocol.

## Base URL

All API endpoints are served relative to the base URL of your server instance, defaulting to:

```
http://localhost:3000
```

## Endpoints

### SSE Connection

Establishes a Server-Sent Events connection for real-time communication.

**Endpoint:** `GET /mcp/sse`

**Response Headers:**
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`

**Event Format:**
```
event: [event-name]
data: [JSON data]

```

**Common Events:**
- Server broadcasts events to all connected clients
- Events typically include a name and JSON-formatted data
- Clients should handle events based on the event name

**Server-Side Methods:**
- `broadcastEvent(eventName, data)`: Sends an event to all connected clients
- `sendEvent(connection, eventName, data)`: Sends an event to a specific client

**Example Client Implementation:**
```javascript
const eventSource = new EventSource('/mcp/sse');

eventSource.addEventListener('custom-event', (event) => {
  const data = JSON.parse(event.data);
  console.log('Received custom event:', data);
});

// Handle generic messages
eventSource.onmessage = (event) => {
  console.log('Received message:', JSON.parse(event.data));
};
```

**Example:**
```bash
curl -N http://localhost:3000/mcp/sse
```

### Resource Retrieval

Accesses a registered resource by its name and parameters.

**Endpoint:** `GET /mcp/resource/:name`

**Path Parameters:**
- `name` (string): The registered resource name

**Query Parameters:**
- Dynamic parameters based on the resource's URI template

**Response:**
```json
{
  "contents": [
    {
      "uri": "resource://example",
      "text": "Resource content"
    }
  ]
}
```

**Example:**
```bash
curl http://localhost:3000/mcp/resource/example?id=123
```

### Tool Execution

Executes a registered tool with the provided parameters.

**Endpoint:** `POST /mcp/tool/:name`

**Path Parameters:**
- `name` (string): The registered tool name

**Request Body:**
```json
{
  "parameters": {
    "param1": "value1",
    "param2": "value2"
  }
}
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "Tool execution result"
    }
  ]
}
```

**Example:**
```bash
curl -X POST \
  http://localhost:3000/mcp/tool/example \
  -H "Content-Type: application/json" \
  -d '{"parameters": {"param1": "value1"}}'
```

### Prompt Processing

Processes a registered prompt with the provided parameters.

**Endpoint:** `POST /mcp/prompt/:name`

**Path Parameters:**
- `name` (string): The registered prompt name

**Request Body:**
```json
{
  "parameters": {
    "param1": "value1",
    "param2": "value2"
  }
}
```

**Response:**
```json
{
  "messages": [
    {
      "role": "assistant",
      "content": {
        "type": "text",
        "text": "Prompt response"
      }
    }
  ]
}
```

**Example:**
```bash
curl -X POST \
  http://localhost:3000/mcp/prompt/example \
  -H "Content-Type: application/json" \
  -d '{"parameters": {"param1": "value1"}}'
```

## Error Handling

All API endpoints return standard HTTP status codes:

- `200 OK`: Request successful
- `400 Bad Request`: Invalid parameters or missing required parameters
- `404 Not Found`: Resource, tool, or prompt not found
- `500 Internal Server Error`: Server error

Error responses have the following format:

```json
{
  "error": "Error message"
}
```

## Resource Registration

To register resources to be used via the API, use the `registerResource` method in your server code:

```typescript
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
```

## Tool Registration

To register tools to be used via the API, use the `registerTool` method in your server code:

```typescript
server.registerTool(
  'example',
  { param1: z.string() },
  async (args, { signal }) => ({
    content: [{
      type: 'text',
      text: `Tool response for: ${args.param1}`
    }]
  })
);
```

## Prompt Registration

To register prompts to be used via the API, use the `registerPrompt` method in your server code:

```typescript
server.registerPrompt(
  'example',
  { param1: z.string() },
  (args, { signal }) => ({
    messages: [{
      role: 'assistant',
      content: {
        type: 'text',
        text: `Prompt response for: ${args.param1}`
      }
    }]
  })
);
``` 