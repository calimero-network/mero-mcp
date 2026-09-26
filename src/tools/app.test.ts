import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.ts';
import { WATCH_INTERVAL_MS } from '../catalog.ts';
import { guideHash, handles } from '../handle.ts';
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
  for (const [change, toolText] of [
    [(a: FakeApp) => (a.version = '1.1.0'), RETRY],
    [(a: FakeApp) => (a.metadata = { ...a.metadata, guide: `${GUIDE}\n### Another` }), RETRY],
    [(a: FakeApp) => (a.contexts = [ctx('newctx')]), RETRY],
  ] as const) {
    const s = await setup();
    try {
      const { app_handle } = await s.json('select_app', { app: 'kv-store' });
      change(s.apps[0]);
      const viaCall = await s.call('call', { app_handle, method: 'set', args: { key: 'k' } });
      assert.equal(viaCall.isError, true);
      assert.equal(viaCall.content.at(-1)!.text, RETRY);
      const res = await s.call('kv_store_set', { app_handle, key: 'k' });
      assert.equal(res.isError, true);
      assert.equal(res.content.at(-1)!.text, toolText);
      assert.deepEqual(s.executed, []);
    } finally {
      await s.close();
    }
  }
});

test('after an in-place upgrade an old tool resyncs, then runs as the new version or refuses with the plain retry', async () => {
  const s = await setup([kv()]);
  try {
    Object.assign(s.apps[0], { version: '1.1.0', abi: manifest([method('set', [{ name: 'key', type: { kind: 'string' } }]), method('del')]) });
    const fresh = await s.json('select_app', { app: 'kv-store' });
    assert.deepEqual([fresh.appVersion, fresh.tools], ['1.1.0', ['kv_store_del', 'kv_store_set']]);
    await s.call('kv_store_set', { app_handle: fresh.app_handle, key: 'k' });
    assert.deepEqual(s.executed, [{ contextId: ctx('kvctx'), method: 'set', argsJson: { key: 'k' } }]);
    const listed = (await s.client.listTools()).tools.find((t) => t.name === 'kv_store_set');
    assert.equal(listed?._meta?.appVersion, '1.1.0');

    Object.assign(s.apps[0], { version: '1.2.0', abi: manifest([method('get', [{ name: 'key', type: { kind: 'string' } }])]) });
    // A handle for the new version must not run the old tool's method, which that version no longer has.
    const current = handles.issue({ p: 'com.calimero.kv-store', v: '1.2.0', g: guideHash(GUIDE), c: ctx('kvctx'), s: null });
    const gone = await s.call('kv_store_set', { app_handle: current, key: 'k' });
    assert.equal(gone.isError, true);
    // 1.1.0 is gone, so the refusal must not send the agent back to it; the tool leaves the list below.
    assert.deepEqual(gone.content.map((b) => b.text ?? b.resource?.text).slice(-1), [RETRY]);
    assert.equal(s.executed.length, 1);
    assert.ok(!(await s.client.listTools()).tools.some((t) => t.name === 'kv_store_set'));
    assert.deepEqual((await s.json('select_app', { app: 'kv-store' })).tools, ['kv_store_get']);
  } finally {
    await s.close();
  }
});

test('a tool whose app was uninstalled refuses with the retry line and the guide, runs nothing, and leaves the list', async () => {
  const s = await setup();
  try {
    const { app_handle } = await s.json('select_app', { app: 'kv-store' });
    s.apps.splice(0, 1);
    const res = await s.call('kv_store_set', { app_handle, key: 'k' });
    assert.equal(res.isError, true);
    assert.deepEqual(res.content.map((b) => b.text ?? b.resource?.text), [LABEL, GUIDE, RETRY]);
    assert.deepEqual(s.executed, []);
    assert.ok(!(await s.client.listTools()).tools.some((t) => t.name.startsWith('kv_store_')));
  } finally {
    await s.close();
  }
});

test('a catalog miss whose re-sync fails still resolves the app, using the direct read', async () => {
  const s = await setup();
  try {
    s.apps.push(kv());
    s.apps[1].id = 'kv-id-2';
    const list = s.session.mero.admin.listApplications.bind(s.session.mero.admin);
    let calls = 0;
    s.session.mero.admin.listApplications = async () => {
      calls++;
      if (calls === 2) throw new Error('node blip');
      return list();
    };
    const res = await s.json('describe_app', { app: 'kv-id-2' });
    assert.equal(res.application, 'kv-id-2');
  } finally {
    await s.close();
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
    // select_app only reads the node and mints a handle, so clients need not confirm it.
    assert.deepEqual(tools.find((t) => t.name === 'select_app')!.annotations, { readOnlyHint: true });
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
    await s.call('call', { app_handle: kvHandle, method: 'set', args: { key: 'k' }, app: 'no-such-app' });
    const docs = await s.json('select_app', { app: 'mero-drive', context: ctx('docsctx') });
    await s.call('call', { app_handle: docs.app_handle, method: 'create_doc', args: { title: 't' }, app: 'mero-drive' });
    assert.deepEqual(s.executed, [
      { contextId: ctx('kvctx'), method: 'set', argsJson: { key: 'k' } },
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

test('with two versions installed the plain names are the newest, select_app agrees, and a crossed call is redirected once', async () => {
  const key = { name: 'key', type: { kind: 'string' } };
  const s = await setup([kvAt('kv-one', '1.0.0', 'kvv1', [key]), kvAt('kv-two', '2.0.0', 'kvv2', [key, { name: 'ttl', type: { kind: 'u32' } }])]);
  try {
    const tools = (await s.client.listTools()).tools;
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
    assert.deepEqual(
      tools.filter((t) => t.name.startsWith('kv_store')).map((t) => [t.name, t._meta?.appVersion, t.description]),
      [
        ['kv_store_kvone_set', '1.0.0', '[mut] set(key: string) -> unit'],
        ['kv_store_set', '2.0.0', '[mut] set(key: string, ttl: u32) -> unit'],
      ],
    );

    const newest = await s.json('select_app', { app: 'kv-store' });
    assert.deepEqual([newest.appVersion, newest.tools], ['2.0.0', ['kv_store_set']]);
    const crossed = await s.call('kv_store_kvone_set', { app_handle: newest.app_handle, key: 'k' });
    assert.equal(crossed.isError, true);
    assert.equal(
      crossed.content.at(-1)!.text,
      'This app_handle is for com.calimero.kv-store 2.0.0, but this tool belongs to com.calimero.kv-store 1.0.0. ' +
        'Pass it to kv_store_set instead, or call select_app for com.calimero.kv-store with a context of ' +
        'com.calimero.kv-store 1.0.0 and retry with the returned app_handle.',
    );
    assert.deepEqual(s.executed, []);

    const retried = await s.call('kv_store_set', { app_handle: newest.app_handle, key: 'k', ttl: 5 });
    assert.equal(retried.isError, undefined);
    await s.call('call', { app_handle: newest.app_handle, method: 'set', args: { key: 'k', ttl: 6 } });
    assert.deepEqual(s.executed, [
      { contextId: ctx('kvv2'), method: 'set', argsJson: { key: 'k', ttl: 5 } },
      { contextId: ctx('kvv2'), method: 'set', argsJson: { key: 'k', ttl: 6 } },
    ]);
  } finally {
    await s.close();
  }
});

test('a crossed version whose own version lacks the method says which version to select', async () => {
  const key = { name: 'key', type: { kind: 'string' } };
  const s = await setup([
    { ...kvAt('kv-one', '1.0.0', 'kvv1', [key]), abi: manifest([method('set', [key]), method('legacy')]) },
    kvAt('kv-two', '2.0.0', 'kvv2', [key]),
  ]);
  try {
    const newest = await s.json('select_app', { app: 'kv-store' });
    const res = await s.call('kv_store_kvone_legacy', { app_handle: newest.app_handle });
    assert.equal(
      res.content.at(-1)!.text,
      'This app_handle is for com.calimero.kv-store 2.0.0, but this tool belongs to com.calimero.kv-store 1.0.0. ' +
        'Call select_app for com.calimero.kv-store with a context of com.calimero.kv-store 1.0.0 and retry with the returned app_handle.',
    );
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test('when the newest version has no contexts, the note lists the contexts of the other versions with their versions', async () => {
  const key = { name: 'key', type: { kind: 'string' } };
  const s = await setup([kvAt('kv-one', '1.0.0', 'kvv1', [key]), { ...kvAt('kv-two', '2.0.0', 'kvv2', [key]), contexts: [] }]);
  try {
    const selected = await s.json('select_app', { app: 'kv-store' });
    assert.equal(selected.context, null);
    assert.equal(
      selected.note,
      `Application "kv-store" 2.0.0 has no contexts on this node; other installed versions do: ${ctx('kvv1')} (1.0.0). ` +
        'Pass context with one of them to act on that version, or create one for 2.0.0 in the Calimero desktop app or with create_context.',
    );
  } finally {
    await s.close();
  }
});

test('select_app binds the installed version whose application owns the chosen context, and the newest without one', async () => {
  const key = { name: 'key', type: { kind: 'string' } };
  const s = await setup([kvAt('kv-one', '1.0.0', 'kvv1', [key]), kvAt('kv-two', '2.0.0', 'kvv2', [key, { name: 'ttl', type: { kind: 'u32' } }])]);
  try {
    const v2 = await s.json('select_app', { app: 'com.calimero.kv-store', context: ctx('kvv2') });
    assert.deepEqual([v2.application, v2.appVersion, v2.context, v2.tools], ['kv-two', '2.0.0', ctx('kvv2'), ['kv_store_set']]);
    await s.call('kv_store_set', { app_handle: v2.app_handle, key: 'k', ttl: 1 });

    const v1 = await s.json('select_app', { app: 'kv-store', context: ctx('kvv1') });
    assert.deepEqual([v1.application, v1.appVersion, v1.tools], ['kv-one', '1.0.0', ['kv_store_kvone_set']]);
    await s.call('kv_store_kvone_set', { app_handle: v1.app_handle, key: 'k' });
    assert.deepEqual(s.executed, [
      { contextId: ctx('kvv2'), method: 'set', argsJson: { key: 'k', ttl: 1 } },
      { contextId: ctx('kvv1'), method: 'set', argsJson: { key: 'k' } },
    ]);

    const newest = await s.json('select_app', { app: 'kv-store' });
    assert.deepEqual([newest.appVersion, newest.context], ['2.0.0', ctx('kvv2')]);
    assert.equal((await s.json('describe_app', { app: 'kv-store' })).appVersion, '2.0.0');
  } finally {
    await s.close();
  }
});

test("select_app refuses a context of another app, by id or alias, naming the app's own contexts", async () => {
  const s = await setup([kv(), plain()], '2025-11-25', { aliases: { theirs: ctx('notesctx') } });
  try {
    for (const context of [ctx('notesctx'), 'theirs']) {
      const res = await s.call('select_app', { app: 'kv-store', context });
      assert.equal(res.isError, true);
      assert.equal(res.content[0].text, `Error: Context "${context}" does not belong to "kv-store". Contexts for "kv-store": ${ctx('kvctx')}`);
    }
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

test('a method with its own app_handle parameter gets no generated tool and is reached through call', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const app: FakeApp = {
    ...plain(),
    abi: manifest([method('ping'), method('store', [{ name: 'app_handle', type: { kind: 'string' } }])]),
  };
  const s = await setup([app]);
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('notes_ping'));
    assert.ok(!names.includes('notes_store'));
    const lines = logged.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(
      lines.includes('[mero-mcp] no tool for org.example.notes 0.2.0 store: its app_handle parameter would collide; use call'),
      `stderr was: ${JSON.stringify(lines)}`,
    );

    const { app_handle, tools } = await s.json('select_app', { app: 'notes' });
    assert.deepEqual(tools, ['notes_ping']);
    await s.call('call', { app_handle, method: 'store', args: { app_handle: 'x' } });
    assert.deepEqual(s.executed, [{ contextId: ctx('notesctx'), method: 'store', argsJson: { app_handle: 'x' } }]);

    // An in-place upgrade that gives ping an app_handle parameter must not run it through the old tool.
    Object.assign(s.apps[0], { version: '0.3.0', abi: manifest([method('ping', [{ name: 'app_handle', type: { kind: 'string' } }])]) });
    const refused = await s.call('notes_ping', { app_handle });
    assert.equal(refused.isError, true);
    assert.equal(s.executed.length, 1);
  } finally {
    await s.close();
  }
});

const tiny = (id: string, pkg: string, methods: string[]): FakeApp => ({
  id,
  package: pkg,
  version: '1.0.0',
  abi: manifest(methods.map((m) => method(m))),
  contexts: [ctx(id.replace(/[^1-9A-HJ-NP-Za-km-z]/g, ''))],
});

test('a generated name that equals a built-in tool is disambiguated, and the server still connects', async () => {
  const s = await setup([tiny('nodeapp-id', 'com.x.node', ['status'])]);
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    assert.equal(names.filter((n) => n === 'node_status').length, 1);
    assert.ok(names.includes('node_nodeap_status'));
    const { app_handle, tools } = await s.json('select_app', { app: 'node' });
    assert.deepEqual(tools, ['node_nodeap_status']);
    await s.call('node_nodeap_status', { app_handle });
    assert.equal(s.executed[0].method, 'status');
  } finally {
    await s.close();
  }
});

test("two apps whose names meet keep one tool each, and each reaches its own app", async () => {
  const s = await setup([tiny('a-id', 'com.x.kv', ['store_get']), tiny('b-id', 'com.y.kv-store', ['get'])]);
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('kv_store_get') && names.includes('kv_store_bid_get'), JSON.stringify(names));
    const kvStore = await s.json('select_app', { app: 'com.y.kv-store' });
    assert.deepEqual(kvStore.tools, ['kv_store_bid_get']);
    await s.call('kv_store_bid_get', { app_handle: kvStore.app_handle });
    const kvApp = await s.json('select_app', { app: 'com.x.kv' });
    await s.call('kv_store_get', { app_handle: kvApp.app_handle });
    assert.deepEqual(s.executed.map((e) => e.method), ['get', 'store_get']);
  } finally {
    await s.close();
  }
});

test('an install whose tool name meets an existing one registers both, and the list keeps working', async () => {
  const s = await setup([tiny('a-id', 'com.x.kv', ['store_get', 'ping'])]);
  Object.assign(s.session.mero.admin, {
    installApplication: async () => (s.apps.push(tiny('b-id', 'com.y.kv-store', ['get'])), { applicationId: 'b-id' }),
  });
  try {
    const installed = await s.call('install_application', { coords: 'com.y.kv-store@1.0.0' });
    assert.equal(installed.isError, undefined);
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    assert.ok(['kv_store_get', 'kv_ping', 'kv_store_bid_get'].every((n) => names.includes(n)), JSON.stringify(names));
    const { app_handle } = await s.json('select_app', { app: 'com.y.kv-store' });
    await s.call('kv_store_bid_get', { app_handle });
    assert.deepEqual(s.executed.map((e) => e.method), ['get']);
  } finally {
    await s.close();
  }
});

const solo = (): FakeApp => ({
  id: 'solo-id',
  package: 'com.x.solo',
  version: '1.0.0',
  signer_id: 'SignerKey4',
  metadata: { name: 'Solo' },
  abi: undefined,
  services: { main: manifest([method('ping')]) },
  contexts: [ctx('soloctx')],
});

test('a context created without a service name belongs to the one service of a single-service bundle', async () => {
  const s = await setup([solo()]);
  try {
    assert.equal((await s.json('describe_app', { app: 'solo' })).service, 'main');
    const selected = await s.json('select_app', { app: 'solo' });
    assert.deepEqual([selected.service, selected.context, selected.tools], ['main', ctx('soloctx'), ['solo_main_ping']]);
    const viaTool = await s.call('solo_main_ping', { app_handle: selected.app_handle });
    assert.equal(viaTool.isError, undefined);
    await s.call('call', { app_handle: selected.app_handle, method: 'ping' });
    assert.deepEqual(s.executed, [
      { contextId: ctx('soloctx'), method: 'ping', argsJson: {} },
      { contextId: ctx('soloctx'), method: 'ping', argsJson: {} },
    ]);
  } finally {
    await s.close();
  }
});

for (const entry of ['select_app', 'describe_app', 'call'] as const) {
  test(`${entry} on a node that was down at connect brings up its app tools and starts the poll`, async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    t.mock.timers.enable({ apis: ['setInterval'] });
    const node = fakeNode([kv()]);
    const admin = node.session.mero.admin as { listApplications: () => Promise<unknown> };
    const list = admin.listApplications;
    let down = true;
    let lists = 0;
    admin.listApplications = async () => {
      lists++;
      if (down) throw new Error('connection refused');
      return list();
    };
    const { client, close } = await connect(createServerFactory(node.session, CFG));
    try {
      assert.match(String(logged.mock.calls[0]?.arguments[0]), /app list unavailable at connect/);
      down = false;
      const handle = handles.issue({ p: 'com.calimero.kv-store', v: '1.0.0', g: guideHash(GUIDE), c: ctx('kvctx'), s: null });
      const args = entry === 'call' ? { app_handle: handle, method: 'set', args: { key: 'k' } } : { app: 'kv-store' };
      const res = (await client.callTool({ name: entry, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
      assert.equal(res.isError, undefined, res.content[0].text);
      if (entry === 'select_app') assert.deepEqual(JSON.parse(res.content[0].text!).tools, ['kv_store_get', 'kv_store_set']);
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'kv_store_set'));

      const before = lists;
      t.mock.timers.tick(WATCH_INTERVAL_MS);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(lists, before + 1);
    } finally {
      await close();
    }
  });
}
