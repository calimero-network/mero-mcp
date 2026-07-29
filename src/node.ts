import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MeroJs, type TokenStore, type TokenData } from '@calimero-network/mero-js';
import type { Config, Handoff } from './config.ts';
import { resolveNode, readHandoff } from './config.ts';

export type AuthMode = 'handoff' | 'token' | 'credentials' | 'none';

export interface NodeSession {
  url: string;
  nodeName: string;
  authMode: AuthMode;
  mero: MeroJs;
}

/** Per-node token cache so multiple configured nodes don't clobber each other's file. */
export class FileTokenStore implements TokenStore {
  readonly path: string;

  constructor(stateDir: string, nodeUrl: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const hash = createHash('sha256').update(nodeUrl).digest('hex').slice(0, 16);
    this.path = join(stateDir, `tokens-${hash}.json`);
  }

  getTokens(): TokenData | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as TokenData;
    } catch {
      console.error(`[mero-mcp] ${this.path} is not valid JSON; ignoring it.`);
      return null;
    }
  }

  setTokens(data: TokenData): void {
    writeFileSync(this.path, JSON.stringify(data), { mode: 0o600 });
  }

  clear(): void {
    try {
      unlinkSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

export function pickAuthMode(cfg: Config, handoff: Handoff | null): AuthMode {
  if (handoff?.accessToken) return 'handoff';
  if (cfg.authToken) return 'token';
  if (cfg.username && cfg.password) return 'credentials';
  return 'none';
}

export async function createSession(cfg: Config): Promise<NodeSession> {
  const node = await resolveNode(cfg);
  const handoff = readHandoff(cfg);
  const authMode = pickAuthMode(cfg, handoff);
  const store = new FileTokenStore(cfg.stateDir, node.url);

  const mero = new MeroJs({
    baseUrl: node.url,
    tokenStore: store,
    ...(authMode === 'credentials' ? { credentials: { username: cfg.username!, password: cfg.password! } } : {}),
  });

  // Adopt an injected pair only when the store has nothing newer: the store holds
  // rotations this process already performed, and replaying a consumed refresh
  // token trips the server's family revocation.
  if (!store.getTokens()) {
    if (authMode === 'handoff') {
      mero.setTokenData({ access_token: handoff!.accessToken, refresh_token: handoff!.refreshToken ?? '', expires_at: 0 });
    } else if (authMode === 'token') {
      mero.setTokenData({ access_token: cfg.authToken!, refresh_token: cfg.refreshToken ?? '', expires_at: 0 });
    }
  }
  if (authMode === 'credentials' && !mero.isAuthenticated()) await mero.authenticate();

  return { url: node.url, nodeName: node.name, authMode, mero };
}
