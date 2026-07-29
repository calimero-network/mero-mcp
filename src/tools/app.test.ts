import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.ts';
import type { NodeSession } from '../node.ts';
import { registerAppTools } from './app.ts';

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

const KV = { id: 'kv-id', package: 'kv-store', version: '0.1.0', blob: { bytecode: 'kv-blob', compiled: 'c' } };
const NOTES = { id: 'notes-id', package: 'notes', version: '0.2.0', blob: { bytecode: 'notes-blob', compiled: 'c' } };

const ABIS: Record<string, unknown> = {
  'kv-id': manifest([method('get', [{ name: 'key', type: 'string' }], 'read_only'), method('set', [{ name: 'key', type: 'string' }])]),
  'notes-id': manifest([method('add', [{ name: 'body', type: 'string' }])]),
};

/** Mirrors the SDK: it validates against `inputSchema` before the handler ever runs. */
function fakeServer() {
  const tools = new Map<string, { config: ToolConfig; handler: (input: Record<string, unknown>) => Promise<ToolResult> }>();
  const removed: string[] = [];
  const server = {
    registerTool(name: string, config: ToolConfig, handler: (input: Record<string, unknown>) => Promise<ToolResult>) {
      tools.set(name, { config, handler });
      return { remove: () => removed.push(name) };
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

function fakeSession(opts: { contexts?: Record<string, string[]>; abis?: Record<string, unknown> } = {}) {
  const apps = [KV, NOTES];
  const abis = opts.abis ?? ABIS;
  const executed: Array<Record<string, unknown>> = [];
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
          contexts: (opts.contexts?.[id] ?? ['ctx-only']).map((c) => ({ id: c })),
        }),
      },
      rpc: {
        execute: async (params: Record<string, unknown>) => {
          executed.push(params);
          return { ok: true };
        },
      },
    },
  } as unknown as NodeSession;
  return { session, executed };
}

function setup(opts: Parameters<typeof fakeSession>[0] = {}) {
  const srv = fakeServer();
  const { session, executed } = fakeSession(opts);
  registerAppTools(srv.server, session, CFG);
  return { ...srv, executed };
}

const text = (res: ToolResult) => res.content[0].text;

test('the fixed tools register before anything is selected', () => {
  const { names } = setup();
  assert.deepEqual(names(), ['describe_app', 'select_app', 'call']);
});

test('describe_app returns the signatures and identity without selecting', async () => {
  const { call, names } = setup();
  const described = JSON.parse(text(await call('describe_app', { app: 'kv-store' })));
  assert.deepEqual(described.methods, ['[view] get(key: string) -> unit', '[mut] set(key: string) -> unit']);
  assert.deepEqual(
    { application: described.application, package: described.package, version: described.version, service: described.service },
    { application: 'kv-id', package: 'kv-store', version: '0.1.0', service: null },
  );
  assert.deepEqual(names(), ['describe_app', 'select_app', 'call']);
});

test('select_app registers one app_ tool per ABI method', async () => {
  const { call, names } = setup();
  const summary = JSON.parse(text(await call('select_app', { app: 'kv-store' })));
  assert.deepEqual(names(), ['describe_app', 'select_app', 'call', 'app_get', 'app_set']);
  assert.deepEqual(summary.tools, ['app_get', 'app_set']);
  assert.equal(summary.context, 'ctx-only');
});

test('a named service prefixes the tool names', async () => {
  const { call, names } = setup();
  await call('select_app', { app: 'kv-store', service: 'api' });
  assert.ok(names().includes('app_api_get'));
});

test('readOnlyHint marks view methods only', async () => {
  const { call, config } = setup();
  await call('select_app', { app: 'kv-store' });
  assert.deepEqual(config('app_get').annotations, { readOnlyHint: true });
  assert.equal(config('app_set').annotations, undefined);
});

test('selecting a second app removes every tool of the first', async () => {
  const { call, names, removed } = setup();
  await call('select_app', { app: 'kv-store' });
  await call('select_app', { app: 'notes' });
  assert.deepEqual(removed, ['app_get', 'app_set']);
  assert.deepEqual(names(), ['describe_app', 'select_app', 'call', 'app_get', 'app_set', 'app_add']);
  const stale = JSON.parse(text(await call('select_app', { app: 'notes' })));
  assert.deepEqual(stale.tools, ['app_add']);
});

test('an argument that violates the derived schema never reaches rpc.execute', async () => {
  const { call, executed } = setup();
  await call('select_app', { app: 'kv-store' });
  const res = await call('app_set', { key: 42 });
  assert.equal(res.isError, true);
  assert.deepEqual(executed, []);
});

test('a valid call reaches rpc.execute with exactly contextId, method and argsJson', async () => {
  const { call, executed } = setup();
  await call('select_app', { app: 'kv-store' });
  await call('app_set', { key: 'k' });
  assert.deepEqual(executed, [{ contextId: 'ctx-only', method: 'set', argsJson: { key: 'k' } }]);
  assert.deepEqual(Object.keys(executed[0]), ['contextId', 'method', 'argsJson']);
});

test('an explicit context beats the pinned one', async () => {
  const { call, executed } = setup({ contexts: { 'kv-id': ['ctx-a', 'ctx-b'] } });
  await call('select_app', { app: 'kv-store', context: 'ctx-pinned' });
  await call('app_set', { key: 'k' });
  await call('app_set', { key: 'k', _context: 'ctx-explicit' });
  assert.deepEqual(executed.map((e) => e.contextId), ['ctx-pinned', 'ctx-explicit']);
});

test('with several contexts and no pin, the error lists the candidates', async () => {
  const { call, executed } = setup({ contexts: { 'kv-id': ['ctx-a', 'ctx-b', 'ctx-c'] } });
  const summary = JSON.parse(text(await call('select_app', { app: 'kv-store' })));
  assert.equal(summary.context, null);
  assert.match(summary.note, /3 contexts; pass context with one of: ctx-a, ctx-b, ctx-c/);

  const res = await call('app_set', { key: 'k' });
  assert.equal(res.isError, true);
  assert.match(text(res), /ctx-a, ctx-b, ctx-c/);
  assert.deepEqual(executed, []);
});

test('with zero contexts the message points at the desktop app and create_context', async () => {
  const { call } = setup({ contexts: { 'kv-id': [] } });
  const summary = JSON.parse(text(await call('select_app', { app: 'kv-store' })));
  const expected =
    'Application "kv-store" has no contexts on this node. Create one in the Calimero desktop app, or use create_context.';
  assert.equal(summary.note, expected);
  assert.equal(text(await call('app_set', { key: 'k' })), `Error: ${expected}`);
});

test('the pin of the selected app does not leak into a call against another app', async () => {
  const { call, executed } = setup({ contexts: { 'notes-id': ['notes-ctx'] } });
  await call('select_app', { app: 'kv-store', context: 'kv-ctx' });
  await call('call', { app: 'notes', method: 'add', args: { body: 'hi' } });
  assert.equal(executed[0].contextId, 'notes-ctx');
});

test('a method with a parameter named context still receives its own argument', async () => {
  const abis = { 'kv-id': manifest([method('note', [{ name: 'context', type: 'string' }])]) };
  const { call, executed } = setup({ abis, contexts: { 'kv-id': ['ctx-only'] } });
  await call('select_app', { app: 'kv-store' });
  await call('app_note', { context: 'the app owns this' });
  assert.deepEqual(executed, [{ contextId: 'ctx-only', method: 'note', argsJson: { context: 'the app owns this' } }]);
});

test('a method with a parameter named context can still be targeted with _context', async () => {
  const abis = { 'kv-id': manifest([method('note', [{ name: 'context', type: 'string' }])]) };
  const { call, executed } = setup({ abis, contexts: { 'kv-id': ['ctx-a', 'ctx-b'] } });
  await call('select_app', { app: 'kv-store', context: 'ctx-pinned' });
  await call('app_note', { context: 'the app owns this', _context: 'ctx-explicit' });
  // The option targets the call and never reaches the app; the param reaches the app and never targets the call.
  assert.deepEqual(executed, [{ contextId: 'ctx-explicit', method: 'note', argsJson: { context: 'the app owns this' } }]);
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
  await call('call', { method: 'set', args: { key: 'k' }, context: 'ctx-explicit' });
  assert.deepEqual(executed, [{ contextId: 'ctx-explicit', method: 'set', argsJson: { key: 'k' } }]);
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
