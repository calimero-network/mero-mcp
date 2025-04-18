import { z } from "zod";
import { mcpServer } from "../server/mcpServer";
import logger from "../utils/logger";

/**
 * Schema for the echo tool parameters
 */
export const echoSchema = {
  message: z.string().describe("The message to echo back"),
};

/**
 * Register the echo tool with the MCP server
 */
export function registerEchoTool(): void {
  logger.info("Registering echo tool");

  mcpServer.tool("echo", echoSchema, async (params) => {
    const { message } = params;
    logger.info(`Echo tool called with message: ${message}`);

    return {
      content: [{ type: "text", text: `Tool echo: ${message}` }],
    };
  });
}
