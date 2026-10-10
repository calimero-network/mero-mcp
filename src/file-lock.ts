import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * A lock file next to a token store, held around a token refresh so two processes sharing the
 * store (mero-mcp and mero-bot, say) never spend the same single-use refresh token: the second
 * waits, then finds the bundle the first rotated. mero-bot takes the same lock on the same file
 * (`<tokens file>.lock`, holding the owner's pid): change both or neither.
 *
 * A lock whose owner has died, or that is older than `staleMs`, is broken: a crashed holder must
 * not lock everyone out of the node.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  { staleMs = 30_000, pollMs = 50 }: { staleMs?: number; pollMs?: number } = {},
): Promise<T> {
  const lock = `${path}.lock`;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (isStale(lock, staleMs)) {
      try {
        unlinkSync(lock);
      } catch {
        // someone else broke it first
      }
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already broken as stale
    }
  }
}

function isStale(lock: string, staleMs: number): boolean {
  try {
    if (Date.now() - statSync(lock).mtimeMs > staleMs) return true;
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return false; // mid-write: give it a moment
    process.kill(pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false; // released meanwhile: just retry
    return code === 'ESRCH'; // its owner is gone; EPERM means alive, under another user
  }
}
