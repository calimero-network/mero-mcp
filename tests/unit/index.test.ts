// Mock dependencies first, before any imports
jest.mock("../../src/server/mcpServer", () => ({
  mcpServer: {
    connect: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../../src/resources/echo", () => ({
  registerEchoResource: jest.fn(),
}));

jest.mock("../../src/tools/echo", () => ({
  registerEchoTool: jest.fn(),
}));

jest.mock("../../src/prompts/echo", () => ({
  registerEchoPrompt: jest.fn(),
}));

jest.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
  SSEServerTransport: jest.fn().mockImplementation(() => ({
    sessionId: "test-session-id",
    handlePostMessage: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../../src/transport/sseTransport", () => ({
  transports: {},
}));

// Mock Express at the end with mockApp defined in the same scope
const mockApp = {
  use: jest.fn().mockReturnThis(),
  get: jest.fn().mockReturnThis(),
  post: jest.fn().mockReturnThis(),
  listen: jest.fn().mockImplementation((port, cb) => {
    cb && cb();
    return mockApp;
  }),
};

const jsonMiddlewareMock = jest.fn().mockReturnValue(() => {});

// Mock express with its json method
jest.mock("express", () => {
  const mockExpressFn = jest.fn().mockReturnValue(mockApp);
  mockExpressFn.json = jsonMiddlewareMock;
  return mockExpressFn;
});

jest.mock("../../src/utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Import after mocking
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { mcpServer } from "../../src/server/mcpServer";
import { registerEchoResource } from "../../src/resources/echo";
import { registerEchoTool } from "../../src/tools/echo";
import { registerEchoPrompt } from "../../src/prompts/echo";

describe("Main Application", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Require the index file to execute it
    jest.isolateModules(() => {
      require("../../src/index");
    });
  });
  
  it("should register MCP resources, tools, and prompts", () => {
    expect(registerEchoResource).toHaveBeenCalled();
    expect(registerEchoTool).toHaveBeenCalled();
    expect(registerEchoPrompt).toHaveBeenCalled();
  });
  
  it("should set up Express middleware", () => {
    expect(mockApp.use).toHaveBeenCalled();
    expect(jsonMiddlewareMock).toHaveBeenCalled();
  });
  
  it("should set up SSE endpoint", () => {
    expect(mockApp.get).toHaveBeenCalledWith("/sse", expect.any(Function));
    
    // Extract the handler and test it
    const getHandler = mockApp.get.mock.calls.find(call => call[0] === "/sse")?.[1];
    if (!getHandler) {
      throw new Error('SSE endpoint handler not found');
    }
    
    const mockReq = {};
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
      on: jest.fn(),
      headersSent: false,
    };
    
    // Call the handler
    getHandler(mockReq, mockRes);
    
    expect(SSEServerTransport).toHaveBeenCalledWith("/messages", mockRes);
    expect(mcpServer.connect).toHaveBeenCalled();
    expect(mockRes.on).toHaveBeenCalledWith("close", expect.any(Function));
  });
  
  it("should set up messages endpoint", () => {
    expect(mockApp.post).toHaveBeenCalledWith("/messages", expect.any(Function));
  });
  
  it("should start the server", () => {
    expect(mockApp.listen).toHaveBeenCalledWith(expect.any(Number), expect.any(Function));
  });
}); 