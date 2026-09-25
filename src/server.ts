import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { createAbiLoader } from './abi.ts';
import { createCatalog } from './catalog.ts';
import type { Config } from './config.ts';
import { createGate } from './gate.ts';
import type { NodeSession } from './node.ts';
import { registerAppTools } from './tools/app.ts';
import { registerCoreTools } from './tools/core.ts';
import { registerGeneratedTools } from './tools/generated.ts';

/** The published version, so a client's diagnostics name the build it is talking to. */
function packageVersion(): string {
  return createRequire(import.meta.url)('../package.json').version as string;
}

/**
 * One factory per process: serveStdio calls it for the connection (and for a discarded server/discover probe),
 * and every server it builds reads the same catalog and handle key, so no list varies by connection.
 */
export function createServerFactory(session: NodeSession, cfg: Config) {
  const loader = createAbiLoader(session);
  const catalog = createCatalog(loader);
  const gate = createGate(session);

  return async (): Promise<McpServer> => {
    // A node that is down must not stop the server: app tools appear on the first refresh that reaches it.
    await catalog.sync().catch((err: unknown) => console.error('[mero-mcp] app list unavailable at connect:', String(err)));

    const server = new McpServer(
      { name: 'mero-mcp', version: packageVersion() },
      { debouncedNotificationMethods: ['notifications/tools/list_changed'] },
    );
    registerCoreTools(server, session, cfg, catalog);
    registerAppTools(server, session, loader, catalog, gate);
    const unsubscribeTools = registerGeneratedTools(server, catalog, gate, session, loader);
    server.server.onclose = unsubscribeTools;
    return server;
  };
}
