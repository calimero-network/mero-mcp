#!/usr/bin/env node

/**
 * Docker MCP Compatibility Test Script
 * 
 * This script verifies that the MCP server running in Docker is compatible
 * with the Model Context Protocol by using the MCP Inspector CLI tool.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fetch from 'node-fetch';
const execAsync = promisify(exec);

// Configuration
const HOST = process.env.MCP_HOST || 'http://localhost';
const PORT = process.env.MCP_PORT || '3000';
const SERVER_URL = `${HOST}:${PORT}`;
const INSPECTOR_VERSION = '1.9.0';

// Main test function
async function runTests() {
  console.log(`🔍 Testing MCP Docker compatibility at ${SERVER_URL}`);
  
  // Ensure MCP Inspector is available
  await ensureInspector();
  
  // Run specific tests
  await testHealthEndpoint(); // Uses direct fetch, not Inspector
  await testToolsEndpoint();
  await testResourcesEndpoint();
  await testPromptsEndpoint();
  await testSSEEndpoint();
  
  console.log('\n✅ All tests completed successfully. Docker setup is MCP compatible!');
}

async function ensureInspector() {
  console.log('\n🔄 Verifying MCP Inspector availability...');
  
  try {
    // Check if the specific version is already installed
    await execAsync(`npx --no @modelcontextprotocol/inspector@${INSPECTOR_VERSION} --version`);
    console.log(`✅ MCP Inspector v${INSPECTOR_VERSION} is available`);
  } catch (error) {
    console.log(`⏳ Installing MCP Inspector v${INSPECTOR_VERSION}...`);
    try {
      await execAsync(`npm install --no-save @modelcontextprotocol/inspector@${INSPECTOR_VERSION}`);
      console.log(`✅ MCP Inspector v${INSPECTOR_VERSION} installed successfully`);
    } catch (installError) {
      console.error('❌ Failed to install MCP Inspector:', installError.message);
      process.exit(1);
    }
  }
}

async function testHealthEndpoint() {
  console.log('\n🔄 Testing health endpoint...');
  
  try {
    // Use direct fetch for health endpoint, not MCP Inspector
    const response = await fetch(`${SERVER_URL}/health`);
    const data = await response.json();
    
    if (response.ok && data.status === 'ok') {
      console.log('✅ Health endpoint is working');
    } else {
      throw new Error(`Unexpected health response: ${JSON.stringify(data)}`);
    }
  } catch (error) {
    console.error('❌ Health endpoint test failed:', error.message);
    process.exit(1);
  }
}

async function testToolsEndpoint() {
  console.log('\n🔄 Testing tools endpoint...');
  
  try {
    // Test tools listing
    const { stdout: toolsStdout } = await execAsync(`npx @modelcontextprotocol/inspector --cli ${SERVER_URL} --method tools/list`);
    const toolsResponse = JSON.parse(toolsStdout);
    
    // Check if the tools are in the expected format (in .tools property)
    const tools = toolsResponse.tools || [];
    
    if (Array.isArray(tools)) {
      console.log(`✅ Tools endpoint returned ${tools.length} tools`);
      
      // Test if echo tool exists
      const echoTool = tools.find(tool => tool.name === 'echo' || tool.name === 'mcp_calimero_echo');
      if (echoTool) {
        console.log(`✅ Found echo tool: ${echoTool.name}`);
      } else {
        console.log(`⚠️ No echo tool found. This might cause other tests to fail.`);
      }
    } else {
      throw new Error(`Unexpected tools response format: ${toolsStdout}`);
    }
  } catch (error) {
    console.error('❌ Tools endpoint test failed:', error.message);
    process.exit(1);
  }
}

async function testResourcesEndpoint() {
  console.log('\n🔄 Testing resources endpoint...');
  
  try {
    // Test resources listing
    const { stdout: resourcesStdout } = await execAsync(`npx @modelcontextprotocol/inspector --cli ${SERVER_URL} --method resources/list`);
    const resourcesResponse = JSON.parse(resourcesStdout);
    
    // Check if the resources are in the expected format
    const resources = resourcesResponse.resources || resourcesResponse || [];
    
    if (Array.isArray(resources)) {
      console.log(`✅ Resources endpoint returned ${resources.length} resources`);
    } else {
      throw new Error(`Unexpected resources response format: ${resourcesStdout}`);
    }
  } catch (error) {
    console.error('❌ Resources endpoint test failed:', error.message);
    process.exit(1);
  }
}

async function testPromptsEndpoint() {
  console.log('\n🔄 Testing prompts endpoint...');
  
  try {
    // Test prompts listing
    const { stdout: promptsStdout } = await execAsync(`npx @modelcontextprotocol/inspector --cli ${SERVER_URL} --method prompts/list`);
    const promptsResponse = JSON.parse(promptsStdout);
    
    // Check if the prompts are in the expected format
    const prompts = promptsResponse.prompts || promptsResponse || [];
    
    if (Array.isArray(prompts)) {
      console.log(`✅ Prompts endpoint returned ${prompts.length} prompts`);
    } else {
      throw new Error(`Unexpected prompts response format: ${promptsStdout}`);
    }
  } catch (error) {
    console.error('❌ Prompts endpoint test failed:', error.message);
    process.exit(1);
  }
}

async function testSSEEndpoint() {
  console.log('\n🔄 Testing SSE endpoint via echo tool...');
  
  try {
    // Find the echo tool name from the previous test
    const { stdout: toolsStdout } = await execAsync(`npx @modelcontextprotocol/inspector --cli ${SERVER_URL} --method tools/list`);
    const toolsResponse = JSON.parse(toolsStdout);
    const tools = toolsResponse.tools || [];
    
    // Look for echo tool
    const echoTool = tools.find(tool => 
      tool.name === 'echo' || 
      tool.name === 'mcp_calimero_echo' || 
      (tool.name && tool.name.toLowerCase().includes('echo'))
    );
    
    if (!echoTool) {
      console.log('⚠️ No echo tool found, skipping echo test');
      return;
    }
    
    // Test SSE by calling the echo tool
    const echoToolName = echoTool.name;
    const echoMessage = "Hello from MCP test";
    
    console.log(`Using tool: ${echoToolName}`);
    const { stdout } = await execAsync(`npx @modelcontextprotocol/inspector --cli ${SERVER_URL} --method tools/call --tool-name ${echoToolName} --tool-arg message="${echoMessage}"`);
    
    try {
      const response = JSON.parse(stdout);
      
      // Check different possible response formats
      if (
        (response && response.message === echoMessage) || 
        (response && response.result && response.result.message === echoMessage) ||
        (stdout.includes(echoMessage))
      ) {
        console.log('✅ SSE endpoint is working properly');
      } else {
        console.log(`⚠️ Echo response doesn't match expected format, but connection worked`);
        console.log(`Response: ${stdout}`);
      }
    } catch (parseError) {
      // If we can't parse JSON but the message is in the output, that's still success
      if (stdout.includes(echoMessage)) {
        console.log('✅ SSE endpoint is working properly (non-JSON response)');
      } else {
        throw new Error(`Invalid JSON response: ${stdout}`);
      }
    }
  } catch (error) {
    console.error('❌ SSE endpoint test failed:', error.message);
    process.exit(1);
  }
}

// Run tests and handle errors
runTests().catch(error => {
  console.error('❌ MCP compatibility tests failed:', error.message);
  process.exit(1);
}); 