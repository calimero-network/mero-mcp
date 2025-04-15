import { MCPExpressServer } from '../mcp/server';
import request from 'supertest';
import { URL } from 'url';
import express from 'express';
import { z } from 'zod';
import { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate';

// Mock the logger properly
jest.mock('../utils/logger', () => ({
  __esModule: true,  // This is needed for ES modules
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

// Mock the MCP server operations
jest.mock('@modelcontextprotocol/sdk/server/mcp', () => {
  return {
    McpServer: jest.fn().mockImplementation(() => {
      return {
        tool: jest.fn().mockImplementation((name, parameters) => {
          if (name === 'test-tool') {
            return Promise.resolve({
              content: [{
                type: 'text',
                text: 'Tool response: test input'
              }]
            });
          } else {
            return Promise.reject(new Error('Tool not found'));
          }
        }),
        prompt: jest.fn().mockImplementation((name, parameters) => {
          if (name === 'test-prompt') {
            return Promise.resolve({
              messages: [{
                role: 'assistant',
                content: {
                  type: 'text',
                  text: 'Prompt response: test input'
                }
              }]
            });
          } else {
            return Promise.reject(new Error('Prompt not found'));
          }
        }),
        resource: jest.fn()
      };
    }),
    ResourceTemplate: jest.fn().mockImplementation(() => {
      return {};
    })
  };
});

describe('MCPExpressServer', () => {
  let server: MCPExpressServer;
  let app: express.Application;
  
  // This helps with timeout issues
  jest.setTimeout(15000);

  beforeEach(() => {
    server = new MCPExpressServer();
    app = server.getApp();
  });

  afterEach(() => {
    // Clean up any resources
    jest.clearAllMocks();
  });

  describe('Health Check', () => {
    it('should respond to health check endpoint', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });
  });

  describe('Resource Registration', () => {
    it('should handle registered resource requests', async () => {
      // Register a test resource
      server.registerResource(
        'test',
        'test://{id}',
        async (uri: URL, variables: Variables) => ({
          contents: [{
            uri: uri.href,
            text: `Test resource: ${variables.id}`
          }]
        })
      );

      // Test the resource endpoint
      const response = await request(app)
        .get('/mcp/resource/test')
        .query({ id: '123' })
        .expect(200);

      expect(response.body).toEqual({
        contents: [{
          uri: 'test://123',
          text: 'Test resource: 123'
        }]
      });
    });

    it('should return 404 for non-existent resources', async () => {
      const response = await request(app)
        .get('/mcp/resource/nonexistent')
        .expect(404);
        
      expect(response.body.error).toBeDefined();
    });
  });

  describe('SSE Connection', () => {
    // Use a simple test that doesn't rely on SSE connection establishment
    it('should set correct headers for SSE connections', () => {
      // Create a mock response object to check headers
      const res = {
        setHeader: jest.fn(),
        on: jest.fn(),
        end: jest.fn()
      };
      const req = { on: jest.fn() };
      
      // Call the SSE endpoint directly
      app._router.handle({ 
        method: 'GET', 
        url: '/mcp/sse',
        headers: {},
        on: req.on 
      }, res);
      
      // Verify headers are set correctly
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    });
  });

  describe('Tool Registration', () => {
    it('should handle registered tool requests', async () => {
      // Register a test tool
      server.registerTool(
        'test-tool',
        {
          input: z.string()
        },
        async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => ({
          content: [{
            type: 'text' as const,
            text: `Tool response: ${args.input}`
          }]
        })
      );

      // Test the tool endpoint with a shorter timeout
      const response = await request(app)
        .post('/mcp/tool/test-tool')
        .send({ parameters: { input: 'test input' } })
        .expect(200);

      expect(response.body).toEqual({
        content: [{
          type: 'text',
          text: 'Tool response: test input'
        }]
      });
    });
    
    it('should handle errors with tool requests', async () => {
      // Use mock implementation for error response
      const { default: logger } = require('../utils/logger');
      
      const response = await request(app)
        .post('/mcp/tool/nonexistent-tool')
        .send({ parameters: { input: 'test input' } })
        .expect(500);
      
      expect(response.body.error).toBe('Internal server error');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('Prompt Registration', () => {
    it('should handle registered prompt requests', async () => {
      // Register a test prompt
      server.registerPrompt(
        'test-prompt',
        {
          input: z.string()
        },
        (args: Record<string, string | undefined>, extra: { signal: AbortSignal }) => ({
          messages: [{
            role: 'assistant' as const,
            content: {
              type: 'text' as const,
              text: `Prompt response: ${args.input}`
            }
          }]
        })
      );

      // Test the prompt endpoint
      const response = await request(app)
        .post('/mcp/prompt/test-prompt')
        .send({ parameters: { input: 'test input' } })
        .expect(200);

      expect(response.body).toEqual({
        messages: [{
          role: 'assistant',
          content: {
            type: 'text',
            text: 'Prompt response: test input'
          }
        }]
      });
    });
    
    it('should handle errors with prompt requests', async () => {
      // Use mock implementation for error response
      const { default: logger } = require('../utils/logger');
      
      const response = await request(app)
        .post('/mcp/prompt/nonexistent-prompt')
        .send({ parameters: { input: 'test input' } })
        .expect(500);
      
      expect(response.body.error).toBe('Internal server error');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('Server Start', () => {
    it('should start the server on the specified port', () => {
      // Mock the listen method
      const mockListen = jest.fn().mockImplementation((port, callback) => {
        callback();
        return { on: jest.fn() };
      });
      
      // Replace the app.listen method with our mock
      app.listen = mockListen;
      
      // Call the start method
      server.start(3000);
      
      // Verify listen was called with the correct port
      expect(mockListen).toHaveBeenCalledWith(3000, expect.any(Function));
      
      // Verify logger was called
      const { default: logger } = require('../utils/logger');
      expect(logger.info).toHaveBeenCalledWith('Server is running on port 3000');
    });
  });
}); 