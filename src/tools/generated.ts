import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import type { AbiMethod } from '@calimero-network/abi-codegen';
import { AppNotFoundError, codeUnit, lastSegment, type AbiLoader, type ResolvedApp } from '../abi.ts';
import type { Catalog } from '../catalog.ts';
import { errorResult } from '../errors.ts';
import { advertised, packageKey, type Gate } from '../gate.ts';
import type { NodeSession } from '../node.ts';
import { inputShapeForMethod, renderMethodSignature, schemaBuilder } from '../schema.ts';

const MAX_SLUG = 20;
const MAX_NAME = 49; // 64 minus Claude Code's 15-char `mcp__mero-mcp__` prefix
const HASHED_KEEP = 42;
const ID_TAIL = 6; // id alphanumerics that tell two same-named apps apart
const NAME_HASH_HEX = 6; // sha256 hex that ends a shortened name
const HANDLE_PARAM = 'app_handle';
const APP_HANDLE_DOC = 'The app_handle select_app returned for this application; it names the context the call runs in.';

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_');

function baseSlug(app: ResolvedApp): string {
  const base = sanitize(lastSegment(app.package || app.id));
  return (app.serviceName ? `${base}_${sanitize(app.serviceName)}` : base).slice(0, MAX_SLUG);
}

// By id within a package, so which of two signers keeps the plain names never depends on node order.
const namingOrder = (apps: readonly ResolvedApp[]) =>
  [...apps].sort((a, b) => codeUnit(packageKey(a), packageKey(b)) || codeUnit(a.id, b.id));

const idTail = (app: ResolvedApp) => app.id.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, ID_TAIL);

/** Slug per app, in catalog order; two apps that sanitise alike are told apart by their own id, never by order. */
export function slugs(apps: readonly ResolvedApp[]): Map<ResolvedApp, string> {
  const out = new Map<ResolvedApp, string>();
  const taken = new Set<string>();
  for (const app of namingOrder(apps)) {
    const base = baseSlug(app);
    let slug = base;
    if (taken.has(slug)) {
      const tail = idTail(app);
      slug = `${base}_${tail}`;
      for (let n = 2; taken.has(slug); n++) slug = `${base}_${tail}_${n}`;
    }
    taken.add(slug);
    out.set(app, slug);
  }
  return out;
}

export function toolName(slug: string, method: string): string {
  const full = `${slug}_${method}`;
  if (full.length <= MAX_NAME) return full;
  return `${full.slice(0, HASHED_KEEP)}_${createHash('sha256').update(full).digest('hex').slice(0, NAME_HASH_HEX)}`;
}

export function toolTitle(app: ResolvedApp, method: string): string {
  const words = method.split('_').filter(Boolean).join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${app.name ?? packageKey(app)})`;
}

// A method's own app_handle parameter would collide with the injected one, so only call reaches it, with args kept apart.
const collides = (method: AbiMethod) => method.params.some((p) => p.name === HANDLE_PARAM);

const toolMethods = (app: ResolvedApp) =>
  app.manifest.methods.filter((m) => !collides(m)).sort((a, b) => codeUnit(a.name, b.name));

/**
 * Tool name per method of every app, unique against `reserved` and each other: what select_app reports and tools/list shows.
 * Slugs are unique, but a slug plus a method can still spell a built-in or another app's name, so a clash takes the id tail.
 */
export function toolNamesByApp(apps: readonly ResolvedApp[], reserved: ReadonlySet<string>): Map<ResolvedApp, Map<string, string>> {
  const bySlug = slugs(apps);
  const taken = new Set(reserved);
  return new Map(
    namingOrder(apps).map((app) => {
      const slug = bySlug.get(app)!;
      const names = new Map<string, string>();
      for (const { name: method } of toolMethods(app)) {
        let name = toolName(slug, method);
        for (let n = 1; taken.has(name); n++) name = toolName(`${slug}_${idTail(app)}${n > 1 ? `_${n}` : ''}`, method);
        taken.add(name);
        names.set(method, name);
      }
      return [app, names];
    }),
  );
}

function toolConfig(app: ResolvedApp, method: AbiMethod) {
  const input = schemaBuilder(app.manifest, 'input');
  const output = schemaBuilder(app.manifest, 'output');
  const readOnly = method.intent === 'read_only';
  const returned = method.returns && output.type(method.returns);
  const returns = returned && (method.returns_nullable ? returned.nullable() : returned);
  return {
    title: toolTitle(app, method.name),
    description: renderMethodSignature(method),
    inputSchema: advertised(
      input.jsonSchema(z.object({ [HANDLE_PARAM]: input.describe(z.string(), APP_HANDLE_DOC), ...input.params(method) })),
    ),
    ...(returns ? { outputSchema: advertised(output.jsonSchema(returns)) } : {}),
    // destructiveHint stays false until the ABI can say otherwise; every hint is sent explicitly.
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false },
    ...(app.icon && URL.canParse(app.icon) ? { icons: [{ src: app.icon }] } : {}),
    _meta: {
      package: packageKey(app),
      appVersion: app.version ?? null,
      signerId: app.signerId ?? null,
      intent: method.intent ?? 'unspecified',
    },
  };
}

/** Registers one tool per method of every catalog app and re-registers when the catalog changes. */
export function registerGeneratedTools(
  server: McpServer,
  catalog: Catalog,
  gate: Gate,
  session: NodeSession,
  loader: AbiLoader,
  reserved: ReadonlySet<string>,
): () => void {
  const registered: RegisteredTool[] = [];

  /** Runs one method as a tool; a tool built before an upgrade or uninstall resyncs the list and answers as it now stands. */
  async function invoke(app: ResolvedApp, method: AbiMethod, args: Record<string, unknown>) {
    // Judged against the app as installed now, so a handle goes stale the moment the app is upgraded.
    const current = await loader.load(app.id, app.serviceName).catch((err: unknown) => {
      if (err instanceof AppNotFoundError) return undefined;
      throw err;
    });
    // A failed re-sync must not replace the refusal; the next poll retries it.
    const resync = () => catalog.sync().catch(() => {});
    if (!current) {
      await resync();
      return gate.refuse(app, gate.retryText(app)).refusal;
    }
    if (current.version !== app.version) {
      await resync();
      // A failed re-sync can leave the pre-upgrade entry, whose schema must never validate a call to the new install.
      const upgraded = catalog
        .apps()
        .find((a) => a.id === app.id && a.serviceName === app.serviceName && a.version === current.version);
      const same = upgraded && toolMethods(upgraded).find((m) => m.name === method.name);
      if (upgraded && same) [app, method] = [upgraded, same];
      // The upgrade is unconfirmed or dropped this method; never run the old tool against the new install.
      else return gate.refuse(current, gate.retryText(current)).refusal;
    }
    const admitted = await gate.admit(current, args[HANDLE_PARAM]);
    if ('refusal' in admitted) return admitted.refusal;
    const argsJson = z.object(inputShapeForMethod(method, app.manifest)).parse(args);
    const result = await session.mero.rpc.execute({ contextId: admitted.contextId, method: method.name, argsJson });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) ?? 'null' }],
      ...(method.returns ? { structuredContent: result as Record<string, unknown> } : {}),
    };
  }

  function register() {
    for (const tool of registered.splice(0)) tool.remove();
    const names = toolNamesByApp(catalog.apps(), reserved);
    for (const app of catalog.apps()) {
      for (const m of app.manifest.methods.filter(collides)) {
        const where = `${packageKey(app)} ${app.version ?? ''} ${m.name}`;
        console.error(`[mero-mcp] no tool for ${where}: its app_handle parameter would collide; use call`);
      }
    }
    // Tracked one by one, so a throw midway still leaves every registered tool removable on the next sync.
    for (const app of catalog.apps()) {
      for (const method of toolMethods(app)) {
        registered.push(
          server.registerTool(names.get(app)!.get(method.name)!, toolConfig(app, method), async (args: unknown) =>
            invoke(app, method, args as Record<string, unknown>).catch(errorResult),
          ),
        );
      }
    }
  }

  register();
  return catalog.subscribe(register);
}
