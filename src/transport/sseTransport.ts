import { Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import logger from "../utils/logger";

/**
 * Enhanced SSE transport wrapper that adds logging and error handling
 */
export class EnhancedSSETransport extends SSEServerTransport {
  /**
   * Create a new enhanced SSE transport instance
   * @param path The path for SSE events
   * @param res The Express response object
   */
  constructor(path: string, res: Response) {
    super(path, res);
    logger.info(`SSE transport created with session ID: ${this.sessionId}`);

    // Add connection close handling
    res.on("close", () => {
      logger.info(`SSE connection closed for session ID: ${this.sessionId}`);
    });
  }

  /**
   * Handle a post message request
   * @param req The Express request object
   * @param res The Express response object
   */
  async handlePostMessage(req: Request, res: Response): Promise<void> {
    try {
      logger.info(`Handling message for session ID: ${this.sessionId}`, {
        method: req.method,
        path: req.path,
        body: req.body,
      });

      await super.handlePostMessage(req, res);
    } catch (error) {
      logger.error(`Error handling message for session ID: ${this.sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  }
}

/**
 * Store of active transports by session ID
 */
export const transports: { [sessionId: string]: EnhancedSSETransport } = {};

/**
 * Get an existing transport by session ID or create a new one
 * @param sessionId The session ID
 * @param path The SSE path
 * @param res The Express response object
 * @returns The transport instance
 */
export function getOrCreateTransport(
  sessionId: string | undefined,
  path: string,
  res: Response,
): EnhancedSSETransport | null {
  if (sessionId && transports[sessionId]) {
    logger.info(`Reusing transport for session ID: ${sessionId}`);
    return transports[sessionId];
  } else if (!sessionId) {
    const transport = new EnhancedSSETransport(path, res);
    transports[transport.sessionId] = transport;

    // Clean up transport when connection closes
    res.on("close", () => {
      delete transports[transport.sessionId];
    });

    return transport;
  }

  return null;
}
