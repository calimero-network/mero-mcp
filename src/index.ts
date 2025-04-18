import express, { Request, Response, NextFunction } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { mcpServer } from "./server/mcpServer";
import { transports } from "./transport/sseTransport";
import { registerEchoResource } from "./resources/echo";
import { registerEchoTool } from "./tools/echo";
import { registerEchoPrompt } from "./prompts/echo";
import logger from "./utils/logger";

// Register MCP resources, tools, and prompts
registerEchoResource();
registerEchoTool();
registerEchoPrompt();

// Initialize Express app
const app = express();
app.use(express.json());

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`[REQUEST] ${req.method} ${req.path}`, {
    sessionId: req.query.sessionId as string | undefined,
    headers: req.headers,
  });
  next();
});

// SSE endpoint for establishing connections
app.get("/sse", async (_: Request, res: Response) => {
  try {
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;

    res.on("close", () => {
      delete transports[transport.sessionId];
      logger.info(`Connection closed for session ${transport.sessionId}`);
    });

    await mcpServer.connect(transport);
    logger.info(
      `SSE connection established for session ${transport.sessionId}`,
    );
  } catch (error) {
    logger.error("Error establishing SSE connection", {
      error: error instanceof Error ? error.message : String(error),
    });

    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
});

// Message handling endpoint
app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    logger.warn("Missing sessionId in request");
    return res.status(400).send("Missing sessionId parameter");
  }

  const transport = transports[sessionId];

  if (transport) {
    try {
      await transport.handlePostMessage(req, res);
    } catch (error) {
      logger.error(`Error handling message for session ${sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });

      if (!res.headersSent) {
        res.status(500).send("Internal Server Error");
      }
    }
  } else {
    logger.warn(`No transport found for sessionId: ${sessionId}`);
    res.status(400).send("No transport found for sessionId");
  }
});

// Catch-all for unhandled routes
app.use((req: Request, res: Response) => {
  logger.warn(`Unhandled route: ${req.method} ${req.path}`);
  res.status(404).send("Not Found");
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error("Unhandled error", {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  if (!res.headersSent) {
    res.status(500).send("Internal Server Error");
  }

  next(err);
});

// Start the server
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
});
