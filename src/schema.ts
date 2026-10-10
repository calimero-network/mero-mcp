import { z } from 'zod';
import type { AbiField, AbiManifest, AbiMethod, AbiTypeDef, AbiTypeRef, AbiVariant, AbiVariantDef } from '@calimero-network/abi-codegen';

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

/**
 * What the node returns for a 64-bit integer. zod's `.int()` stops at 2^53, but a contract's u64 goes past it
 * (a nanosecond timestamp is ~1.8e18) and arrives as a JSON number all the same: refusing it fails the whole
 * call over one field. The value is what JSON.parse made of it; the text content carries the node's digits.
 */
const OUTPUT_SCALARS: Record<string, () => z.ZodType> = {
  ...SCALARS,
  i64: () => z.number(),
  u64: () => z.number().nonnegative(),
};

type Meta = { id?: string; description?: string };
type Tagged = z.ZodType & z.core.$ZodTypeDiscriminable;

/** `input` accepts what an agent may send (bytes as hex too); `output` describes what the node returns. */
export type SchemaMode = 'input' | 'output';

/**
 * One manifest's zod schemas. Named ABI types are built once, lazily, and registered under their name,
 * so recursion terminates and JSON Schema output carries them as `$defs` + `$ref`.
 */
export function schemaBuilder(m: AbiManifest, mode: SchemaMode = 'input') {
  const registry = z.registry<Meta>();
  // Unions whose members can never both match, advertised as oneOf rather than zod's default anyOf.
  const exclusive = new WeakSet<object>();

  const note = <T extends z.ZodType>(schema: T, meta: Meta): T => {
    registry.add(schema, meta);
    return schema;
  };

  const main = types(mode === 'input');
  // serde matches untagged members against the raw JSON, so bytes there take no hex: "abcd" must stay a string.
  const raw = mode === 'input' ? types(false) : main;

  /** The schemas for one bytes form: `hex` also accepts a hex string for bytes. */
  function types(hex: boolean) {
    const named = new Map<string, z.ZodType>();
    const isCopy = !hex && mode === 'input';

    function ref(name: string): z.ZodType {
      const known = named.get(name);
      if (known) return known;
      const def = m.types?.[name];
      // A $ref may name a built-in absent from the type table; accept anything rather than failing the whole app.
      if (!def) return z.unknown();
      // The hex-free copy only differs where bytes occur, and one id cannot name two schemas.
      if (isCopy && !hasBytes(def)) return main.type({ $ref: name });
      const schema = note(
        z.lazy(() => fromDef(def)),
        { ...(isCopy ? {} : { id: name }), ...('doc' in def && def.doc ? { description: def.doc } : {}) },
      );
      named.set(name, schema);
      return schema;
    }

    function type(t: AbiTypeRef): z.ZodType {
      if ('$ref' in t) return ref(t.$ref);
      const scalar = (mode === 'output' ? OUTPUT_SCALARS : SCALARS)[t.kind];
      if (scalar) return scalar();
      switch (t.kind) {
        case 'bytes':
          return bytes('size' in t ? t.size : undefined, hex);
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

    /** Each serde tagging mode, by the ABI's wire rules; absent keys mean externally tagged. */
    function variant(def: AbiVariantDef): z.ZodType {
      const { tag, content } = def;
      if (def.untagged) return union(def.variants.map((v) => documented(v.payload ? raw.type(v.payload) : z.null(), v)), false);
      if (tag) return byTag(tag, def.variants.map((v) => documented(tagged(tag, content, v), v)));
      // Externally tagged: unit variants ride as bare names, payload variants as {Name: payload}; documented units become consts.
      const units = def.variants.filter((v) => !v.payload);
      const plainEnum = units.length > 0 && !units.some((v) => v.doc);
      const unitSchemas = plainEnum ? [z.enum(units.map((v) => v.name) as [string, ...string[]])] : units.map((v) => documented(z.literal(v.name), v));
      const payloads = def.variants.filter((v) => v.payload).map((v) => documented(z.object({ [v.name]: type(v.payload!) }).strict(), v));
      return union([...unitSchemas, ...payloads], true);
    }

    /** One tagged member: its tag (after any enclosing ones in `outer`), then the adjacent content or the internal payload's keys. */
    function tagged(tag: string, content: string | undefined, v: AbiVariant, outer: z.ZodRawShape = {}): Tagged {
      const tags = { ...outer, [tag]: z.literal(v.name) };
      if (!v.payload) return z.object(tags);
      if (content) return z.object({ ...tags, [content]: type(v.payload) });
      return beside(tags, v.payload);
    }

    /**
     * An internally tagged payload's keys beside the tags, as one object since an allOf of closed objects admits
     * nothing in output mode. The tags go last so a payload field of the same name cannot replace their check.
     */
    function beside(tags: z.ZodRawShape, t: AbiTypeRef): Tagged {
      const def = '$ref' in t ? m.types?.[t.$ref] : t;
      if (def?.kind === 'alias') return beside(tags, def.target);
      if (def?.kind === 'record' && !def.inner_type) return z.object({ ...record(def.fields).shape, ...tags });
      if (def?.kind === 'map') return z.object(tags).catchall(type(def.value));
      // An inner enum reusing an outer tag would write that key twice; this also ends every enum cycle.
      if (def?.kind === 'variant' && def.tag && !(def.tag in tags)) {
        const { tag, content } = def;
        return byTag(tag, def.variants.map((v) => documented(tagged(tag, content, v, tags), v)));
      }
      // serde refuses any other payload under an internal tag, so the node gets the final say.
      return z.looseObject(tags);
    }

    function record(fields: AbiField[]) {
      const shape: Record<string, z.ZodType> = {};
      for (const f of fields) {
        const base = type(f.type);
        // A contract's `Option` field is often left out rather than sent as null (serde's
        // skip_serializing_if): in what the node returns, a nullable field may be absent.
        const nullable = mode === 'output' ? base.nullable().optional() : base.nullable();
        shape[f.name] = withDoc(f.nullable ? nullable : base, f.doc, base);
      }
      return z.object(shape);
    }

    return { type };
  }

  /** Mutually exclusive members advertise as oneOf; untagged members may overlap and serde takes the first match, so anyOf. */
  function union(members: z.ZodType[], isExclusive: boolean): z.ZodType {
    if (members.length === 1) return members[0];
    const schema = z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    if (isExclusive) exclusive.add(schema);
    return schema;
  }

  /** Tagged members, matched by their tag, so a refusal names the chosen variant's own problem rather than every member's. */
  function byTag(tag: string, members: Tagged[]): Tagged {
    if (members.length === 1) return members[0];
    const schema = z.discriminatedUnion(tag, members as [Tagged, ...Tagged[]]);
    exclusive.add(schema);
    return schema;
  }

  function documented<T extends z.ZodType>(schema: T, v: AbiVariant): T {
    return v.doc ? note(schema, { description: v.doc }) : schema;
  }

  /** Whether bytes occur anywhere under `t`. */
  function hasBytes(t: AbiTypeRef | AbiTypeDef, seen = new Set<string>()): boolean {
    if ('$ref' in t) {
      const def = m.types?.[t.$ref];
      if (!def || seen.has(t.$ref)) return false;
      seen.add(t.$ref);
      return hasBytes(def, seen);
    }
    const inner = (u: AbiTypeRef) => hasBytes(u, seen);
    switch (t.kind) {
      case 'bytes':
        return true;
      case 'list':
        return inner(t.items);
      case 'map':
        return inner(t.value);
      case 'tuple':
        return t.elements.some(inner);
      case 'record':
        return t.fields.some((f) => inner(f.type)) || (t.inner_type !== undefined && inner(t.inner_type));
      case 'variant':
        return t.variants.some((v) => v.payload !== undefined && inner(v.payload));
      case 'alias':
        return inner(t.target);
      default:
        return false;
    }
  }

  /**
   * The node wants a JSON number array, and hex is the only string form the Calimero toolchain reads.
   * The size rides in the pattern so the advertised JSON Schema carries it, not just the validator.
   */
  function bytes(size: number | undefined, hex: boolean): z.ZodType {
    const plain = z.array(z.number().int().min(0).max(255));
    const array = size === undefined ? plain : plain.length(size);
    const label = size === undefined ? 'a byte array' : `a ${size}-byte array`;
    if (!hex) return note(array, { description: `bytes: ${label}` });
    const hexString = z
      .string()
      .regex(size === undefined ? /^(?:[0-9a-fA-F]{2})*$/ : new RegExp(`^[0-9a-fA-F]{${size * 2}}$`))
      .transform((s) => Array.from(Buffer.from(s, 'hex')));
    return note(z.union([hexString, array]), { description: `bytes: a hex string or ${label}` });
  }

  /** A doc replaces a description, so a type-level hint (bytes) is carried beside it. */
  function withDoc(schema: z.ZodType, doc: string | undefined, base: z.ZodType): z.ZodType {
    if (!doc) return schema;
    const meta = registry.get(base);
    const hint = meta?.id ? undefined : meta?.description;
    return note(schema === base ? schema.clone() : schema, { description: hint ? `${doc} (${hint})` : doc });
  }

  function params(method: AbiMethod): Record<string, z.ZodType> {
    const shape: Record<string, z.ZodType> = {};
    for (const p of method.params) {
      const base = main.type(p.type);
      shape[p.name] = withDoc(p.nullable ? base.nullable().optional() : base, p.doc, base);
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
    type: main.type,
    params,
    jsonSchema,
    describe: (schema: z.ZodType, description: string) => note(schema, { description }),
  };
}

export const inputShapeForMethod = (method: AbiMethod, m: AbiManifest): Record<string, z.ZodType> => schemaBuilder(m).params(method);

export const parseArgs = (method: AbiMethod, m: AbiManifest, args: unknown) => z.object(inputShapeForMethod(method, m)).parse(args);

/** The tool description: the author's doc, when the ABI carries one, above the signature. */
export function methodDescription(method: AbiMethod): string {
  const signature = renderMethodSignature(method);
  return method.doc ? `${method.doc}\n\n${signature}` : signature;
}

/** describe_app registers no schema to carry parameter docs, so they follow the description. */
export function methodReference(method: AbiMethod): string {
  const params = method.params
    .filter((p) => p.doc)
    .map((p) => `  ${p.name}: ${p.doc!.replace(/\n/g, '\n    ')}`);
  return [methodDescription(method), ...params].join('\n');
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
      // Must match the schema's unwrap: the signature the agent reads is what it calls the tool by.
      return t.crdt_type && t.inner_type ? typeName(t.inner_type) : t.kind;
    default:
      return t.kind;
  }
}
