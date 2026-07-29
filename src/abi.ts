import { parseAbiManifest, type AbiManifest } from '@calimero-network/abi-codegen';
import type { NodeSession } from './node.ts';

const UPGRADE_MEROD =
  "This node's merod does not support the ABI endpoint (GET /admin-api/applications/:id/abi). " +
  'Upgrade merod to a release that includes it.';

export interface ResolvedApp {
  id: string;
  manifest: AbiManifest;
  serviceName?: string;
  blobId: string;
}

// mero-js ships its admin and http-client types behind extensionless directory
// barrels, which NodeNext will not resolve, so `mero.admin` reaches us as `any`.
// These describe the fields we actually read until the SDK's .d.ts files resolve.
interface InstalledApp {
  id: string;
  package?: string;
  blob: { bytecode: string };
}
interface HttpErrorLike {
  status: number;
  bodyText?: string;
}

const isHttpError = (err: unknown): err is Error & HttpErrorLike =>
  err instanceof Error && typeof (err as Partial<HttpErrorLike>).status === 'number';

/** Core answers every handled failure with `{"error": "..."}`; a route it never registered has no body. */
function nodeMessage(bodyText?: string): string | undefined {
  if (!bodyText) return undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown } | null;
    return typeof parsed?.error === 'string' && parsed.error ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Core's own 4xx messages already name the fix (rebuild the app, pass service_name);
 * only a bodyless 404 means the route itself is missing.
 */
function abiError(err: unknown): unknown {
  if (!isHttpError(err)) return err;
  const message = nodeMessage(err.bodyText);
  if (message) return new Error(message, { cause: err });
  return err.status === 404 ? new Error(UPGRADE_MEROD, { cause: err }) : err;
}

export function createAbiLoader(session: NodeSession) {
  const cache = new Map<string, AbiManifest>();

  async function resolveAppId(nameOrId: string): Promise<{ id: string; blobId: string }> {
    const { apps } = (await session.mero.admin.listApplications()) as { apps: InstalledApp[] };
    const app = apps.find((a) => a.id === nameOrId || a.package === nameOrId);
    if (!app) {
      const installed = apps.map((a) => a.package || a.id).join(', ') || '(none)';
      throw new Error(`Application "${nameOrId}" not found. Installed: ${installed}`);
    }
    return { id: app.id, blobId: app.blob.bytecode };
  }

  return {
    resolveAppId,

    async load(nameOrId: string, serviceName?: string): Promise<ResolvedApp> {
      // Blob ids are content-addressed, so an upgraded app resolves to a new key.
      const { id, blobId } = await resolveAppId(nameOrId);
      const key = `${blobId}:${serviceName ?? ''}`;

      const cached = cache.get(key);
      if (cached) return { id, manifest: cached, serviceName, blobId };

      let raw: unknown;
      try {
        raw = await session.mero.admin.getApplicationAbi(id, serviceName);
      } catch (err) {
        throw abiError(err);
      }

      // Cached only past every failure mode, so one bad fetch can't wedge the app.
      const manifest = parseAbiManifest(raw);
      cache.set(key, manifest);
      return { id, manifest, serviceName, blobId };
    },
  };
}

export type AbiLoader = ReturnType<typeof createAbiLoader>;
