import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import type { AbiMethod } from '@calimero-network/abi-codegen';
import { lastSegment, type AbiLoader, type ResolvedApp } from '../abi.ts';
import type { Catalog } from '../catalog.ts';
import { errorResult } from '../errors.ts';
import { advertised, packageKey, type Gate } from '../gate.ts';
import type { NodeSession } from '../node.ts';
import { renderMethodSignature, schemaBuilder } from '../schema.ts';

const MAX_SLUG = 20;
const MAX_NAME = 49; // 64 minus Claude Code's 15-char `mcp__mero-mcp__` prefix
const HASHED_KEEP = 42;
const APP_HANDLE_DOC = 'The app_handle select_app returned for this application; it names the context the call runs in.';

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_');

function baseSlug(app: ResolvedApp): string {
  const base = sanitize(lastSegment(app.package || app.id));
  return (app.serviceName ? `${base}_${sanitize(app.serviceName)}` : base).slice(0, MAX_SLUG);
}

/** Slug per app, in catalog order; two apps that sanitise alike are told apart by their own id, never by order. */
export function slugs(apps: readonly ResolvedApp[]): Map<ResolvedApp, string> {
  const out = new Map<ResolvedApp, string>();
  const taken = new Set<string>();
  for (const app of apps) {
    const base = baseSlug(app);
    let slug = base;
    if (taken.has(slug)) {
      const tail = app.id.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 6);
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
  return `${full.slice(0, HASHED_KEEP)}_${createHash('sha256').update(full).digest('hex').slice(0, 6)}`;
}

export function toolTitle(app: ResolvedApp, method: string): string {
  const words = method.split('_').filter(Boolean).join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${app.name ?? packageKey(app)})`;
}

const sortedMethods = (app: ResolvedApp) => [...app.manifest.methods].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Every tool name the catalog yields, per app: what select_app reports and what tools/list shows. */
export function toolNamesByApp(apps: readonly ResolvedApp[]): Map<ResolvedApp, string[]> {
  const bySlug = slugs(apps);
  return new Map(apps.map((app) => [app, sortedMethods(app).map((m) => toolName(bySlug.get(app)!, m.name))]));
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
    inputSchema: advertised(input.jsonSchema(z.object({ app_handle: input.describe(z.string(), APP_HANDLE_DOC), ...input.params(method) }))),
    ...(returns ? { outputSchema: advertised(output.jsonSchema(returns)) } : {}),
    // destructiveHint stays false until the ABI can say otherwise; every hint is sent explicitly.
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false },
    ...(app.icon && URL.canParse(app.icon) ? { icons: [{ src: app.icon }] } : {}),
    _meta: { package: packageKey(app), appVersion: app.version ?? null, signerId: app.signerId ?? null, intent: method.intent ?? 'unspecified' },
    validator: z.object(input.params(method)),
  };
}

/** Registers one tool per method of every catalog app and re-registers when the catalog changes. */
export function registerGeneratedTools(server: McpServer, catalog: Catalog, gate: Gate, session: NodeSession, loader: AbiLoader): () => void {
  let registered: RegisteredTool[] = [];

  function register() {
    for (const tool of registered) tool.remove();
    const names = toolNamesByApp(catalog.apps());
    registered = catalog.apps().flatMap((app) =>
      sortedMethods(app).map((method, i) => {
        const { validator, ...config } = toolConfig(app, method);
        return server.registerTool(names.get(app)![i], config, async (args: unknown) => {
          try {
            // Judged against the app as installed now, so a handle goes stale the moment the app is upgraded.
            const current = await loader.load(app.id, app.serviceName);
            const admitted = await gate.admit(current, (args as Record<string, unknown>).app_handle, app.version ?? '');
            if ('refusal' in admitted) return admitted.refusal;
            const argsJson = validator.parse(args);
            const result = await session.mero.rpc.execute({ contextId: admitted.contextId, method: method.name, argsJson });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) ?? 'null' }],
              ...(method.returns ? { structuredContent: result as Record<string, unknown> } : {}),
            };
          } catch (err) {
            return errorResult(err);
          }
        });
      }),
    );
  }

  register();
  return catalog.subscribe(register);
}
