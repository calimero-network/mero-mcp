import { z } from 'zod';
import type { AbiField, AbiManifest, AbiMethod, AbiTypeDef, AbiTypeRef } from '@calimero-network/abi-codegen';

/** Depth cap for self-referential types; beyond it the schema degrades to unknown. */
const MAX_DEPTH = 8;

const SCALARS: Record<string, () => z.ZodTypeAny> = {
  bool: () => z.boolean(),
  string: () => z.string(),
  unit: () => z.null(),
  i32: () => z.number().int(),
  i64: () => z.number().int(),
  u32: () => z.number().int().nonnegative(),
  u64: () => z.number().int().nonnegative(),
  f32: () => z.number(),
  f64: () => z.number(),
};

export function zodForType(t: AbiTypeRef, m: AbiManifest, depth = 0): z.ZodTypeAny {
  if (depth > MAX_DEPTH) return z.unknown();
  if ('$ref' in t) {
    const def = m.types?.[t.$ref];
    // A $ref may name a built-in absent from the type table; accept anything rather than failing the whole app.
    return def ? zodForDef(def, m, depth + 1) : z.unknown();
  }
  const scalar = SCALARS[t.kind];
  if (scalar) return scalar();
  switch (t.kind) {
    case 'bytes':
      return bytesSchema('size' in t ? t.size : undefined);
    case 'list':
      return z.array(zodForType(t.items, m, depth + 1));
    case 'map':
      return z.record(z.string(), zodForType(t.value, m, depth + 1));
    case 'record':
      // A crdt collection is a transparent wrapper: the wire value is the inner type, not the fields.
      if (t.crdt_type && t.inner_type) return zodForType(t.inner_type, m, depth + 1);
      return recordSchema(t.fields, m, depth);
    case 'tuple':
      return z.tuple(t.elements.map((e) => zodForType(e, m, depth + 1)) as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
    default:
      return z.unknown();
  }
}

function zodForDef(def: AbiTypeDef, m: AbiManifest, depth: number): z.ZodTypeAny {
  if (def.kind === 'alias') return zodForType(def.target, m, depth + 1);
  if (def.kind === 'variant') {
    // serde externally-tagged: unit variants ride as bare names, payload variants as {Name: payload}.
    const units = def.variants.filter((v) => !v.payload).map((v) => v.name);
    const tagged = def.variants
      .filter((v) => v.payload)
      .map((v) => z.object({ [v.name]: zodForType(v.payload!, m, depth + 1) }));
    if (!tagged.length) return z.enum(units);
    return z.union(units.length ? [z.enum(units), ...tagged] : tagged);
  }
  // record and bytes defs are shapes AbiTypeRef already covers.
  return zodForType(def, m, depth);
}

function recordSchema(fields: AbiField[], m: AbiManifest, depth: number): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    const base = zodForType(f.type, m, depth + 1);
    shape[f.name] = f.nullable ? base.nullable() : base;
  }
  return z.object(shape);
}

/**
 * The node wants a JSON number array, and hex is the only string form the Calimero toolchain reads.
 * The size rides in the pattern so the advertised JSON Schema carries it, not just the validator.
 */
function bytesSchema(size?: number): z.ZodTypeAny {
  const bytes = z.array(z.number().int().min(0).max(255));
  const array = size === undefined ? bytes : bytes.length(size);
  const hex = z
    .string()
    .regex(size === undefined ? /^(?:[0-9a-fA-F]{2})*$/ : new RegExp(`^[0-9a-fA-F]{${size * 2}}$`))
    .transform((s) => Array.from(Buffer.from(s, 'hex')));
  const label = size === undefined ? 'a byte array' : `a ${size}-byte array`;
  return z.union([hex, array]).describe(`bytes: a hex string or ${label}`);
}

export function inputShapeForMethod(method: AbiMethod, m: AbiManifest): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  shape.context = z.string().optional().describe('Context id or alias to execute against; defaults to the selected context.');
  // Params last: an app method named `context` owns the key, since dropping its argument would break the call.
  for (const p of method.params) {
    const base = zodForType(p.type, m);
    shape[p.name] = p.nullable ? base.nullable().optional() : base;
  }
  return shape;
}

export function renderMethodSignature(method: AbiMethod): string {
  const kind = method.intent === 'read_only' ? 'view' : 'mut';
  const params = method.params.map((p) => `${p.name}${p.nullable ? '?' : ''}: ${typeName(p.type)}`).join(', ');
  const returns = method.returns ? typeName(method.returns) : 'unit';
  return `[${kind}] ${method.name}(${params}) -> ${returns}${method.returns_nullable ? ' | null' : ''}`;
}

function typeName(t: AbiTypeRef): string {
  if ('$ref' in t) return t.$ref;
  switch (t.kind) {
    case 'list':
      return `${typeName(t.items)}[]`;
    case 'map':
      return `map<${typeName(t.key)}, ${typeName(t.value)}>`;
    case 'tuple':
      return `(${t.elements.map(typeName).join(', ')})`;
    case 'record':
      // Must match zodForType's unwrap: the signature the agent reads is what it calls the tool by.
      return t.crdt_type && t.inner_type ? typeName(t.inner_type) : t.kind;
    default:
      return t.kind;
  }
}
