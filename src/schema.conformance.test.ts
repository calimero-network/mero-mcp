import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbiManifest, type AbiManifest } from '@calimero-network/abi-codegen';
import { INIT_METHOD } from './abi.ts';
import { loadConfig } from './config.ts';
import { inputShapeForMethod } from './schema.ts';
import { createServerFactory } from './server.ts';
import { connect } from '../test/support/connect.ts';
import { fakeNode } from '../test/support/node.ts';

// Committed straight from core's own builds, so a change to the ABI format fails here rather than in production.
const FIXTURES = join(fileURLToPath(new URL('../test/fixtures/abi/', import.meta.url)));

const raw = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

const load = (name: string): AbiManifest => parseAbiManifest(raw(name));

const CFG = loadConfig({ HOME: '/x' } as NodeJS.ProcessEnv);

const EXPECTED_METHOD_COUNTS: Record<string, number> = {
  'kv-store': 11,
  abi_conformance: 41,
  'scaffolding-e2e': 91,
};

/**
 * Methods whose input cannot be represented and legitimately fall back to `z.unknown()`.
 * Empty, so any new ABI construct that slips through unhandled fails the count instead of passing as "supported".
 */
const UNREPRESENTABLE: string[] = [];

// Zod v4 keeps a schema's children on `_zod.def` under per-type keys (element, options, shape, ...), so walk it generically.
type Def = { type?: string } & Record<string, unknown>;
const defOf = (s: unknown): Def | undefined => (s as { _zod?: { def?: Def } } | null)?._zod?.def;

/** Every path inside `schema` that bottomed out at `z.unknown()`. */
function unknownPaths(schema: unknown, path: string, seen = new Set<unknown>()): string[] {
  const def = defOf(schema);
  if (!def || seen.has(schema)) return [];
  seen.add(schema);
  if (def.type === 'unknown') return [path];
  // A named ABI type is a lazy schema; its body is where an unknown would hide.
  if (def.type === 'lazy') return unknownPaths((schema as { _zod: { innerType: unknown } })._zod.innerType, path, seen);

  const out: string[] = [];
  const visit = (child: unknown, key: string) => out.push(...unknownPaths(child, `${path}.${key}`, seen));
  for (const [key, value] of Object.entries(def)) {
    if (key === 'type') continue;
    if (defOf(value)) visit(value, key);
    else if (Array.isArray(value)) value.forEach((entry, i) => visit(entry, `${key}[${i}]`));
    else if (value && typeof value === 'object') for (const [inner, child] of Object.entries(value)) visit(child, inner);
  }
  return out;
}

const degradedMethods = (m: AbiManifest): string[] =>
  m.methods
    .filter((method) =>
      Object.entries(inputShapeForMethod(method, m)).some(([param, schema]) => unknownPaths(schema, param).length > 0),
    )
    .map((method) => method.name);

/** The fixture installed as package `name` on a fake node, and the tools a real server generates for it, keyed by method. */
async function listTools(name: string) {
  const { session } = fakeNode([{ id: `${name}-id`, package: name, version: '1.0.0', abi: raw(name) }]);
  const { client, close } = await connect(createServerFactory(session, CFG), '2026-07-28');
  try {
    const prefix = `${name.replace(/[^a-z0-9_]+/g, '_')}_`;
    const tools = (await client.listTools()).tools.filter((t) => t.name.startsWith(prefix));
    return new Map(tools.map((t) => [t.name.slice(prefix.length), t]));
  } finally {
    await close();
  }
}

test('the unknown-detector fires on a construct the deriver cannot represent, even inside a named type', () => {
  // Control case: without it, "zero degraded methods" would also hold if the walker simply never looked.
  // Built by hand: parseAbiManifest would reject the unknown kind before the deriver ever saw it.
  const m = {
    schema_version: 'wasm-abi/1',
    types: { Holder: { kind: 'record', fields: [{ name: 'inner', type: { kind: 'future_kind' } }] } },
    methods: [{ name: 'takes_future', params: [{ name: 'p', type: { $ref: 'Holder' } }], intent: 'mutating' }],
    events: [],
  } as unknown as AbiManifest;
  assert.deepEqual(degradedMethods(m), ['takes_future']);
  assert.deepEqual(unknownPaths(inputShapeForMethod(m.methods[0], m)['p'], 'p'), ['p.inner']);
});

for (const [name, count] of Object.entries(EXPECTED_METHOD_COUNTS)) {
  test(`${name}: every ABI method derives an input schema`, () => {
    const m = load(name);
    assert.equal(m.methods.length, count);
    for (const method of m.methods) {
      const shape = inputShapeForMethod(method, m);
      for (const param of method.params) assert.ok(shape[param.name], `${method.name}: no schema for ${param.name}`);
    }
  });

  test(`${name}: no method silently degrades to unknown`, () => {
    assert.deepEqual(degradedMethods(load(name)), UNREPRESENTABLE);
  });

  // tools/list is where the SDK converts every registered shape, so a schema it cannot render fails here and nowhere earlier.
  // init runs once through create_context, so it never gets its own generated tool.
  test(`${name}: every method registers as a generated tool and converts to JSON Schema through the MCP SDK`, async () => {
    const tools = await listTools(name);
    const expected = load(name)
      .methods.filter((x) => x.name !== INIT_METHOD)
      .map((x) => x.name);
    assert.deepEqual([...tools.keys()].sort(), expected.sort());
    for (const [method, tool] of tools) {
      assert.equal(tool.inputSchema.type, 'object', `${method} is not an object schema`);
      assert.equal(typeof tool.inputSchema.properties, 'object', `${method} advertises no properties`);
    }
  });
}

test('scaffolding-e2e: 90 methods register under one server at once, each under its own name', async () => {
  assert.equal((await listTools('scaffolding-e2e')).size, 90);
});

test('kv-store: set(key, value) advertises exactly those two required properties beside the app_handle', async () => {
  const set = (await listTools('kv-store')).get('set');
  assert.ok(set, 'kv-store fixture has no set method');
  const schema = set.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(schema.properties).sort(), ['app_handle', 'key', 'value']);
  assert.deepEqual([...(schema.required ?? [])].sort(), ['app_handle', 'key', 'value']);
});

test('abi_conformance: its method and parameter docs reach tools/list', async () => {
  const documented = load('abi_conformance').methods.filter((x) => x.doc);
  assert.ok(documented.length > 0, 'abi_conformance carries no docs: refresh it from core apps/abi_conformance/abi.expected.json');
  const tools = await listTools('abi_conformance');
  for (const method of documented) {
    const tool = tools.get(method.name);
    assert.ok(tool, `${method.name} is not listed`);
    assert.ok(tool.description?.startsWith(`${method.doc}\n\n`), `${method.name}: its doc is missing from the description`);
    const props = tool.inputSchema.properties as Record<string, { description?: string }>;
    for (const p of method.params.filter((x) => x.doc)) {
      assert.ok(props[p.name].description?.startsWith(p.doc!), `${method.name}(${p.name}): its doc is missing from the schema`);
    }
  }
});

test('abi_conformance: hints, a returns_doc and a variant doc from core reach the tools', async () => {
  const tools = await listTools('abi_conformance');
  assert.equal(tools.get('drop_counter')!.annotations?.destructiveHint, true);
  assert.equal(tools.get('xcall_noop')!.annotations?.idempotentHint, true);
  const status = tools.get('get_status')!.outputSchema as { description?: string; oneOf?: Array<{ const?: string; description?: string }> };
  assert.equal(status.description, 'The `Active` status stamped with `timestamp`.');
  assert.equal(status.oneOf?.find((v) => v.const === 'Pending')?.description, 'Waiting to start.');
});
