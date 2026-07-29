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
} from './config.ts';

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
