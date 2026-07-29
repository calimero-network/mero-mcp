import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AbiManifest } from '@calimero-network/abi-codegen';
import { inputShapeForMethod, zodForType, renderMethodSignature } from './schema.ts';
import { z } from 'zod';

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') Object.values(v).forEach(deepFreeze);
  return Object.freeze(v);
}

// abi.ts caches one manifest and shares it across every tool registration, so derivation must never mutate it.
const manifest = (over: Partial<AbiManifest> = {}): AbiManifest =>
  deepFreeze({ schema_version: 'wasm-abi/1', types: {}, methods: [], events: [], ...over }) as AbiManifest;

test('scalars map to their zod counterparts', () => {
  const m = manifest();
  assert.equal(zodForType({ kind: 'string' }, m).safeParse('a').success, true);
  assert.equal(zodForType({ kind: 'u32' }, m).safeParse(1).success, true);
  assert.equal(zodForType({ kind: 'u32' }, m).safeParse(1.5).success, false);
  assert.equal(zodForType({ kind: 'bool' }, m).safeParse(true).success, true);
  assert.equal(zodForType({ kind: 'string' }, m).safeParse(3).success, false);
});

test('a list of strings accepts an array and rejects a scalar', () => {
  const s = zodForType({ kind: 'list', items: { kind: 'string' } }, manifest());
  assert.equal(s.safeParse(['a', 'b']).success, true);
  assert.equal(s.safeParse('a').success, false);
});

test('a map becomes a record keyed by string', () => {
  const s = zodForType({ kind: 'map', key: { kind: 'string' }, value: { kind: 'u32' } }, manifest());
  assert.equal(s.safeParse({ a: 1 }).success, true);
  assert.equal(s.safeParse({ a: 'x' }).success, false);
});

test('a $ref resolves through the manifest type table', () => {
  const m = manifest({ types: { Point: { kind: 'record', fields: [{ name: 'x', type: { kind: 'u32' } }] } } } as Partial<AbiManifest>);
  const s = zodForType({ $ref: 'Point' }, m);
  assert.equal(s.safeParse({ x: 1 }).success, true);
  assert.equal(s.safeParse({ x: 'no' }).success, false);
});

test('an unresolvable $ref degrades to unknown rather than throwing', () => {
  assert.equal(zodForType({ $ref: 'NotDefined' }, manifest()).safeParse('anything').success, true);
});

test('a record field marked nullable accepts null', () => {
  const m = manifest({ types: { R: { kind: 'record', fields: [{ name: 'a', type: { kind: 'string' }, nullable: true }] } } } as Partial<AbiManifest>);
  assert.equal(zodForType({ $ref: 'R' }, m).safeParse({ a: null }).success, true);
});

test('a unit-only variant becomes an enum of its names', () => {
  const m = manifest({ types: { S: { kind: 'variant', variants: [{ name: 'Open' }, { name: 'Done' }] } } } as Partial<AbiManifest>);
  const s = zodForType({ $ref: 'S' }, m);
  assert.equal(s.safeParse('Open').success, true);
  assert.equal(s.safeParse('Nope').success, false);
});

test('an alias resolves to its target', () => {
  const m = manifest({ types: { Name: { kind: 'alias', target: { kind: 'string' } } } } as Partial<AbiManifest>);
  assert.equal(zodForType({ $ref: 'Name' }, m).safeParse('x').success, true);
});

test('a self-referential type terminates instead of recursing forever', () => {
  const m = manifest({ types: { Node: { kind: 'record', fields: [{ name: 'next', type: { $ref: 'Node' }, nullable: true }] } } } as Partial<AbiManifest>);
  assert.equal(zodForType({ $ref: 'Node' }, m).safeParse({ next: null }).success, true);
});

test('inputShapeForMethod makes a nullable param optional and nullable', () => {
  const shape = inputShapeForMethod(
    { name: 'm', params: [{ name: 'a', type: { kind: 'string' } }, { name: 'b', type: { kind: 'string' }, nullable: true }] } as never,
    manifest(),
  );
  const obj = z.object(shape);
  assert.equal(obj.safeParse({ a: 'x' }).success, true);
  assert.equal(obj.safeParse({ a: 'x', b: null }).success, true);
  assert.equal(obj.safeParse({ b: 'y' }).success, false);
});

test('inputShapeForMethod adds an optional context parameter', () => {
  const shape = inputShapeForMethod({ name: 'm', params: [] } as never, manifest());
  assert.ok('context' in shape);
  assert.equal(z.object(shape).safeParse({}).success, true);
});

test('renderMethodSignature marks read_only methods as view', () => {
  assert.match(renderMethodSignature({ name: 'get', params: [{ name: 'k', type: { kind: 'string' } }], returns: { kind: 'string' }, intent: 'read_only' } as never), /^\[view\] get\(k: string\) -> string$/);
});

test('a tuple accepts an exact-arity array and rejects a short one', () => {
  const s = zodForType({ kind: 'tuple', elements: [{ kind: 'string' }, { kind: 'u32' }] }, manifest());
  assert.equal(s.safeParse(['a', 1]).success, true);
  assert.equal(s.safeParse(['a']).success, false);
  assert.equal(s.safeParse(['a', 'b']).success, false);
});

test('a crdt record is transparent over its inner type', () => {
  // Real manifests wrap collections: {kind:'record', crdt_type:'unordered_map', inner_type:{kind:'map',...}}.
  const s = zodForType(
    { kind: 'record', fields: [], crdt_type: 'unordered_map', inner_type: { kind: 'map', key: { kind: 'string' }, value: { kind: 'u32' } } },
    manifest(),
  );
  assert.equal(s.safeParse({ a: 1 }).success, true);
  assert.equal(s.safeParse({ a: 'x' }).success, false);
});

test('a mixed variant accepts a bare name for unit members and a tagged object for payload members', () => {
  const m = manifest({
    types: { Action: { kind: 'variant', variants: [{ name: 'Reset' }, { name: 'Set', payload: { kind: 'u32' } }] } },
  } as Partial<AbiManifest>);
  const s = zodForType({ $ref: 'Action' }, m);
  assert.equal(s.safeParse('Reset').success, true);
  assert.equal(s.safeParse({ Set: 7 }).success, true);
  assert.equal(s.safeParse({ Set: 'no' }).success, false);
  assert.equal(s.safeParse('Nope').success, false);
});

test('bytes accepts a hex string and the byte array the node expects, decoding the former', () => {
  const m = manifest();
  const s = zodForType({ kind: 'bytes' }, m);
  assert.equal(s.safeParse('deadbeef').success, true);
  assert.equal(s.safeParse([1, 2, 3]).success, true);
  assert.equal(s.safeParse(1).success, false);
  assert.deepEqual(s.parse('dead'), [222, 173]);
  assert.deepEqual(s.parse('DEAD'), [222, 173]);
  assert.deepEqual(s.parse([1, 2, 3]), [1, 2, 3]);
});

test('bytes rejects a string that is not hex', () => {
  const s = zodForType({ kind: 'bytes' }, manifest());
  assert.equal(s.safeParse('zzz').success, false);
  assert.equal(s.safeParse('dea').success, false, 'an odd digit count is half a byte');
});

test('a byte element outside 0..255 is rejected', () => {
  const s = zodForType({ kind: 'bytes' }, manifest());
  assert.equal(s.safeParse([999, 1]).success, false);
  assert.equal(s.safeParse([-1]).success, false);
  assert.equal(s.safeParse([1.5]).success, false);
});

test('an empty hex string is an empty byte array, but not a valid sized one', () => {
  // Vec<u8> can legitimately be empty; a declared size cannot be satisfied by nothing.
  assert.deepEqual(zodForType({ kind: 'bytes' }, manifest()).parse(''), []);
  assert.equal(zodForType({ kind: 'bytes', size: 2 }, manifest()).safeParse('').success, false);
});

test('fixed-size bytes rejects a byte array of the wrong length', () => {
  const s = zodForType({ kind: 'bytes', size: 2 }, manifest());
  assert.equal(s.safeParse([1, 2]).success, true);
  assert.equal(s.safeParse([1, 2, 3]).success, false);
});

test('fixed-size bytes rejects hex of the wrong length', () => {
  const s = zodForType({ kind: 'bytes', size: 2 }, manifest());
  assert.deepEqual(s.parse('dead'), [222, 173]);
  assert.equal(s.safeParse('de').success, false);
  assert.equal(s.safeParse('deadbe').success, false);
  // The bug this pins: a 32-byte Hash used to accept any string at all.
  assert.equal(zodForType({ kind: 'bytes', size: 32 }, manifest()).safeParse('dead').success, false);
});

test('a named alias to a list resolves through the type table', () => {
  const m = manifest({ types: { Tags: { kind: 'alias', target: { kind: 'list', items: { kind: 'string' } } } } } as Partial<AbiManifest>);
  const s = zodForType({ $ref: 'Tags' }, m);
  assert.equal(s.safeParse(['a']).success, true);
  assert.equal(s.safeParse('a').success, false);
});

test('a nullable param is nullable at the param level, not inside its list', () => {
  const shape = inputShapeForMethod(
    { name: 'm', params: [{ name: 'xs', type: { kind: 'list', items: { kind: 'string' } }, nullable: true }] } as never,
    manifest(),
  );
  const obj = z.object(shape);
  assert.equal(obj.safeParse({ xs: null }).success, true);
  assert.equal(obj.safeParse({ xs: ['a'] }).success, true);
  assert.equal(obj.safeParse({ xs: [null] }).success, false);
});

test('inputShapeForMethod does not let a param named context shadow the context option', () => {
  const shape = inputShapeForMethod(
    { name: 'm', params: [{ name: 'context', type: { kind: 'u32' } }] } as never,
    manifest(),
  );
  const obj = z.object(shape);
  assert.equal(obj.safeParse({ context: 1 }).success, true);
  // The param wins outright: it is neither unioned with the context option nor left optional.
  assert.equal(obj.safeParse({ context: 'ctx' }).success, false);
  assert.equal(obj.safeParse({}).success, false);
});

test('renderMethodSignature shows nullability and defaults an absent return to unit', () => {
  assert.equal(
    renderMethodSignature({ name: 'set', params: [{ name: 'k', type: { kind: 'string' }, nullable: true }], intent: 'mutating' } as never),
    '[mut] set(k?: string) -> unit',
  );
  assert.equal(
    renderMethodSignature({ name: 'find', params: [], returns: { $ref: 'Point' }, returns_nullable: true, intent: 'read_only' } as never),
    '[view] find() -> Point | null',
  );
});

test('every derived shape converts to the json schema the mcp sdk advertises', () => {
  // The sdk runs toJSONSchema(shape, {target:'draft-7', io:'input'}) at registerTool time; a throw there kills select_app.
  const m = manifest({
    types: {
      // Fields are deliberately out of alphabetical order so an in-place sort trips the frozen manifest.
      Node: {
        kind: 'record',
        fields: [
          { name: 'next', type: { $ref: 'Node' }, nullable: true },
          { name: 'label', type: { kind: 'string' } },
        ],
      },
      Action: { kind: 'variant', variants: [{ name: 'Reset' }, { name: 'Set', payload: { kind: 'u32' } }] },
      Status: { kind: 'variant', variants: [{ name: 'Open' }] },
    },
  } as Partial<AbiManifest>);
  const params = [
    { name: 'node', type: { $ref: 'Node' } },
    { name: 'action', type: { $ref: 'Action' } },
    { name: 'status', type: { $ref: 'Status' }, nullable: true },
    { name: 'missing', type: { $ref: 'NotDefined' } },
    { name: 'blob', type: { kind: 'bytes', size: 32 } },
    { name: 'pair', type: { kind: 'tuple', elements: [{ kind: 'string' }, { kind: 'f64' }] } },
    { name: 'nothing', type: { kind: 'unit' } },
  ];
  const shape = inputShapeForMethod({ name: 'm', params } as never, m);
  let json!: { properties: Record<string, { anyOf: unknown[] }> };
  assert.doesNotThrow(() => {
    json = z.toJSONSchema(z.object(shape), { target: 'draft-7', io: 'input' }) as typeof json;
  });
  // The hex decode is a transform, representable only on the input side the sdk asks for.
  assert.deepEqual(json.properties.blob.anyOf, [
    { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
    { minItems: 32, maxItems: 32, type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 } },
  ]);
});

test('renderMethodSignature unwraps a crdt record the same way the schema does', () => {
  assert.equal(
    renderMethodSignature({
      name: 'put',
      params: [
        {
          name: 'entries',
          type: {
            kind: 'record',
            fields: [],
            crdt_type: 'unordered_map',
            inner_type: { kind: 'map', key: { kind: 'string' }, value: { kind: 'u32' } },
          },
        },
      ],
      returns: { kind: 'record', fields: [] },
    } as never),
    '[mut] put(entries: map<string, u32>) -> record',
  );
});

test('renderMethodSignature names containers compactly', () => {
  assert.equal(
    renderMethodSignature({
      name: 'bulk',
      params: [
        { name: 'xs', type: { kind: 'list', items: { $ref: 'Point' } } },
        { name: 'm', type: { kind: 'map', key: { kind: 'string' }, value: { kind: 'u64' } } },
      ],
      returns: { kind: 'bytes' },
    } as never),
    '[mut] bulk(xs: Point[], m: map<string, u64>) -> bytes',
  );
});
