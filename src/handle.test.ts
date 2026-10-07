import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guideHash, handleKeeper, loadHandleKey } from './handle.ts';

const PAYLOAD = { a: 'BlocksAppId', p: 'com.example.blocks', v: '1.2.0', g: guideHash('## Overview'), c: 'Ctx111', s: null };

test('a handle reads back as the payload it was issued with', () => {
  const keeper = handleKeeper(randomBytes(32));
  assert.deepEqual(keeper.read(keeper.issue(PAYLOAD)), PAYLOAD);
});

test('a handle with an edited payload, an edited mac, another key, or no dot is not read', () => {
  const keeper = handleKeeper(randomBytes(32));
  const handle = keeper.issue(PAYLOAD);
  const [body, mac] = handle.split('.');
  const forged = `${Buffer.from(JSON.stringify({ ...PAYLOAD, c: 'Ctx999' })).toString('base64url')}.${mac}`;
  assert.equal(keeper.read(forged), undefined);
  const flipped = Buffer.from(mac, 'base64url');
  flipped[0] ^= 1;
  assert.equal(keeper.read(`${body}.${flipped.toString('base64url')}`), undefined);
  assert.equal(handleKeeper(randomBytes(32)).read(handle), undefined);
  assert.equal(keeper.read(handle.replace('.', '')), undefined);
  assert.equal(keeper.read(`${handle}.x`), undefined);
  assert.equal(keeper.read(undefined), undefined);
  assert.equal(keeper.read(42), undefined);
});

function withStateDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-handle-key-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the handle key is created once, owner-only, and reused by the next process', () => {
  withStateDir((dir) => {
    const first = loadHandleKey(join(dir, 'state'));
    assert.equal(first.length, 32);
    assert.equal(statSync(join(dir, 'state', 'handle.key')).mode & 0o777, 0o600);
    const handle = handleKeeper(first).issue(PAYLOAD);
    assert.deepEqual(handleKeeper(loadHandleKey(join(dir, 'state'))).read(handle), PAYLOAD);
  });
});

test('a handle key file of the wrong length is replaced, and the replacement is kept', () => {
  withStateDir((dir) => {
    writeFileSync(join(dir, 'handle.key'), 'short');
    const key = loadHandleKey(dir);
    assert.equal(key.length, 32);
    assert.deepEqual(readFileSync(join(dir, 'handle.key')), key);
    assert.deepEqual(loadHandleKey(dir), key);
  });
});

test('a state dir that cannot hold the key still yields a usable key', () => {
  withStateDir((dir) => {
    const blocked = join(dir, 'not-a-dir');
    writeFileSync(blocked, '');
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));
    try {
      assert.equal(loadHandleKey(blocked).length, 32);
    } finally {
      console.error = original;
    }
    assert.match(errors.join('\n'), /handles will not survive a restart/);
  });
});
