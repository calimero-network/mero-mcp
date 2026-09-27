import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbiManifest, type AbiManifest } from '@calimero-network/abi-codegen';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { inputShapeForMethod } from './schema.ts';

// Committed straight from core's own builds, so a change to the ABI format fails here rather than in production.
const FIXTURES = join(fileURLToPath(new URL('../test/fixtures/abi/', import.meta.url)));

const load = (name: string): AbiManifest =>
  parseAbiManifest(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as unknown);

const EXPECTED_METHOD_COUNTS: Record<string, number> = {
  'kv-store': 11,
  abi_conformance: 40,
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

  test(`${name}: every method registers and converts to JSON Schema through the MCP SDK`, async () => {
    const m = load(name);
    const server = new McpServer({ name: 'conformance', version: '0.0.0' });
    for (const method of m.methods) {
      server.registerTool(`app_${method.name}`, { description: method.name, inputSchema: inputShapeForMethod(method, m) }, async () => ({
        content: [{ type: 'text' as const, text: '' }],
      }));
    }

    // tools/list is where the SDK converts every registered shape, so a schema it cannot render fails here and nowhere earlier.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'conformance', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, m.methods.length);
      for (const tool of tools) {
        assert.equal(tool.inputSchema.type, 'object', `${tool.name} is not an object schema`);
        assert.equal(typeof tool.inputSchema.properties, 'object', `${tool.name} advertises no properties`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
}

test('scaffolding-e2e: 91 methods register under one server at once', async () => {
  const m = load('scaffolding-e2e');
  const server = new McpServer({ name: 'scale', version: '0.0.0' });
  for (const method of m.methods) {
    server.registerTool(`scaffolding_e2e_${method.name}`, { description: method.name, inputSchema: inputShapeForMethod(method, m) }, async () => ({
      content: [{ type: 'text' as const, text: '' }],
    }));
  }

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scale', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 91);
    assert.equal(new Set(tools.map((t) => t.name)).size, 91, 'two methods collided on one tool name');
  } finally {
    await client.close();
    await server.close();
  }
});

test('kv-store: set(key, value) advertises exactly those two required properties', async () => {
  const m = load('kv-store');
  const set = m.methods.find((x) => x.name === 'set');
  assert.ok(set, 'kv-store fixture has no set method');

  const server = new McpServer({ name: 'kv', version: '0.0.0' });
  server.registerTool('kv_store_set', { description: 'set', inputSchema: inputShapeForMethod(set, m) }, async () => ({
    content: [{ type: 'text' as const, text: '' }],
  }));

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'kv', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const { tools } = await client.listTools();
    const schema = tools[0].inputSchema as { properties: Record<string, unknown>; required?: string[] };
    assert.deepEqual(Object.keys(schema.properties).sort(), ['key', 'value']);
    assert.deepEqual([...(schema.required ?? [])].sort(), ['key', 'value']);
  } finally {
    await client.close();
    await server.close();
  }
});
