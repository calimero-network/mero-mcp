import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileTokenStore, pickAuthMode } from './node.ts';
import { loadConfig } from './config.ts';

const withDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-tok-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('FileTokenStore round-trips a token pair', () => {
  withDir((dir) => {
    const store = new FileTokenStore(dir, 'http://localhost:2528');
    store.setTokens({ access_token: 'a', refresh_token: 'r', expires_at: 123 });
    assert.deepEqual(store.getTokens(), { access_token: 'a', refresh_token: 'r', expires_at: 123 });
  });
});

test('FileTokenStore writes the token file 0600', () => {
  withDir((dir) => {
    const store = new FileTokenStore(dir, 'http://localhost:2528');
    store.setTokens({ access_token: 'a', refresh_token: 'r', expires_at: 1 });
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
  });
});

test('FileTokenStore.clear removes the file and returns null after', () => {
  withDir((dir) => {
    const store = new FileTokenStore(dir, 'http://localhost:2528');
    store.setTokens({ access_token: 'a', refresh_token: 'r', expires_at: 1 });
    store.clear();
    assert.equal(existsSync(store.path), false);
    assert.equal(store.getTokens(), null);
  });
});

test('FileTokenStore returns null when nothing was ever stored', () => {
  withDir((dir) => assert.equal(new FileTokenStore(dir, 'http://x').getTokens(), null));
});

test('FileTokenStore.setTokens leaves no .tmp file behind after a successful write', () => {
  withDir((dir) => {
    const store = new FileTokenStore(dir, 'http://localhost:2528');
    store.setTokens({ access_token: 'a', refresh_token: 'r', expires_at: 1 });
    assert.equal(existsSync(`${store.path}.tmp`), false);
  });
});

test('FileTokenStore.setTokens still writes the final file 0600', () => {
  withDir((dir) => {
    const store = new FileTokenStore(dir, 'http://localhost:2528');
    store.setTokens({ access_token: 'a', refresh_token: 'r', expires_at: 1 });
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
  });
});

test('FileTokenStore.getTokens returns null and does not throw on invalid JSON', () => {
  withDir((dir) => {
    const store = new FileTokenStore(dir, 'http://localhost:2528');
    writeFileSync(store.path, 'not json', { mode: 0o600 });
    assert.equal(store.getTokens(), null);
  });
});

test('pickAuthMode prefers the handoff file over env token and credentials', () => {
  const cfg = loadConfig({ HOME: '/x', CALIMERO_AUTH_TOKEN: 't', CALIMERO_USERNAME: 'u', CALIMERO_PASSWORD: 'p' } as NodeJS.ProcessEnv);
  assert.equal(pickAuthMode(cfg, { accessToken: 'h' }), 'handoff');
});

test('pickAuthMode prefers an env token over credentials', () => {
  const cfg = loadConfig({ HOME: '/x', CALIMERO_AUTH_TOKEN: 't', CALIMERO_USERNAME: 'u', CALIMERO_PASSWORD: 'p' } as NodeJS.ProcessEnv);
  assert.equal(pickAuthMode(cfg, null), 'token');
});

test('pickAuthMode falls back to credentials, then none', () => {
  const creds = loadConfig({ HOME: '/x', CALIMERO_USERNAME: 'u', CALIMERO_PASSWORD: 'p' } as NodeJS.ProcessEnv);
  assert.equal(pickAuthMode(creds, null), 'credentials');
  assert.equal(pickAuthMode(loadConfig({ HOME: '/x' } as NodeJS.ProcessEnv), null), 'none');
});
