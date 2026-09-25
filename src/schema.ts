import { z } from 'zod';
import type { AbiField, AbiManifest, AbiMethod, AbiTypeDef, AbiTypeRef, AbiVariantDef } from '@calimero-network/abi-codegen';

const SCALARS: Record<string, () => z.ZodType> = {
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

type Meta = { id?: string; description?: string };

/** `input` accepts what an agent may send (bytes as hex too); `output` describes what the node returns. */
export type SchemaMode = 'input' | 'output';

/**
 * One manifest's zod schemas. Named ABI types are built once, lazily, and registered under their name,
 * so recursion terminates and JSON Schema output carries them as `$defs` + `$ref`.
 */
export function schemaBuilder(m: AbiManifest, mode: SchemaMode = 'input') {
  const registry = z.registry<Meta>();
  const named = new Map<string, z.ZodType>();
  // Unions whose members can never both match, advertised as oneOf rather than zod's default anyOf.
  const exclusive = new WeakSet<object>();

  const note = <T extends z.ZodType>(schema: T, meta: Meta): T => {
    registry.add(schema, meta);
    return schema;
  };

  function ref(name: string): z.ZodType {
    const known = named.get(name);
    if (known) return known;
    const def = m.types?.[name];
    // A $ref may name a built-in absent from the type table; accept anything rather than failing the whole app.
    if (!def) return z.unknown();
    const schema = note(
      z.lazy(() => fromDef(def)),
      { id: name },
    );
    named.set(name, schema);
    return schema;
  }

  function type(t: AbiTypeRef): z.ZodType {
    if ('$ref' in t) return ref(t.$ref);
    const scalar = SCALARS[t.kind];
    if (scalar) return scalar();
    switch (t.kind) {
      case 'bytes':
        return bytes('size' in t ? t.size : undefined);
      case 'list':
        return z.array(type(t.items));
      case 'map':
        return z.record(z.string(), type(t.value));
      case 'record':
        // A crdt collection is a transparent wrapper: the wire value is the inner type, not the fields.
        if (t.crdt_type && t.inner_type) return type(t.inner_type);
        return record(t.fields);
      case 'tuple':
        return z.tuple(t.elements.map(type) as [z.ZodType, ...z.ZodType[]]);
      default:
        return z.unknown();
    }
  }

  function fromDef(def: AbiTypeDef): z.ZodType {
    if (def.kind === 'alias') return type(def.target);
    if (def.kind === 'variant') return variant(def);
    return type(def);
  }

  /** Members that can never both match advertise as oneOf rather than zod's default anyOf. */
  function union(members: z.ZodType[], isExclusive: boolean): z.ZodType {
    if (members.length === 1) return members[0];
    const schema = z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    if (isExclusive) exclusive.add(schema);
    return schema;
  }

  /** serde externally-tagged: unit variants ride as bare names, payload variants as {Name: payload}. */
  function variant(def: AbiVariantDef): z.ZodType {
    const units = def.variants.filter((v) => !v.payload).map((v) => v.name);
    const unitSchemas = units.length ? [z.enum(units as [string, ...string[]])] : [];
    const tagged = def.variants.filter((v) => v.payload).map((v) => z.object({ [v.name]: type(v.payload!) }).strict());
    return union([...unitSchemas, ...tagged], true);
  }

  function record(fields: AbiField[]): z.ZodType {
    const shape: Record<string, z.ZodType> = {};
    for (const f of fields) {
      const base = type(f.type);
      shape[f.name] = f.nullable ? base.nullable() : base;
    }
    return z.object(shape);
  }

  /**
   * The node wants a JSON number array, and hex is the only string form the Calimero toolchain reads.
   * The size rides in the pattern so the advertised JSON Schema carries it, not just the validator.
   */
  function bytes(size?: number): z.ZodType {
    const plain = z.array(z.number().int().min(0).max(255));
    const array = size === undefined ? plain : plain.length(size);
    const label = size === undefined ? 'a byte array' : `a ${size}-byte array`;
    if (mode === 'output') return note(array, { description: `bytes: ${label}` });
    const hex = z
      .string()
      .regex(size === undefined ? /^(?:[0-9a-fA-F]{2})*$/ : new RegExp(`^[0-9a-fA-F]{${size * 2}}$`))
      .transform((s) => Array.from(Buffer.from(s, 'hex')));
    return note(z.union([hex, array]), { description: `bytes: a hex string or ${label}` });
  }

  function params(method: AbiMethod): Record<string, z.ZodType> {
    const shape: Record<string, z.ZodType> = {};
    for (const p of method.params) {
      const base = type(p.type);
      shape[p.name] = p.nullable ? base.nullable().optional() : base;
    }
    return shape;
  }

  const jsonSchema = (schema: z.ZodType): Record<string, unknown> => {
    const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
      metadata: registry,
      io: mode,
      unrepresentable: 'any',
      reused: 'inline',
      cycles: 'ref',
      override: ({ zodSchema, jsonSchema }) => {
        if (!exclusive.has(zodSchema) || !jsonSchema.anyOf) return;
        jsonSchema.oneOf = jsonSchema.anyOf;
        delete jsonSchema.anyOf;
      },
    }) as Record<string, unknown>;
    return json;
  };

  return {
    type,
    params,
    jsonSchema,
    describe: (schema: z.ZodType, description: string) => note(schema, { description }),
  };
}

export const zodForType = (t: AbiTypeRef, m: AbiManifest): z.ZodType => schemaBuilder(m).type(t);

export const inputShapeForMethod = (method: AbiMethod, m: AbiManifest): Record<string, z.ZodType> => schemaBuilder(m).params(method);

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
      // Must match the schema's unwrap: the signature the agent reads is what it calls the tool by.
      return t.crdt_type && t.inner_type ? typeName(t.inner_type) : t.kind;
    default:
      return t.kind;
  }
}
