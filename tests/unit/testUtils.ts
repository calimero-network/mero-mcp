import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Response, Request } from "express";
import { EventEmitter } from "events";

/**
 * Create a mock MCP server for testing
 */
export function createMockMcpServer(): McpServer {
  const mockServer = {
    resource: jest.fn(),
    tool: jest.fn(),
    prompt: jest.fn(),
    connect: jest.fn(),
    close: jest.fn(),
  } as unknown as McpServer;
  
  return mockServer;
}

/**
 * Create a mock Express response object
 */
export function createMockResponse(): Response {
  const res = new EventEmitter() as Response;
  res.status = jest.fn().mockReturnThis();
  res.json = jest.fn().mockReturnThis();
  res.send = jest.fn().mockReturnThis();
  res.end = jest.fn().mockReturnThis();
  res.setHeader = jest.fn().mockReturnThis();
  res.headersSent = false;
  
  return res;
}

/**
 * Create a mock Express request object
 */
export function createMockRequest(body = {}, query = {}, headers = {}, path = "/test-path", method = "POST"): Request {
  const req = {
    body,
    query,
    headers,
    path,
    method,
  } as unknown as Request;
  
  return req;
}

/**
 * Mock logger for testing
 */
export const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  clear: jest.fn(),
}; 