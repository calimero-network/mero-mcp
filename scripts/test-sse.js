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
      console.log(`Connecting to SSE endpoint: ${BASE_URL}/mcp/sse`);
      const eventSource = new EventSource(`${BASE_URL}/mcp/sse`);
      
      // Listen for connection open
      eventSource.onopen = async () => {
        console.log('✅ SSE connection established');
      };
      
      // Listen for the initial connected event
      eventSource.addEventListener('connected', async (event) => {
        console.log(`✅ Received connected event: ${event.data}`);
        
        // Now trigger a broadcast event
        try {
          console.log('🔄 Triggering broadcast event...');
          await triggerTestBroadcast();
        } catch (error) {
          console.error('❌ Error triggering broadcast:', error.message);
          global.clearTimeout(timeoutId);
          eventSource.close();
          reject(error);
        }
      });
      
      // Listen for heartbeat events
      eventSource.addEventListener('heartbeat', (event) => {
        console.log(`💓 Received heartbeat: ${event.data}`);
      });
      
      // Listen for test events
      eventSource.addEventListener('test-event', (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log(`✅ Received test event: ${JSON.stringify(data)}`);
          
          // Close the connection and resolve the promise
          global.clearTimeout(timeoutId);
          eventSource.close();
          resolve();
        } catch (error) {
          console.error('❌ Error handling test event:', error.message);
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
      console.error('❌ Error setting up SSE connection:', error.message);
      global.clearTimeout(timeoutId);
      reject(error);
    }
  });
}

async function triggerTestBroadcast() {
  console.log('Calling the broadcast endpoint to trigger an SSE event...');
  
  try {
    // Use our new broadcast endpoint to trigger an event
    const response = await fetch(`${BASE_URL}/mcp/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventName: 'test-event',
        data: { message: 'Test broadcast', timestamp: new Date().toISOString() }
      })
    });
    
    // Log the HTTP status
    console.log(`Broadcast endpoint response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Broadcast endpoint error: ${errorText}`);
      throw new Error(`Failed to broadcast event: ${errorText}`);
    }
    
    // Parse and log the response
    const result = await response.json();
    console.log(`Broadcast sent successfully: ${JSON.stringify(result)}`);
    console.log(`Broadcast sent to ${result.connectionsCount} connections`);
    
    if (result.connectionsCount === 0) {
      console.warn("Warning: No active SSE connections found. The broadcast may not reach any clients.");
    }
  } catch (error) {
    console.error(`Error making broadcast request: ${error.message}`);
    throw error;
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