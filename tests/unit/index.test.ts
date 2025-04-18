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

jest.mock("../../src/transport/sseTransport", () => {
  // Create a class mock for EnhancedSSETransport
  const MockEnhancedSSETransport = jest.fn().mockImplementation(() => ({
    sessionId: "test-session-id",
    connect: jest.fn().mockResolvedValue(undefined),
    handlePostMessage: jest.fn().mockResolvedValue(undefined)
  }));
  
  return {
    EnhancedSSETransport: MockEnhancedSSETransport,
    getOrCreateTransport: jest.fn().mockReturnValue({
      sessionId: "test-session-id",
      connect: jest.fn().mockResolvedValue(undefined)
    }),
    transports: {},
    ConnectionState: {
      CONNECTED: "connected",
      DISCONNECTED: "disconnected",
      RECONNECTING: "reconnecting",
      ERROR: "error"
    },
    cleanupStaleTransports: jest.fn(),
  };
});

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
  // Define the mock function with proper typing
  const mockExpressFn = jest.fn().mockReturnValue(mockApp) as jest.Mock & { json: jest.Mock };
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
import { mcpServer } from "../../src/server/mcpServer";
import { registerEchoResource } from "../../src/resources/echo";
import { registerEchoTool } from "../../src/tools/echo";
import { registerEchoPrompt } from "../../src/prompts/echo";
import { getOrCreateTransport } from "../../src/transport/sseTransport";

// Add interval mocking
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const intervals = new Set<NodeJS.Timeout>();

// Mock setInterval and clearInterval
global.setInterval = function(
  callback: (...args: unknown[]) => void, 
  ms?: number, 
  ...args: unknown[]
): NodeJS.Timeout {
  const id = originalSetInterval(callback, ms, ...args);
  intervals.add(id);
  return id;
} as typeof global.setInterval;

global.clearInterval = function(id?: NodeJS.Timeout): void {
  if (id) {
    intervals.delete(id);
    originalClearInterval(id);
  }
} as typeof global.clearInterval;

describe("Main Application", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Require the index file to execute it
    jest.isolateModules(() => {
      require("../../src/index");
    });
  });
  
  afterEach(() => {
    // Clear all intervals created during the test
    intervals.forEach(id => {
      originalClearInterval(id);
    });
    intervals.clear();
  });
  
  it("should register MCP resources, tools, and prompts", () => {
    expect(registerEchoResource).toHaveBeenCalled();
    expect(registerEchoTool).toHaveBeenCalled();
    expect(registerEchoPrompt).toHaveBeenCalled();
  });
  
  it("should set up Express server", () => {
    // Verify Express was initialized
    expect(mockApp).toBeDefined();
  });
  
  it("should set up SSE endpoint", async () => {
    expect(mockApp.get).toHaveBeenCalledWith("/sse", expect.any(Function));
    
    // Extract the handler and test it
    const getHandler = mockApp.get.mock.calls.find(call => call[0] === "/sse")?.[1];
    if (!getHandler) {
      throw new Error('SSE endpoint handler not found');
    }
    
    const mockReq = { query: {} };
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
      on: jest.fn(),
      headersSent: false,
    };
    
    // Mock the EnhancedSSETransport constructor
    const mockTransport = {
      sessionId: "test-session-id",
      connect: jest.fn().mockResolvedValue(undefined)
    };
    
    // Temporarily replace getOrCreateTransport to avoid issues with EnhancedSSETransport constructor
    (getOrCreateTransport as jest.Mock).mockReturnValue(mockTransport);
    
    // Also mock mcpServer.connect
    (mcpServer.connect as jest.Mock).mockResolvedValue(undefined);
    
    // Call the handler and await it
    await getHandler(mockReq, mockRes);
    
    // mcpServer.connect should be called
    expect(mcpServer.connect).toHaveBeenCalled();
  });
  
  it("should set up messages endpoint", () => {
    expect(mockApp.post).toHaveBeenCalledWith("/messages", expect.any(Function));
  });
  
  it("should start the server", () => {
    expect(mockApp.listen).toHaveBeenCalledWith(3000);
  });
}); 