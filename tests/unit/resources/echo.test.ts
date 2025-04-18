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
    resource: jest.fn(),
  },
  McpServer: jest.fn(),
}));

// Mock ResourceTemplate
jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  ResourceTemplate: jest.fn().mockImplementation((pattern) => ({
    pattern,
  })),
}));

// Now import everything after mocks
import { registerEchoResource } from "../../../src/resources/echo";
import { mcpServer } from "../../../src/server/mcpServer";
import logger from "../../../src/utils/logger";

describe("Echo Resource Module", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("registerEchoResource", () => {
    it("should register the echo resource with the MCP server", () => {
      registerEchoResource();

      expect(logger.info).toHaveBeenCalledWith("Registering echo resource");
      expect(mcpServer.resource).toHaveBeenCalledWith(
        "echo",
        expect.objectContaining({ pattern: "echo://{message}" }),
        expect.any(Function)
      );
    });

    it("should return the expected resource content when called", async () => {
      // First register the resource
      registerEchoResource();

      // Extract the handler function from the mock call
      const resourceHandler = (mcpServer.resource as jest.Mock).mock.calls[0][2];

      // Create mock URI and parameters
      const mockUri = { href: "echo://hello-world" };
      const mockParams = { message: "hello-world" };

      // Call the handler
      const result = await resourceHandler(mockUri, mockParams);

      // Verify the result
      expect(result).toEqual({
        contents: [{
          uri: "echo://hello-world",
          text: "Resource echo: hello-world",
        }]
      });

      // Verify logging
      expect(logger.info).toHaveBeenCalledWith(
        "Echo resource called with message: hello-world"
      );
    });
  });
}); 