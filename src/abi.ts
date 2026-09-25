import { parseAbiManifest, type AbiManifest } from '@calimero-network/abi-codegen';
import { isHttpError, nodeMessage } from './errors.ts';
import { guideOf, metadataField } from './guide.ts';
import type { NodeSession } from './node.ts';

const UPGRADE_MEROD =
  "This node's merod does not support the ABI endpoint (GET /admin-api/applications/:id/abi). " +
  'Upgrade merod to a release that includes it.';

export interface ResolvedApp {
  id: string;
  package?: string;
  version?: string;
  /** metadata.name from the bundle, the human name of the app. */
  name?: string;
  icon?: string;
  signerId?: string;
  guide?: string;
  manifest: AbiManifest;
  serviceName?: string;
  /** A one-service bundle's service, which core runs for a context created without a service name. */
  soleService?: string;
  blobId: string;
}

/** No installed app answers to the name or id asked for. */
export class AppNotFoundError extends Error {}

// Numeric, so 1.10.0 sorts after 1.9.0 and two installed versions of one package never fall back to node order.
const byVersion = (a: { version?: string }, b: { version?: string }) =>
  (a.version ?? '').localeCompare(b.version ?? '', undefined, { numeric: true });

/** Packages are reverse-DNS dotted; the trailing segment is the name people type and tool names are built from. */
export const lastSegment = (name: string) => name.split('.').pop() || name;

// mero-js ships its admin types behind extensionless directory barrels, which NodeNext
// will not resolve, so `mero.admin` reaches us as `any`; these are the fields we read.
interface InstalledApp {
  id: string;
  package?: string;
  version?: string;
  blob: { bytecode: string };
  metadata: number[];
  signer_id?: string;
  services?: Record<string, unknown>;
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

  async function installed(): Promise<InstalledApp[]> {
    try {
      return ((await session.mero.admin.listApplications()) as { apps: InstalledApp[] }).apps;
    } catch (err) {
      throw abiError(err);
    }
  }

  /** Every installed version of the one package `nameOrId` names, newest first. */
  async function versionsOf(nameOrId: string): Promise<InstalledApp[]> {
    const apps = await installed();
    const byId = apps.filter((a) => a.id === nameOrId);
    const byPackage = apps.filter((a) => a.package === nameOrId);
    // Whole segments only, never a prefix: "mero-chat" must not resolve to "mero-chat-v2".
    const matches = byId.length
      ? byId
      : byPackage.length
        ? byPackage
        : apps.filter((a) => a.package && lastSegment(a.package).toLowerCase() === nameOrId.toLowerCase());

    const packages = [...new Set(matches.map((a) => a.package))];
    if (packages.length > 1) {
      const listed = packages.join(', ');
      throw new Error(`Application "${nameOrId}" is ambiguous: ${listed}. Pass the full package name or the application id.`);
    }
    if (!matches.length) {
      const listed = apps.map((a) => a.package || a.id).join(', ') || '(none)';
      throw new AppNotFoundError(`Application "${nameOrId}" not found. Installed: ${listed}`);
    }
    return matches.sort((a, b) => byVersion(b, a));
  }

  const findApp = async (nameOrId: string) => (await versionsOf(nameOrId))[0];

  async function manifestFor(app: InstalledApp, blobId: string, serviceName?: string): Promise<AbiManifest> {
    // Blob ids are content-addressed, so an upgraded app resolves to a new key.
    const key = `${blobId}:${serviceName ?? ''}`;
    const cached = cache.get(key);
    if (cached) return cached;
    let raw: unknown;
    try {
      raw = await session.mero.admin.getApplicationAbi(app.id, serviceName);
    } catch (err) {
      throw abiError(err);
    }
    // Cached only past every failure mode, so one bad fetch can't wedge the app.
    const manifest = parseAbiManifest(raw);
    cache.set(key, manifest);
    return manifest;
  }

  async function resolve(app: InstalledApp, requested?: string): Promise<ResolvedApp> {
    const blobId = app.blob.bytecode;
    const services = Object.keys(app.services ?? {});
    const soleService = services.length === 1 ? services[0] : undefined;
    const serviceName = requested ?? soleService;
    return {
      id: app.id,
      package: app.package,
      version: app.version,
      name: metadataField(app.metadata, 'name'),
      icon: metadataField(app.metadata, 'icon'),
      signerId: app.signer_id,
      guide: guideOf(app.metadata),
      serviceName,
      soleService,
      blobId,
      manifest: await manifestFor(app, blobId, serviceName),
    };
  }

  return {
    async resolveAppId(nameOrId: string): Promise<{ id: string; package?: string; blobId: string }> {
      const app = await findApp(nameOrId);
      return { id: app.id, package: app.package, blobId: app.blob.bytecode };
    },

    async versionsOf(nameOrId: string): Promise<Array<{ id: string; version?: string }>> {
      return (await versionsOf(nameOrId)).map((a) => ({ id: a.id, version: a.version }));
    },

    async load(nameOrId: string, serviceName?: string): Promise<ResolvedApp> {
      return resolve(await findApp(nameOrId), serviceName);
    },

    /** Every installed app, one entry per service, skipping (and reporting) any whose ABI cannot be read. */
    async loadAll(): Promise<ResolvedApp[]> {
      const units = (await installed()).flatMap((app) =>
        (app.services ? Object.keys(app.services).sort() : [undefined]).map((service) => ({ app, service })),
      );
      const loaded = await Promise.all(
        units.map(({ app, service }) =>
          resolve(app, service).catch((err: unknown) => {
            console.error(`[mero-mcp] skipping ${app.package ?? app.id}${service ? `/${service}` : ''}: ${String(err)}`);
            return undefined;
          }),
        ),
      );
      const code = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
      const compare = (a: ResolvedApp, b: ResolvedApp): number => {
        const pkg = code(a.package ?? a.id, b.package ?? b.id);
        if (pkg !== 0) return pkg;
        const version = byVersion(a, b);
        if (version !== 0) return version;
        const service = code(a.serviceName ?? '', b.serviceName ?? '');
        return service !== 0 ? service : code(a.id, b.id);
      };
      return loaded.filter((a): a is ResolvedApp => a !== undefined).sort(compare);
    },
  };
}

export type AbiLoader = ReturnType<typeof createAbiLoader>;
