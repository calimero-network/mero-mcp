// Mock dependencies first, before any imports
jest.mock("../../../src/utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  return {
    McpServer: jest.fn().mockImplementation(() => ({
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

// Now import everything after mocks
import { createServer, mcpServer } from "../../../src/server/mcpServer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import logger from "../../../src/utils/logger";

describe("MCP Server Module", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createServer", () => {
    it("should create a new McpServer instance with default parameters", () => {
      createServer();
      
      expect(McpServer).toHaveBeenCalledWith({
        name: "example-server",
        version: "1.0.0",
      });
      
      expect(logger.info).toHaveBeenCalledWith(
        "Creating MCP server: example-server v1.0.0"
      );
    });

    it("should create a new McpServer instance with custom parameters", () => {
      createServer("custom-server", "2.0.0");
      
      expect(McpServer).toHaveBeenCalledWith({
        name: "custom-server",
        version: "2.0.0",
      });
      
      expect(logger.info).toHaveBeenCalledWith(
        "Creating MCP server: custom-server v2.0.0"
      );
    });

    it("should set up SIGINT handler", () => {
      const processOnSpy = jest.spyOn(process, "on");
      createServer();
      
      expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
      
      // Clean up
      processOnSpy.mockRestore();
    });
  });

  describe("mcpServer", () => {
    it("should export a singleton instance", () => {
      expect(mcpServer).toBeDefined();
    });
  });
}); 