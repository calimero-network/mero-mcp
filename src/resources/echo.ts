import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpServer } from "../server/mcpServer";
import logger from "../utils/logger";

/**
 * Register the echo resource with the MCP server
 */
export function registerEchoResource(): void {
  logger.info("Registering echo resource");

  mcpServer.resource(
    "echo",
    new ResourceTemplate("echo://{message}", { list: undefined }),
    async (uri, { message }) => {
      logger.info(`Echo resource called with message: ${message}`);

      return {
        contents: [
          {
            uri: uri.href,
            text: `Resource echo: ${message}`,
          },
        ],
      };
    },
  );
}

// Re-export for convenience
export { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
