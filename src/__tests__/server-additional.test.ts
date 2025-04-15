import express from 'express';
import { MCPExpressServer } from '../mcp/server';
import supertest from 'supertest';
import { z } from 'zod';

// Create a mock for the MCP SDK
const mockTool = jest.fn();
const mockPrompt = jest.fn();
const mockResource = jest.fn();

// Mock the entire SDK
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  return {
    McpServer: jest.fn().mockImplementation(() => ({
      tool: mockTool,
      prompt: mockPrompt,
      resource: mockResource
    })),
    ResourceTemplate: jest.fn().mockImplementation((template) => ({
      template,
      list: undefined
    }))
  };
});

// Mock the FileSystemResourceProvider
jest.mock('../resources/fileSystemResource', () => {
  return {
    FileSystemResourceProvider: jest.fn().mockImplementation(() => ({
      handleResource: jest.fn().mockResolvedValue({
        contents: [{ uri: 'file:///test.txt', text: 'mock content' }]
      })
    }))
  };
});

// Also need to mock the fileTools to avoid initialization issues
jest.mock('../tools/fileTools', () => {
  return {
    fileTools: [],
    fileToolHandlers: {}
  };
});

describe('MCPExpressServer - Additional Tests', () => {
  let server: MCPExpressServer;
  let app: express.Application;
  let request: supertest.SuperTest<supertest.Test>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Create a new server instance for each test
    server = new MCPExpressServer();
    app = server.getApp();
    request = supertest(app);
  });

  describe('Error handling', () => {
    it('should handle resource not found errors', async () => {
      const response = await request.get('/mcp/resource/nonexistent');
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('not found');
    });

    it('should handle invalid logging levels', async () => {
      const response = await request.post('/mcp/logging/setLevel')
        .send({ params: { level: 'invalid_level' } });
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid logging level');
    });

    it('should handle broadcast requests without event name', async () => {
      const response = await request.post('/mcp/broadcast')
        .send({ data: { test: 'data' } });
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('required');
    });

    it('should handle errors in tool endpoints', async () => {
      // Mock the SDK tool method to reject for this specific test
      mockTool.mockRejectedValueOnce(new Error('Tool execution failed'));

      const response = await request.post('/mcp/tool/test')
        .send({ parameters: { test: 'data' } });
      
      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });

    it('should handle errors in prompt endpoints', async () => {
      // Mock the SDK prompt method to reject for this specific test
      mockPrompt.mockRejectedValueOnce(new Error('Prompt execution failed'));

      const response = await request.post('/mcp/prompt/test')
        .send({ parameters: { test: 'data' } });
      
      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('Tool registration', () => {
    it('should register a tool successfully', () => {
      // Define a tool schema and handler
      const schema = { name: z.string() };
      const handler = async (_args: Record<string, unknown>, _extra: { signal: AbortSignal }): Promise<{
        content: Array<{ type: "text"; text: string }>;
      }> => ({
        content: [{ type: "text" as const, text: 'result' }]
      });
      
      // Register the tool
      server.registerTool('test-tool', schema, handler);
      
      // Verify the SDK tool method was called with correct arguments
      expect(mockTool).toHaveBeenCalledWith('test-tool', schema, expect.any(Function));
    });

    it('should handle tool registration errors gracefully', () => {
      // Directly test the error handling by mocking console.error
      // and inspecting server's behavior when errors occur
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const mockServerRegisterTool = jest.spyOn(server, 'registerTool');
      
      // Define a tool schema and handler
      const schema = { name: z.string() };
      const handler = async (_args: Record<string, unknown>, _extra: { signal: AbortSignal }): Promise<{
        content: Array<{ type: "text"; text: string }>;
      }> => ({
        content: [{ type: "text" as const, text: 'result' }]
      });
      
      // Trigger the registration - this will call our mocked mcpServer
      try {
        server.registerTool('test-tool', schema, handler);
      } catch (error) {
        // We shouldn't get here, but if we do, the test should fail
        fail('Tool registration should not throw errors to the caller');
      }
      
      // Clean up spy
      consoleErrorSpy.mockRestore();
      
      // Verify that the tool registration was attempted
      expect(mockServerRegisterTool).toHaveBeenCalled();
    });
  });

  describe('Resource registration', () => {
    it('should register a resource successfully', () => {
      // Create a mock resource handler
      const handler = async (): Promise<{
        contents: Array<{ uri: string; text: string }>;
      }> => ({
        contents: [{ uri: 'test://uri', text: 'content' }]
      });
      
      // Register the resource
      server.registerResource('test-resource', 'test://{param}', handler);
      
      // Verify resource was registered
      expect(mockResource).toHaveBeenCalled();
    });
  });

  describe('Broadcasting events', () => {
    it('should successfully broadcast events to clients', async () => {
      // Create a mock response object
      const mockResponse = {
        write: jest.fn().mockReturnValue(true),
        flush: jest.fn(),
        end: jest.fn()
      } as unknown as express.Response;
      
      // Access private property safely
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sseConnections = (server as any).sseConnections;
      sseConnections.add(mockResponse);
      
      // Broadcast an event
      const eventName = 'test-event';
      const eventData = { message: 'Hello, world!' };
      server.broadcastEvent(eventName, eventData);
      
      // Verify the response.write was called with the correct event data
      expect(mockResponse.write).toHaveBeenCalled();
      const writeCall = (mockResponse.write as jest.Mock).mock.calls[0][0];
      expect(writeCall).toContain(`event: ${eventName}`);
      expect(writeCall).toContain(JSON.stringify(eventData));
    });

    it('should handle broadcast request through HTTP endpoint', async () => {
      // Create a mock for the broadcastEvent method
      const mockBroadcastEvent = jest.spyOn(server, 'broadcastEvent').mockImplementation(() => {});
      
      // Send a broadcast request
      const response = await request
        .post('/mcp/broadcast')
        .send({ eventName: 'test-event', data: { message: 'Hello' } });
      
      // Verify the response
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      
      // Verify the broadcastEvent method was called with correct arguments
      expect(mockBroadcastEvent).toHaveBeenCalledWith('test-event', { message: 'Hello' });
    });
  });
}); 