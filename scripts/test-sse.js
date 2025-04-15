#!/usr/bin/env node

/**
 * SSE Functionality Test Script
 * 
 * This script tests the Server-Sent Events (SSE) functionality,
 * including the broadcast event feature.
 * 
 * Note: This is an ES module (uses import instead of require).
 */

import fetch from 'node-fetch';
import * as eventsource from 'eventsource';
const { EventSource } = eventsource;
import { setTimeout } from 'timers/promises';

// Configuration
const HOST = process.env.MCP_HOST || 'http://localhost';
const PORT = process.env.MCP_PORT || '3000';
const BASE_URL = `${HOST}:${PORT}`;
const TEST_TIMEOUT_MS = 10000;  // 10 seconds max for test to complete

// Main test function
async function runTests() {
  console.log(`🔍 Testing SSE functionality at ${BASE_URL}`);
  
  try {
    // Create a temporary webhook endpoint to trigger SSE broadcast
    await createBroadcastWebhook();
    
    // Test SSE connection and broadcasting
    await testSSEBroadcasting();
    
    console.log('\n✅ All SSE tests completed successfully!');
  } finally {
    // Clean up
    await cleanupTests();
  }
}

async function createBroadcastWebhook() {
  console.log('\n🔄 Creating temporary broadcast webhook...');
  
  // This creates a writeFile operation that broadcasts an event
  // We'll use this to test the SSE functionality
  
  const webhookCode = `
  const { broadcastEvent } = require('./src/mcp/server');
  
  // Simple webhook that broadcasts an event when called
  module.exports = async function broadcastWebhook(req, res) {
    const eventName = req.body.eventName || 'test-event';
    const eventData = req.body.data || { message: 'Test broadcast message' };
    
    // Broadcast to all SSE connections
    try {
      // Access the server instance to call broadcastEvent
      const server = req.app.locals.server;
      if (server && server.broadcastEvent) {
        server.broadcastEvent(eventName, eventData);
        res.json({ success: true, message: 'Event broadcasted successfully' });
      } else {
        res.status(500).json({ success: false, message: 'Server instance not available' });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  };
  `;
  
  // We won't actually create this file on disk since we don't have file access permissions
  // In a real environment, you'd want to register this as a temporary endpoint
  
  console.log('✅ Broadcast webhook configured (simulated)');
}

async function testSSEBroadcasting() {
  console.log('\n🔄 Testing SSE connection and event broadcasting...');
  
  // Create a promise that will resolve when the test is complete
  return new Promise((resolve, reject) => {
    // Set a timeout to fail the test if it takes too long
    const timeoutId = global.setTimeout(() => {
      reject(new Error('SSE test timed out'));
    }, TEST_TIMEOUT_MS);
    
    try {
      // Connect to the SSE endpoint
      const eventSource = new EventSource(`${BASE_URL}/mcp/sse`);
      
      // Listen for connection open
      eventSource.onopen = async () => {
        console.log('✅ SSE connection established');
        
        // Now trigger a broadcast event
        try {
          // Simulate a webhook call that broadcasts an event
          // In a real test, you would use the webhook endpoint
          console.log('🔄 Triggering broadcast event...');
          
          // Since we can't directly call the server methods, we'll call our own endpoint
          await triggerTestBroadcast();
          
          // Waited long enough, if we don't receive an event, the test will timeout
          console.log('⚠️ No events received yet, waiting...');
        } catch (error) {
          global.clearTimeout(timeoutId);
          eventSource.close();
          reject(error);
        }
      };
      
      // Listen for events
      eventSource.addEventListener('test-event', (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log(`✅ Received test event: ${JSON.stringify(data)}`);
          
          // Close the connection and resolve the promise
          global.clearTimeout(timeoutId);
          eventSource.close();
          resolve();
        } catch (error) {
          global.clearTimeout(timeoutId);
          eventSource.close();
          reject(error);
        }
      });
      
      // Handle generic messages
      eventSource.onmessage = (event) => {
        console.log(`📄 Received message: ${event.data}`);
      };
      
      // Handle errors
      eventSource.onerror = (error) => {
        console.error('❌ SSE connection error:', error);
        global.clearTimeout(timeoutId);
        eventSource.close();
        reject(new Error('SSE connection error'));
      };
    } catch (error) {
      global.clearTimeout(timeoutId);
      reject(error);
    }
  });
}

async function triggerTestBroadcast() {
  // In a real test with the webhook set up, we'd call it like this:
  // await fetch(`${BASE_URL}/webhook/broadcast`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     eventName: 'test-event',
  //     data: { message: 'Test broadcast', timestamp: new Date().toISOString() }
  //   })
  // });
  
  // For this demo, simulate the broadcast by doing something that should trigger 
  // server activity, like creating and deleting a file
  
  console.log('   (simulating broadcast - in reality we would call the broadcast method directly)');
  
  // Create a file
  const createResponse = await fetch(`${BASE_URL}/mcp/tool/write_file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parameters: {
        filePath: 'sse-test.txt',
        content: 'Testing SSE broadcast'
      }
    })
  });
  
  if (!createResponse.ok) {
    throw new Error(`Failed to create test file: ${await createResponse.text()}`);
  }
  
  // Wait a moment
  await new Promise(resolve => global.setTimeout(resolve, 1000));
  
  // Delete the file
  const deleteResponse = await fetch(`${BASE_URL}/mcp/tool/delete_file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parameters: {
        filePath: 'sse-test.txt'
      }
    })
  });
  
  if (!deleteResponse.ok) {
    console.warn(`Warning: Failed to delete test file: ${await deleteResponse.text()}`);
  }
}

async function cleanupTests() {
  console.log('\n🧹 Cleaning up test resources...');
  
  try {
    // Delete test files
    const response = await fetch(`${BASE_URL}/mcp/tool/delete_file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parameters: {
          filePath: 'sse-test.txt'
        }
      })
    });
    
    // Ignore errors - file might already be deleted
    console.log('✅ Cleanup completed');
  } catch (error) {
    console.warn('⚠️ Cleanup warning:', error.message);
  }
}

// Run tests and handle errors
runTests().catch(error => {
  console.error('❌ SSE tests failed:', error.message);
  process.exit(1);
}); 