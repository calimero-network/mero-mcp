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
      uri: 'calimero://apps/kv-id/1.0.0/guide',
      mimeType: 'text/markdown',
      text: GUIDE,
      _meta: { package: 'com.calimero.kv-store', appVersion: '1.0.0', signerId: 'SignerKey1' },
    });
    assert.deepEqual((await s.client.listTools()).tools.map((t) => t.name), before);
  } finally {
    await s.close();
  }
});

test('describe_app, select_app and call name an app by its display name too', async () => {
  const s = await setup();
  try {
    assert.equal((await s.json('describe_app', { app: 'kv store' })).package, 'com.calimero.kv-store');
    const { app_handle, package: pkg } = await s.json('select_app', { app: 'KV Store' });
    assert.equal(pkg, 'com.calimero.kv-store');
    await s.call('call', { app_handle, method: 'set', args: { key: 'k' }, app: 'kv store' });
    assert.deepEqual(s.executed, [{ contextId: ctx('kvctx'), method: 'set', argsJson: { key: 'k' } }]);
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
    assert.deepEqual(Object.keys(set.inputSchema.properties ?? {}), ['app_handle', 'context', 'key']);
    assert.deepEqual(set.inputSchema.required, ['key']);
  } finally {
    await s.close();
  }
});

const withInit = (): FakeApp => ({
  ...kv(),
  abi: manifest([method('init', [{ name: 'name', type: { kind: 'string' } }]), method('set', [{ name: 'key', type: { kind: 'string' } }])]),
});

const INIT_REFUSED =
  "init runs once, when create_context creates the context; pass its arguments as create_context's args. It cannot be called on a context.";

test('init gets no generated tool and select_app names none, since create_context runs it', async () => {
  const s = await setup([withInit()]);
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('kv_store_'));
    assert.deepEqual(names, ['kv_store_set']);
    assert.deepEqual((await s.json('select_app', { app: 'kv-store' })).tools, ['kv_store_set']);
  } finally {
    await s.close();
  }
});

test('call refuses init after the handle check, pointing at create_context, and runs nothing', async () => {
  const s = await setup([withInit()]);
  try {
    const unhandled = await s.call('call', { method: 'init', args: { name: 'x' }, app: 'kv-store' });
    assert.equal(unhandled.content.at(-1)!.text, RETRY);
    const { app_handle } = await s.json('select_app', { app: 'kv-store' });
    const res = await s.call('call', { app_handle, method: 'init', args: { name: 'x' } });
    assert.equal(res.isError, true);
    assert.deepEqual(res.content.map((b) => b.text), [INIT_REFUSED]);
    assert.deepEqual(s.executed, []);
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
      const viaCall = await s.call('call', { app_handle, method: 'set', args: { key: 'k' } });
      assert.equal(viaCall.isError, true);
      assert.equal(viaCall.content.at(-1)!.text, RETRY);
      const res = await s.call('kv_store_set', { app_handle, key: 'k' });
      assert.equal(res.isError, true);
      assert.equal(res.content.at(-1)!.text, RETRY);
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
    const current = handles.issue({ a: 'kv-id', p: 'com.calimero.kv-store', v: '1.2.0', g: guideHash(GUIDE), c: ctx('kvctx'), s: null });
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

test('after an in-place upgrade whose re-sync fails, an old tool refuses a current handle and runs nothing', async () => {
  const s = await setup([kv()]);
  try {
    s.apps[0].version = '1.1.0';
    const current = handles.issue({ a: 'kv-id', p: 'com.calimero.kv-store', v: '1.1.0', g: guideHash(GUIDE), c: ctx('kvctx'), s: null });
    const list = s.session.mero.admin.listApplications.bind(s.session.mero.admin);
    let calls = 0;
    s.session.mero.admin.listApplications = async () => {
      if (++calls === 2) throw new Error('node blip');
      return list();
    };
    const res = await s.call('kv_store_set', { app_handle: current, key: 'k' });
    assert.equal(res.isError, true);
    assert.equal(res.content.at(-1)!.text, RETRY);
    assert.deepEqual(s.executed, []);
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

test('a tool whose app was uninstalled still refuses with the retry line when the re-sync fails', async () => {
  const s = await setup();
  try {
    const { app_handle } = await s.json('select_app', { app: 'kv-store' });
    s.apps.splice(0, 1);
    const list = s.session.mero.admin.listApplications.bind(s.session.mero.admin);
    let calls = 0;
    s.session.mero.admin.listApplications = async () => {
      if (++calls === 2) throw new Error('node blip');
      return list();
    };
    const res = await s.call('kv_store_set', { app_handle, key: 'k' });
    assert.deepEqual(res.content.map((b) => b.text ?? b.resource?.text), [LABEL, GUIDE, RETRY]);
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test('call with a handle for an uninstalled app, or without one for a multi-service app, refuses with the retry line', async () => {
  const s = await setup([kv(), drive()]);
  try {
    const { app_handle } = await s.json('select_app', { app: 'kv-store' });
    s.apps.splice(0, 1);
    const gone = await s.call('call', { app_handle, method: 'set', args: { key: 'k' } });
    assert.deepEqual(gone.content.map((b) => b.text), ['Call select_app for the application and retry with the returned app_handle.']);

    const bare = await s.call('call', { method: 'create_doc', args: { title: 't' }, app: 'mero-drive' });
    assert.deepEqual(bare.content.map((b) => b.text ?? b.resource?.text).slice(-2), [
      '## Overview\ndrive',
      'Call select_app for com.calimero.mero-drive and retry with the returned app_handle.',
    ]);
    assert.deepEqual(s.executed, []);
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

test('generated tools carry a title, explicit annotations, no icon, and _meta', async () => {
  const s = await setup();
  try {
    const tools = (await s.client.listTools()).tools;
    const get = tools.find((t) => t.name === 'kv_store_get')!;
    const add = tools.find((t) => t.name === 'notes_add')!;
    assert.equal(get.title, 'Get (KV Store)');
    assert.deepEqual(get.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(add.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    assert.equal(get.icons, undefined);
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

test('a method returning unit advertises no outputSchema and sends no structuredContent', async () => {
  const app: FakeApp = {
    ...kv(),
    abi: manifest(
      [method('clear', [], { returns: { kind: 'unit' } }), method('wipe', [], { returns: { $ref: 'Done' } }), method('get', [], { returns: { kind: 'string' } })],
      { Done: { kind: 'alias', target: { kind: 'unit' } } },
    ),
  };
  const s = await setup([app]);
  try {
    const tools = (await s.client.listTools()).tools;
    assert.equal(tools.find((t) => t.name === 'kv_store_clear')!.outputSchema, undefined);
    assert.equal(tools.find((t) => t.name === 'kv_store_wipe')!.outputSchema, undefined);
    assert.ok(tools.find((t) => t.name === 'kv_store_get')!.outputSchema);
    const { app_handle } = await s.json('select_app', { app: 'kv-store' });
    assert.equal((await s.call('kv_store_clear', { app_handle })).structuredContent, undefined);
    assert.equal((await s.call('kv_store_wipe', { app_handle })).structuredContent, undefined);
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

  test(`${era}: a returns_doc on an object return keeps outputSchema.type: object and does not add an era wrap`, async () => {
    const documented: FakeApp = {
      ...plain(),
      abi: manifest(
        [
          method('add', [{ name: 'body', type: { kind: 'string' } }], { returns: { $ref: 'Note' }, returns_doc: 'The saved note.' }),
          method('count', [], { intent: 'read_only', returns: { kind: 'u32' }, returns_doc: 'How many notes exist.' }),
        ],
        { Note: { kind: 'record', fields: [{ name: 'id', type: { kind: 'u32' } }] } },
      ),
    };
    const s = await setup([documented], era, { execute: (p) => (p.method === 'count' ? 3 : { id: 7 }) });
    try {
      const tools = (await s.client.listTools()).tools;
      const add = tools.find((t) => t.name === 'notes_add')!;
      const count = tools.find((t) => t.name === 'notes_count')!;
      const { app_handle } = await s.json('select_app', { app: 'notes' });
      const added = await s.call('notes_add', { app_handle, body: 'x' });
      const counted = await s.call('notes_count', { app_handle });
      // The documented named-record return stays type: object at the root, era-independent: never wrapped.
      assert.equal(add.outputSchema?.type, 'object');
      assert.equal((add.outputSchema as { description?: string }).description, 'The saved note.');
      assert.deepEqual(added.structuredContent, { id: 7 });
      if (era === '2025-11-25') {
        assert.deepEqual(count.outputSchema, {
          type: 'object',
          properties: { result: { type: 'integer', minimum: 0, maximum: 9007199254740991, description: 'How many notes exist.' } },
          required: ['result'],
        });
        assert.deepEqual(counted.structuredContent, { result: 3 });
      } else {
        assert.deepEqual(count.outputSchema, { type: 'integer', minimum: 0, maximum: 9007199254740991, description: 'How many notes exist.' });
        assert.equal(counted.structuredContent, 3);
      }
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

const kvBy = (id: string, signer: string, context: string): FakeApp => ({ ...kv(), id, signer_id: signer, contexts: [ctx(context)] });

test("call refuses a handle for one app when app gives another app's display name, and runs nothing", async () => {
  const s = await setup();
  try {
    const { app_handle } = await s.json('select_app', { app: 'org.example.notes' });
    const res = await s.call('call', { app_handle, method: 'add', args: { body: 'b' }, app: 'KV Store' });
    assert.equal(res.isError, true);
    assert.equal(res.content.at(-1)!.text, RETRY);
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test('one package from two signers is two apps: own tools, no silent pick by name, and a handle per signer', async () => {
  // Same package, version and guide, so only the signer tells the two handles apart.
  const s = await setup([kvBy('kv-a', 'SignerA', 'ctxa'), kvBy('kv-b', 'SignerB', 'ctxb')]);
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('kv_store') && n.endsWith('_set'));
    assert.deepEqual(names, ['kv_store_set', 'kv_store_kvb_set']);

    const listed = 'kv-a (signer SignerA), kv-b (signer SignerB). Pass the application id.';
    for (const tool of ['select_app', 'describe_app']) {
      const res = await s.call(tool, { app: 'kv-store' });
      assert.equal(res.isError, true);
      assert.equal(res.content[0].text, `Error: Application "kv-store" is published by several signers: ${listed}`);
    }

    const a = await s.json('select_app', { app: 'kv-a' });
    const b = await s.json('select_app', { app: 'kv-b' });
    assert.deepEqual([a.context, a.tools.at(-1), b.context, b.tools.at(-1)], [ctx('ctxa'), 'kv_store_set', ctx('ctxb'), 'kv_store_kvb_set']);
    for (const [tool, handle] of [['kv_store_kvb_set', a.app_handle], ['kv_store_set', b.app_handle]]) {
      const crossed = await s.call(tool, { app_handle: handle, key: 'k' });
      assert.equal(crossed.isError, true);
    }
    // A planning handle names no context, so only the bound signer can tell the tool it is for the other app.
    const planning = (await s.json('describe_app', { app: 'kv-a' })).app_handle;
    assert.equal((await s.call('kv_store_kvb_set', { app_handle: planning, key: 'k' })).content.at(-1)!.text, RETRY);
    const viaCall = await s.call('call', { app_handle: a.app_handle, method: 'set', args: { key: 'k' }, app: 'kv-b' });
    assert.equal(viaCall.isError, true);
    assert.deepEqual(s.executed, []);

    await s.call('kv_store_kvb_set', { app_handle: b.app_handle, key: 'k' });
    await s.call('call', { app_handle: a.app_handle, method: 'set', args: { key: 'k' } });
    assert.deepEqual(s.executed, [
      { contextId: ctx('ctxb'), method: 'set', argsJson: { key: 'k' } },
      { contextId: ctx('ctxa'), method: 'set', argsJson: { key: 'k' } },
    ]);
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

test('a context that is neither an id nor an alias is named with the candidates, and every alias is looked up live', async () => {
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
    assert.deepEqual(lookups, ['nope', 'nope', 'core', 'core']);
  } finally {
    await s.close();
  }
});

test('select_app accepts a real hex context id straight off, without treating it as an alias', async () => {
  const s = await setup([kv()], '2025-11-25', { aliases: { core: ctx('kvctx') } });
  const admin = s.session.mero.admin as { lookupContextAlias: (name: string) => Promise<unknown> };
  const lookups: string[] = [];
  const lookup = admin.lookupContextAlias;
  admin.lookupContextAlias = (name) => (lookups.push(name), lookup(name));
  try {
    const selected = await s.json('select_app', { app: 'kv-store', context: ctx('kvctx') });
    assert.equal(selected.context, ctx('kvctx'));
    assert.deepEqual(lookups, []);
  } finally {
    await s.close();
  }
});

test('the not-found refusal never lists the value it just rejected, even if that shape reappears among the candidates', async () => {
  // Core's own ids are always 64-char hex; this fixture id is not, so it can never resolve as
  // an id or an alias - it exercises the guard even if a future id format slips past CONTEXT_ID.
  const oddShaped = 'not-a-real-id-shape';
  const s = await setup([{ ...kv(), contexts: [oddShaped] }]);
  try {
    const missing = await s.call('select_app', { app: 'kv-store', context: oddShaped });
    assert.equal(missing.isError, true);
    assert.equal(
      missing.content[0].text,
      `Error: Context "${oddShaped}" not found: it is neither a context id nor an alias on this node. Contexts for "kv-store": (none)`,
    );
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
  contexts: [ctx(id)],
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
    let listed = () => {};
    admin.listApplications = async () => {
      listed();
      if (down) throw new Error('connection refused');
      return list();
    };
    const { client, close } = await connect(createServerFactory(node.session, CFG));
    try {
      assert.match(String(logged.mock.calls[0]?.arguments[0]), /app list unavailable at connect/);
      down = false;
      const handle = handles.issue({ a: 'kv-id', p: 'com.calimero.kv-store', v: '1.0.0', g: guideHash(GUIDE), c: ctx('kvctx'), s: null });
      const args = entry === 'call' ? { app_handle: handle, method: 'set', args: { key: 'k' } } : { app: 'kv-store' };
      const res = (await client.callTool({ name: entry, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
      assert.equal(res.isError, undefined, res.content[0].text);
      if (entry === 'select_app') assert.deepEqual(JSON.parse(res.content[0].text!).tools, ['kv_store_get', 'kv_store_set']);
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'kv_store_set'));

      const polled = new Promise<void>((resolve) => (listed = resolve));
      t.mock.timers.tick(WATCH_INTERVAL_MS);
      await polled;
    } finally {
      await close();
    }
  });
}

test("a returns_doc on a bytes return keeps the bytes hint beside it, and on a named type replaces the type's own doc", async () => {
  const documented: FakeApp = {
    ...kv(),
    abi: manifest(
      [
        method('digest', [], { intent: 'read_only', returns: { kind: 'bytes' }, returns_doc: 'The digest.' }),
        method('status', [], { intent: 'read_only', returns: { $ref: 'Status' }, returns_doc: 'The current status.' }),
      ],
      { Status: { kind: 'record', doc: 'A status.', fields: [{ name: 'ok', type: { kind: 'bool' } }] } },
    ),
  };
  const s = await setup([documented], '2026-07-28');
  try {
    const tools = (await s.client.listTools()).tools;
    const described = (name: string) => (tools.find((t) => t.name === name)!.outputSchema as { description?: string }).description;
    assert.equal(described('kv_store_digest'), 'The digest. (bytes: a byte array)');
    assert.equal(described('kv_store_status'), 'The current status.');
  } finally {
    await s.close();
  }
});

test('ABI docs and flags reach the tool: description, parameter doc, returns_doc, destructive and idempotent hints', async () => {
  const documented: FakeApp = {
    ...kv(),
    abi: manifest([
      method('clear', [], { doc: 'Delete every key.', destructive: true, idempotent: true }),
      method('get', [{ name: 'key', type: { kind: 'string' }, doc: 'Up to 64 bytes.' }], {
        intent: 'read_only',
        returns: { kind: 'string' },
        returns_doc: 'The stored value.',
      }),
    ]),
  };
  const s = await setup([documented], '2026-07-28');
  try {
    const tools = (await s.client.listTools()).tools;
    const clear = tools.find((t) => t.name === 'kv_store_clear')!;
    const get = tools.find((t) => t.name === 'kv_store_get')!;
    assert.equal(clear.description, 'Delete every key.\n\n[mut] clear() -> unit');
    assert.deepEqual(clear.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    assert.equal((get.inputSchema.properties as Record<string, { description?: string }>).key.description, 'Up to 64 bytes.');
    assert.deepEqual(get.outputSchema, { type: 'string', description: 'The stored value.' });
    const described = await s.json('describe_app', { app: 'kv-store' });
    assert.deepEqual(described.methods, ['Delete every key.\n\n[mut] clear() -> unit', '[view] get(key: string) -> string\n  key: Up to 64 bytes.']);
  } finally {
    await s.close();
  }
});

test('a generated tool serializes its result compactly in the text block', async () => {
  const s = await setup([kv(), plain()], '2025-11-25', { execute: () => ({ id: 7, tags: ['a'] }) });
  try {
    const { app_handle } = await s.json('select_app', { app: 'notes' });
    const added = await s.call('notes_add', { app_handle, body: 'x' });
    assert.equal(added.content[0].text, '{"id":7,"tags":["a"]}');
  } finally {
    await s.close();
  }
});

test('select_app leaves out the methods, shows the guide once per session and then points at its resource', async () => {
  const s = await setup();
  try {
    const first = await s.call('select_app', { app: 'kv-store' });
    const summary = JSON.parse(first.content[0].text!);
    assert.equal(summary.methods, undefined);
    assert.equal(summary.guide, 'calimero://apps/kv-id/1.0.0/guide');
    assert.equal(first.content[2].resource?.text, GUIDE);
    const again = await s.call('select_app', { app: 'kv-store' });
    assert.equal(again.content.length, 2);
    assert.equal(JSON.parse(again.content[0].text!).guide, 'calimero://apps/kv-id/1.0.0/guide');
  } finally {
    await s.close();
  }
});

test('describe_app always carries the guide, and select_app after a show says so and points at the resource', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 2; i++) assert.equal((await s.call('describe_app', { app: 'kv-store' })).content[2].resource?.text, GUIDE);
    const res = await s.call('select_app', { app: 'kv-store' });
    assert.equal(res.content.length, 2);
    assert.match(res.content[1].text!, /shown earlier this session.*calimero:\/\/apps\/kv-id\/1\.0\.0\/guide/);
    assert.equal(JSON.parse((await s.call('describe_app', { app: 'kv-store' })).content[0].text!).methods.length, 2);
  } finally {
    await s.close();
  }
});

test('a new app version shows its guide again, and verbose counts as a show', async () => {
  const s = await setup();
  try {
    await s.call('select_app', { app: 'kv-store', verbose: true });
    assert.equal((await s.call('select_app', { app: 'kv-store' })).content.length, 2);
    s.apps[0].version = '1.1.0';
    assert.equal((await s.call('select_app', { app: 'kv-store' })).content[2].resource?.text, GUIDE);
  } finally {
    await s.close();
  }
});

test('select_app with verbose restores the methods and the guide', async () => {
  const s = await setup();
  try {
    await s.call('select_app', { app: 'kv-store' });
    const res = await s.call('select_app', { app: 'kv-store', verbose: true });
    assert.equal(JSON.parse(res.content[0].text!).methods.length, 2);
    assert.equal(res.content[2].resource?.text, GUIDE);
  } finally {
    await s.close();
  }
});

test('call and generated tools run in a context named by id or alias, without an app_handle', async () => {
  const apps = [{ ...kv(), contexts: [ctx('kvctx'), ctx('kvtwo')] }];
  const s = await setup(apps, '2025-11-25', { aliases: { work: ctx('kvtwo') } });
  try {
    await s.call('call', { app: 'kv-store', context: 'work', method: 'set', args: { key: 'a' } });
    await s.call('call', { app: 'KV Store', context: ctx('kvctx'), method: 'set', args: { key: 'b' } });
    await s.call('kv_store_set', { context: 'work', key: 'c' });
    await s.call('kv_store_set', { context: ctx('kvctx'), key: 'd' });
    assert.deepEqual(s.executed.map((e) => [e.contextId, e.argsJson]), [
      [ctx('kvtwo'), { key: 'a' }],
      [ctx('kvctx'), { key: 'b' }],
      [ctx('kvtwo'), { key: 'c' }],
      [ctx('kvctx'), { key: 'd' }],
    ]);
  } finally {
    await s.close();
  }
});

test('call by context refuses what select_app refuses: another app context, an unknown context, no context', async () => {
  const s = await setup([kv(), plain()], '2025-11-25', { aliases: { theirs: ctx('notesctx') } });
  try {
    for (const context of [ctx('notesctx'), 'theirs']) {
      for (const run of [
        () => s.call('call', { app: 'kv-store', context, method: 'set', args: { key: 'k' } }),
        () => s.call('kv_store_set', { context, key: 'k' }),
      ]) {
        const res = await run();
        assert.equal(res.isError, true);
        assert.match(res.content[0].text!, /does not belong to/);
      }
    }
    const unknown = await s.call('call', { app: 'kv-store', context: 'nope', method: 'set', args: { key: 'k' } });
    assert.match(unknown.content[0].text!, /neither a context id nor an alias/);
    const bare = await s.call('call', { app: 'kv-store', method: 'set', args: { key: 'k' } });
    assert.equal(bare.content.at(-1)!.text, RETRY);
    assert.deepEqual(s.executed, []);
  } finally {
    await s.close();
  }
});

test('call and generated tools by context pick the service the context belongs to, and refuse the other service tools', async () => {
  const s = await setup([drive()]);
  try {
    await s.call('call', { app: 'mero-drive', context: ctx('regctx'), method: 'register_folder', args: { name: 'f' } });
    await s.call('mero_drive_docs_create_doc', { context: ctx('docsctx'), title: 't' });
    assert.deepEqual(s.executed.map((e) => [e.contextId, e.method]), [[ctx('regctx'), 'register_folder'], [ctx('docsctx'), 'create_doc']]);
    const crossed = await s.call('mero_drive_registry_register_folder', { context: ctx('docsctx'), name: 'f' });
    assert.equal(crossed.content.at(-1)!.text, 'Call select_app for com.calimero.mero-drive and retry with the returned app_handle.');
    assert.equal(s.executed.length, 2);
  } finally {
    await s.close();
  }
});

test('a method with its own context parameter keeps it and takes the handle only', async () => {
  const withContext: FakeApp = { ...plain(), abi: manifest([method('add', [{ name: 'context', type: { kind: 'string' } }])]) };
  const s = await setup([withContext]);
  try {
    const add = (await s.client.listTools()).tools.find((t) => t.name === 'notes_add')!;
    assert.equal((add.inputSchema.properties as Record<string, { description?: string }>).context.description, undefined);
    const { app_handle } = await s.json('select_app', { app: 'notes' });
    await s.call('notes_add', { app_handle, context: 'room' });
    assert.deepEqual(s.executed[0].argsJson, { context: 'room' });
    const noHandle = await s.call('notes_add', { context: 'room' });
    assert.equal(noHandle.isError, true);
  } finally {
    await s.close();
  }
});

test('an alias that is repointed is followed on the next call, never served from memory', async () => {
  const aliases = { work: ctx('kvctx') };
  const s = await setup([{ ...kv(), contexts: [ctx('kvctx'), ctx('kvtwo')] }], '2025-11-25', { aliases });
  try {
    await s.call('call', { app: 'kv-store', context: 'work', method: 'set', args: { key: 'a' } });
    aliases.work = ctx('kvtwo');
    await s.call('kv_store_set', { context: 'work', key: 'b' });
    assert.deepEqual(s.executed.map((e) => e.contextId), [ctx('kvctx'), ctx('kvtwo')]);
  } finally {
    await s.close();
  }
});

test('an app_handle and a context that name different contexts are refused, and the same one is accepted', async () => {
  const s = await setup([{ ...kv(), contexts: [ctx('kvctx'), ctx('kvtwo')] }], '2025-11-25', { aliases: { work: ctx('kvctx') } });
  try {
    const { app_handle } = await s.json('select_app', { app: 'kv-store', context: ctx('kvctx') });
    const args = { app_handle, key: 'k' };
    const callArgs = { app_handle, method: 'set', args: { key: 'k' } };
    for (const res of [
      await s.call('call', { ...callArgs, context: ctx('kvtwo') }),
      await s.call('kv_store_set', { ...args, context: ctx('kvtwo') }),
    ]) {
      assert.equal(res.isError, true);
      assert.match(res.content.at(-1)!.text!, /different contexts/);
    }
    assert.deepEqual(s.executed, []);
    assert.equal((await s.call('call', { ...callArgs, context: 'work' })).isError, undefined);
    assert.equal((await s.call('kv_store_set', { ...args, context: ctx('kvctx') })).isError, undefined);
  } finally {
    await s.close();
  }
});

test('call_many runs each call like call, in order, and one failure does not fail the batch', async () => {
  const apps = [{ ...kv(), contexts: [ctx('kvctx'), ctx('kvtwo')] }, plain()];
  const s = await setup(apps, '2025-11-25', { execute: (p) => ({ ran: p.method, in: p.contextId }) });
  try {
    const { app_handle } = await s.json('select_app', { app: 'notes' });
    const res = await s.call('call_many', {
      calls: [
        { app: 'kv-store', context: ctx('kvtwo'), method: 'set', args: { key: 'a' } },
        { app: 'kv-store', context: ctx('kvctx'), method: 'nope' },
        { app_handle, method: 'add', args: { body: 'x' } },
        { app: 'kv-store', method: 'set', args: { key: 'k' } },
        { app: 'kv-store', context: ctx('notesctx'), method: 'set', args: { key: 'k' } },
        { app: 'kv-store', context: ctx('kvctx'), method: 'set', args: {} },
        { app: 'kv-store', context: ctx('kvctx'), method: 'init' },
      ],
    });
    assert.equal(res.isError, undefined);
    const out = JSON.parse(res.content[0].text!);
    assert.equal(out.length, 7);
    assert.deepEqual(out[0], { ok: true, result: { ran: 'set', in: ctx('kvtwo') } });
    assert.match(out[1].error, /Method "nope" not found/);
    assert.deepEqual(out[2], { ok: true, result: { ran: 'add', in: ctx('notesctx') } });
    assert.equal(out[3].error, RETRY);
    assert.match(out[4].error, /does not belong to/);
    assert.equal(out[5].ok, false);
    assert.match(out[6].error, /init runs once/);
    assert.deepEqual(out.map((o: { ok: boolean }) => o.ok), [true, false, true, false, false, false, false]);
    assert.equal(s.executed.length, 2);
  } finally {
    await s.close();
  }
});

test('call_many refuses an empty or oversized batch before running anything', async () => {
  const s = await setup([kv()]);
  try {
    const one = { app: 'kv-store', context: ctx('kvctx'), method: 'set', args: { key: 'k' } };
    for (const calls of [[], Array.from({ length: 33 }, () => one), undefined]) {
      const res = await s.call('call_many', { calls });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text!, /calls/);
    }
    assert.deepEqual(s.executed, []);
    const advertised = (await s.client.listTools()).tools.find((t) => t.name === 'call_many')!;
    const schema = (advertised.inputSchema.properties as { calls: { minItems: number; maxItems: number } }).calls;
    assert.deepEqual([schema.minItems, schema.maxItems], [1, 32]);
  } finally {
    await s.close();
  }
});
