import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config.ts';
import type { NodeSession } from '../node.ts';
import { getSelection, registerAppTools } from './app.ts';

const CFG = { toolsets: new Set(['core']) } as Config;

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
type ToolConfig = { description?: string; inputSchema?: Record<string, z.ZodTypeAny>; annotations?: { readOnlyHint?: boolean } };

const method = (name: string, params: Array<{ name: string; type: string }> = [], intent = 'mutating') => ({
  name,
  params: params.map((p) => ({ name: p.name, type: { kind: p.type } })),
  returns: { kind: 'unit' },
  intent,
});
const manifest = (methods: unknown[]) => ({ schema_version: 'wasm-abi/1', types: {}, methods, events: [] });

/** Context ids are base58 32-byte hashes and the alias path keys on that shape, so a fixture id must have it too. */
const ctx = (label: string) => {
  assert.match(label, /^[1-9A-HJ-NP-Za-km-z]+$/, `${label} is not base58, so it would not read as a context id`);
  return label.padEnd(44, 'z');
};

const KV = { id: 'kv-id', package: 'com.calimero.kv-store', version: '0.1.0', blob: { bytecode: 'kv-blob', compiled: 'c' } };
const NOTES = { id: 'notes-id', package: 'notes', version: '0.2.0', blob: { bytecode: 'notes-blob', compiled: 'c' } };
// Sanitising `kv_store` and `kv-store` lands on one slug, while whole-segment resolution keeps them distinct inputs.
const TWIN = { id: 'twin-id', package: 'org.example.kv_store', version: '1.0.0', blob: { bytecode: 'twin-blob', compiled: 'c' } };
const BARE = { id: 'RawApp42', package: undefined, version: '0.0.1', blob: { bytecode: 'bare-blob', compiled: 'c' } };

const ABIS: Record<string, unknown> = {
  'kv-id': manifest([method('get', [{ name: 'key', type: 'string' }], 'read_only'), method('set', [{ name: 'key', type: 'string' }])]),
  'notes-id': manifest([method('add', [{ name: 'body', type: 'string' }]), method('get', [{ name: 'id', type: 'string' }], 'read_only')]),
  'twin-id': manifest([method('ping')]),
  RawApp42: manifest([method('ping')]),
};

const FIXED = ['describe_app', 'select_app', 'deselect_app', 'call'];

/** Mirrors the SDK: it validates against `inputSchema` before the handler ever runs. */
function fakeServer() {
  const tools = new Map<string, { config: ToolConfig; handler: (input: Record<string, unknown>) => Promise<ToolResult> }>();
  const removed: string[] = [];
  const server = {
    registerTool(name: string, config: ToolConfig, handler: (input: Record<string, unknown>) => Promise<ToolResult>) {
      tools.set(name, { config, handler });
      return {
        remove: () => {
          removed.push(name);
          tools.delete(name);
        },
      };
    },
  } as unknown as McpServer;

  return {
    server,
    removed,
    names: () => [...tools.keys()],
    config: (name: string) => tools.get(name)!.config,
    async call(name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} is not registered`);
      const shape = tool.config.inputSchema;
      if (!shape) return tool.handler(input);
      const parsed = z.object(shape).safeParse(input);
      if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
      return tool.handler(parsed.data as Record<string, unknown>);
    },
  };
}

type FakeContext = string | { id: string; serviceName?: string };

function fakeSession(
  opts: { contexts?: Record<string, FakeContext[]>; abis?: Record<string, unknown>; aliases?: Record<string, string> } = {},
) {
  const apps = [KV, NOTES, TWIN, BARE];
  const abis = opts.abis ?? ABIS;
  const executed: Array<Record<string, unknown>> = [];
  const lookups: string[] = [];
  const session = {
    url: 'http://localhost:2528',
    nodeName: 'test',
    authMode: 'none',
    mero: {
      admin: {
        listApplications: async () => ({ apps }),
        getApplication: async (id: string) => ({ application: apps.find((a) => a.id === id) ?? null }),
        getApplicationAbi: async (id: string) => abis[id],
        getContextsForApplication: async (id: string) => ({
          contexts: (opts.contexts?.[id] ?? [ctx('ctxone')]).map((c) => (typeof c === 'string' ? { id: c } : c)),
        }),
        // Mirrors core: a miss is a 200 carrying a null value, not a throw.
        lookupContextAlias: async (name: string) => {
          lookups.push(name);
          return { value: opts.aliases?.[name] ?? null };
        },
      },
      rpc: {
        execute: async (params: Record<string, unknown>) => {
          executed.push(params);
          return { ok: true };
        },
      },
    },
  } as unknown as NodeSession;
  return { session, executed, lookups };
}

function setup(opts: Parameters<typeof fakeSession>[0] = {}) {
  const srv = fakeServer();
  const { session, executed, lookups } = fakeSession(opts);
  registerAppTools(srv.server, session, CFG);
  return { ...srv, executed, lookups };
}

const text = (res: ToolResult) => res.content[0].text;

test('the fixed tools register before anything is selected', () => {
  const { names } = setup();
  assert.deepEqual(names(), FIXED);
});

test('describe_app returns the signatures and identity without selecting', async () => {
  const { call, names } = setup();
  const described = JSON.parse(text(await call('describe_app', { app: 'kv-store' })));
  assert.deepEqual(described.methods, ['[view] get(key: string) -> unit', '[mut] set(key: string) -> unit']);
  assert.deepEqual(
    { application: described.application, package: described.package, version: described.version, service: described.service },
    { application: 'kv-id', package: 'com.calimero.kv-store', version: '0.1.0', service: null },
  );
  assert.deepEqual(names(), FIXED);
});

test('select_app registers one tool per ABI method, prefixed by the package name', async () => {
  const { call, names } = setup();
  const summary = JSON.parse(text(await call('select_app', { app: 'kv-store' })));
  assert.deepEqual(names(), [...FIXED, 'kv_store_get', 'kv_store_set']);
  assert.deepEqual(summary.tools, ['kv_store_get', 'kv_store_set']);
  assert.equal(summary.context, ctx('ctxone'));
});

test('an application with no package falls back to its id for the prefix', async () => {
  const { call, names } = setup();
  const summary = JSON.parse(text(await call('select_app', { app: 'RawApp42' })));
  assert.deepEqual(summary.tools, ['rawapp42_ping']);
  assert.deepEqual(names(), [...FIXED, 'rawapp42_ping']);
});

test('a named service prefixes the tool names', async () => {
  const { call, names } = setup();
  await call('select_app', { app: 'kv-store', service: 'api' });
  assert.ok(names().includes('kv_store_api_get'));
});

test('readOnlyHint marks view methods only', async () => {
  const { call, config } = setup();
  await call('select_app', { app: 'kv-store' });
  assert.deepEqual(config('kv_store_get').annotations, { readOnlyHint: true });
  assert.equal(config('kv_store_set').annotations, undefined);
});

test('two applications stay selected at once, each with its own tools and schema', async () => {
  const { call, names, config } = setup();
  await call('select_app', { app: 'kv-store' });
  const summary = JSON.parse(text(await call('select_app', { app: 'notes' })));
  assert.deepEqual(names(), [...FIXED, 'kv_store_get', 'kv_store_set', 'notes_add', 'notes_get']);
  assert.deepEqual(Object.keys(config('kv_store_set').inputSchema!), ['_context', 'key']);
  assert.deepEqual(Object.keys(config('notes_add').inputSchema!), ['_context', 'body']);
  assert.deepEqual(
    summary.selected.map((s: { application: string; context: string }) => [s.application, s.context]),
    [['kv-id', ctx('ctxone')], ['notes-id', ctx('ctxone')]],
  );
  assert.equal(summary.toolCount, 4);
  assert.equal(summary.warning, undefined);
});

test('two applications declaring the same method get distinct tools that reach their own app', async () => {
  const { call, names, executed } = setup({ contexts: { 'kv-id': [ctx('kvctx')], 'notes-id': [ctx('notesctx')] } });
  await call('select_app', { app: 'kv-store' });
  await call('select_app', { app: 'notes' });
  assert.ok(names().includes('kv_store_get') && names().includes('notes_get'));
  await call('kv_store_get', { key: 'k' });
  await call('notes_get', { id: '7' });
  assert.deepEqual(executed, [
    { contextId: ctx('kvctx'), method: 'get', argsJson: { key: 'k' } },
    { contextId: ctx('notesctx'), method: 'get', argsJson: { id: '7' } },
  ]);
});

test('two packages that sanitise to one prefix are disambiguated by application id', async () => {
  const { call, names } = setup();
  await call('select_app', { app: 'kv-store' });
  const twin = JSON.parse(text(await call('select_app', { app: 'kv_store' })));
  assert.deepEqual(twin.tools, ['kv_store_twinid_ping']);
  assert.deepEqual(names(), [...FIXED, 'kv_store_get', 'kv_store_set', 'kv_store_twinid_ping']);
});

test('re-selecting an application refreshes its tools instead of duplicating them', async () => {
  const { call, names, removed } = setup();
  await call('select_app', { app: 'kv-store' });
  const again = JSON.parse(text(await call('select_app', { app: 'kv-store' })));
  assert.deepEqual(removed, ['kv_store_get', 'kv_store_set']);
  assert.deepEqual(names(), [...FIXED, 'kv_store_get', 'kv_store_set']);
  assert.deepEqual(again.tools, ['kv_store_get', 'kv_store_set']);
  assert.equal(again.selected.length, 1);
  assert.equal(again.toolCount, 2);
});

test('deselect_app removes one application and leaves the other registered and callable', async () => {
  const { call, names, removed, executed } = setup({ contexts: { 'notes-id': [ctx('notesctx')] } });
  await call('select_app', { app: 'kv-store' });
  await call('select_app', { app: 'notes' });
  const res = JSON.parse(text(await call('deselect_app', { app: 'kv-store' })));
  assert.deepEqual(removed, ['kv_store_get', 'kv_store_set']);
  assert.deepEqual(names(), [...FIXED, 'notes_add', 'notes_get']);
  assert.deepEqual(res.selected.map((s: { application: string }) => s.application), ['notes-id']);
  assert.equal(res.toolCount, 2);
  await call('notes_add', { body: 'hi' });
  assert.deepEqual(executed, [{ contextId: ctx('notesctx'), method: 'add', argsJson: { body: 'hi' } }]);
});

test('deselect_app on an application that is not selected says which ones are', async () => {
  const { call } = setup();
  await call('select_app', { app: 'kv-store' });
  const res = await call('deselect_app', { app: 'notes' });
  assert.equal(res.isError, true);
  assert.match(text(res), /"notes" is not selected\. Selected: kv-store/);
});

test('past the tool-count threshold select_app warns but still registers', async () => {
  const many = manifest(Array.from({ length: 81 }, (_, i) => method(`m${i}`)));
  const { call, names } = setup({ abis: { ...ABIS, 'kv-id': many } });
  const summary = JSON.parse(text(await call('select_app', { app: 'kv-store' })));
  assert.equal(summary.toolCount, 81);
  assert.match(summary.warning, /81 application tools/);
  assert.ok(names().includes('kv_store_m80'));
});

test('node_status reports every selected application and its own pinned context', async () => {
  const { call } = setup({ contexts: { 'kv-id': [ctx('kvctx')], 'notes-id': [ctx('notesctx')] } });
  await call('select_app', { app: 'kv-store' });
  await call('select_app', { app: 'notes' });
  assert.deepEqual(getSelection().selected, [
    { application: 'kv-id', package: 'com.calimero.kv-store', service: null, context: ctx('kvctx'), tools: 2 },
    { application: 'notes-id', package: 'notes', service: null, context: ctx('notesctx'), tools: 2 },
  ]);
});

test('an argument that violates the derived schema never reaches rpc.execute', async () => {
  const { call, executed } = setup();
  await call('select_app', { app: 'kv-store' });
  const res = await call('kv_store_set', { key: 42 });
  assert.equal(res.isError, true);
  assert.deepEqual(executed, []);
});

test('a valid call reaches rpc.execute with exactly contextId, method and argsJson', async () => {
  const { call, executed } = setup();
  await call('select_app', { app: 'kv-store' });
  await call('kv_store_set', { key: 'k' });
  assert.deepEqual(executed, [{ contextId: ctx('ctxone'), method: 'set', argsJson: { key: 'k' } }]);
  assert.deepEqual(Object.keys(executed[0]), ['contextId', 'method', 'argsJson']);
});

test('an explicit context beats the pinned one', async () => {
  const { call, executed } = setup({ contexts: { 'kv-id': [ctx('ctxa'), ctx('ctxb')] } });
  await call('select_app', { app: 'kv-store', context: ctx('ctxpinned') });
  await call('kv_store_set', { key: 'k' });
  await call('kv_store_set', { key: 'k', _context: ctx('ctxdirect') });
  assert.deepEqual(executed.map((e) => e.contextId), [ctx('ctxpinned'), ctx('ctxdirect')]);
});

test('with several contexts and no pin, the error lists the candidates', async () => {
  const ids = [ctx('ctxa'), ctx('ctxb'), ctx('ctxc')];
  const { call, executed } = setup({ contexts: { 'kv-id': ids } });
  const summary = JSON.parse(text(await call('select_app', { app: 'kv-store' })));
  assert.equal(summary.context, null);
  assert.equal(summary.note, `Application "kv-store" has 3 contexts; pass context with one of: ${ids.join(', ')}`);

  const res = await call('kv_store_set', { key: 'k' });
  assert.equal(res.isError, true);
  assert.ok(text(res).includes(ids.join(', ')));
  assert.deepEqual(executed, []);
});

test('with zero contexts the message points at the desktop app and create_context', async () => {
  const { call } = setup({ contexts: { 'kv-id': [] } });
  const summary = JSON.parse(text(await call('select_app', { app: 'kv-store' })));
  const expected =
    'Application "kv-store" has no contexts on this node. Create one in the Calimero desktop app, or use create_context.';
  assert.equal(summary.note, expected);
  assert.equal(text(await call('kv_store_set', { key: 'k' })), `Error: ${expected}`);
});

test('the pin of the selected app does not leak into a call against another app', async () => {
  const { call, executed } = setup({ contexts: { 'notes-id': [ctx('notesctx')] } });
  await call('select_app', { app: 'kv-store', context: ctx('kvctx') });
  await call('call', { app: 'notes', method: 'add', args: { body: 'hi' } });
  assert.equal(executed[0].contextId, ctx('notesctx'));
});

test('a context pinned for one selected application is never used by another', async () => {
  const ids = [ctx('na'), ctx('nb')];
  const { call, executed } = setup({ contexts: { 'notes-id': ids } });
  await call('select_app', { app: 'kv-store', context: ctx('kvctx') });
  await call('select_app', { app: 'notes' });

  const res = await call('notes_add', { body: 'hi' });
  assert.equal(res.isError, true);
  assert.equal(text(res), `Error: Application "notes" has 2 contexts; pass context with one of: ${ids.join(', ')}`);
  assert.deepEqual(executed, []);

  await call('kv_store_set', { key: 'k' });
  assert.deepEqual(executed, [{ contextId: ctx('kvctx'), method: 'set', argsJson: { key: 'k' } }]);
});

test('_context targets a call on whichever selected application it is passed to', async () => {
  const { call, executed } = setup({ contexts: { 'notes-id': [ctx('na'), ctx('nb')] } });
  await call('select_app', { app: 'kv-store', context: ctx('kvctx') });
  await call('select_app', { app: 'notes' });
  await call('notes_add', { body: 'hi', _context: ctx('nb') });
  await call('kv_store_set', { key: 'k', _context: ctx('kvother') });
  assert.deepEqual(executed.map((e) => e.contextId), [ctx('nb'), ctx('kvother')]);
});

test('call without `app` while several are selected asks which one', async () => {
  const { call } = setup();
  await call('select_app', { app: 'kv-store' });
  await call('select_app', { app: 'notes' });
  const res = await call('call', { method: 'get', args: { key: 'k' } });
  assert.equal(res.isError, true);
  assert.match(text(res), /Several applications are selected \(kv-store, notes\); pass `app` to choose one/);
});

test('a method with a parameter named context still receives its own argument', async () => {
  const abis = { 'kv-id': manifest([method('note', [{ name: 'context', type: 'string' }])]) };
  const { call, executed } = setup({ abis, contexts: { 'kv-id': [ctx('ctxone')] } });
  await call('select_app', { app: 'kv-store' });
  await call('kv_store_note', { context: 'the app owns this' });
  assert.deepEqual(executed, [{ contextId: ctx('ctxone'), method: 'note', argsJson: { context: 'the app owns this' } }]);
});

test('a method with a parameter named context can still be targeted with _context', async () => {
  const abis = { 'kv-id': manifest([method('note', [{ name: 'context', type: 'string' }])]) };
  const { call, executed } = setup({ abis, contexts: { 'kv-id': [ctx('ctxa'), ctx('ctxb')] } });
  await call('select_app', { app: 'kv-store', context: ctx('ctxpinned') });
  await call('kv_store_note', { context: 'the app owns this', _context: ctx('ctxdirect') });
  // The option targets the call and never reaches the app; the param reaches the app and never targets the call.
  assert.deepEqual(executed, [{ contextId: ctx('ctxdirect'), method: 'note', argsJson: { context: 'the app owns this' } }]);
});

test('call validates against the same derived schema', async () => {
  const { call, executed } = setup();
  await call('select_app', { app: 'kv-store' });
  const res = await call('call', { method: 'set', args: { key: 42 } });
  assert.equal(res.isError, true);
  assert.deepEqual(executed, []);
});

test('call reaches the same method as the dynamic tool', async () => {
  const { call, executed } = setup();
  await call('select_app', { app: 'kv-store' });
  await call('call', { method: 'set', args: { key: 'k' }, context: ctx('ctxdirect') });
  assert.deepEqual(executed, [{ contextId: ctx('ctxdirect'), method: 'set', argsJson: { key: 'k' } }]);
});

test('call without a selection says how to get one', async () => {
  const { call } = setup();
  const res = await call('call', { method: 'set', args: { key: 'k' } });
  assert.equal(res.isError, true);
  assert.match(text(res), /Pass `app`, or run select_app first/);
});

test('call on an unknown method lists what the app exposes', async () => {
  const { call } = setup();
  const res = await call('call', { app: 'kv-store', method: 'nope' });
  assert.match(text(res), /Method "nope" not found on "kv-store"\. Available: get, set/);
});

test('an alias passed as _context resolves, and the call reaches that context', async () => {
  const contexts = { 'kv-id': [ctx('kvctx'), ctx('kvtwo')] };
  const { call, executed } = setup({ contexts, aliases: { core: ctx('kvctx') } });
  await call('select_app', { app: 'kv-store', context: ctx('kvtwo') });
  await call('kv_store_set', { key: 'k', _context: 'core' });
  assert.deepEqual(executed, [{ contextId: ctx('kvctx'), method: 'set', argsJson: { key: 'k' } }]);
});

test("call's context option resolves an alias too", async () => {
  const { call, executed } = setup({ aliases: { work: ctx('kvctx') } });
  await call('select_app', { app: 'kv-store' });
  await call('call', { method: 'set', args: { key: 'k' }, context: 'work' });
  assert.deepEqual(executed, [{ contextId: ctx('kvctx'), method: 'set', argsJson: { key: 'k' } }]);
});

test('a context id is used as passed, without an alias lookup', async () => {
  const { call, executed, lookups } = setup();
  await call('select_app', { app: 'kv-store' });
  await call('kv_store_set', { key: 'k', _context: ctx('kvraw') });
  assert.deepEqual(executed, [{ contextId: ctx('kvraw'), method: 'set', argsJson: { key: 'k' } }]);
  assert.deepEqual(lookups, []);
});

test('a context that is neither an id nor an alias names it and lists the candidates', async () => {
  const ids = [ctx('kvctx'), ctx('kvtwo')];
  const { call, executed } = setup({ contexts: { 'kv-id': ids } });
  await call('select_app', { app: 'kv-store', context: ctx('kvctx') });
  const res = await call('kv_store_set', { key: 'k', _context: 'core' });
  assert.equal(res.isError, true);
  assert.equal(
    text(res),
    `Error: Context "core" not found: it is neither a context id nor an alias on this node. ` +
      `Contexts for "kv-store": ${ids.join(', ')}`,
  );
  assert.deepEqual(executed, []);
});

test('a resolved alias is looked up once, and a failed resolution is never remembered', async () => {
  const { call, lookups } = setup({ aliases: { core: ctx('kvctx') } });
  await call('select_app', { app: 'kv-store' });
  await call('kv_store_set', { key: 'k', _context: 'core' });
  await call('kv_store_set', { key: 'k', _context: 'core' });
  assert.deepEqual(lookups, ['core']);

  assert.equal((await call('kv_store_set', { key: 'k', _context: 'nope' })).isError, true);
  assert.equal((await call('kv_store_set', { key: 'k', _context: 'nope' })).isError, true);
  assert.deepEqual(lookups, ['core', 'nope', 'nope']);
});

test('select_app pins an alias by the context id it resolves to', async () => {
  const contexts = { 'kv-id': [ctx('kvctx'), ctx('kvtwo')] };
  const { call, executed } = setup({ contexts, aliases: { core: ctx('kvctx') } });
  const summary = JSON.parse(text(await call('select_app', { app: 'kv-store', context: 'core' })));
  assert.equal(summary.context, ctx('kvctx'));
  assert.equal(getSelection().selected[0].context, ctx('kvctx'));
  await call('kv_store_set', { key: 'k' });
  assert.deepEqual(executed, [{ contextId: ctx('kvctx'), method: 'set', argsJson: { key: 'k' } }]);
});

test('a pin that resolves to nothing leaves the selection it would have replaced alone', async () => {
  const { call, names, removed } = setup();
  await call('select_app', { app: 'kv-store' });
  const res = await call('select_app', { app: 'kv-store', context: 'nope' });
  assert.equal(res.isError, true);
  assert.deepEqual(removed, []);
  assert.deepEqual(names(), [...FIXED, 'kv_store_get', 'kv_store_set']);
  assert.equal(getSelection().selected[0].context, ctx('ctxone'));
});

test('describe_app reports the service name its contexts carry', async () => {
  const { call } = setup({ contexts: { 'kv-id': [{ id: ctx('kvctx'), serviceName: 'issue-tracker' }] } });
  const described = JSON.parse(text(await call('describe_app', { app: 'kv-store' })));
  assert.equal(described.service, 'issue-tracker');
  assert.deepEqual(described.contextServices, ['issue-tracker']);
  assert.equal(described.serviceNote, undefined);
});

test('describe_app lists every service in use and names none when the contexts disagree', async () => {
  const contexts = [{ id: ctx('kvctx'), serviceName: 'api' }, { id: ctx('kvtwo'), serviceName: 'worker' }];
  const { call } = setup({ contexts: { 'kv-id': contexts } });
  const described = JSON.parse(text(await call('describe_app', { app: 'kv-store' })));
  assert.equal(described.service, null);
  assert.deepEqual(described.contextServices, ['api', 'worker']);
});

test('describe_app says a service name is not discoverable when no context carries one', async () => {
  const { call } = setup({ contexts: { 'kv-id': [] } });
  const described = JSON.parse(text(await call('describe_app', { app: 'kv-store' })));
  assert.equal(described.service, null);
  assert.deepEqual(described.contextServices, []);
  assert.match(described.serviceNote, /^Not discoverable: a node exposes no service list/);
});

test('a requested service is reported even with no context to confirm it', async () => {
  const { call } = setup({ contexts: { 'kv-id': [] } });
  const described = JSON.parse(text(await call('describe_app', { app: 'kv-store', service: 'api' })));
  assert.equal(described.service, 'api');
  assert.equal(described.serviceNote, undefined);
});

test('select_app marks its tool names as the server-side ones a client may prefix', async () => {
  const { call } = setup();
  const summary = JSON.parse(text(await call('select_app', { app: 'kv-store' })));
  assert.deepEqual(summary.tools, ['kv_store_get', 'kv_store_set']);
  assert.match(summary.toolsNote, /server-side tool names/);
  assert.match(summary.toolsNote, /mcp__<server>__<tool>/);
});
