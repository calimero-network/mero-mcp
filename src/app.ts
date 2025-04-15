import express from "express";
import cors from "cors";
import helmet from "helmet";

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// MCP server setup will be added here
// We'll implement this later when we have the correct SDK

export { app };
