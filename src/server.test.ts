import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';
import { createServerFactory } from './server.ts';
import { connect, ERAS, type Era } from '../test/support/connect.ts';
import { ctx, fakeNode, manifest, method, type FakeApp } from '../test/support/node.ts';

const CFG = loadConfig({ HOME: '/x' } as NodeJS.ProcessEnv);
const INSTRUCTIONS =
  'Calimero apps describe themselves. Do not read app source. ' +
  'To use an app: list_applications, then describe_app to plan or select_app to act, ' +
  'then pass the returned app_handle on every app tool call.';

const guided = (version = '1.0.0'): FakeApp => ({
  id: 'kv-id',
  package: 'com.calimero.kv-store',
  version,
  signer_id: 'SignerKey1',
  metadata: { name: 'KV Store', guide: '## Overview\nkv' },
  abi: manifest([method('set', [{ name: 'key', type: { kind: 'string' } }])]),
  contexts: [ctx('kvctx')],
});

for (const era of Object.keys(ERAS) as Era[]) {
  test(`${era}: the client negotiates its own era and sees the instructions and the same tools`, async () => {
    const { client, close } = await connect(createServerFactory(fakeNode([guided()]).session, CFG), era);
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), era);
      assert.equal(client.getInstructions(), INSTRUCTIONS);
      assert.ok((await client.listTools()).tools.some((t) => t.name === 'kv_store_set'));
    } finally {
      await close();
    }
  });

  test(`${era}: the guide is a resource template, listed per installed version and readable, and an unknown guide is -32602`, async () => {
    const { client, close } = await connect(createServerFactory(fakeNode([guided()]).session, CFG), era);
    try {
      const { resourceTemplates } = await client.listResourceTemplates();
      assert.deepEqual(resourceTemplates.map((t) => [t.uriTemplate, t.mimeType]), [['calimero://apps/{package}/{version}/guide', 'text/markdown']]);
      const { resources } = await client.listResources();
      assert.deepEqual(resources.map((r) => r.uri), ['calimero://apps/com.calimero.kv-store/1.0.0/guide']);
      const read = await client.readResource({ uri: 'calimero://apps/com.calimero.kv-store/1.0.0/guide' });
      assert.equal((read.contents[0] as { text: string }).text, '## Overview\nkv');
      await assert.rejects(client.readResource({ uri: 'calimero://apps/com.calimero.kv-store/9.9.9/guide' }), (err: { code?: number }) => err.code === -32602);
    } finally {
      await close();
    }
  });
}

test('guide resources are one per package version: a multi-service app lists once, two versions list side by side', async () => {
  const drive: FakeApp = {
    id: 'drive-id',
    package: 'com.calimero.mero-drive',
    version: '2.0.0',
    metadata: { name: 'Mero Drive', guide: '## Overview\ndrive' },
    abi: undefined,
    services: { docs: manifest([method('create_doc')]), registry: manifest([method('register_folder')]) },
  };
  const newer = { ...guided('1.1.0'), id: 'kv-two', metadata: { name: 'KV Store', guide: '## Overview\nkv two' } };
  const { client, close } = await connect(createServerFactory(fakeNode([guided(), newer, drive]).session, CFG));
  try {
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri), [
      'calimero://apps/com.calimero.kv-store/1.0.0/guide',
      'calimero://apps/com.calimero.kv-store/1.1.0/guide',
      'calimero://apps/com.calimero.mero-drive/2.0.0/guide',
    ]);
    const read = await client.readResource({ uri: 'calimero://apps/com.calimero.kv-store/1.1.0/guide' });
    assert.equal((read.contents[0] as { text: string }).text, '## Overview\nkv two');
  } finally {
    await close();
  }
});

test('both eras list wire-identical tool, resource and resource-template definitions', async () => {
  const listedIn = async (era: Era) => {
    const { client, close } = await connect(createServerFactory(fakeNode([guided()]).session, CFG), era);
    try {
      return {
        tools: (await client.listTools()).tools,
        resources: (await client.listResources()).resources,
        resourceTemplates: (await client.listResourceTemplates()).resourceTemplates,
      };
    } finally {
      await close();
    }
  };
  const [modern, legacy] = await Promise.all([listedIn('2026-07-28'), listedIn('2025-11-25')]);
  // JSON-normalize: legacy Tool carries an `execution: undefined` key the 2026 anchor type deleted, which JSON drops on both sides.
  assert.deepEqual(JSON.parse(JSON.stringify(modern)), JSON.parse(JSON.stringify(legacy)));
});

test('2026-07-28: lists carry ttlMs 30000 and a guide read carries 86400000, both private', async () => {
  const { client, close } = await connect(createServerFactory(fakeNode([guided()]).session, CFG), '2026-07-28');
  try {
    const tools = (await client.listTools()) as { ttlMs?: number; cacheScope?: string };
    assert.deepEqual([tools.ttlMs, tools.cacheScope], [30000, 'private']);
    const resources = (await client.listResources()) as { ttlMs?: number; cacheScope?: string };
    assert.deepEqual([resources.ttlMs, resources.cacheScope], [30000, 'private']);
    const read = (await client.readResource({ uri: 'calimero://apps/com.calimero.kv-store/1.0.0/guide' })) as { ttlMs?: number; cacheScope?: string };
    assert.deepEqual([read.ttlMs, read.cacheScope], [86400000, 'private']);
  } finally {
    await close();
  }
});

test('a node that is down at connect still serves the fixed tools, and says so on stderr', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const node = fakeNode([]);
  (node.session.mero.admin as unknown as { listApplications: () => Promise<never> }).listApplications = async () => {
    throw new Error('connection refused');
  };
  const { client, close } = await connect(createServerFactory(node.session, CFG));
  try {
    assert.ok((await client.listTools()).tools.some((t) => t.name === 'select_app'));
    assert.equal(logged.mock.calls[0]?.arguments[0], '[mero-mcp] app list unavailable at connect:');
  } finally {
    await close();
  }
});

test('installing an app announces a tool and resource list change; selecting one announces nothing', async () => {
  const node = fakeNode([guided()]);
  Object.assign(node.session.mero.admin, {
    installApplication: async () => {
      node.apps.push({ ...guided(), id: 'notes-id', package: 'org.example.notes' });
      return { applicationId: 'notes-id' };
    },
  });
  const { client, close } = await connect(createServerFactory(node.session, CFG));
  const seen: string[] = [];
  const notified = (method: 'notifications/tools/list_changed' | 'notifications/resources/list_changed', label: string) =>
    new Promise<void>((resolve) => client.setNotificationHandler(method, () => (seen.push(label), resolve())));
  const toolsChanged = notified('notifications/tools/list_changed', 'tools');
  const resourcesChanged = notified('notifications/resources/list_changed', 'resources');
  try {
    await client.callTool({ name: 'select_app', arguments: { app: 'kv-store' } });
    // The transport keeps order, so once a later request answers, anything select_app sent has arrived.
    await client.listTools();
    assert.deepEqual(seen, []);

    await client.callTool({ name: 'install_application', arguments: { coords: 'org.example.notes@1.0.0' } });
    await Promise.all([toolsChanged, resourcesChanged]);
    assert.deepEqual([...new Set(seen)].sort(), ['resources', 'tools']);
    assert.ok((await client.listTools()).tools.some((t) => t.name === 'notes_set'));
  } finally {
    await close();
  }
});
