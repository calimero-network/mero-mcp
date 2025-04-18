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
    prompt: jest.fn(),
  },
}));

// Now import everything after mocks
import { registerEchoPrompt, echoPromptSchema } from "../../../src/prompts/echo";
import { mcpServer } from "../../../src/server/mcpServer";
import logger from "../../../src/utils/logger";
import { z } from "zod";

describe("Echo Prompt Module", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("echoPromptSchema", () => {
    it("should define the correct schema for the echo prompt", () => {
      expect(echoPromptSchema).toHaveProperty("message");
      expect(echoPromptSchema.message).toBeInstanceOf(z.ZodString);
    });
  });

  describe("registerEchoPrompt", () => {
    it("should register the echo prompt with the MCP server", () => {
      registerEchoPrompt();

      expect(logger.info).toHaveBeenCalledWith("Registering echo prompt");
      expect(mcpServer.prompt).toHaveBeenCalledWith(
        "echo",
        echoPromptSchema,
        expect.any(Function)
      );
    });

    it("should return the expected prompt when called", () => {
      // First register the prompt
      registerEchoPrompt();

      // Extract the handler function from the mock call
      const promptHandler = (mcpServer.prompt as jest.Mock).mock.calls[0][2];

      // Create mock parameters
      const mockParams = { message: "hello-world" };

      // Call the handler
      const result = promptHandler(mockParams);

      // Verify the result
      expect(result).toEqual({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: "Please process this message: hello-world"
          }
        }]
      });

      // Verify logging
      expect(logger.info).toHaveBeenCalledWith(
        "Echo prompt called with message: hello-world"
      );
    });
  });
}); 