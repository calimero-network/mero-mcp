#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { createLazySession } from './session.ts';
import { registerCoreTools } from './tools/core.ts';
import { registerAppTools } from './tools/app.ts';

/** The published version, so a client's diagnostics name the build it is talking to. */
function packageVersion(): string {
  return createRequire(import.meta.url)('../package.json').version as string;
}

async function main() {
  const cfg = loadConfig();
  const session = createLazySession(cfg);

  const server = new McpServer({ name: 'mero-mcp', version: packageVersion() });
  registerCoreTools(server, session, cfg);
  registerAppTools(server, session, cfg);

  console.error('[mero-mcp] ready on stdio; the node connects lazily on first tool call');
  await server.connect(new StdioServerTransport());
}

// Unconditional: npm links this file into .bin, and node reports the symlink path
// in argv[1] while import.meta.url resolves to the realpath, so any main-module
// comparison here skips main() and exits 0 in silence.
main().catch((err) => {
  console.error('[mero-mcp] failed to start:', err);
  process.exit(1);
});
