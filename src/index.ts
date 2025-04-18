import express, { Request, Response } from "express";
import { mcpServer } from "./server/mcpServer";
import { registerEchoPrompt } from "./prompts/echo";
import { registerEchoTool } from "./tools/echo";
import { registerEchoResource } from "./resources/echo";
import { EnhancedSSETransport } from "./transport/sseTransport";

registerEchoPrompt();
registerEchoResource();
registerEchoTool();

const app = express();

// to support multiple simultaneous connections we have a lookup object from
// sessionId to transport
const transports: {[sessionId: string]: EnhancedSSETransport} = {};

app.get("/sse", async (_: Request, res: Response) => {
  const transport = new EnhancedSSETransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    delete transports[transport.sessionId];
  });
  await mcpServer.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send('No transport found for sessionId');
  }
});

app.listen(3000);