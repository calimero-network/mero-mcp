// Mock dependencies first, before any imports
jest.mock("../../../src/utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock the mcpServer
jest.mock("../../../src/server/mcpServer", () => ({
  mcpServer: {
    tool: jest.fn(),
  },
}));

// Now import everything after mocks
import { registerEchoTool, echoSchema } from "../../../src/tools/echo";
import { mcpServer } from "../../../src/server/mcpServer";
import logger from "../../../src/utils/logger";
import { z } from "zod";

describe("Echo Tool Module", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("echoSchema", () => {
    it("should define the correct schema for the echo tool", () => {
      expect(echoSchema).toHaveProperty("message");
      expect(echoSchema.message).toBeInstanceOf(z.ZodString);
    });
  });

  describe("registerEchoTool", () => {
    it("should register the echo tool with the MCP server", () => {
      registerEchoTool();

      expect(logger.info).toHaveBeenCalledWith("Registering echo tool");
      expect(mcpServer.tool).toHaveBeenCalledWith(
        "echo",
        echoSchema,
        expect.any(Function)
      );
    });

    it("should return the expected tool response when called", async () => {
      // First register the tool
      registerEchoTool();

      // Extract the handler function from the mock call
      const toolHandler = (mcpServer.tool as jest.Mock).mock.calls[0][2];

      // Create mock parameters
      const mockParams = { message: "hello-world" };

      // Call the handler
      const result = await toolHandler(mockParams);

      // Verify the result
      expect(result).toEqual({
        content: [{ 
          type: "text", 
          text: "Tool echo: hello-world" 
        }]
      });

      // Verify logging
      expect(logger.info).toHaveBeenCalledWith(
        "Echo tool called with message: hello-world"
      );
    });
  });
}); 