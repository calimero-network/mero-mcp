# SSE Broadcasting Example

This example demonstrates how to use the SSE (Server-Sent Events) functionality to broadcast real-time updates to connected clients.

## Server-Side Code

```typescript
import { MCPExpressServer } from '../mcp/server';

// Initialize the server
const server = new MCPExpressServer();

// Register a tool that broadcasts a notification
server.registerTool(
  'notify',
  {
    message: z.string().describe('The message to broadcast')
  },
  async (args, { signal }) => {
    const message = args.message as string;
    
    // Broadcast the notification to all connected clients
    server.broadcastEvent('notification', { 
      message,
      timestamp: new Date().toISOString()
    });
    
    return {
      content: [{
        type: 'text',
        text: `Notification sent: ${message}`
      }]
    };
  }
);

// Start the server
server.start(3000);

// Example of broadcasting an event periodically
setInterval(() => {
  const currentTime = new Date().toISOString();
  server.broadcastEvent('heartbeat', { 
    timestamp: currentTime,
    serverStatus: 'healthy'
  });
}, 30000); // Every 30 seconds
```

## Client-Side Code

```html
<!DOCTYPE html>
<html>
<head>
  <title>SSE Client Example</title>
  <style>
    #notifications {
      height: 300px;
      overflow-y: auto;
      border: 1px solid #ccc;
      padding: 10px;
      margin: 10px 0;
    }
    .notification {
      padding: 8px;
      margin-bottom: 8px;
      border-radius: 4px;
    }
    .notification.heartbeat {
      background-color: #f0f8ff;
      border-left: 3px solid #1e90ff;
    }
    .notification.alert {
      background-color: #fff0f0;
      border-left: 3px solid #ff4500;
    }
  </style>
</head>
<body>
  <h1>Real-time Notifications</h1>
  
  <div id="notifications"></div>
  
  <button id="trigger-notification">Send Test Notification</button>
  
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const notificationsContainer = document.getElementById('notifications');
      const triggerButton = document.getElementById('trigger-notification');
      
      // Connect to the SSE endpoint
      const eventSource = new EventSource('/mcp/sse');
      
      // Handle connection open
      eventSource.onopen = () => {
        addNotification('Connected to server', 'system');
      };
      
      // Handle connection error
      eventSource.onerror = (error) => {
        addNotification('Connection error, attempting to reconnect...', 'error');
        console.error('SSE error:', error);
      };
      
      // Listen for notification events
      eventSource.addEventListener('notification', (event) => {
        const data = JSON.parse(event.data);
        addNotification(`${data.message} (at ${formatTime(data.timestamp)})`, 'alert');
      });
      
      // Listen for heartbeat events
      eventSource.addEventListener('heartbeat', (event) => {
        const data = JSON.parse(event.data);
        addNotification(`Server heartbeat: ${data.serverStatus} (${formatTime(data.timestamp)})`, 'heartbeat');
      });
      
      // Trigger a notification via API call
      triggerButton.addEventListener('click', async () => {
        try {
          const response = await fetch('/mcp/tool/notify', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              parameters: {
                message: 'User-triggered notification'
              }
            })
          });
          
          const result = await response.json();
          console.log('Notification result:', result);
        } catch (error) {
          console.error('Error sending notification:', error);
        }
      });
      
      // Helper function to add a notification to the UI
      function addNotification(message, type) {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;
        
        notificationsContainer.appendChild(notification);
        notificationsContainer.scrollTop = notificationsContainer.scrollHeight;
      }
      
      // Helper function to format timestamp
      function formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString();
      }
    });
  </script>
</body>
</html>
```

## Using the Broadcast API Programmatically

You can also use the broadcast functionality from other parts of your application:

```typescript
import { MCPExpressServer } from '../mcp/server';

// Assuming you have access to the server instance
function notifyAllClients(server: MCPExpressServer, message: string, level: 'info' | 'warning' | 'error' = 'info') {
  server.broadcastEvent('system-event', {
    message,
    level,
    timestamp: new Date().toISOString()
  });
}

// Example usage
function applicationErrorHandler(server: MCPExpressServer, error: Error) {
  console.error('Application error:', error);
  
  // Notify all connected clients about the error
  notifyAllClients(
    server,
    `System error occurred: ${error.message}`,
    'error'
  );
}
```

## Best Practices

1. **Event Naming**: Use consistent event names to make client-side handling easier.
2. **Data Structure**: Maintain a consistent data structure for each event type.
3. **Error Handling**: The server automatically handles connection errors and cleanup.
4. **Performance**: For high-traffic applications, consider implementing a message queue.
5. **Security**: Be careful about sensitive information in broadcast events, as they go to all connected clients. 