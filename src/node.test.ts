import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileTokenStore, createSession, isNewerCredential, pickAuthMode } from './node.ts';
import { loadConfig, readHandoff, resolveNode } from './config.ts';

/** A token shaped like the node's: only the payload is ever read. */
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const at = (iat: number) => jwt({ sub: 'client', iat, exp: iat + 3600 });

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

test('FileTokenStore.getTokens returns null and does not throw on invalid JSON', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  withDir((dir) => {
    const store = new FileTokenStore(dir, 'http://localhost:2528');
    writeFileSync(store.path, 'not json', { mode: 0o600 });
    assert.equal(store.getTokens(), null);
    assert.equal(logged.mock.callCount(), 1);
  });
});

test('FileTokenStore gives two usernames on one node two different files', () => {
  withDir((dir) => {
    const alice = new FileTokenStore(dir, 'http://localhost:2528', 'alice');
    const bob = new FileTokenStore(dir, 'http://localhost:2528', 'bob');
    assert.notEqual(alice.path, bob.path);
    assert.match(alice.path, /tokens-[0-9a-f]{16}\.json$/);
    assert.equal(new FileTokenStore(dir, 'http://localhost:2528', 'alice').path, alice.path);

    alice.setTokens({ access_token: 'a', refresh_token: 'r', expires_at: 1 });
    assert.equal(bob.getTokens(), null, "bob must not inherit alice's session");
  });
});

test('a handoff rejected for its origin never reaches pickAuthMode', () => {
  withDir((dir) => {
    const originalError = console.error;
    try {
      console.error = () => {};
      writeFileSync(join(dir, 'agent.json'), JSON.stringify({ nodeUrl: 'http://evil.example.com', accessToken: 'h' }));
      const cfg = loadConfig({
        HOME: '/x',
        CALIMERO_MCP_STATE_DIR: dir,
        CALIMERO_USERNAME: 'u',
        CALIMERO_PASSWORD: 'p',
      } as NodeJS.ProcessEnv);
      // Both createSession and resolveNode read the file; neither may report or inject the rejected token.
      assert.equal(readHandoff(cfg), null);
      assert.equal(pickAuthMode(cfg, readHandoff(cfg)), 'credentials');
    } finally {
      console.error = originalError;
    }
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

const stored = (access: string) => ({ access_token: access, refresh_token: 'r', expires_at: 0 });

test('isNewerCredential adopts an injected token issued after the stored one', () => {
  assert.equal(isNewerCredential(at(2000), stored(at(1000))), true);
});

test('isNewerCredential keeps a store this process rotated past the injected token', () => {
  assert.equal(isNewerCredential(at(1000), stored(at(2000))), false);
});

test('isNewerCredential keeps the store when both were issued in the same second', () => {
  assert.equal(isNewerCredential(at(1000), stored(at(1000))), false);
});

test('isNewerCredential adopts whenever the store is empty', () => {
  assert.equal(isNewerCredential(at(1000), null), true);
  assert.equal(isNewerCredential('opaque', null), true);
});

test('isNewerCredential keeps the store when either side has no readable iat', () => {
  // Undecidable must not adopt: a replayed refresh token revokes the whole family.
  assert.equal(isNewerCredential('opaque', stored(at(1000))), false);
  assert.equal(isNewerCredential(at(2000), stored('opaque')), false);
  assert.equal(isNewerCredential(jwt({ sub: 'c' }), stored(at(1000))), false);
  assert.equal(isNewerCredential(at(2000), stored(jwt({ iat: '2000' }))), false);
  assert.equal(isNewerCredential(at(2000), stored('h.!!!not-base64!!!.s')), false);
});

const sessionCfg = (dir: string) =>
  loadConfig({ HOME: '/x', CALIMERO_MCP_STATE_DIR: dir, CALIMERO_NODE_URL: 'http://localhost:2528' } as NodeJS.ProcessEnv);

test('createSession adopts a handoff minted after the cached token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-tok-'));
  try {
    const store = new FileTokenStore(dir, 'http://localhost:2528');
    store.setTokens(stored(at(1000)));
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ accessToken: at(2000), refreshToken: 'fresh' }));
    await createSession(sessionCfg(dir));
    assert.deepEqual(store.getTokens()?.refresh_token, 'fresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A node home holding one node directory, named `name`, whose config.toml listens on `port`. */
function nodeHome(dir: string, name: string, port: number): string {
  const home = join(dir, 'calimero');
  mkdirSync(join(home, name), { recursive: true });
  writeFileSync(join(home, name, 'config.toml'), `[server]\nlisten = ["/ip4/127.0.0.1/tcp/${port}"]\n`);
  return home;
}

test('a node found through the handoff reports its own name, not the label for how it was found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-name-'));
  try {
    const home = nodeHome(dir, 'default', 2528);
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ nodeUrl: 'http://localhost:2528', accessToken: at(1000) }));
    const cfg = loadConfig({ HOME: '/x', CALIMERO_MCP_STATE_DIR: dir, CALIMERO_NODE_HOME: home } as NodeJS.ProcessEnv);

    // The discovery source is still 'handoff' - that fact is reported separately, and only the name changes.
    assert.equal((await resolveNode(cfg)).source, 'handoff');
    const session = await createSession(cfg);
    assert.equal(session.authMode, 'handoff');
    assert.equal(session.nodeName, 'default', 'node_status would report the source label while list_nodes reports "default"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a node nothing ever named has no name rather than a made-up one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-name-'));
  try {
    const cfg = loadConfig({
      HOME: '/x',
      CALIMERO_MCP_STATE_DIR: dir,
      CALIMERO_NODE_HOME: nodeHome(dir, 'default', 2528),
      CALIMERO_NODE_URL: 'http://localhost:9999',
    } as NodeJS.ProcessEnv);
    assert.equal((await createSession(cfg)).nodeName, undefined);

    const named = loadConfig({ HOME: '/x', CALIMERO_MCP_STATE_DIR: dir, CALIMERO_NODE_URL: 'http://localhost:9999', CALIMERO_NODE_NAME: 'remote' } as NodeJS.ProcessEnv);
    assert.equal((await createSession(named)).nodeName, 'remote');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createSession keeps a cached token rotated past the handoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-tok-'));
  try {
    const store = new FileTokenStore(dir, 'http://localhost:2528');
    store.setTokens(stored(at(2000)));
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ accessToken: at(1000), refreshToken: 'consumed' }));
    await createSession(sessionCfg(dir));
    assert.deepEqual(store.getTokens(), stored(at(2000)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
