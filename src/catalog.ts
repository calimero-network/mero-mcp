import { lastSegment, type AbiLoader, type ResolvedApp } from './abi.ts';
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
  let queue: Promise<void> = Promise.resolve();

  async function refresh(): Promise<void> {
    const next = await loader.loadAll();
    // Armed by the first sync that reached the node, so startup and an absent node cost no polling.
    timer ??= setInterval(
      () => sync().catch((err: unknown) => console.error('[mero-mcp] app list refresh failed:', err)),
      WATCH_INTERVAL_MS,
    ).unref();
    const nextPrint = fingerprint(next);
    if (nextPrint === print) return;
    apps = next;
    print = nextPrint;
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[mero-mcp] app list listener failed:', err);
      }
    }
  }

  /** One sync at a time, so a slow older read can never land after, and over, a newer one. */
  function sync(): Promise<void> {
    const run = queue.then(refresh);
    queue = run.catch(() => {});
    return run;
  }

  /** The cached units of the one app `nameOrId` names, by the loader's tiers; empty when it is unknown or ambiguous. */
  function match(nameOrId: string): ResolvedApp[] {
    const lower = nameOrId.toLowerCase();
    const tiers = [
      (a: ResolvedApp) => a.id === nameOrId,
      (a: ResolvedApp) => a.package === nameOrId,
      (a: ResolvedApp) => (a.package && lastSegment(a.package).toLowerCase() === lower) || a.name?.toLowerCase() === lower,
    ];
    const matches = tiers.map((tier) => apps.filter(tier)).find((m) => m.length) ?? [];
    return new Set(matches.map((a) => a.id)).size === 1 ? matches : [];
  }

  /** The cached app and service `nameOrId` names, else undefined so the caller falls back to the loader and its errors. */
  function find(nameOrId: string, service?: string): ResolvedApp | undefined {
    const units = match(nameOrId).filter((a) => service === undefined || a.serviceName === service);
    return units.length === 1 ? units[0] : undefined;
  }

  /** The app `nameOrId` names, whichever of its services is cached. */
  const identify = (nameOrId: string): ResolvedApp | undefined => match(nameOrId)[0];

  return {
    apps: () => apps,
    find,
    identify,
    sync,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
