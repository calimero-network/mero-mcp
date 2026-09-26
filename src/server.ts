import { createRequire } from 'node:module';
import { McpServer, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import { createAbiLoader } from './abi.ts';
import { createCatalog } from './catalog.ts';
import type { Config } from './config.ts';
import { createGate } from './gate.ts';
import { GUIDE_URI_TEMPLATE, guideUri } from './guide.ts';
import type { NodeSession } from './node.ts';
import { registerAppTools } from './tools/app.ts';
import { registerCoreTools } from './tools/core.ts';
import { registerGeneratedTools } from './tools/generated.ts';

const INSTRUCTIONS =
  'Calimero apps describe themselves. Do not read app source. ' +
  'To use an app: list_applications, then describe_app to plan or select_app to act, ' +
  'then pass the returned app_handle on every app tool call.';

const LIST_CACHE = { ttlMs: 30_000, cacheScope: 'private' as const };
const GUIDE_CACHE = { ttlMs: 86_400_000, cacheScope: 'private' as const };

/** Runs `register`, adding every tool name it registers on `server` to `names`, so generated names can steer around them. */
function recordToolNames(server: McpServer, names: Set<string>, register: () => void): void {
  const registerTool = server.registerTool;
  server.registerTool = ((...args: unknown[]) => {
    names.add(args[0] as string);
    return (registerTool as (...a: unknown[]) => unknown).apply(server, args);
  }) as typeof registerTool;
  try {
    register();
  } finally {
    server.registerTool = registerTool;
  }
}

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
      {
        instructions: INSTRUCTIONS,
        cacheHints: { 'tools/list': LIST_CACHE, 'resources/list': LIST_CACHE, 'resources/templates/list': LIST_CACHE, 'prompts/list': LIST_CACHE },
        debouncedNotificationMethods: ['notifications/tools/list_changed', 'notifications/resources/list_changed'],
      },
    );
    const reserved = new Set<string>();
    recordToolNames(server, reserved, () => {
      registerCoreTools(server, session, cfg, catalog);
      registerAppTools(server, session, loader, catalog, gate, reserved);
    });
    const unsubscribeTools = registerGeneratedTools(server, catalog, gate, session, loader, reserved);
    const unsubscribeResources = catalog.subscribe(() => server.sendResourceListChanged());

    const guided = () => catalog.apps().filter((a) => a.guide && guideUri(a));
    server.registerResource(
      'app-guide',
      new ResourceTemplate(GUIDE_URI_TEMPLATE, {
        list: async () => ({
          resources: [...new Map(guided().map((a) => [guideUri(a)!, a])).entries()].map(([uri, a]) => ({
            uri,
            name: `${a.name ?? a.package} guide`,
            mimeType: 'text/markdown',
          })),
        }),
      }),
      { mimeType: 'text/markdown', cacheHint: GUIDE_CACHE },
      async (uri, { package: pkg, version }) => {
        const app = guided().find((a) => a.package === pkg && a.version === version);
        if (!app) throw new ResourceNotFoundError(uri.href);
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: app.guide! }] };
      },
    );

    server.server.onclose = () => {
      unsubscribeTools();
      unsubscribeResources();
    };
    return server;
  };
}
