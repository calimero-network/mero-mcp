import dotenv from "dotenv";
import { MCPExpressServer } from "./mcp/server";

// Load environment variables
dotenv.config();

// Validate environment variables
function validateEnv(): void {
  const requiredVars: string[] = [];
  const missingVars = requiredVars.filter(v => !process.env[v]);
  
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
  
  // Validate PORT is numeric
  if (process.env.PORT && isNaN(parseInt(process.env.PORT, 10))) {
    throw new Error('PORT must be a valid number');
  }
  
  // Validate LOG_LEVEL if present
  const validLogLevels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
  if (process.env.LOG_LEVEL && !validLogLevels.includes(process.env.LOG_LEVEL.toLowerCase())) {
    throw new Error(`LOG_LEVEL must be one of: ${validLogLevels.join(', ')}`);
  }
}

// Run validation
try {
  validateEnv();
} catch (error) {
  // Using console.error is acceptable for startup errors before logger is initialized
  // eslint-disable-next-line no-console
  console.error(`Environment validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3000", 10);

const mcpServer = new MCPExpressServer();

// Store the server instance in app.locals so it can be accessed by other parts of the application
const app = mcpServer.getApp();
app.locals.server = mcpServer;

// Register example resources, tools, and prompts
mcpServer.registerResource(
  "test",
  "test://{id}",
  async (uri: URL, params: Record<string, string | string[]>) => ({
    contents: [
      {
        uri: uri.href,
        text: `Test resource: ${Array.isArray(params.id) ? params.id.join(",") : params.id}`,
      },
    ],
  }),
);

mcpServer.start(PORT);
