import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GUIDE_HASH_HEX = 16;
const KEY_BYTES = 32;
const HANDLE_KEY_FILE = 'handle.key'; // beside the token files, so it is no easier to read than they are

/**
 * What an app_handle vouches for: the application (core derives its id from package and signer), package, app version,
 * guide hash, the context it targets, and that context's service.
 */
export interface HandlePayload {
  a: string;
  p: string;
  v: string;
  g: string;
  c: string | null;
  s: string | null;
}

/** The first GUIDE_HASH_HEX hex of sha256 over the guide text, or over "" for an app that ships none. */
export const guideHash = (guide: string | undefined): string =>
  createHash('sha256').update(guide ?? '').digest('hex').slice(0, GUIDE_HASH_HEX);

export type HandleKeeper = ReturnType<typeof handleKeeper>;

export function handleKeeper(key: Buffer) {
  const mac = (json: Buffer) => createHmac('sha256', key).update(json).digest();
  return {
    issue(payload: HandlePayload): string {
      const json = Buffer.from(JSON.stringify(payload), 'utf8');
      return `${json.toString('base64url')}.${mac(json).toString('base64url')}`;
    },
    /** The payload of a handle this keeper minted, or undefined for anything else. */
    read(handle: unknown): HandlePayload | undefined {
      if (typeof handle !== 'string') return undefined;
      const parts = handle.split('.');
      if (parts.length !== 2) return undefined;
      const json = Buffer.from(parts[0], 'base64url');
      const given = Buffer.from(parts[1], 'base64url');
      const expected = mac(json);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
      return JSON.parse(json.toString('utf8')) as HandlePayload;
    },
  };
}

/** The key on disk, or null when there is none or it is not a key. */
function readKey(path: string): Buffer | null {
  try {
    const key = readFileSync(path);
    return key.length === KEY_BYTES ? key : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Exclusive create, so two processes starting together agree; a malformed file is replaced whole. */
function writeKey(path: string): void {
  try {
    writeFileSync(path, randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600 });
    renameSync(tmp, path);
  }
}

/**
 * The handle key kept in the state dir, so handles survive a server restart (an agent harness reconnecting).
 * A handle grants no access of its own; only the node credential beside this file does.
 */
export function loadHandleKey(stateDir: string): Buffer {
  const path = join(stateDir, HANDLE_KEY_FILE);
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const held = readKey(path);
    if (held) return held;
    writeKey(path);
    const written = readKey(path);
    if (!written) throw new Error(`${path} was replaced mid-write`);
    return written;
  } catch (err) {
    console.error(`[mero-mcp] cannot keep a handle key in ${stateDir}, so handles will not survive a restart: ${String(err)}`);
    return randomBytes(KEY_BYTES);
  }
}

// A per-process key for callers that bring none; the server process passes the persisted one.
export const handles = handleKeeper(randomBytes(KEY_BYTES));
