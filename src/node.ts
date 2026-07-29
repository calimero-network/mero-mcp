import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
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

  constructor(stateDir: string, nodeUrl: string, username?: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // Identity is part of the key: switching to a lower-privilege account must not silently
    // keep running on the previous account's cached tokens.
    const hash = createHash('sha256').update(`${nodeUrl}\0${username ?? ''}`).digest('hex').slice(0, 16);
    this.path = join(stateDir, `tokens-${hash}.json`);
  }

  getTokens(): TokenData | null {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as TokenData;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      console.error(`[mero-mcp] ${this.path} is not valid JSON; ignoring it.`);
      return null;
    }
  }

  setTokens(data: TokenData): void {
    // Write-then-rename so a crash mid-write can't leave a half-written file
    // that reads as "no tokens" and triggers re-injection of a consumed token.
    const tmpPath = `${this.path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
    try {
      renameSync(tmpPath, this.path);
    } catch (err) {
      unlinkSync(tmpPath);
      throw err;
    }
  }

  clear(): void {
    try {
      unlinkSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/** JWT `iat` in seconds, or null when the token carries no readable one. */
function issuedAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iat?: unknown };
    return typeof claims.iat === 'number' ? claims.iat : null;
  } catch {
    return null;
  }
}

/**
 * Whether an injected credential is newer than the one the store holds. Revocation is
 * server-side state a JWT cannot carry, so an unexpired stored token proves nothing - only
 * a later `iat` decides. Undecidable keeps the store, since dropping rotations this process
 * performed would replay a consumed refresh token and revoke the whole family.
 */
export function isNewerCredential(injected: string, stored: TokenData | null): boolean {
  if (!stored) return true;
  const fresh = issuedAt(injected);
  const held = issuedAt(stored.access_token);
  return fresh !== null && held !== null && fresh > held;
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
  const store = new FileTokenStore(cfg.stateDir, node.url, cfg.username);

  const mero = new MeroJs({
    baseUrl: node.url,
    tokenStore: store,
    ...(authMode === 'credentials' ? { credentials: { username: cfg.username!, password: cfg.password! } } : {}),
  });

  const injected =
    authMode === 'handoff' ? { access_token: handoff!.accessToken, refresh_token: handoff!.refreshToken ?? '' }
    : authMode === 'token' ? { access_token: cfg.authToken!, refresh_token: cfg.refreshToken ?? '' }
    : null;
  if (injected && isNewerCredential(injected.access_token, store.getTokens())) {
    mero.setTokenData({ ...injected, expires_at: 0 });
  }
  if (authMode === 'credentials' && !mero.isAuthenticated()) await mero.authenticate();

  return { url: node.url, nodeName: node.name, authMode, mero };
}
