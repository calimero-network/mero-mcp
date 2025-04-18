import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Schema for the calimero echo tool parameters
export const calimeroEchoSchema: {
  message: z.ZodString;
};

// Dependencies for the calimero echo tool
export interface CalimeroEchoDependencies {
  mcpServer?: McpServer;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    debug: (message: string, meta?: Record<string, unknown>) => void;
  };
}

// Register the calimero echo tool with the MCP server
export function registerCalimeroEchoTool(deps?: CalimeroEchoDependencies): void; 