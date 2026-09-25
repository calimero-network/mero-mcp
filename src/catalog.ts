import type { AbiLoader, ResolvedApp } from './abi.ts';
import { guideHash } from './handle.ts';

// Matches the tools/list ttlMs, so a client that caches a list for its full lifetime is never staler than a poll.
export const WATCH_INTERVAL_MS = 30_000;

const fingerprint = (apps: readonly ResolvedApp[]) =>
  apps.map((a) => [a.id, a.blobId, a.version, a.serviceName, guideHash(a.guide)].join(':')).join('\n');

/**
 * The installed apps every list is built from. Server-global, so no list varies by connection;
 * listeners fire only when an app is installed, upgraded or uninstalled.
 */
export function createCatalog(loader: AbiLoader) {
  let apps: readonly ResolvedApp[] = [];
  let print = '';
  let timer: NodeJS.Timeout | undefined;
  const listeners = new Set<() => void>();

  async function sync(): Promise<void> {
    const next = await loader.loadAll();
    // Armed by the first sync that reached the node, so startup and an absent node cost no polling.
    timer ??= setInterval(() => sync().catch((err: unknown) => console.error('[mero-mcp] app list refresh failed:', err)), WATCH_INTERVAL_MS).unref();
    const nextPrint = fingerprint(next);
    if (nextPrint === print) return;
    apps = next;
    print = nextPrint;
    for (const listener of listeners) listener();
  }

  return {
    apps: () => apps,
    sync,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
