import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import logger from "../utils/logger";

/**
 * Create and configure the MCP server instance
 */
export function createServer(
  name = "example-server",
  version = "1.0.0",
): McpServer {
  logger.info(`Creating MCP server: ${name} v${version}`);

  const server = new McpServer({
    name,
    version,
  });

  // Handle server lifecycle events
  process.on("SIGINT", async () => {
    logger.info("Shutting down server...");
    await server.close();
    process.exit(0);
  });

  return server;
}

// Export a singleton instance for the application
export const mcpServer = createServer();

// Re-export for convenience
export { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
