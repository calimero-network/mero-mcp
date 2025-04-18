import { z } from "zod";
import { calimeroEchoSchema, registerCalimeroEchoTool } from "../../../src/tools/calimeroEcho";

describe("calimeroEcho", () => {
  // Create mock tool function
  const mockToolFn = jest.fn();
  
  // Create mock dependencies with properly typed mock function
  const mockMcpServer = {
    tool: mockToolFn,
    server: {},
    _registeredTools: {},
    _registeredResources: {},
    _registeredResourceTemplates: {},
    connect: jest.fn(),
    close: jest.fn(),
    resource: jest.fn(),
    resourceTemplate: jest.fn(),
    prompt: jest.fn()
  };
  
  const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  };
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("calimeroEchoSchema", () => {
    it("should define a zod schema with a message field", () => {
      expect(calimeroEchoSchema).toBeDefined();
      expect(calimeroEchoSchema.message).toBeInstanceOf(z.ZodString);
    });
  });

  describe("registerCalimeroEchoTool", () => {
    it("should register the calimero echo tool with the MCP server", () => {
      // Pass mocks as dependencies
      registerCalimeroEchoTool({ 
        // @ts-expect-error - We're passing a mock with only needed functions
        mcpServer: mockMcpServer, 
        logger: mockLogger 
      });

      expect(mockLogger.info).toHaveBeenCalledWith("Registering calimero echo tool");
      expect(mockToolFn).toHaveBeenCalledWith(
        "mcp_calimero_echo",
        calimeroEchoSchema,
        expect.any(Function)
      );
    });

    it("should return the expected tool response when called", async () => {
      // Pass mocks as dependencies
      registerCalimeroEchoTool({ 
        // @ts-expect-error - We're passing a mock with only needed functions
        mcpServer: mockMcpServer, 
        logger: mockLogger 
      });

      // Extract the handler function from the mock call
      const toolHandler = mockToolFn.mock.calls[0][2];

      // Create mock parameters
      const mockParams = { message: "hello-world" };

      // Call the handler
      const result = await toolHandler(mockParams);

      // Verify the result
      expect(result).toEqual({
        content: [{ 
          type: "text", 
          text: "Calimero Echo: hello-world" 
        }]
      });

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Calimero Echo tool called with message: hello-world"
      );
    });
  });
}); 