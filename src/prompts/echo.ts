import { z } from "zod";
import { mcpServer } from "../server/mcpServer";
import logger from "../utils/logger";

/**
 * Schema for the echo prompt parameters
 */
export const echoPromptSchema = {
  message: z.string().describe("The message to echo in the prompt"),
};

/**
 * Register the echo prompt with the MCP server
 */
export function registerEchoPrompt(): void {
  logger.info("Registering echo prompt");

  mcpServer.prompt("echo", echoPromptSchema, (params) => {
    const { message } = params;
    logger.info(`Echo prompt called with message: ${message}`);

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please process this message: ${message}`,
          },
        },
      ],
    };
  });
}
