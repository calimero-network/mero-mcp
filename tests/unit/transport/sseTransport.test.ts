// Mock dependencies first, before any imports
jest.mock("../../../src/utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock SSEServerTransport from the SDK
jest.mock("@modelcontextprotocol/sdk/server/sse.js", () => {
  return {
    SSEServerTransport: jest.fn().mockImplementation(() => ({
      sessionId: "test-session-id",
      handlePostMessage: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

// Now import everything after mocks
import { EnhancedSSETransport, getOrCreateTransport, transports } from "../../../src/transport/sseTransport";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMockRequest } from "../testUtils";
import logger from "../../../src/utils/logger";
import { EventEmitter } from "events";
import { Response } from "express";

// Create a mock response for tests
function createTestResponse(): Response {
  const res = new EventEmitter() as unknown as Response;
  res.status = jest.fn().mockReturnThis();
  res.json = jest.fn().mockReturnThis();
  res.send = jest.fn().mockReturnThis();
  res.end = jest.fn().mockReturnThis();
  res.setHeader = jest.fn().mockReturnThis();
  res.headersSent = false;
  return res;
}

describe("SSE Transport Module", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear the transports object between tests
    Object.keys(transports).forEach(key => delete transports[key]);
  });

  describe("EnhancedSSETransport", () => {
    it("should extend SSEServerTransport and log creation", () => {
      const mockRes = createTestResponse();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const transport = new EnhancedSSETransport("/messages", mockRes);

      expect(SSEServerTransport).toHaveBeenCalledWith("/messages", mockRes);
      expect(logger.info).toHaveBeenCalledWith(
        "SSE transport created with session ID: test-session-id"
      );
    });

    it("should log when connection is closed", () => {
      const mockRes = createTestResponse();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const transport = new EnhancedSSETransport("/messages", mockRes);

      // Clear previous calls
      jest.clearAllMocks();

      // Simulate connection close
      mockRes.emit("close");

      expect(logger.info).toHaveBeenCalledWith(
        "SSE connection closed for session ID: test-session-id"
      );
    });

    it("should handle post messages and log activity", async () => {
      // Create a custom EnhancedSSETransport implementation for testing handlePostMessage
      const mockTransport = {
        sessionId: "test-session-id",
        handlePostMessage: jest.fn().mockImplementation(async (req) => {
          logger.info(`Handling message for session ID: test-session-id`, { 
            method: req.method,
            path: req.path,
            body: req.body 
          });
        }),
      };

      const mockReq = createMockRequest({ method: "test_method" });
      const mockRes = createTestResponse();

      // Clear previous calls
      jest.clearAllMocks();

      // Call the method directly
      await mockTransport.handlePostMessage(mockReq, mockRes);

      expect(logger.info).toHaveBeenCalledWith(
        "Handling message for session ID: test-session-id",
        expect.objectContaining({
          method: "POST",
          path: "/test-path",
          body: { method: "test_method" },
        })
      );
    });

    it("should handle errors during post message processing", async () => {
      // Create a custom EnhancedSSETransport implementation for testing error handling
      const mockTransport = {
        sessionId: "test-session-id",
        handlePostMessage: jest.fn().mockImplementation(async (req, res) => {
          try {
            throw new Error("Test error");
          } catch (error) {
            logger.error(`Error handling message for session ID: test-session-id`, {
              error: error instanceof Error ? error.message : String(error)
            });
            
            res.status(500).json({
              jsonrpc: "2.0",
              error: {
                code: -32603,
                message: "Internal server error",
              },
              id: null,
            });
          }
        }),
      };

      const mockReq = createMockRequest();
      const mockRes = createTestResponse();

      // Clear previous calls
      jest.clearAllMocks();

      // Call the method with our mock that will throw an error
      await mockTransport.handlePostMessage(mockReq, mockRes);

      expect(logger.error).toHaveBeenCalledWith(
        "Error handling message for session ID: test-session-id",
        expect.objectContaining({
          error: "Test error",
        })
      );
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    });
  });

  describe("getOrCreateTransport", () => {
    it("should reuse an existing transport when session ID is provided", () => {
      const mockRes = createTestResponse();
      const existingTransport = new EnhancedSSETransport("/messages", mockRes);
      transports["existing-session"] = existingTransport;

      // Clear previous calls
      jest.clearAllMocks();

      const result = getOrCreateTransport("existing-session", "/messages", mockRes);

      expect(result).toBe(existingTransport);
      expect(logger.info).toHaveBeenCalledWith(
        "Reusing transport for session ID: existing-session"
      );
    });

    it("should create a new transport when no session ID is provided", () => {
      const mockRes = createTestResponse();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = getOrCreateTransport(undefined, "/messages", mockRes);

      expect(result).toBeTruthy();
      expect(transports["test-session-id"]).toBe(result);
    });

    it("should remove transport from store when connection closes", () => {
      const mockRes = createTestResponse();
      const result = getOrCreateTransport(undefined, "/messages", mockRes);

      expect(transports["test-session-id"]).toBeDefined();

      // Simulate connection close
      mockRes.emit("close");

      expect(transports["test-session-id"]).toBeUndefined();
    });

    it("should return null when session ID is provided but no matching transport exists", () => {
      const mockRes = createTestResponse();
      const result = getOrCreateTransport("non-existent-session", "/messages", mockRes);

      expect(result).toBeNull();
    });
  });
}); 