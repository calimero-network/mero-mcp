import { MCPExpressServer } from "../mcp/server";
import request from "supertest";
import { URL } from "url";
import express from "express";
import { z } from "zod";
import { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
// Import logger for testing
import logger from "../utils/logger";

// Mock the file tools
jest.mock("../tools/fileTools", () => ({
  fileTools: [],
  fileToolHandlers: {},
}));

// Mock the logger properly
jest.mock("../utils/logger", () => ({
  __esModule: true, // This is needed for ES modules
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the MCP server operations
jest.mock("@modelcontextprotocol/sdk/server/mcp", () => {
  return {
    McpServer: jest.fn().mockImplementation(() => {
      return {
        tool: jest.fn().mockImplementation((name, schema, handler) => {
          // During initialization, just register the tool without throwing errors
          if (handler) {
            return;
          }

          // When called from the tool endpoint
          if (name === "test-tool") {
            return Promise.resolve({
              content: [
                {
                  type: "text",
                  text: "Tool response: test input",
                },
              ],
            });
          } else {
            return Promise.reject(new Error("Tool not found"));
          }
        }),
        prompt: jest.fn().mockImplementation((name, schema, handler) => {
          // During initialization, just register the prompt without throwing errors
          if (handler) {
            return;
          }

          // When called from the prompt endpoint
          if (name === "test-prompt") {
            return Promise.resolve({
              messages: [
                {
                  role: "assistant",
                  content: {
                    type: "text",
                    text: "Prompt response: test input",
                  },
                },
              ],
            });
          } else {
            return Promise.reject(new Error("Prompt not found"));
          }
        }),
        resource: jest.fn(),
      };
    }),
    ResourceTemplate: jest.fn().mockImplementation(() => {
      return {};
    }),
  };
});

describe("MCPExpressServer", () => {
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

  describe("Health Check", () => {
    it("should respond to health check endpoint", async () => {
      const response = await request(app).get("/health");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: "ok" });
    });
  });

  describe("Resource Registration", () => {
    it("should handle registered resource requests", async () => {
      // Register a test resource
      server.registerResource(
        "test",
        "test://{id}",
        async (uri: URL, variables: Variables) => ({
          contents: [
            {
              uri: uri.href,
              text: `Test resource: ${variables.id}`,
            },
          ],
        }),
      );

      // Test the resource endpoint
      const response = await request(app)
        .get("/mcp/resource/test")
        .query({ id: "123" })
        .expect(200);

      expect(response.body).toEqual({
        contents: [
          {
            uri: "test://123",
            text: "Test resource: 123",
          },
        ],
      });
    });

    it("should return 404 for non-existent resources", async () => {
      const response = await request(app)
        .get("/mcp/resource/nonexistent")
        .expect(404);

      expect(response.body.error).toBeDefined();
    });
  });

  describe("SSE Connection", () => {
    let sseHandler: (req: express.Request, res: express.Response) => void;

    beforeEach(() => {
      // Extract the SSE handler from the routes
      const routes = app._router.stack.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (layer: any) =>
          layer.route &&
          layer.route.path === "/mcp/sse" &&
          layer.route.methods.get,
      );
      sseHandler = routes[0].route.stack[0].handle;
    });

    it("should set correct headers for SSE connections", () => {
      // Create mock request and response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = { on: jest.fn() } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = {
        setHeader: jest.fn(),
        on: jest.fn(),
        end: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      // Call the handler directly
      sseHandler(req, res);

      // Verify headers are set correctly
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream",
      );
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
      expect(res.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    });

    it("should broadcast events to all SSE connections", () => {
      // Create mock response objects to simulate SSE connections
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res1 = { write: jest.fn(), on: jest.fn() } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res2 = { write: jest.fn(), on: jest.fn() } as any;

      // Add the connections to the server's sseConnections Set
      // We need to access the private property using type casting
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connections = (server as any).sseConnections;
      connections.add(res1);
      connections.add(res2);

      // Broadcast an event
      server.broadcastEvent("test-event", { message: "Hello World" });

      // Verify that write was called on both connections with the correct format
      const expectedData =
        'event: test-event\ndata: {"message":"Hello World"}\n\n';
      expect(res1.write).toHaveBeenCalledWith(expectedData);
      expect(res2.write).toHaveBeenCalledWith(expectedData);

      // Test sending to a specific connection
      server.sendEvent(res1 as any, "specific-event", { value: 42 });

      // Verify that only res1 received the specific event
      const specificEventData = 'event: specific-event\ndata: {"value":42}\n\n';
      expect(res1.write).toHaveBeenCalledWith(specificEventData);
      expect(res2.write).not.toHaveBeenCalledWith(specificEventData);
    });

    it("should handle connection cleanup on client disconnect", () => {
      // Create mock request and response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = { on: jest.fn() } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = {
        setHeader: jest.fn(),
        on: jest.fn(),
        end: jest.fn(),
        write: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      // Call the handler directly
      sseHandler(req, res);

      // Get the 'close' handler from the request.on() call
      const closeHandler = req.on.mock.calls.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (call: [string, (error?: Error) => void]) => call[0] === "close",
      )[1];

      // Verify the connection was added
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connections = (server as any).sseConnections;
      expect(connections.has(res)).toBe(true);

      // Simulate client disconnection
      closeHandler();

      // Verify the connection was removed
      expect(connections.has(res)).toBe(false);
    });

    it("should handle request errors properly", () => {
      // Create mock request and response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = { on: jest.fn() } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = {
        setHeader: jest.fn(),
        on: jest.fn(),
        end: jest.fn(),
        write: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      // Call the handler directly
      sseHandler(req, res);

      // Get the 'error' handler from the request.on() call
      const errorHandler = req.on.mock.calls.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (call: [string, (error: Error) => void]) => call[0] === "error",
      )[1];

      // Verify the connection was added
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connections = (server as any).sseConnections;
      expect(connections.has(res)).toBe(true);

      // Simulate an error
      const testError = new Error("Test error");
      errorHandler(testError);

      // Verify error was logged
      expect(logger.error).toHaveBeenCalledWith(
        "SSE connection error",
        expect.objectContaining({ error: testError }),
      );

      // Verify the connection was removed and response ended
      expect(connections.has(res)).toBe(false);
      expect(res.end).toHaveBeenCalled();
    });

    it("should handle response errors properly", () => {
      // Create mock request and response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = { on: jest.fn() } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = {
        setHeader: jest.fn(),
        on: jest.fn(),
        end: jest.fn(),
        write: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      // Call the handler directly
      sseHandler(req, res);

      // Get the 'error' handler from the response.on() call
      const errorHandler = res.on.mock.calls.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (call: [string, (error: Error) => void]) => call[0] === "error",
      )[1];

      // Verify the connection was added
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connections = (server as any).sseConnections;
      expect(connections.has(res)).toBe(true);

      // Simulate an error
      const testError = new Error("Test error");
      errorHandler(testError);

      // Verify error was logged
      expect(logger.error).toHaveBeenCalledWith(
        "SSE response error",
        expect.objectContaining({ error: testError }),
      );

      // Verify the connection was removed and response ended
      expect(connections.has(res)).toBe(false);
      expect(res.end).toHaveBeenCalled();
    });

    it("should handle connection write errors during broadcast", () => {
      // Create mock response objects - one that throws an error when write is called
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res1 = {
        write: jest.fn().mockImplementation(() => {
          throw new Error("Write error");
        }),
        on: jest.fn(),
      } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res2 = {
        write: jest.fn(),
        on: jest.fn(),
      } as any;

      // Add the connections to the server's sseConnections Set
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connections = (server as any).sseConnections;
      connections.add(res1);
      connections.add(res2);

      // Broadcast an event
      server.broadcastEvent("test-event", { message: "Hello World" });

      // Verify error was logged
      expect(logger.error).toHaveBeenCalledWith(
        "Error broadcasting to SSE client",
        expect.objectContaining({
          error: expect.objectContaining({ message: "Write error" }),
        }),
      );

      // Verify the problematic connection was removed
      expect(connections.has(res1)).toBe(false);
      expect(connections.has(res2)).toBe(true);

      // Verify the working connection still received the event
      const expectedData =
        'event: test-event\ndata: {"message":"Hello World"}\n\n';
      expect(res2.write).toHaveBeenCalledWith(expectedData);
    });

    it("should handle invalid connections in sendEvent", () => {
      // Create a valid response object
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = { write: jest.fn(), on: jest.fn() } as any;

      // Add it to the connections
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connections = (server as any).sseConnections;
      connections.add(res);

      // Create an invalid response object (not in the connections set)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const invalidRes = { write: jest.fn(), on: jest.fn() } as any;

      // Try sending to invalid connection
      const result = server.sendEvent(invalidRes, "test-event", {
        message: "Hello",
      });

      // Verify it returns false and doesn't call write
      expect(result).toBe(false);
      expect(invalidRes.write).not.toHaveBeenCalled();
    });

    it("should handle write errors in sendEvent", () => {
      // Create a response that throws on write
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = {
        write: jest.fn().mockImplementation(() => {
          throw new Error("Write error");
        }),
        on: jest.fn(),
      } as any;

      // Add it to the connections
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connections = (server as any).sseConnections;
      connections.add(res);

      // Try sending to the error-throwing connection
      const result = server.sendEvent(res, "test-event", { message: "Hello" });

      // Verify it returns false, logs the error, and removes the connection
      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        "Error sending event to SSE client",
        expect.objectContaining({
          error: expect.objectContaining({ message: "Write error" }),
        }),
      );
      expect(connections.has(res)).toBe(false);
    });

    it("should handle errors during SSE setup", () => {
      // Create mock request and response with a throwing setHeader
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = { on: jest.fn() } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = {
        setHeader: jest.fn().mockImplementation(() => {
          throw new Error("Setup error");
        }),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      // Call the handler directly
      sseHandler(req, res);

      // Verify error handling
      expect(logger.error).toHaveBeenCalledWith(
        "SSE setup error",
        expect.objectContaining({
          error: expect.objectContaining({ message: "Setup error" }),
        }),
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });

  describe("Tool Registration", () => {
    it("should handle registered tool requests", async () => {
      // Register a test tool
      server.registerTool(
        "test-tool",
        {
          input: z.string(),
        },
        async (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: Record<string, unknown>,
          _extra: { signal: AbortSignal },
        ) => ({
          content: [
            {
              type: "text" as const,
              text: `Tool response: ${args.input}`,
            },
          ],
        }),
      );

      // Test the tool endpoint with a shorter timeout
      const response = await request(app)
        .post("/mcp/tool/test-tool")
        .send({ parameters: { input: "test input" } })
        .expect(200);

      expect(response.body).toEqual({
        content: [
          {
            type: "text",
            text: "Tool response: test input",
          },
        ],
      });
    });

    it("should handle errors with tool requests", async () => {
      // Use imported logger module for testing
      const response = await request(app)
        .post("/mcp/tool/nonexistent-tool")
        .send({ parameters: { input: "test input" } })
        .expect(500);

      expect(response.body.error).toBe("Internal server error");
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("Prompt Registration", () => {
    it("should handle registered prompt requests", async () => {
      // Register a test prompt
      server.registerPrompt(
        "test-prompt",
        {
          input: z.string(),
        },
        (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: Record<string, string | undefined>,
          _extra: { signal: AbortSignal },
        ) => ({
          messages: [
            {
              role: "assistant" as const,
              content: {
                type: "text" as const,
                text: `Prompt response: ${args.input}`,
              },
            },
          ],
        }),
      );

      // Test the prompt endpoint
      const response = await request(app)
        .post("/mcp/prompt/test-prompt")
        .send({ parameters: { input: "test input" } })
        .expect(200);

      expect(response.body).toEqual({
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: "Prompt response: test input",
            },
          },
        ],
      });
    });

    it("should handle errors with prompt requests", async () => {
      // Use imported logger
      const response = await request(app)
        .post("/mcp/prompt/nonexistent-prompt")
        .send({ parameters: { input: "test input" } })
        .expect(500);

      expect(response.body.error).toBe("Internal server error");
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("Server Start", () => {
    it("should start the server on the specified port", () => {
      // Mock the listen method
      const mockListen = jest.fn().mockImplementation((port, callback) => {
        callback();
        return { on: jest.fn() };
      });

      // Replace the app.listen method with our mock
      app.listen = mockListen;

      // Start the server
      server.start(3000);

      // Verify the server was started on the correct port
      expect(mockListen).toHaveBeenCalledWith(3000, expect.any(Function));
    });
  });

  describe("Logging Endpoint", () => {
    it("should handle valid logging level requests", async () => {
      const response = await request(app)
        .post("/mcp/logging/setLevel")
        .send({ params: { level: "debug" } })
        .expect(200);

      expect(response.body).toEqual({ result: true });
      expect(logger.info).toHaveBeenCalledWith("Setting logging level", {
        level: "debug",
      });
    });

    it("should reject invalid logging level requests", async () => {
      const response = await request(app)
        .post("/mcp/logging/setLevel")
        .send({ params: { level: "invalid-level" } })
        .expect(400);

      expect(response.body.error).toContain("Invalid logging level");
    });

    it("should handle errors in logging endpoint", async () => {
      // Create a request that will cause an error by sending malformed data
      const response = await request(app)
        .post("/mcp/logging/setLevel")
        .send({ invalid: "data" }) // Not using the expected params structure
        .expect(500);

      expect(response.body.error).toBe("Internal server error");
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
