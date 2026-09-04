import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as meroJs from '@calimero-network/mero-js';
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
  'delete_context',
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
interface ToolConfig {
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

function fakeServer() {
  const tools = new Map<string, FakeHandler>();
  const configs = new Map<string, ToolConfig>();
  const server = {
    registerTool: (name: string, config: ToolConfig, handler: FakeHandler) => {
      tools.set(name, handler);
      configs.set(name, config);
    },
  } as unknown as McpServer;
  return { server, tools, configs };
}

type FakeAdmin = Record<string, (...args: never[]) => unknown>;

function fakeSession(admin: FakeAdmin = {}, over: Partial<NodeSession> = {}) {
  return { url: 'http://localhost:2528', nodeName: 'test', authMode: 'none', mero: { admin }, ...over } as unknown as NodeSession;
}

const env = (over: Record<string, string> = {}) => ({ HOME: '/x', ...over }) as NodeJS.ProcessEnv;

/** Registers the core tools on a real server so the SDK's own input validation and JSON Schema conversion run. */
async function realServer(admin: FakeAdmin, over: Record<string, string> = {}) {
  const server = new McpServer({ name: 'core-test', version: '0.0.0' });
  registerCoreTools(server, fakeSession(admin), loadConfig(env(over)));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'core-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

const textOf = (result: { content: Array<{ type: 'text'; text: string }> }) => result.content[0].text;

const jsonOf = (result: { content: Array<{ type: 'text'; text: string }> }) => JSON.parse(textOf(result)) as Record<string, unknown>;

/** One installed app, shaped the way the ABI resolver reads it. */
const listApplications = async () => ({
  apps: [{ id: 'AppId111', package: 'network.calimero.kv-store', blob: { bytecode: 'Blob111' } }],
});

// HTTPError is absent from mero-js's resolvable types but real at runtime, and it is what
// every rejected admin call throws, so use the genuine class rather than a stand-in.
type HttpErrorCtor = new (status: number, statusText: string, url: string, headers: Headers, bodyText?: string) => Error;
const { HTTPError } = meroJs as unknown as { HTTPError: HttpErrorCtor };

/** `{"error": ...}` is what core's ApiError serializes to for every handled failure. */
const httpError = (status: number, message: string) =>
  new HTTPError(status, 'Bad Request', 'http://localhost:2528/admin-api/dev/contexts', new Headers(), JSON.stringify({ error: message }));

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

const utf8Bytes = (s: string) => [...Buffer.from(s, 'utf8')];

test('list_applications decodes metadata for display: JSON object, plain string, dropped non-UTF-8 bytes, and an absent empty array', async () => {
  const admin = {
    listApplications: async () => ({
      apps: [
        { id: 'AppId1', package: 'pkg-json', version: '0.1.0', metadata: utf8Bytes(JSON.stringify({ name: 'kv-store' })) },
        { id: 'AppId2', package: 'pkg-text', version: '0.1.0', metadata: utf8Bytes('plain text') },
        { id: 'AppId3', package: 'pkg-binary', version: '0.1.0', metadata: [0xff, 0xfe] },
        { id: 'AppId4', package: 'pkg-empty', version: '0.1.0', metadata: [] },
      ],
    }),
  };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));
  const { apps } = jsonOf(await tools.get('list_applications')!({})) as unknown as { apps: Array<Record<string, unknown>> };

  assert.deepEqual(apps[0].metadata, { name: 'kv-store' });
  assert.equal(apps[1].metadata, 'plain text');
  assert.equal('metadata' in apps[2], false, 'non-UTF-8 metadata is not readable, so it is dropped rather than dumped');
  assert.equal('metadata' in apps[3], false, 'an empty metadata array carries nothing worth showing');
});

test('list_contexts renders dagHeads as hex, keeping every head a multi-head context carries', async () => {
  const admin = {
    getContexts: async () => ({
      contexts: [
        {
          id: 'Ctx111',
          applicationId: 'AppId111',
          contextStateHash: 'a'.repeat(64),
          dagHeads: [
            [1, 2, 3],
            [255, 0, 128],
          ],
        },
      ],
    }),
  };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));
  const { contexts } = jsonOf(await tools.get('list_contexts')!({})) as unknown as { contexts: Array<{ dagHeads: string[] }> };
  assert.deepEqual(contexts[0].dagHeads, ['010203', 'ff0080']);
});

// The exact object invite_to_namespace hands back: core's wire keys are snake_case, and it carries
// two fields (application_id, app_key) no camelCase mirror of the type mentions.
const INVITATION = {
  invitation: {
    inviter_identity: [1, 2, 3],
    group_id: [4, 5, 6],
    expiration_timestamp: 1893456000,
    secret_salt: [7, 8, 9],
    invited_role: 1,
    application_id: '2TvLMYGVCFhXdxnRv5LLaRU6st8nmkxY425VpqUrKdCz',
    app_key: 'ab'.repeat(32),
  },
  inviter_signature: 'ed25519:2mQ8',
};

test('join_namespace takes the invitation invite_to_namespace returns and reaches the SDK byte-identical', async () => {
  let seen: [string, { invitation: unknown; groupName?: string }] | undefined;
  const admin = {
    joinNamespace: async (namespaceId: string, request: { invitation: unknown; groupName?: string }) => {
      seen = [namespaceId, request];
      return { groupId: 'Group111', memberIdentity: 'Member111', governanceOp: 'op1' };
    },
  };
  const { client, close } = await realServer(admin);
  try {
    // Through a real client, so the SDK's own input validation runs - this is where the camelCase schema rejected it.
    const result = await client.callTool({ name: 'join_namespace', arguments: { namespace: 'Ns111', invitation: INVITATION } });
    assert.notEqual(result.isError, true, textOf(result as never));
    assert.ok(seen, 'joinNamespace was never called');
    assert.equal(seen[0], 'Ns111');
    // Byte-identical: deepEqual would pass with reordered keys, and a signature is over bytes.
    assert.equal(JSON.stringify(seen[1].invitation), JSON.stringify(INVITATION));
  } finally {
    await close();
  }
});

test('join_namespace advertises the invitation as an open object, declaring none of its fields', async () => {
  const { client, close } = await realServer({});
  try {
    const { tools } = await client.listTools();
    const join = tools.find((t) => t.name === 'join_namespace');
    assert.ok(join, 'join_namespace is not registered');
    const schema = join.inputSchema as { properties: Record<string, { type?: string; properties?: unknown }>; required?: string[] };
    assert.deepEqual(Object.keys(schema.properties).sort(), ['groupName', 'invitation', 'namespace']);
    assert.equal(schema.properties.invitation.type, 'object');
    assert.equal(schema.properties.invitation.properties, undefined, 'the signed invitation must not have its fields declared');
    assert.deepEqual([...(schema.required ?? [])].sort(), ['invitation', 'namespace']);
  } finally {
    await close();
  }
});

test('delete_context is destructive and deletes by id', async () => {
  const calls: unknown[][] = [];
  const admin = {
    deleteContext: async (contextId: string) => {
      calls.push([contextId]);
      return { isDeleted: true };
    },
  };
  const { server, tools, configs } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));
  assert.equal(configs.get('delete_context')?.annotations?.destructiveHint, true);

  const handler = tools.get('delete_context')!;
  assert.match(textOf(await handler({ context: 'Ctx111' })), /"isDeleted": true/);
  assert.deepEqual(calls, [['Ctx111']]);
});

test('install_application splits package@version, and rejects a coordinate missing either half', async () => {
  const calls: unknown[][] = [];
  const admin = {
    installApplication: async (request: Record<string, unknown>) => {
      calls.push([request]);
      return { applicationId: 'AppId111' };
    },
  };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));

  const handler = tools.get('install_application')!;
  assert.match(textOf(await handler({ coords: 'network.calimero.kv-store@1.0.0' })), /"applicationId": "AppId111"/);
  assert.deepEqual(calls, [[{ package: 'network.calimero.kv-store', version: '1.0.0' }]]);

  const bad = await handler({ coords: 'network.calimero.kv-store' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Expected package@version/);
});

test('create_namespace and create_context resolve an application the way describe_app does', async () => {
  const created: Array<Record<string, unknown>> = [];
  const admin = {
    listApplications,
    createNamespace: async (request: Record<string, unknown>) => {
      created.push(request);
      return { namespaceId: 'Ns111' };
    },
    createContext: async (request: Record<string, unknown>) => {
      created.push(request);
      return { contextId: 'Ctx111', memberPublicKey: 'Member111' };
    },
  };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));

  // The package tail, the full package name, and the raw id all name the same application.
  await tools.get('create_namespace')!({ application: 'kv-store' });
  await tools.get('create_namespace')!({ application: 'network.calimero.kv-store' });
  await tools.get('create_context')!({ application: 'AppId111', namespace: 'Ns111' });
  assert.deepEqual(created, [
    { applicationId: 'AppId111', name: undefined },
    { applicationId: 'AppId111', name: undefined },
    { applicationId: 'AppId111', groupId: 'Ns111', name: undefined, serviceName: undefined },
  ]);

  const missing = await tools.get('create_namespace')!({ application: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /Application "nope" not found\. Installed: network\.calimero\.kv-store/);
});

test('create_alias confirms what it created instead of answering null', async () => {
  const admin = { createContextAlias: async () => null };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));
  assert.equal(textOf(await tools.get('create_alias')!({ alias: 'chat', contextId: 'Ctx111' })), 'Alias "chat" now resolves to context Ctx111.');
});

test('lookup_alias names the context on a hit and says so on a miss, without calling the miss an error', async () => {
  // Core answers a miss with a null value, which on its own is indistinguishable from a failed call.
  const admin = { lookupContextAlias: async (name: string) => ({ value: name === 'chat' ? 'Ctx111' : null }) };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));

  const hit = await tools.get('lookup_alias')!({ name: 'chat' });
  assert.deepEqual(jsonOf(hit), { alias: 'chat', contextId: 'Ctx111' });

  const miss = await tools.get('lookup_alias')!({ name: 'ghost' });
  assert.equal(miss.isError, undefined, 'a lookup miss is an answer, not a failure');
  assert.equal(textOf(miss), 'No alias named "ghost" on this node.');
});

test('leave_namespace and add_group_members report what they did rather than returning null', async () => {
  const admin = { leaveNamespace: async () => undefined, addGroupMembers: async () => undefined };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));

  assert.equal(textOf(await tools.get('leave_namespace')!({ namespace: 'Ns111' })), 'Left namespace Ns111.');
  const added = await tools.get('add_group_members')!({
    group: 'Group111',
    members: [{ identity: 'Member111', role: 'member' }, { identity: 'Member222', role: 'admin' }],
  });
  assert.equal(textOf(added), 'Added Member111 (member), Member222 (admin) to group Group111.');
});

test('node_status reports the node name the session carries, and the discovery source as its own field', async () => {
  const admin = { healthCheck: async () => ({ status: 'alive' }) };
  // An explicit url keeps resolveNode off the network; its source is a source, never the name.
  const cfg = env({ CALIMERO_NODE_URL: 'http://localhost:2528', CALIMERO_NODE_NAME: 'default' });
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin, { nodeName: 'default' }), loadConfig(cfg));
  const named = jsonOf(await tools.get('node_status')!({}));
  assert.equal(named.nodeName, 'default');
  assert.equal(named.discoverySource, 'env');

  // Nothing named this node: an explicit null, not the label for how it was found.
  const { server: server2, tools: tools2 } = fakeServer();
  registerCoreTools(server2, fakeSession(admin, { nodeName: undefined }), loadConfig(env({ CALIMERO_NODE_URL: 'http://localhost:2528' })));
  const nameless = jsonOf(await tools2.get('node_status')!({}));
  assert.equal(nameless.nodeName, null);
  assert.equal(nameless.discoverySource, 'env');
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

test("a rejected admin call reaches the tool result as the node's own message, not its status line", async () => {
  const noNamespace = 'namespace Ns111 is not on this node';
  const needsService = 'application has multiple services; pass service_name (available: api, worker)';
  const admin = {
    listApplications,
    createNamespace: async () => {
      throw httpError(400, noNamespace);
    },
    createContext: async () => {
      throw httpError(400, needsService);
    },
  };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env()));

  const namespaced = await tools.get('create_namespace')!({ application: 'kv-store' });
  assert.equal(namespaced.isError, true);
  assert.equal(textOf(namespaced), `Error: ${noNamespace}`);

  const contexted = await tools.get('create_context')!({ application: 'kv-store', namespace: 'Ns111' });
  assert.equal(contexted.isError, true);
  assert.equal(textOf(contexted), `Error: ${needsService}`);
});

test('a bodyless rejection still names the endpoint and the status, and an unreachable node says so', async () => {
  const admin = {
    listBlobs: async () => {
      throw new HTTPError(500, 'Internal Server Error', 'http://localhost:2528/admin-api/dev/blobs', new Headers());
    },
    healthCheck: async () => {
      throw new HTTPError(0, 'Network Error', 'http://localhost:2528/admin-api/health', new Headers(), 'fetch failed');
    },
  };
  const { server, tools } = fakeServer();
  registerCoreTools(server, fakeSession(admin), loadConfig(env({ CALIMERO_NODE_URL: 'http://localhost:2528' })));

  const bodyless = await tools.get('list_blobs')!({});
  assert.equal(bodyless.isError, true);
  assert.equal(
    textOf(bodyless),
    'Error: HTTP 500 Internal Server Error from http://localhost:2528/admin-api/dev/blobs - the node returned no message',
  );

  const unreachable = await tools.get('node_status')!({});
  assert.equal(unreachable.isError, true);
  assert.equal(textOf(unreachable), 'Error: Cannot reach the node at http://localhost:2528/admin-api/health: fetch failed');
});
