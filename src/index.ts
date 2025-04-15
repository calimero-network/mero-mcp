import dotenv from 'dotenv';
import { MCPExpressServer } from './mcp/server';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);

const mcpServer = new MCPExpressServer();

// Register example resources, tools, and prompts
mcpServer.registerResource(
  'test',
  'test://{id}',
  async (uri: URL, params: Record<string, string | string[]>) => ({
    contents: [{
      uri: uri.href,
      text: `Test resource: ${Array.isArray(params.id) ? params.id.join(',') : params.id}`
    }]
  })
);

mcpServer.start(PORT); 