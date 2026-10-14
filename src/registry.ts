/**
 * Read-only client for an app registry's public bundle listing (calimero-network/app-registry).
 *
 * The node installs from its own `[registry] base_url` but serves no way to browse it, so this
 * reads the registry directly. `GET /api/v2/bundles` returns the latest unyanked bundle of every
 * package; `?package=…&all_versions=true` returns every version of one, newest first, with `yanked`.
 * The registry has no search parameter, so matching happens here.
 */

const TIMEOUT_MS = 10_000;
const DESCRIPTION_MAX = 200; // keeps a search row small

/** The fields of a registry bundle manifest this module reads. */
interface Bundle {
  package?: unknown;
  appVersion?: unknown;
  minRuntimeVersion?: unknown;
  downloads?: unknown;
  verified?: unknown;
  yanked?: unknown;
  metadata?: { name?: unknown; description?: unknown; author?: unknown; tags?: unknown } | null;
}

export interface RegistryApp {
  /** What install_application takes. */
  coords: string;
  package: string;
  version: string;
  name: string;
  description?: string;
  author?: string;
  tags: string[];
  downloads: number;
  verified: boolean;
  minRuntimeVersion?: string;
}

export interface RegistryVersion {
  version: string;
  coords: string;
  yanked: boolean;
}

export interface Registry {
  url: string;
  /** Latest version of every package matching all of `query`'s words, most downloaded first. */
  search(query?: string): Promise<RegistryApp[]>;
  /** Every published version of one package, newest first, as the registry orders them. */
  versions(pkg: string): Promise<RegistryVersion[]>;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function toApp(bundle: Bundle): RegistryApp | undefined {
  const pkg = str(bundle.package);
  const version = str(bundle.appVersion);
  if (!pkg || !version) return undefined;
  const meta = bundle.metadata ?? {};
  const description = str(meta.description);
  return {
    coords: `${pkg}@${version}`,
    package: pkg,
    version,
    name: str(meta.name) ?? pkg,
    description: description && description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX)}…` : description,
    author: str(meta.author),
    tags: Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === 'string') : [],
    downloads: typeof bundle.downloads === 'number' ? bundle.downloads : 0,
    verified: bundle.verified === true,
    minRuntimeVersion: str(bundle.minRuntimeVersion),
  };
}

/** Every word must appear in the package, name, description, author or a tag; matching ignores case. */
export function matches(app: RegistryApp, query: string): boolean {
  const haystack = [app.package, app.name, app.description, app.author, ...app.tags].filter(Boolean).join('\n').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

export function createRegistry(baseUrl: string, fetchFn: typeof fetch = (...args) => fetch(...args)): Registry {
  const url = baseUrl.replace(/\/+$/, '');

  async function bundles(params: Record<string, string>): Promise<Bundle[]> {
    const target = new URL('/api/v2/bundles', url);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchFn(target, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`Could not reach the app registry at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`The app registry at ${url} answered ${res.status} for ${target.pathname}${target.search}.`);
    const body: unknown = await res.json();
    return Array.isArray(body) ? (body as Bundle[]) : [];
  }

  return {
    url,
    async search(query) {
      const apps = (await bundles({})).map(toApp).filter((a): a is RegistryApp => a !== undefined);
      const hits = query?.trim() ? apps.filter((a) => matches(a, query)) : apps;
      return hits.sort((a, b) => b.downloads - a.downloads || a.package.localeCompare(b.package));
    },
    async versions(pkg) {
      const seen = new Set<string>();
      const out: RegistryVersion[] = [];
      for (const bundle of await bundles({ package: pkg, all_versions: 'true' })) {
        const version = str(bundle.appVersion);
        // One entry per platform can repeat a version.
        if (!version || str(bundle.package)?.toLowerCase() !== pkg.toLowerCase() || seen.has(version)) continue;
        seen.add(version);
        out.push({ version, coords: `${pkg}@${version}`, yanked: bundle.yanked === true });
      }
      return out;
    },
  };
}
