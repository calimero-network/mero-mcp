import { z } from "zod";
import { mcpServer as defaultMcpServer } from "../server/mcpServer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import defaultLogger from "../utils/logger";

/**
 * Schema for the calimero echo tool parameters
 */
export const calimeroEchoSchema = {
  message: z.string(),
};

/**
 * Dependencies for the calimero echo tool
 */
interface CalimeroEchoDependencies {
  mcpServer?: McpServer;
  logger?: typeof defaultLogger;
}

/**
 * Register the calimero echo tool with the MCP server
 * @param deps Optional dependencies for testing
 */
export function registerCalimeroEchoTool(
  deps: CalimeroEchoDependencies = {},
): void {
  const mcpServer = deps.mcpServer || defaultMcpServer;
  const logger = deps.logger || defaultLogger;

  logger.info("Registering calimero echo tool");

  mcpServer.tool(
    "mcp_calimero_echo",
    calimeroEchoSchema,
    async (params: { message: string }) => {
      logger.info(`Calimero Echo tool called with message: ${params.message}`);

      return {
        content: [
          {
            type: "text",
            text: `Calimero Echo: ${params.message}`,
          },
        ],
      };
    },
  );
}
