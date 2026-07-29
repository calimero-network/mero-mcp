import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  preferredNodeUrl,
  nodeUrlFromConfigToml,
  listConfiguredNodes,
  discoverLocalNodes,
  readHandoff,
  resolveNode,
} from './config.ts';

/** A node home dir with one config.toml per {name, port} entry. */
function nodeHome(...nodes: Array<{ name: string; port: number }>): string {
  const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
  for (const { name, port } of nodes) {
    mkdirSync(join(home, name));
    writeFileSync(join(home, name, 'config.toml'), `[server]\nlisten = ["/ip4/127.0.0.1/tcp/${port}"]\n`);
  }
  return home;
}

function withHandoff(stateDir: string, handoff: Record<string, unknown>): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'agent.json'), JSON.stringify(handoff));
}

test('loadConfig defaults nodeHome to ~/.calimero and toolsets to all', () => {
  const cfg = loadConfig({ HOME: '/home/x' } as NodeJS.ProcessEnv);
  assert.equal(cfg.nodeHome, '/home/x/.calimero');
  assert.ok(cfg.toolsets.has('core'));
  assert.ok(cfg.toolsets.has('governance'));
});

test('loadConfig parses an explicit toolset list and always keeps core', () => {
  const cfg = loadConfig({ HOME: '/home/x', CALIMERO_MCP_TOOLSETS: 'blobs' } as NodeJS.ProcessEnv);
  assert.ok(cfg.toolsets.has('core'));
  assert.ok(cfg.toolsets.has('blobs'));
  assert.ok(!cfg.toolsets.has('governance'));
});

test('loadConfig trims empty env values to undefined', () => {
  const cfg = loadConfig({ HOME: '/home/x', CALIMERO_NODE_URL: '  ' } as NodeJS.ProcessEnv);
  assert.equal(cfg.nodeUrl, undefined);
});

test('loadConfig strips a trailing slash from the node url', () => {
  const cfg = loadConfig({ HOME: '/home/x', CALIMERO_NODE_URL: 'http://localhost:2528/' } as NodeJS.ProcessEnv);
  assert.equal(cfg.nodeUrl, 'http://localhost:2528');
});

test('preferredNodeUrl picks 2528 over 2428 when both answered', () => {
  const got = preferredNodeUrl(['http://localhost:2428', 'http://localhost:2528']);
  assert.equal(got, 'http://localhost:2528');
});

test('preferredNodeUrl falls back to the first url when no preferred port is present', () => {
  assert.equal(preferredNodeUrl(['http://localhost:9999']), 'http://localhost:9999');
});

test('preferredNodeUrl returns undefined for an empty list', () => {
  assert.equal(preferredNodeUrl([]), undefined);
});

test('nodeUrlFromConfigToml reads the server port, not the swarm port', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  try {
    writeFileSync(join(dir, 'config.toml'),
      '[swarm]\nlisten = ["/ip4/127.0.0.1/tcp/2428"]\n\n[server]\nlisten = ["/ip4/127.0.0.1/tcp/2528"]\n');
    assert.equal(nodeUrlFromConfigToml(join(dir, 'config.toml')), 'http://localhost:2528');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listConfiguredNodes finds each node directory that has a config.toml', () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
  try {
    mkdirSync(join(home, 'default'));
    writeFileSync(join(home, 'default', 'config.toml'), '[server]\nlisten = ["/ip4/127.0.0.1/tcp/2528"]\n');
    mkdirSync(join(home, 'not-a-node'));
    const nodes = listConfiguredNodes(loadConfig({ HOME: '/x', CALIMERO_NODE_HOME: home } as NodeJS.ProcessEnv));
    assert.deepEqual(nodes, [{ name: 'default', url: 'http://localhost:2528' }]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('discoverLocalNodes returns only the ports that answer healthy, and ignores rejections', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(':2528/')) return new Response(null, { status: 200 });
      if (url.includes(':2428/')) return Promise.reject(new Error('ECONNREFUSED'));
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const live = await discoverLocalNodes();
    assert.deepEqual(live, ['http://localhost:2528']);
  } finally {
    globalThis.fetch = original;
  }
});

test('readHandoff returns null when agent.json does not exist', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  try {
    const cfg = loadConfig({ HOME: '/x', CALIMERO_MCP_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
    assert.equal(readHandoff(cfg), null);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('readHandoff returns the parsed object for a valid file', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  try {
    withHandoff(stateDir, { nodeUrl: 'http://localhost:2528', accessToken: 'tok', refreshToken: 'ref' });
    const cfg = loadConfig({ HOME: '/x', CALIMERO_MCP_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
    assert.deepEqual(readHandoff(cfg), { nodeUrl: 'http://localhost:2528', accessToken: 'tok', refreshToken: 'ref' });
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('readHandoff returns null and does not throw on malformed JSON', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  const originalError = console.error;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'agent.json'), '{ not json');
    console.error = () => {};
    const cfg = loadConfig({ HOME: '/x', CALIMERO_MCP_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
    assert.doesNotThrow(() => readHandoff(cfg));
    assert.equal(readHandoff(cfg), null);
  } finally {
    console.error = originalError;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('readHandoff returns null for valid JSON that has no accessToken', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  const originalError = console.error;
  try {
    console.error = () => {};
    withHandoff(stateDir, { nodeUrl: 'http://localhost:2528' });
    const cfg = loadConfig({ HOME: '/x', CALIMERO_MCP_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
    assert.equal(readHandoff(cfg), null);
  } finally {
    console.error = originalError;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('resolveNode: CALIMERO_NODE_URL wins over a handoff file and configured nodes', async () => {
  const home = nodeHome({ name: 'alpha', port: 2528 });
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  try {
    withHandoff(stateDir, { nodeUrl: 'http://localhost:9999', accessToken: 'tok' });
    const cfg = loadConfig({
      HOME: '/x',
      CALIMERO_NODE_HOME: home,
      CALIMERO_MCP_STATE_DIR: stateDir,
      CALIMERO_NODE_URL: 'http://localhost:7777/',
    } as NodeJS.ProcessEnv);
    const node = await resolveNode(cfg);
    assert.equal(node.url, 'http://localhost:7777');
    assert.equal(node.source, 'env');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('resolveNode: handoff file nodeUrl used when there is no env url', async () => {
  const home = nodeHome({ name: 'alpha', port: 2528 });
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  try {
    withHandoff(stateDir, { nodeUrl: 'http://localhost:8888/', accessToken: 'tok' });
    const cfg = loadConfig({
      HOME: '/x',
      CALIMERO_NODE_HOME: home,
      CALIMERO_MCP_STATE_DIR: stateDir,
    } as NodeJS.ProcessEnv);
    const node = await resolveNode(cfg);
    assert.equal(node.url, 'http://localhost:8888');
    assert.equal(node.source, 'handoff');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('resolveNode: CALIMERO_NODE_NAME selects that node directory', async () => {
  const home = nodeHome({ name: 'alpha', port: 2528 }, { name: 'beta', port: 2429 });
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  try {
    const cfg = loadConfig({
      HOME: '/x',
      CALIMERO_NODE_HOME: home,
      CALIMERO_MCP_STATE_DIR: stateDir,
      CALIMERO_NODE_NAME: 'beta',
    } as NodeJS.ProcessEnv);
    const node = await resolveNode(cfg);
    assert.equal(node.url, 'http://localhost:2429');
    assert.equal(node.source, 'named');
    assert.equal(node.name, 'beta');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('resolveNode: a CALIMERO_NODE_NAME that does not exist throws, listing the available names', async () => {
  const home = nodeHome({ name: 'alpha', port: 2528 }, { name: 'beta', port: 2429 });
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  try {
    const cfg = loadConfig({
      HOME: '/x',
      CALIMERO_NODE_HOME: home,
      CALIMERO_MCP_STATE_DIR: stateDir,
      CALIMERO_NODE_NAME: 'ghost',
    } as NodeJS.ProcessEnv);
    await assert.rejects(resolveNode(cfg), (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /alpha/);
      assert.match(msg, /beta/);
      return true;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('resolveNode: exactly one configured node is used without any env var', async () => {
  const home = nodeHome({ name: 'solo', port: 2528 });
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  try {
    const cfg = loadConfig({
      HOME: '/x',
      CALIMERO_NODE_HOME: home,
      CALIMERO_MCP_STATE_DIR: stateDir,
    } as NodeJS.ProcessEnv);
    const node = await resolveNode(cfg);
    assert.equal(node.url, 'http://localhost:2528');
    assert.equal(node.source, 'config-scan');
    assert.equal(node.name, 'solo');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('resolveNode: several configured nodes with one named "default" picks it', async () => {
  const home = nodeHome({ name: 'default', port: 2528 }, { name: 'other', port: 2429 });
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  try {
    const cfg = loadConfig({
      HOME: '/x',
      CALIMERO_NODE_HOME: home,
      CALIMERO_MCP_STATE_DIR: stateDir,
    } as NodeJS.ProcessEnv);
    const node = await resolveNode(cfg);
    assert.equal(node.url, 'http://localhost:2528');
    assert.equal(node.source, 'config-scan');
    assert.equal(node.name, 'default');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('resolveNode: several configured nodes with none named "default" throws, naming both env vars and each node', async () => {
  const home = nodeHome({ name: 'alpha', port: 2528 }, { name: 'beta', port: 2429 });
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  try {
    const cfg = loadConfig({
      HOME: '/x',
      CALIMERO_NODE_HOME: home,
      CALIMERO_MCP_STATE_DIR: stateDir,
    } as NodeJS.ProcessEnv);
    await assert.rejects(resolveNode(cfg), (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /CALIMERO_NODE_NAME/);
      assert.match(msg, /CALIMERO_NODE_URL/);
      assert.match(msg, /alpha/);
      assert.match(msg, /beta/);
      return true;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('resolveNode: zero configured nodes and no live node throws, naming CALIMERO_NODE_URL', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    const cfg = loadConfig({
      HOME: '/x',
      CALIMERO_NODE_HOME: home,
      CALIMERO_MCP_STATE_DIR: stateDir,
    } as NodeJS.ProcessEnv);
    await assert.rejects(resolveNode(cfg), (err: unknown) => {
      assert.match((err as Error).message, /CALIMERO_NODE_URL/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
