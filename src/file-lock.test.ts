import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from './file-lock.ts';

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mero-lock-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('withFileLock runs one holder at a time and removes the lock after', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'tokens.json');
    const order: string[] = [];
    const hold = (name: string) => async () => {
      order.push(`${name} in`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name} out`);
    };
    await Promise.all([withFileLock(path, hold('a'), { pollMs: 5 }), withFileLock(path, hold('b'), { pollMs: 5 })]);
    assert.deepEqual(order, ['a in', 'a out', 'b in', 'b out']);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});

test('withFileLock releases the lock when the holder throws', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'tokens.json');
    await assert.rejects(withFileLock(path, async () => { throw new Error('refresh failed'); }), /refresh failed/);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});

test('withFileLock breaks a lock whose owner is gone', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'tokens.json');
    writeFileSync(`${path}.lock`, '2147483646'); // no such process
    assert.equal(await withFileLock(path, async () => 'ran', { pollMs: 5 }), 'ran');
  });
});

test('withFileLock breaks a lock older than staleMs, even with a live owner', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'tokens.json');
    writeFileSync(`${path}.lock`, String(process.pid));
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    assert.equal(await withFileLock(path, async () => 'ran', { pollMs: 5 }), 'ran');
  });
});

test('withFileLock waits for a live owner', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'tokens.json');
    writeFileSync(`${path}.lock`, String(process.pid));
    let ran = false;
    const pending = withFileLock(path, async () => { ran = true; }, { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ran, false);
    rmSync(`${path}.lock`);
    await pending;
    assert.equal(ran, true);
  });
});
