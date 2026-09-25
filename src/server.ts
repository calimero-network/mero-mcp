import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import type { Config } from './config.ts';
import type { NodeSession } from './node.ts';
import { registerCoreTools } from './tools/core.ts';
import { registerAppTools } from './tools/app.ts';

/** The published version, so a client's diagnostics name the build it is talking to. */
function packageVersion(): string {
  return createRequire(import.meta.url)('../package.json').version as string;
}

export function createServer(session: NodeSession, cfg: Config): McpServer {
  const server = new McpServer({ name: 'mero-mcp', version: packageVersion() });
  registerCoreTools(server, session, cfg);
  registerAppTools(server, session, cfg);
  return server;
}
