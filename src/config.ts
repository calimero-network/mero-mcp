import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

/** Probe order preference: the desktop app serves on 2528, merod's CLI convention is 2428. */
const PORT_PREFERENCE = [2528, 2428, 2529, 2429];
const ALL_TOOLSETS = ['core', 'blobs', 'governance'];

export interface Config {
  nodeUrl?: string;
  nodeName?: string;
  nodeHome: string;
  authToken?: string;
  refreshToken?: string;
  username?: string;
  password?: string;
  stateDir: string;
  toolsets: Set<string>;
}

const trimmed = (v?: string) => v?.trim() || undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || homedir();
  const requested = trimmed(env.CALIMERO_MCP_TOOLSETS);
  const toolsets = new Set(
    requested && requested !== 'all' ? requested.split(',').map((s) => s.trim()).filter(Boolean) : ALL_TOOLSETS,
  );
  toolsets.add('core');

  const password = trimmed(env.CALIMERO_PASSWORD)
    ?? (trimmed(env.CALIMERO_PASSWORD_FILE) ? readFileSync(env.CALIMERO_PASSWORD_FILE!.trim(), 'utf8').trim() : undefined);

  return {
    nodeUrl: trimmed(env.CALIMERO_NODE_URL)?.replace(/\/+$/, ''),
    nodeName: trimmed(env.CALIMERO_NODE_NAME),
    nodeHome: trimmed(env.CALIMERO_NODE_HOME) ?? join(home, '.calimero'),
    authToken: trimmed(env.CALIMERO_AUTH_TOKEN),
    refreshToken: trimmed(env.CALIMERO_REFRESH_TOKEN),
    username: trimmed(env.CALIMERO_USERNAME),
    password,
    stateDir: trimmed(env.CALIMERO_MCP_STATE_DIR) ?? join(home, '.config', 'calimero', 'mcp'),
    toolsets,
  };
}

export function preferredNodeUrl(urls: string[]): string | undefined {
  for (const port of PORT_PREFERENCE) {
    const match = urls.find((u) => u.endsWith(`:${port}`));
    if (match) return match;
  }
  return urls[0];
}

/** Reads `[server] listen` out of a node's config.toml and returns its base URL. */
export function nodeUrlFromConfigToml(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  const server = text.split(/^\[/m).find((s) => s.startsWith('server]'));
  const port = server?.match(/\/ip4\/127\.0\.0\.1\/tcp\/(\d+)/)?.[1];
  return port ? `http://localhost:${port}` : undefined;
}

export function listConfiguredNodes(cfg: Config): Array<{ name: string; url?: string }> {
  if (!existsSync(cfg.nodeHome)) return [];
  return readdirSync(cfg.nodeHome, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, url: nodeUrlFromConfigToml(join(cfg.nodeHome, e.name, 'config.toml')) }))
    .filter((n) => n.url !== undefined);
}

// Local until mero-js publishes discoverLocalNodes (calimero-network/mero-js#77).
export async function discoverLocalNodes(): Promise<string[]> {
  const results = await Promise.allSettled(
    PORT_PREFERENCE.map(async (port) => {
      const url = `http://localhost:${port}`;
      const res = await fetch(`${url}/admin-api/health`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`unhealthy: ${res.status}`);
      return url;
    }),
  );
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

export interface DiscoveredNode {
  name: string;
  url: string;
  source: 'env' | 'handoff' | 'named' | 'config-scan' | 'probe';
}

export interface Handoff { nodeUrl?: string; accessToken: string; refreshToken?: string }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Returns the origin to name in a rejection, or null when the url is a loopback node. Origin only: the rest of the url can carry a token. */
function nonLoopbackOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'an unparseable url';
  }
  const scheme = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  if (scheme && LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  // A non-special scheme has no origin of its own, and there the scheme is the whole story.
  return parsed.origin === 'null' ? parsed.protocol : parsed.origin;
}

/** The desktop app's "Connect AI agent" output. Absent or malformed is not an error - the next auth rung applies. */
export function readHandoff(cfg: Config): Handoff | null {
  const path = join(cfg.stateDir, 'agent.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Handoff>;
    if (!parsed.accessToken) {
      console.error(`[mero-mcp] ${path} has no accessToken; ignoring it.`);
      return null;
    }
    // Only the local desktop app writes this file, so a remote origin means someone else did - which makes
    // its token untrustworthy too, not just its url. Set CALIMERO_NODE_URL to reach a remote node.
    const origin = parsed.nodeUrl === undefined ? null : nonLoopbackOrigin(parsed.nodeUrl);
    if (origin) {
      console.error(`[mero-mcp] ${path} points at ${origin}, which is not a local node; ignoring the file.`);
      return null;
    }
    return { ...parsed, accessToken: parsed.accessToken };
  } catch {
    console.error(`[mero-mcp] ${path} is not valid JSON; ignoring it.`);
    return null;
  }
}

export async function resolveNode(cfg: Config): Promise<DiscoveredNode> {
  if (cfg.nodeUrl) return { name: cfg.nodeName ?? 'configured', url: cfg.nodeUrl, source: 'env' };

  const handoff = readHandoff(cfg);
  if (handoff?.nodeUrl) return { name: 'handoff', url: handoff.nodeUrl.replace(/\/+$/, ''), source: 'handoff' };

  const configured = listConfiguredNodes(cfg);
  if (cfg.nodeName) {
    const match = configured.find((n) => n.name === cfg.nodeName);
    if (!match) {
      throw new Error(
        `Node "${cfg.nodeName}" not found in ${cfg.nodeHome}. Available: ${configured.map((n) => n.name).join(', ') || '(none)'}`,
      );
    }
    return { name: match.name, url: match.url!, source: 'named' };
  }
  if (configured.length === 1) return { name: configured[0].name, url: configured[0].url!, source: 'config-scan' };
  if (configured.length > 1) {
    const preferred = configured.find((n) => n.name === 'default');
    if (preferred) return { name: preferred.name, url: preferred.url!, source: 'config-scan' };
    throw new Error(
      `Several nodes found in ${cfg.nodeHome}: ${configured.map((n) => `${n.name} (${n.url})`).join(', ')}. ` +
        'Set CALIMERO_NODE_NAME or CALIMERO_NODE_URL.',
    );
  }

  const live = await discoverLocalNodes();
  const url = preferredNodeUrl(live);
  if (!url) {
    throw new Error(
      `No Calimero node found. Start one in the Calimero desktop app, or set CALIMERO_NODE_URL. (Looked in ${cfg.nodeHome} and probed local ports.)`,
    );
  }
  return { name: 'discovered', url, source: 'probe' };
}
