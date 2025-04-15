# Simple SSE Broadcasting Example

This example provides a minimal demonstration of using the SSE broadcasting functionality.

## 1. Server Code

```typescript
// server.js or server.ts
import express from 'express';
import { MCPExpressServer } from 'mero-mcp';

// Create and configure the server
const mcpServer = new MCPExpressServer();

// Start the server
mcpServer.start(3000);
console.log('Server listening on port 3000');

// Broadcast a message every 5 seconds
setInterval(() => {
  mcpServer.broadcastEvent('ping', { 
    time: new Date().toISOString(),
    counter: Math.floor(Math.random() * 100)
  });
  console.log('Ping message broadcasted');
}, 5000);
```

## 2. HTML Client

Save this as `client.html` and open it in a browser:

```html
<!DOCTYPE html>
<html>
<head>
  <title>SSE Test Client</title>
  <style>
    body { font-family: sans-serif; margin: 20px; }
    #events { 
      height: 300px; 
      overflow-y: scroll; 
      border: 1px solid #ccc; 
      padding: 10px;
      margin-bottom: 10px;
    }
    .event {
      padding: 5px;
      margin-bottom: 5px;
      border-left: 3px solid #4CAF50;
      background-color: #f9f9f9;
    }
  </style>
</head>
<body>
  <h1>SSE Test Client</h1>
  <div id="connection-status">Connecting...</div>
  <div id="events"></div>
  <button id="manual-event">Trigger Manual Event</button>

  <script>
    const eventsContainer = document.getElementById('events');
    const statusElement = document.getElementById('connection-status');
    const manualButton = document.getElementById('manual-event');
    
    // Function to add an event message to the UI
    function addEvent(eventName, data) {
      const eventDiv = document.createElement('div');
      eventDiv.className = 'event';
      eventDiv.innerHTML = `
        <strong>${eventName}</strong> - ${new Date().toLocaleTimeString()}<br>
        <pre>${JSON.stringify(data, null, 2)}</pre>
      `;
      eventsContainer.appendChild(eventDiv);
      eventsContainer.scrollTop = eventsContainer.scrollHeight;
    }
    
    // Connect to the SSE endpoint
    const eventSource = new EventSource('http://localhost:3000/mcp/sse');
    
    // When connection opens
    eventSource.onopen = () => {
      statusElement.textContent = 'Connected';
      statusElement.style.color = 'green';
      addEvent('connection', { status: 'Connected to server' });
    };
    
    // When connection error occurs
    eventSource.onerror = (error) => {
      statusElement.textContent = 'Connection Error - Reconnecting...';
      statusElement.style.color = 'red';
      addEvent('error', { message: 'Connection error - browser will automatically try to reconnect' });
      console.error('SSE error:', error);
    };
    
    // Listen for 'ping' events
    eventSource.addEventListener('ping', (event) => {
      const data = JSON.parse(event.data);
      addEvent('ping', data);
    });
    
    // Listen for 'manual' events
    eventSource.addEventListener('manual', (event) => {
      const data = JSON.parse(event.data);
      addEvent('manual', data);
    });
    
    // Listen for other events that don't have a specific handler
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      addEvent('message', data);
    };
    
    // Manual event trigger
    manualButton.addEventListener('click', async () => {
      try {
        // You would typically have an API endpoint to trigger an event
        // This is a simplified example - in a real app you would call your server API
        const response = await fetch('http://localhost:3000/mcp/trigger-event', {
          method: 'POST'
        });
        addEvent('button-click', { message: 'Manual event requested' });
      } catch (error) {
        console.error('Error triggering event:', error);
      }
    });
  </script>
</body>
</html>
```

## 3. Testing with cURL

You can test the SSE connection using cURL:

```bash
curl -N http://localhost:3000/mcp/sse
```

You should see events streamed in this format:

```
event: ping
data: {"time":"2023-06-15T14:30:45.123Z","counter":42}

event: ping
data: {"time":"2023-06-15T14:30:50.456Z","counter":87}
```

## 4. Manually Broadcasting Events

You can add an endpoint to manually trigger broadcasts:

```typescript
// Add this to your server code
const app = express();

// Endpoint to trigger a manual event
app.post('/mcp/trigger-event', (req, res) => {
  mcpServer.broadcastEvent('manual', {
    message: 'This is a manually triggered event',
    timestamp: new Date().toISOString()
  });
  
  res.json({ success: true });
});

app.listen(3001, () => {
  console.log('API server listening on port 3001');
});
```

Test the manual trigger with:

```bash
curl -X POST http://localhost:3001/mcp/trigger-event
```

## Tips

- Each connected client receives all broadcasted events
- The server automatically handles client disconnects
- The browser handles reconnection automatically if the connection drops
- Use different event names for different types of notifications 