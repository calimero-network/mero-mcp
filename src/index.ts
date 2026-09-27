#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.ts';
import { createServerFactory } from './server.ts';
import { createLazySession } from './session.ts';

function main() {
  const cfg = loadConfig();
  serveStdio(createServerFactory(createLazySession(cfg), cfg), { onerror: (err) => console.error('[mero-mcp]', err) });
  console.error('[mero-mcp] ready on stdio; the node connects when a client opens the connection');
}

// Unconditional: npm links this file into .bin, and node reports the symlink path
// in argv[1] while import.meta.url resolves to the realpath, so any main-module
// comparison here skips main() and exits 0 in silence.
try {
  main();
} catch (err) {
  console.error('[mero-mcp] failed to start:', err);
  process.exit(1);
}
