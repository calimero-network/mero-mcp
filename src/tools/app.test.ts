import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.ts';
import { handles } from '../handle.ts';
import { createServerFactory } from '../server.ts';
import { connect, type Era } from '../../test/support/connect.ts';
import { ctx, fakeNode, manifest, method, type FakeApp } from '../../test/support/node.ts';

const CFG = loadConfig({ HOME: '/x' } as NodeJS.ProcessEnv);
const GUIDE = '## Overview\nA store that explains itself.\n## Procedures\n### Save a value';

type Block = { type: string; text?: string; resource?: { uri: string; mimeType?: string; text?: string; _meta?: Record<string, unknown> } };
type ToolResult = { isError?: boolean; content: Block[]; structuredContent?: unknown };

const kv = (): FakeApp => ({
  id: 'kv-id',
  package: 'com.calimero.kv-store',
  version: '1.0.0',
  signer_id: 'SignerKey1',
  metadata: { name: 'KV Store', guide: GUIDE, icon: 'https://example.com/kv.png' },
  abi: manifest([
    method('set', [{ name: 'key', type: { kind: 'string' } }]),
    method('get', [{ name: 'key', type: { kind: 'string' } }], { intent: 'read_only', returns: { kind: 'string' }, returns_nullable: true }),
  ]),
  contexts: [ctx('kvctx')],
});

const plain = (): FakeApp => ({
  id: 'notes-id',
  package: 'org.example.notes',
  version: '0.2.0',
  signer_id: 'SignerKey2',
  metadata: { name: 'Notes', icon: 'notes.png' },
  abi: manifest([method('add', [{ name: 'body', type: { kind: 'string' } }], { returns: { $ref: 'Note' } })], {
    Note: { kind: 'record', fields: [{ name: 'id', type: { kind: 'u32' } }] },
  }),
  contexts: [ctx('notesctx')],
});

async function setup(apps: FakeApp[] = [kv(), plain()], era: Era = '2025-11-25', opts: Parameters<typeof fakeNode>[1] = {}) {
  const node = fakeNode(apps, opts);
  const { client, close } = await connect(createServerFactory(node.session, CFG), era);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<ToolResult>;
  const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await call(name, args)).content[0].text!);
  return { ...node, client, close, call, json };
}

const LABEL = "App guide, provided by the app's author (package com.calimero.kv-store, signer SignerKey1):";
const RETRY = 'Call select_app for com.calimero.kv-store and retry with the returned app_handle.';

test('describe_app returns the author-labelled guide as an embedded resource, and a handle, without registering anything', async () => {
  const s = await setup();
  try {
    const before = (await s.client.listTools()).tools.map((t) => t.name);
    const res = await s.call('describe_app', { app: 'kv-store' });
    const summary = JSON.parse(res.content[0].text!);
    assert.equal(summary.appVersion, '1.0.0');
    assert.equal(typeof summary.app_handle, 'string');
    assert.equal(res.content[1].text, LABEL);
    assert.deepEqual(res.content[2].resource, {
      uri: 'calimero://apps/com.calimero.kv-store/1.0.0/guide',
      mimeType: 'text/markdown',
      text: GUIDE,
      _meta: { package: 'com.calimero.kv-store', appVersion: '1.0.0', signerId: 'SignerKey1' },
    });
    assert.deepEqual((await s.client.listTools()).tools.map((t) => t.name), before);
  } finally {
    await s.close();
  }
});

test('describe_app on an app without a guide says so and still issues a handle', async () => {
  const s = await setup();
  try {
    const res = await s.call('describe_app', { app: 'notes' });
    assert.equal(typeof JSON.parse(res.content[0].text!).app_handle, 'string');
    assert.equal(res.content[1].text, 'This app ships no guide.');
  } finally {
    await s.close();
  }
});

test('the tool list is every method of every installed app, sorted by package then method, with no _context argument', async () => {
  const s = await setup();
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('kv_store_') || n.startsWith('notes_'));
    assert.deepEqual(names, ['kv_store_get', 'kv_store_set', 'notes_add']);
    const set = (await s.client.listTools()).tools.find((t) => t.name === 'kv_store_set')!;
    assert.deepEqual(Object.keys(set.inputSchema.properties ?? {}), ['app_handle', 'key']);
    assert.deepEqual(set.inputSchema.required, ['app_handle', 'key']);
  } finally {
    await s.close();
  }
});

test('a generated tool called without an app_handle is refused with the guide and runs nothing', async () => {
  const s = await setup();
  try {
    const res = await s.call('kv_store_set', { key: 'k' });
    assert.equal(res.isError, true);
    assert.equal(res.content[0].text, LABEL);
    assert.equal(res.content[1].resource?.text, GUIDE);
    assert.equal(res.content[2].text, RETRY);
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test('a forged handle is refused and runs nothing', async () => {
  const s = await setup();
  try {
    const { app_handle } = await s.json('select_app', { app: 'kv-store' });
    const [body] = (app_handle as string).split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const forged = `${Buffer.from(JSON.stringify({ ...payload, c: ctx('otherctx') })).toString('base64url')}.${(app_handle as string).split('.')[1]}`;
    const res = await s.call('kv_store_set', { app_handle: forged, key: 'k' });
    assert.equal(res.isError, true);
    assert.equal(res.content.at(-1)!.text, RETRY);
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test('a handle from select_app runs the call in the context it names', async () => {
  const s = await setup();
  try {
    const { app_handle, context } = await s.json('select_app', { app: 'kv-store' });
    assert.equal(context, ctx('kvctx'));
    const res = await s.call('kv_store_set', { app_handle, key: 'k' });
    assert.equal(res.isError, undefined);
    assert.deepEqual(s.executed, [{ contextId: ctx('kvctx'), method: 'set', argsJson: { key: 'k' } }]);
  } finally {
    await s.close();
  }
});

test('a handle with no context is refused with a request to select one, and runs nothing', async () => {
  const s = await setup();
  try {
    const { app_handle } = await s.json('describe_app', { app: 'kv-store' });
    const res = await s.call('kv_store_set', { app_handle, key: 'k' });
    assert.equal(res.isError, true);
    assert.deepEqual(res.content.map((b) => b.text), [
      'This app_handle names no context. Call select_app for com.calimero.kv-store with a context and retry with the returned app_handle.',
    ]);
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test('a handle goes stale when the app version, its guide, or its context changes', async () => {
  for (const change of [
    (a: FakeApp) => (a.version = '1.1.0'),
    (a: FakeApp) => (a.metadata = { ...a.metadata, guide: `${GUIDE}\n### Another` }),
    (a: FakeApp) => (a.contexts = [ctx('newctx')]),
  ]) {
    const s = await setup();
    try {
      const { app_handle } = await s.json('select_app', { app: 'kv-store' });
      change(s.apps[0]);
      const res = await s.call('kv_store_set', { app_handle, key: 'k' });
      assert.equal(res.isError, true);
      assert.equal(res.content.at(-1)!.text, RETRY);
      assert.deepEqual(s.executed, []);
    } finally {
      await s.close();
    }
  }
});

test('an app without a guide still needs a handle, and the refusal carries only the retry line', async () => {
  const s = await setup();
  try {
    const res = await s.call('notes_add', { body: 'x' });
    assert.equal(res.isError, true);
    assert.deepEqual(res.content.map((b) => b.text), ['Call select_app for org.example.notes and retry with the returned app_handle.']);
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test("a handle for one app is refused by another app's tool", async () => {
  const s = await setup();
  try {
    const { app_handle } = await s.json('select_app', { app: 'notes' });
    const res = await s.call('kv_store_set', { app_handle, key: 'k' });
    assert.equal(res.isError, true);
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test('an argument that violates the ABI is an error after the handle check, and runs nothing', async () => {
  const s = await setup();
  try {
    const { app_handle } = await s.json('select_app', { app: 'kv-store' });
    const res = await s.call('kv_store_set', { app_handle, key: 42 });
    assert.equal(res.isError, true);
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test('a failed contract call is an isError result carrying the node message, not a protocol error', async () => {
  const s = await setup([kv()], '2025-11-25', {
    execute: () => {
      throw new Error('key too long');
    },
  });
  try {
    const { app_handle } = await s.json('select_app', { app: 'kv-store' });
    const res = await s.call('kv_store_set', { app_handle, key: 'k' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text!, /key too long/);
  } finally {
    await s.close();
  }
});

test('call takes the same handle, and without one refuses with the named app guide', async () => {
  const s = await setup();
  try {
    const refused = await s.call('call', { method: 'set', args: { key: 'k' }, app: 'kv-store' });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[1].resource?.text, GUIDE);
    const bare = await s.call('call', { method: 'set', args: { key: 'k' } });
    assert.deepEqual(bare.content.map((b) => b.text), ['Call select_app for the application and retry with the returned app_handle.']);
    assert.deepEqual(s.executed, []);

    const { app_handle } = await s.json('select_app', { app: 'kv-store' });
    await s.call('call', { app_handle, method: 'set', args: { key: 'k' } });
    assert.deepEqual(s.executed, [{ contextId: ctx('kvctx'), method: 'set', argsJson: { key: 'k' } }]);
  } finally {
    await s.close();
  }
});

test('select_app resolves an alias to the context it pins in the handle', async () => {
  const apps = [{ ...kv(), contexts: [ctx('kvctx'), ctx('kvtwo')] }];
  const s = await setup(apps, '2025-11-25', { aliases: { work: ctx('kvtwo') } });
  try {
    const several = await s.json('select_app', { app: 'kv-store' });
    assert.equal(several.context, null);
    assert.equal(several.note, `Application "kv-store" has 2 contexts; pass context with one of: ${ctx('kvctx')}, ${ctx('kvtwo')}`);
    const { app_handle } = await s.json('select_app', { app: 'kv-store', context: 'work' });
    await s.call('kv_store_set', { app_handle, key: 'k' });
    assert.equal(s.executed[0].contextId, ctx('kvtwo'));
  } finally {
    await s.close();
  }
});

test('generated tools carry a title, explicit annotations, an icon only for a URL, and _meta', async () => {
  const s = await setup();
  try {
    const tools = (await s.client.listTools()).tools;
    const get = tools.find((t) => t.name === 'kv_store_get')!;
    const add = tools.find((t) => t.name === 'notes_add')!;
    assert.equal(get.title, 'Get (KV Store)');
    assert.deepEqual(get.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(add.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    assert.deepEqual(get.icons, [{ src: 'https://example.com/kv.png' }]);
    assert.equal(add.icons, undefined);
    assert.deepEqual(get._meta, { package: 'com.calimero.kv-store', appVersion: '1.0.0', signerId: 'SignerKey1', intent: 'read_only' });
  } finally {
    await s.close();
  }
});

test('a long method name is cut to 49 characters with a hash of the full name', async () => {
  const long = 'reconcile_every_pending_attachment_upload_now';
  const s = await setup([{ ...plain(), package: 'org.example.a-very-long-application-name', abi: manifest([method(long)]) }]);
  try {
    const name = (await s.client.listTools()).tools.map((t) => t.name).find((n) => n.startsWith('a_very_long'))!;
    assert.equal(name.length, 49);
    assert.match(name, /^a_very_long_applicat_reconcile_every_pendi_[0-9a-f]{6}$/);
  } finally {
    await s.close();
  }
});

for (const era of ['2025-11-25', '2026-07-28'] as const) {
  test(`${era}: outputSchema and structuredContent follow the era, wrapped in {result} only for 2025-11-25 non-object returns`, async () => {
    const s = await setup([kv(), plain()], era, { execute: (p) => (p.method === 'get' ? 'v' : { id: 7 }) });
    try {
      const tools = (await s.client.listTools()).tools;
      const get = tools.find((t) => t.name === 'kv_store_get')!;
      const add = tools.find((t) => t.name === 'notes_add')!;
      const { app_handle: kvHandle } = await s.json('select_app', { app: 'kv-store' });
      const { app_handle: notesHandle } = await s.json('select_app', { app: 'notes' });
      const got = await s.call('kv_store_get', { app_handle: kvHandle, key: 'k' });
      const added = await s.call('notes_add', { app_handle: notesHandle, body: 'x' });
      if (era === '2025-11-25') {
        assert.deepEqual(get.outputSchema, { type: 'object', properties: { result: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['result'] });
        assert.deepEqual(got.structuredContent, { result: 'v' });
      } else {
        assert.deepEqual(get.outputSchema, { anyOf: [{ type: 'string' }, { type: 'null' }] });
        assert.equal(got.structuredContent, 'v');
      }
      assert.deepEqual(added.structuredContent, { id: 7 });
      assert.equal(add.outputSchema?.type, 'object');
    } finally {
      await s.close();
    }
  });
}

test('a missing handle is refused with the guide even when the arguments are also wrong', async () => {
  const s = await setup();
  try {
    const tool = await s.call('kv_store_set', { key: 42 });
    assert.equal(tool.content.at(-1)!.text, RETRY);
    assert.equal(tool.content[1].resource?.text, GUIDE);
    const viaCall = await s.call('call', { method: 'set', args: { key: 42 }, app: 'kv-store' });
    assert.equal(viaCall.content.at(-1)!.text, RETRY);
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

const drive = (): FakeApp => ({
  id: 'drive-id',
  package: 'com.calimero.mero-drive',
  version: '2.0.0',
  signer_id: 'SignerKey3',
  metadata: { name: 'Mero Drive', guide: '## Overview\ndrive' },
  abi: undefined,
  services: {
    docs: manifest([method('create_doc', [{ name: 'title', type: { kind: 'string' } }])]),
    registry: manifest([method('register_folder', [{ name: 'name', type: { kind: 'string' } }])]),
  },
  contexts: [
    { id: ctx('docsctx'), serviceName: 'docs' },
    { id: ctx('regctx'), serviceName: 'registry' },
  ],
});

test('for a multi-service app the chosen context picks the service, the handle binds it, and each service keeps its own tools', async () => {
  const s = await setup([drive()]);
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('mero_drive'));
    assert.deepEqual(names, ['mero_drive_docs_create_doc', 'mero_drive_registry_register_folder']);

    const docs = await s.json('select_app', { app: 'mero-drive', context: ctx('docsctx') });
    assert.equal(docs.service, 'docs');
    assert.deepEqual(docs.tools, ['mero_drive_docs_create_doc']);
    await s.call('mero_drive_docs_create_doc', { app_handle: docs.app_handle, title: 't' });
    assert.deepEqual(s.executed, [{ contextId: ctx('docsctx'), method: 'create_doc', argsJson: { title: 't' } }]);

    // A docs handle is not a registry handle, even though both name the same package and version.
    const crossed = await s.call('mero_drive_registry_register_folder', { app_handle: docs.app_handle, name: 'f' });
    assert.equal(crossed.isError, true);

    const registry = await s.json('select_app', { app: 'mero-drive', context: ctx('regctx') });
    await s.call('call', { app_handle: registry.app_handle, method: 'register_folder', args: { name: 'f' } });
    assert.deepEqual(s.executed.at(-1), { contextId: ctx('regctx'), method: 'register_folder', argsJson: { name: 'f' } });
  } finally {
    await s.close();
  }
});

test("a handle's own service and its context's service are each checked, so either mismatch alone is refused", async () => {
  const s = await setup([drive()]);
  try {
    const { app_handle } = await s.json('select_app', { app: 'mero-drive', context: ctx('regctx') });
    const payload = handles.read(app_handle)!;
    for (const minted of [{ ...payload, s: 'docs' }, { ...payload, c: ctx('docsctx') }]) {
      const res = await s.call('mero_drive_registry_register_folder', { app_handle: handles.issue(minted), name: 'f' });
      assert.equal(res.content.at(-1)!.text, 'Call select_app for com.calimero.mero-drive and retry with the returned app_handle.');
    }
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test("call refuses a handle for one app when app names another, with that app's guide, and runs nothing", async () => {
  const s = await setup([kv(), plain(), drive()]);
  try {
    const notes = await s.json('select_app', { app: 'notes' });
    const crossed = await s.call('call', { app_handle: notes.app_handle, method: 'set', args: { key: 'k' }, app: 'kv-store' });
    assert.equal(crossed.isError, true);
    assert.deepEqual(crossed.content.map((b) => b.text ?? b.resource?.text), [LABEL, GUIDE, RETRY]);
    const kvHandle = (await s.json('select_app', { app: 'kv-store' })).app_handle;
    const reverse = await s.call('call', { app_handle: kvHandle, method: 'add', args: { body: 'x' }, app: 'notes' });
    assert.deepEqual(reverse.content.map((b) => b.text), ['Call select_app for org.example.notes and retry with the returned app_handle.']);
    assert.deepEqual(s.executed, []);

    await s.call('call', { app_handle: kvHandle, method: 'set', args: { key: 'k' }, app: 'kv-store' });
    const docs = await s.json('select_app', { app: 'mero-drive', context: ctx('docsctx') });
    await s.call('call', { app_handle: docs.app_handle, method: 'create_doc', args: { title: 't' }, app: 'mero-drive' });
    assert.deepEqual(s.executed, [
      { contextId: ctx('kvctx'), method: 'set', argsJson: { key: 'k' } },
      { contextId: ctx('docsctx'), method: 'create_doc', argsJson: { title: 't' } },
    ]);
  } finally {
    await s.close();
  }
});

const kvAt = (id: string, version: string, context: string, params: Array<{ name: string; type: unknown }>): FakeApp => ({
  ...kv(),
  id,
  version,
  abi: manifest([method('set', params)]),
  contexts: [ctx(context)],
});

test('two installed versions of one package keep their own tools, and a handle for one version is refused by the other', async () => {
  const key = { name: 'key', type: { kind: 'string' } };
  const s = await setup([kvAt('kv-one', '1.0.0', 'kvv1', [key]), kvAt('kv-two', '2.0.0', 'kvv2', [key, { name: 'ttl', type: { kind: 'u32' } }])]);
  try {
    const tools = (await s.client.listTools()).tools;
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
    assert.deepEqual(
      tools.filter((t) => t.name.startsWith('kv_store')).map((t) => [t.name, t._meta?.appVersion, t.description]),
      [
        ['kv_store_set', '1.0.0', '[mut] set(key: string) -> unit'],
        ['kv_store_kvtwo_set', '2.0.0', '[mut] set(key: string, ttl: u32) -> unit'],
      ],
    );

    const v2 = await s.json('select_app', { app: 'kv-two', context: ctx('kvv2') });
    assert.deepEqual(v2.tools, ['kv_store_kvtwo_set']);
    const refused = await s.call('kv_store_set', { app_handle: v2.app_handle, key: 'k' });
    assert.equal(refused.isError, true);
    assert.equal(
      refused.content.at(-1)!.text,
      'This app_handle is for com.calimero.kv-store 2.0.0, but this tool belongs to com.calimero.kv-store 1.0.0. ' +
        'Call select_app for com.calimero.kv-store and retry with the returned app_handle.',
    );
    assert.deepEqual(s.executed, []);

    await s.call('kv_store_kvtwo_set', { app_handle: v2.app_handle, key: 'k', ttl: 5 });
    await s.call('call', { app_handle: v2.app_handle, method: 'set', args: { key: 'k', ttl: 6 } });
    assert.deepEqual(s.executed, [
      { contextId: ctx('kvv2'), method: 'set', argsJson: { key: 'k', ttl: 5 } },
      { contextId: ctx('kvv2'), method: 'set', argsJson: { key: 'k', ttl: 6 } },
    ]);
  } finally {
    await s.close();
  }
});

test('two packages that sanitise to one slug are told apart by app id, and an app with no package is named by its id', async () => {
  const twin: FakeApp = { ...plain(), id: 'twin-id', package: 'org.example.kv_store', abi: manifest([method('ping')]) };
  const bare: FakeApp = { ...plain(), id: 'RawApp42', package: undefined, metadata: undefined, abi: manifest([method('ping')]) };
  const s = await setup([kv(), twin, bare]);
  try {
    const tools = (await s.client.listTools()).tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('kv_store_set') && names.includes('kv_store_twinid_ping') && names.includes('rawapp42_ping'));
    assert.equal(tools.find((t) => t.name === 'rawapp42_ping')!.title, 'Ping (RawApp42)');
  } finally {
    await s.close();
  }
});

test('select_app with no context says how to get one, and marks its tool names as the ones a client may prefix', async () => {
  const s = await setup([{ ...kv(), contexts: [] }]);
  try {
    const summary = await s.json('select_app', { app: 'kv-store' });
    assert.equal(summary.context, null);
    assert.equal(
      summary.note,
      'Application "kv-store" has no contexts on this node. Create one in the Calimero desktop app, or use create_context.',
    );
    assert.deepEqual(summary.tools, ['kv_store_get', 'kv_store_set']);
    assert.match(summary.toolsNote, /mcp__<server>__<tool>/);
  } finally {
    await s.close();
  }
});

test('a context that is neither an id nor an alias is named with the candidates, and only a resolved alias is remembered', async () => {
  const s = await setup([kv()], '2025-11-25', { aliases: { core: ctx('kvctx') } });
  const lookups: string[] = [];
  const admin = s.session.mero.admin as { lookupContextAlias: (name: string) => Promise<unknown> };
  const lookup = admin.lookupContextAlias;
  admin.lookupContextAlias = (name) => (lookups.push(name), lookup(name));
  try {
    const missing = await s.call('select_app', { app: 'kv-store', context: 'nope' });
    assert.equal(missing.isError, true);
    assert.equal(
      missing.content[0].text,
      `Error: Context "nope" not found: it is neither a context id nor an alias on this node. Contexts for "kv-store": ${ctx('kvctx')}`,
    );
    await s.call('select_app', { app: 'kv-store', context: 'nope' });
    await s.call('select_app', { app: 'kv-store', context: 'core' });
    await s.call('select_app', { app: 'kv-store', context: 'core' });
    await s.call('select_app', { app: 'kv-store', context: ctx('kvctx') });
    assert.deepEqual(lookups, ['nope', 'nope', 'core']);
  } finally {
    await s.close();
  }
});

test('call on an unknown method lists what the app exposes, and runs nothing', async () => {
  const s = await setup();
  try {
    const { app_handle } = await s.json('select_app', { app: 'kv-store' });
    const res = await s.call('call', { app_handle, method: 'nope' });
    assert.equal(res.isError, true);
    assert.equal(res.content[0].text, 'Error: Method "nope" not found on "com.calimero.kv-store". Available: set, get');
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test('describe_app reads the service from contexts, and says when none can be read', async () => {
  const s = await setup([
    { ...kv(), contexts: [{ id: ctx('kvctx'), serviceName: 'issue-tracker' }] },
    { ...plain(), contexts: [] },
  ]);
  try {
    const kvDescribed = await s.json('describe_app', { app: 'kv-store' });
    assert.equal(kvDescribed.service, 'issue-tracker');
    assert.deepEqual(kvDescribed.contextServices, ['issue-tracker']);
    assert.equal(kvDescribed.serviceNote, undefined);
    const notesDescribed = await s.json('describe_app', { app: 'notes' });
    assert.equal(notesDescribed.service, null);
    assert.match(notesDescribed.serviceNote, /^Not discoverable: a node exposes no service list/);
  } finally {
    await s.close();
  }
});
