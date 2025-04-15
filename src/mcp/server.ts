import express from "express";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import logger from "../utils/logger";
import { FileSystemResourceProvider } from "../resources/fileSystemResource";
import { fileTools, fileToolHandlers } from "../tools/fileTools";
import path from "path";
import cors from "cors";

// Define our own type that's compatible with the SDK
type VariablesMap = Record<string, string | string[]>;

export class MCPExpressServer {
  private app: express.Application;
  private server: McpServer;
  private sseConnections: Set<express.Response>;
  private resources: Map<
    string,
    {
      templateString: string;
      handler: (
        uri: URL,
        variables: VariablesMap,
      ) => Promise<{
        contents: Array<{
          uri: string;
          text: string;
        }>;
      }>;
    }
  >;

  private fileResourceProvider: FileSystemResourceProvider;

  constructor(
    options: {
      dataBasePath?: string;
    } = {},
  ) {
    this.app = express();
    this.server = new McpServer({
      name: "mero-mcp",
      version: "1.0.0",
    });
    this.sseConnections = new Set();
    this.resources = new Map();

    // Create a file resource provider with the specified base path or default to ./data
    const dataBasePath =
      options.dataBasePath || path.join(process.cwd(), "data");
    this.fileResourceProvider = new FileSystemResourceProvider(dataBasePath);

    this.setupMiddleware();
    this.setupRoutes();
    this.registerDefaultTools();
    this.registerDefaultResources();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get("/health", (req, res): void => {
      res.json({ status: "ok" });
    });

    // SSE endpoint for server-sent events
    this.app.get("/mcp/sse", (req, res): void => {
      try {
        // Required headers for SSE
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("Access-Control-Allow-Origin", "*");

        // Disable response buffering
        res.flushHeaders();

        // Send an initial connection message to keep the connection alive
        res.write('event: connected\ndata: {"status":"connected"}\n\n');

        this.sseConnections.add(res);

        req.on("close", () => {
          this.sseConnections.delete(res);
        });

        req.on("error", (error) => {
          logger.error("SSE connection error", { error });
          this.sseConnections.delete(res);
          res.end();
        });

        res.on("error", (error) => {
          logger.error("SSE response error", { error });
          this.sseConnections.delete(res);
          res.end();
        });

        // For SSE connections that stay open, we don't return anything
      } catch (error) {
        logger.error("SSE setup error", { error });
        res.status(500).json({ error: "Internal server error" });
        // Don't return anything to match void return type
      }
    });

    // Broadcast endpoint - allows test scripts to trigger SSE broadcasts
    this.app.post("/mcp/broadcast", (req, res): void => {
      try {
        const { eventName, data } = req.body;

        logger.info("Received broadcast request", {
          eventName,
          connectionCount: this.sseConnections.size,
        });

        if (!eventName) {
          logger.warn("Missing eventName in broadcast request");
          res.status(400).json({ error: "Event name is required" });
          return;
        }

        this.broadcastEvent(eventName, data || {});
        res.json({
          success: true,
          connectionsCount: this.sseConnections.size,
          message: `Broadcast sent to ${this.sseConnections.size} clients`,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error("Broadcast request error", { error, message: errorMsg });
        res
          .status(500)
          .json({ error: "Internal server error", message: errorMsg });
      }
    });

    // Resource endpoint
    this.app.get("/mcp/resource/:name", async (req, res): Promise<void> => {
      try {
        const name = req.params.name;
        const variables: VariablesMap = {};

        // Extract variables from query parameters
        Object.entries(req.query).forEach(([key, value]) => {
          if (typeof value === "string") {
            variables[key] = value;
          } else if (
            Array.isArray(value) &&
            value.every((v) => typeof v === "string")
          ) {
            variables[key] = value as string[];
          }
        });

        const resourceHandler = this.resources.get(name);
        if (!resourceHandler) {
          res.status(404).json({ error: `Resource '${name}' not found` });
          return;
        }

        // Construct a URL using the template string
        let urlString = resourceHandler.templateString;
        Object.entries(variables).forEach(([key, value]) => {
          urlString = urlString.replace(
            `{${key}}`,
            Array.isArray(value) ? value.join(",") : (value as string),
          );
        });
        const url = new URL(urlString);

        // Call the handler
        const result = await resourceHandler.handler(url, variables);
        res.json(result);
      } catch (error) {
        logger.error("Resource request error", { error });
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // Tool endpoint
    this.app.post(
      "/mcp/tool/:name",
      async (req, res): Promise<express.Response> => {
        try {
          const { name } = req.params;
          const { parameters } = req.body;
          
          // Get the handler from our fileToolHandlers map
          const handler = fileToolHandlers[name as keyof typeof fileToolHandlers];
          
          if (!handler) {
            // If no direct handler found, try the SDK
            try {
              const result = await this.server.tool(name, parameters);
              return res.json(result);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              if (errorMessage.includes("already registered")) {
                // If it's just a registration issue, we can try a direct call
                logger.warn(`Using direct tool handler for ${name} due to SDK registration issue`);
              } else {
                logger.error("Tool request SDK error", { error, message: errorMessage, tool: name });
                throw error;
              }
            }
          }
          
          // If we have a direct handler for this tool, use it
          if (handler) {
            // Create an abort controller for timeout
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout
            
            try {
              const result = await handler(parameters, { signal: controller.signal });
              clearTimeout(timeout);
              return res.json(result);
            } catch (error) {
              clearTimeout(timeout);
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error("Direct tool handler error", { error, message: errorMessage, tool: name });
              throw error;
            }
          }
          
          // If we get here, we couldn't find a handler
          return res.status(404).json({ error: `Tool ${name} not found` });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : '';
          logger.error("Tool request error", { error, message: errorMessage, stack: errorStack, tool: req.params.name, parameters: req.body.parameters });
          return res.status(500).json({ error: "Internal server error", message: errorMessage });
        }
      },
    );

    // Prompt endpoint
    this.app.post(
      "/mcp/prompt/:name",
      async (req, res): Promise<express.Response> => {
        try {
          const { name } = req.params;
          const { parameters } = req.body;
          const result = await this.server.prompt(name, parameters);
          return res.json(result);
        } catch (error) {
          logger.error("Prompt request error", { error });
          return res.status(500).json({ error: "Internal server error" });
        }
      },
    );

    // Logging endpoint
    this.app.post("/mcp/logging/setLevel", (req, res): express.Response => {
      try {
        const { level } = req.body.params;

        // Validate the logging level
        const validLevels = [
          "debug",
          "info",
          "notice",
          "warning",
          "error",
          "critical",
          "alert",
          "emergency",
        ];
        if (!validLevels.includes(level)) {
          return res
            .status(400)
            .json({ error: `Invalid logging level: ${level}` });
        }

        logger.info("Setting logging level", { level });
        // Here you would actually set the logging level
        // This is a mock implementation

        return res.json({ result: true });
      } catch (error) {
        logger.error("Logging level request error", { error });
        return res.status(500).json({ error: "Internal server error" });
      }
    });
  }

  /**
   * Register default file-based tools
   */
  private registerDefaultTools(): void {
    // Keep track of registered tools to avoid duplicates
    const registeredTools = new Set<string>();

    // Register all file tools from the fileTools array
    for (const tool of fileTools) {
      const handler =
        fileToolHandlers[tool.name as keyof typeof fileToolHandlers];
      
      // Skip if already registered
      if (registeredTools.has(tool.name) || !handler) {
        continue;
      }

      // Convert the properties to ZodRawShape by creating a schema for each property
      const zodSchema: z.ZodRawShape = {};
      if (tool.inputSchema.properties) {
        Object.entries(tool.inputSchema.properties).forEach(
          ([key, propSchema]) => {
            // Need to type cast to access properties
            const typedSchema = propSchema as {
              type?: string;
              description?: string;
            };

            // Create basic zod schema based on the type
            if (typedSchema.type === "string") {
              zodSchema[key] = z
                .string()
                .describe(typedSchema.description || "");
            } else if (typedSchema.type === "number") {
              zodSchema[key] = z
                .number()
                .describe(typedSchema.description || "");
            } else if (typedSchema.type === "boolean") {
              zodSchema[key] = z
                .boolean()
                .describe(typedSchema.description || "");
            } else {
              // Default to string for unknown types
              zodSchema[key] = z
                .string()
                .describe(typedSchema.description || "");
            }
          },
        );
      }

      // We need to type cast the handler to match the expected signature
      const typedHandler = (args: Record<string, unknown>, extra: { signal: AbortSignal }): Promise<{
        content: Array<{
          type: "text";
          text: string;
        }>;
      }> => {
        // The original handler expects specific args, but we're getting a generic Record
        // We need to use 'any' here due to the complex types involved
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return handler(args as any, extra);
      };

      try {
        // Register the tool directly with the server
        this.server.tool(tool.name, zodSchema, typedHandler);
        // Mark as registered
        registeredTools.add(tool.name);
        logger.info(`Registered tool: ${tool.name}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // If it's already registered, we can ignore
        if (errorMessage.includes("already registered")) {
          logger.info(`Tool ${tool.name} is already registered, skipping`);
        } else {
          logger.error(`Error registering tool ${tool.name}`, { error, message: errorMessage });
        }
      }
    }
  }

  /**
   * Register default file-based resources
   */
  private registerDefaultResources(): void {
    // Register a file resource handler
    this.registerResource(
      "file",
      "file:///{path}",
      async (uri: URL, variables: VariablesMap) => {
        return this.fileResourceProvider.handleResource(uri, variables);
      },
    );
    logger.info("Registered file resource handler");
  }

  public registerResource(
    name: string,
    uriTemplate: string,
    handler: (
      uri: URL,
      variables: VariablesMap,
    ) => Promise<{
      contents: Array<{
        uri: string;
        text: string;
      }>;
    }>,
  ): void {
    const template = new ResourceTemplate(uriTemplate, { list: undefined });
    this.resources.set(name, { templateString: uriTemplate, handler });
    
    // We need to use 'any' here because the SDK expects a slightly different 
    // handler signature than what we're providing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.server.resource(name, template, handler as any);
  }

  public registerTool(
    name: string,
    paramsSchema: z.ZodRawShape,
    handler: (
      args: Record<string, unknown>,
      extra: { signal: AbortSignal },
    ) => Promise<{
      content: Array<{
        type: "text";
        text: string;
      }>;
    }>,
  ): void {
    this.server.tool(name, paramsSchema, handler);
  }

  public registerPrompt(
    name: string,
    argsSchema: z.ZodRawShape,
    handler: (
      args: Record<string, string | undefined>,
      extra: { signal: AbortSignal },
    ) => {
      messages: Array<{
        role: "user" | "assistant";
        content: {
          type: "text";
          text: string;
        };
      }>;
    },
  ): void {
    this.server.prompt(name, argsSchema, handler);
  }

  /**
   * Broadcasts an event to all connected SSE clients
   * @param eventName The name of the event
   * @param data The data to send with the event
   */
  public broadcastEvent(eventName: string, data: Record<string, unknown>): void {
    // Format according to SSE spec: each field (event, data) on its own line, ending with double newline
    const eventString = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    
    logger.debug(`Broadcasting event to ${this.sseConnections.size} clients`, { 
      eventName, 
      clientsCount: this.sseConnections.size 
    });
    
    if (this.sseConnections.size === 0) {
      logger.warn('No SSE connections available for broadcast');
    }
    
    this.sseConnections.forEach(connection => {
      try {
        connection.write(eventString);
      } catch (error) {
        logger.error('Error broadcasting to SSE client', { error });
        this.sseConnections.delete(connection);
      }
    });
  }

  /**
   * Send an event to a specific SSE client
   * @param connection The SSE connection
   * @param eventName The name of the event
   * @param data The data to send with the event
   * @returns Whether the event was successfully sent
   */
  public sendEvent(connection: express.Response, eventName: string, data: Record<string, unknown>): boolean {
    if (!this.sseConnections.has(connection)) {
      return false;
    }
    
    try {
      const eventString = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
      connection.write(eventString);
      return true;
    } catch (error) {
      logger.error('Error sending event to SSE client', { error });
      this.sseConnections.delete(connection);
      return false;
    }
  }

  /**
   * Start a heartbeat to keep SSE connections alive
   * @private
   */
  private startSSEHeartbeat(): void {
    // Send a heartbeat every 30 seconds to all SSE clients
    const intervalId = setInterval(() => {
      if (this.sseConnections.size > 0) {
        logger.debug(
          `Sending heartbeat to ${this.sseConnections.size} SSE clients`,
        );
        this.broadcastEvent("heartbeat", {
          timestamp: new Date().toISOString(),
        });
      }
    }, 30000);

    // Store the interval ID for cleanup if needed
    this.app.locals.sseHeartbeatInterval = intervalId;
  }

  public start(port: number): void {
    // Start the SSE heartbeat
    this.startSSEHeartbeat();

    this.app.listen(port, () => {
      logger.info(`Server is running on port ${port}`);
    });
  }

  public getApp(): express.Application {
    return this.app;
  }
}
