import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from '../config.ts';
import type { NodeSession } from '../node.ts';
import { registerCoreTools } from './core.ts';

const CORE = [
  'node_status',
  'list_nodes',
  'list_applications',
  'list_namespaces',
  'list_contexts',
  'create_context',
  'create_alias',
  'lookup_alias',
];
const BLOBS = ['install_application', 'uninstall_application', 'upload_blob', 'list_blobs', 'delete_blob'];
const GOVERNANCE = [
  'create_namespace',
  'delete_namespace',
  'invite_to_namespace',
  'join_namespace',
  'leave_namespace',
  'list_group_members',
  'add_group_members',
];

type FakeHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;

function fakeServer() {
  const tools = new Map<string, FakeHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: FakeHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

function fakeSession(admin: Record<string, (...args: never[]) => unknown> = {}) {
  return { url: 'http://localhost:2528', nodeName: 'test', authMode: 'none', mero: { admin } } as unknown as NodeSession;
}

const env = (over: Record<string, string> = {}) => ({ HOME: '/x', ...over }) as NodeJS.ProcessEnv;

test('default toolsets register core, blobs, and governance tools', () => {
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(), loadConfig(env()));
  for (const name of [...CORE, ...BLOBS, ...GOVERNANCE]) assert.ok(tools.has(name), `${name} not registered`);
  assert.equal(tools.size, CORE.length + BLOBS.length + GOVERNANCE.length);
});

test('CALIMERO_MCP_TOOLSETS=core registers only the core group, and core registers even when the toolset set omits it', () => {
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(), loadConfig(env({ CALIMERO_MCP_TOOLSETS: 'core' })));
  for (const name of CORE) assert.ok(tools.has(name), `${name} not registered`);
  for (const name of [...BLOBS, ...GOVERNANCE]) assert.equal(tools.has(name), false, `${name} should not be registered`);

  // A hand-built Config whose toolsets Set never mentions 'core' at all - registerCoreTools
  // must not gate the core group behind cfg.toolsets.has('core').
  const bare = { ...loadConfig(env()), toolsets: new Set(['blobs']) };
  const { server: server2, tools: tools2 } = fakeServer();
  registerCoreTools(server2, fakeSession(), bare);
  for (const name of CORE) assert.ok(tools2.has(name), `${name} not registered`);
  assert.equal(tools2.has('install_application'), true);
  assert.equal(tools2.has('create_namespace'), false);
});

test('list_contexts calls getContextsForApplication when given an application, else getContexts', async () => {
  const calls: string[] = [];
  const admin = {
    getContexts: async () => {
      calls.push('getContexts');
      return { contexts: [] };
    },
    getContextsForApplication: async (id: string) => {
      calls.push(`getContextsForApplication:${id}`);
      return { contexts: [] };
    },
  };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));
  const handler = tools.get('list_contexts')!;
  await handler({});
  await handler({ application: 'app1' });
  assert.deepEqual(calls, ['getContexts', 'getContextsForApplication:app1']);
});

test('a throwing admin call yields isError: true carrying the message', async () => {
  const admin = {
    listApplications: async () => {
      throw new Error('boom');
    },
  };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));
  const result = await tools.get('list_applications')!({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom/);
});
