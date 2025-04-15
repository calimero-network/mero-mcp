import express from 'express';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp';
import { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate';
import { z } from 'zod';
import logger from '../utils/logger';

export class MCPExpressServer {
  private app: express.Application;
  private server: McpServer;
  private sseConnections: Set<express.Response>;
  private resources: Map<string, {
    templateString: string;
    handler: (uri: URL, variables: Variables) => Promise<{
      contents: Array<{
        uri: string;
        text: string;
      }>;
    }>;
  }>;

  constructor() {
    this.app = express();
    this.server = new McpServer({
      name: 'mero-mcp',
      version: '1.0.0'
    });
    this.sseConnections = new Set();
    this.resources = new Map();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    this.app.use(express.json());
  }

  private setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok' });
    });

    // SSE endpoint for server-sent events
    this.app.get('/mcp/sse', (req, res) => {
      try {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        this.sseConnections.add(res);

        req.on('close', () => {
          this.sseConnections.delete(res);
        });

        req.on('error', (error) => {
          logger.error('SSE connection error', { error });
          this.sseConnections.delete(res);
          res.end();
        });

        res.on('error', (error) => {
          logger.error('SSE response error', { error });
          this.sseConnections.delete(res);
          res.end();
        });
      } catch (error) {
        logger.error('SSE setup error', { error });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Resource endpoint
    this.app.get('/mcp/resource/:name', async (req, res) => {
      try {
        const name = req.params.name;
        const variables: Variables = {};
        
        // Extract variables from query parameters
        Object.entries(req.query).forEach(([key, value]) => {
          if (typeof value === 'string') {
            variables[key] = value;
          } else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
            variables[key] = value as string[];
          }
        });

        const resourceHandler = this.resources.get(name);
        if (!resourceHandler) {
          return res.status(404).json({ error: `Resource '${name}' not found` });
        }

        // Construct a URL using the template string
        let urlString = resourceHandler.templateString;
        Object.entries(variables).forEach(([key, value]) => {
          urlString = urlString.replace(`{${key}}`, Array.isArray(value) ? value.join(',') : value as string);
        });
        const url = new URL(urlString);

        // Call the handler
        const result = await resourceHandler.handler(url, variables);
        res.json(result);
      } catch (error) {
        logger.error('Resource request error', { error });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Tool endpoint
    this.app.post('/mcp/tool/:name', async (req, res) => {
      try {
        const { name } = req.params;
        const { parameters } = req.body;
        const result = await this.server.tool(name, parameters);
        res.json(result);
      } catch (error) {
        logger.error('Tool request error', { error });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Prompt endpoint
    this.app.post('/mcp/prompt/:name', async (req, res) => {
      try {
        const { name } = req.params;
        const { parameters } = req.body;
        const result = await this.server.prompt(name, parameters);
        res.json(result);
      } catch (error) {
        logger.error('Prompt request error', { error });
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  public registerResource(
    name: string,
    uriTemplate: string,
    handler: (uri: URL, variables: Variables) => Promise<{
      contents: Array<{
        uri: string;
        text: string;
      }>;
    }>
  ) {
    const template = new ResourceTemplate(uriTemplate, { list: undefined });
    this.resources.set(name, { templateString: uriTemplate, handler });
    this.server.resource(name, template, handler);
  }

  public registerTool(
    name: string,
    paramsSchema: z.ZodRawShape,
    handler: (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{
      content: Array<{
        type: 'text';
        text: string;
      }>;
    }>
  ) {
    this.server.tool(name, paramsSchema, handler);
  }

  public registerPrompt(
    name: string,
    argsSchema: z.ZodRawShape,
    handler: (args: Record<string, string | undefined>, extra: { signal: AbortSignal }) => {
      messages: Array<{
        role: 'user' | 'assistant';
        content: {
          type: 'text';
          text: string;
        };
      }>;
    }
  ) {
    this.server.prompt(name, argsSchema, handler);
  }

  public start(port: number) {
    this.app.listen(port, () => {
      logger.info(`Server is running on port ${port}`);
    });
  }

  public getApp(): express.Application {
    return this.app;
  }
} 