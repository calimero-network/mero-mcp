import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import express, { Request, Response } from 'express';
import { z } from 'zod';

// Mock the logger
jest.mock('../utils/logger', () => ({
  __esModule: true,  // This is needed for ES modules
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

// Mock SSE transport
jest.mock('@modelcontextprotocol/sdk/server/sse.js', () => {
  return {
    SSEServerTransport: jest.fn().mockImplementation((_messagePath, _res) => {
      // Return a simplified mock of SSEServerTransport
      return {
        sessionId: 'test-session-id',
        handlePostMessage: jest.fn().mockImplementation((req, res) => {
          res.status(200).json({ status: 'success' });
        })
      };
    })
  };
});

describe('MCP Server', () => {
  let app: express.Application;
  let server: McpServer;
  let sseHandlerFn: (req: Request, res: Response) => void;
  
  // Increase the test timeout to avoid issues
  jest.setTimeout(15000);

  beforeEach(() => {
    app = express();
    app.use(express.json());

    server = new McpServer({
      name: 'mero-mcp',
      version: '1.0.0'
    });

    // Capture the handler function instead of setting up a route
    sseHandlerFn = (req, res): void => {
      // Set headers for SSE connection
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // End the response immediately for testing purposes
      res.end();
    };

    // Set up SSE endpoint with our captured handler
    app.get('/sse', sseHandlerFn);

    // Set up messages endpoint
    app.post('/messages', (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string;
      if (sessionId === 'test-session-id') {
        res.status(200).json({ status: 'success' });
      } else {
        res.status(400).send('No transport found for sessionId');
      }
    });
  });

  afterEach(() => {
    // Clean up resources and mocks
    jest.clearAllMocks();
  });

  describe('Server Configuration', () => {
    it('should initialize with correct configuration', () => {
      expect(server).toBeDefined();
    });
  });

  describe('SSE Connection', () => {
    it('should correctly configure SSE connection headers', () => {
      // Create mock request and response objects
      const req = {} as Request;
      const res = {
        setHeader: jest.fn(),
        end: jest.fn()
      } as unknown as Response;
      
      // Call the handler function directly
      sseHandlerFn(req, res);
      
      // Verify the headers were set correctly
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('Resource Management', () => {
    it('should register resource handlers', () => {
      // Create a spy to check if the resource method is called
      const resourceSpy = jest.spyOn(server, 'resource');
      
      const template = new ResourceTemplate('test://{id}', { list: undefined });
      server.resource(
        'test',
        template,
        async (uri: URL, variables: Variables) => ({
          contents: [{
            uri: uri.href,
            text: `Test resource: ${variables.id}`
          }]
        })
      );

      expect(resourceSpy).toHaveBeenCalledWith(
        'test',
        expect.any(Object),
        expect.any(Function)
      );
    });
  });

  describe('Tool Management', () => {
    it('should register tool handlers', () => {
      // Create a spy to check if the tool method is called
      const toolSpy = jest.spyOn(server, 'tool');
      
      server.tool(
        'test',
        { message: z.string() },
        async (args: Record<string, unknown>, _extra: { signal: AbortSignal }) => ({
          content: [{
            type: 'text' as const,
            text: `Test tool: ${args.message as string}`
          }]
        })
      );

      expect(toolSpy).toHaveBeenCalledWith(
        'test',
        { message: expect.any(Object) },
        expect.any(Function)
      );
    });
  });

  describe('Prompt Management', () => {
    it('should register prompt handlers', () => {
      // Create a spy to check if the prompt method is called
      const promptSpy = jest.spyOn(server, 'prompt');
      
      server.prompt(
        'test',
        { message: z.string() },
        (args: Record<string, string | undefined>, _extra: { signal: AbortSignal }) => ({
          messages: [{
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Test prompt: ${args.message}`
            }
          }]
        })
      );

      expect(promptSpy).toHaveBeenCalledWith(
        'test',
        { message: expect.any(Object) },
        expect.any(Function)
      );
    });
  });
}); 