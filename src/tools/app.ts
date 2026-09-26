import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import type { AbiMethod } from '@calimero-network/abi-codegen';
import { createAbiLoader, lastSegment, type ResolvedApp } from '../abi.ts';
import type { Config } from '../config.ts';
import type { NodeSession } from '../node.ts';
import { errorResult, textResult } from '../errors.ts';
import { CONTEXT_OPTION, inputShapeForMethod, renderMethodSignature } from '../schema.ts';

interface AppRef {
  resolved: ResolvedApp;
  /** What the caller typed: a package name reads better in errors than a base58 id. */
  label: string;
}

interface Selected extends AppRef {
  /** Tool-name prefix, derived from the resolved app so one app always yields one set of names. */
  slug: string;
  context?: string;
  tools: RegisteredTool[];
}

// mero-js ships its admin types behind extensionless barrels NodeNext will not
// resolve, so `mero.admin` reaches us as `any`; these are the fields we read.
interface InstalledApp {
  package?: string;
  version?: string;
}
interface AppContext {
  id: string;
  serviceName?: string;
}

/** Past this many app tools the list gets unwieldy, so say so - but never refuse a selection the user asked for. */
const TOOL_WARNING_THRESHOLD = 80;

/** Base58 of 32 bytes always lands in 32..45 chars, so this never misreads an id; a base58-only alias that long is the cost. */
const CONTEXT_ID = /^[1-9A-HJ-NP-Za-km-z]{32,45}$/;

const TOOLS_NOTE =
  'These are the server-side tool names. An MCP client may expose them under a prefix of its own ' +
  '(commonly mcp__<server>__<tool>), so if a name does not resolve, look for the prefixed form.';

const SERVICE_UNKNOWN =
  'Not discoverable: a node exposes no service list for an application, and this one has no context to read a service name from. ' +
  "Take it from the app's bundle or its docs when create_context asks for one.";

// One stdio server drives one node, so the selection is process-wide; core.ts reads it for node_status.
const selection = new Map<string, Selected>();

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_');

/** Derived from the resolved app rather than the string the caller passed, so the same app always names its tools the same way. */
function slugFor(app: ResolvedApp): string {
  const base = sanitize(lastSegment(app.package || app.id));
  return app.serviceName ? `${base}_${sanitize(app.serviceName)}` : base;
}

function uniqueSlug(app: ResolvedApp): string {
  const taken = new Set([...selection.values()].map((s) => s.slug));
  const base = slugFor(app);
  if (!taken.has(base)) return base;
  // Two packages can sanitise to one slug; the app's own id disambiguates, so the suffix never depends on selection order.
  const tail = app.id.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 6);
  let candidate = `${base}_${tail}`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${tail}_${n}`;
  return candidate;
}

const toolName = (sel: Selected, method: AbiMethod) => `${sel.slug}_${method.name}`;

const selectedLabels = () => [...selection.values()].map((s) => s.label).join(', ');

const totalTools = () => [...selection.values()].reduce((n, s) => n + s.tools.length, 0);

const selectionSummary = () =>
  [...selection.values()].map((s) => ({
    application: s.resolved.id,
    package: s.resolved.package ?? null,
    service: s.resolved.serviceName ?? null,
    context: s.context ?? null,
    tools: s.tools.length,
  }));

export function getSelection(): { selected: ReturnType<typeof selectionSummary> } {
  return { selected: selectionSummary() };
}

function removeApp(id: string): Selected | undefined {
  const existing = selection.get(id);
  if (!existing) return undefined;
  for (const tool of existing.tools) tool.remove();
  selection.delete(id);
  return existing;
}

const noContexts = (label: string) =>
  `Application "${label}" has no contexts on this node. Create one in the Calimero desktop app, or use create_context.`;

const severalContexts = (label: string, ids: string[]) =>
  `Application "${label}" has ${ids.length} contexts; pass context with one of: ${ids.join(', ')}`;

/** The wire args are exactly the declared parameters, so an injected option can never reach the app. */
const argsFrom = (method: AbiMethod, input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(method.params.filter((p) => p.name in input).map((p) => [p.name, input[p.name]]));

/** schema.ts lets a declared param of the same name own the key, so targeting exists only when the method declares none. */
function targetFrom(method: AbiMethod, input: Record<string, unknown>): string | undefined {
  if (method.params.some((p) => p.name === CONTEXT_OPTION)) return undefined;
  return typeof input[CONTEXT_OPTION] === 'string' ? input[CONTEXT_OPTION] : undefined;
}

export function registerAppTools(server: McpServer, session: NodeSession, _cfg: Config): void {
  selection.clear();
  const loader = createAbiLoader(session);
  const aliases = new Map<string, string>();

  async function contextsOf(applicationId: string): Promise<AppContext[]> {
    const { contexts } = (await session.mero.admin.getContextsForApplication(applicationId)) as { contexts: AppContext[] };
    return contexts;
  }

  const contextIds = async (applicationId: string) => (await contextsOf(applicationId)).map((c) => c.id);

  async function summarize(resolved: ResolvedApp, contexts: AppContext[]) {
    const { application } = (await session.mero.admin.getApplication(resolved.id)) as { application: InstalledApp | null };
    const contextServices = [...new Set(contexts.map((c) => c.serviceName).filter((s): s is string => !!s))];
    return {
      application: resolved.id,
      package: application?.package,
      version: application?.version,
      // Nothing on the application record or in the ABI names its services, so an existing context is the only place to read one from.
      service: resolved.serviceName ?? (contextServices.length === 1 ? contextServices[0] : null),
      contextServices,
      ...(resolved.serviceName || contextServices.length ? {} : { serviceNote: SERVICE_UNKNOWN }),
      methods: resolved.manifest.methods.map(renderMethodSignature),
    };
  }

  const unknownContext = async (value: string, ref: AppRef) =>
    `Context "${value}" not found: it is neither a context id nor an alias on this node. ` +
    `Contexts for "${ref.label}": ${(await contextIds(ref.resolved.id)).join(', ') || '(none)'}`;

  /**
   * Ids pass through untouched; anything else is an alias. Core answers a miss with a null value and
   * rejects a string no alias could be, so both mean unresolvable - and only a hit is worth keeping.
   */
  async function resolveContextValue(value: string, ref: AppRef): Promise<string> {
    if (CONTEXT_ID.test(value)) return value;
    const cached = aliases.get(value);
    if (cached) return cached;

    let found: string | null | undefined;
    try {
      ({ value: found } = (await session.mero.admin.lookupContextAlias(value)) as { value?: string | null });
    } catch {
      found = null;
    }
    if (!found) throw new Error(await unknownContext(value, ref));

    aliases.set(value, found);
    return found;
  }

  async function resolveContext(ref: AppRef, explicit?: string): Promise<string> {
    if (explicit) return resolveContextValue(explicit, ref);
    // A pin belongs to the one app it was selected for; every other app resolves its own or says so.
    const pinned = selection.get(ref.resolved.id)?.context;
    if (pinned) return pinned;
    const ids = await contextIds(ref.resolved.id);
    if (ids.length === 1) return ids[0];
    throw new Error(ids.length ? severalContexts(ref.label, ids) : noContexts(ref.label));
  }

  async function execute(ref: AppRef, method: AbiMethod, input: Record<string, unknown>, explicit?: string) {
    try {
      const contextId = await resolveContext(ref, explicit);
      const result = await session.mero.rpc.execute({ contextId, method: method.name, argsJson: argsFrom(method, input) });
      return textResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }

  function registerMethod(sel: Selected, method: AbiMethod): RegisteredTool {
    return server.registerTool(
      toolName(sel, method),
      {
        description: renderMethodSignature(method),
        inputSchema: inputShapeForMethod(method, sel.resolved.manifest),
        ...(method.intent === 'read_only' ? { annotations: { readOnlyHint: true } } : {}),
      },
      async (input: Record<string, unknown>) => execute(sel, method, input, targetFrom(method, input)),
    );
  }

  server.registerTool(
    'describe_app',
    {
      description:
        "Show an application's ABI: every method with its parameters and return type. Does not select it. " +
        'For a multi-service app, omitting `service` returns an error naming the available services. ' +
        "Also reports the service name(s) the application's existing contexts use, which is what create_context asks for.",
      inputSchema: {
        app: z.string().describe('Application id or package name.'),
        service: z.string().optional().describe('Service name, for an app that bundles several.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ app, service }) => {
      try {
        const resolved = await loader.load(app, service);
        return textResult(await summarize(resolved, await contextsOf(resolved.id)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'select_app',
    {
      description:
        'Select an application: registers one tool per ABI method, named after the application, and pins a default context. ' +
        'Adds to the selection - applications already selected keep their tools. Selecting one again refreshes it.',
      inputSchema: {
        app: z.string().describe('Application id or package name.'),
        service: z.string().optional().describe('Service name, for an app that bundles several.'),
        context: z.string().optional().describe('Context id or alias to pin; defaults to the application\'s only context.'),
      },
    },
    async ({ app, service, context }) => {
      try {
        const resolved = await loader.load(app, service);
        // Resolve the pin before touching the selection, so a name that resolves to nothing leaves the current tools alone.
        const pinned = context ? await resolveContextValue(context, { resolved, label: app }) : undefined;
        // Drop the old handles before naming the new ones, so re-selecting refreshes instead of duplicating or self-colliding.
        removeApp(resolved.id);

        const sel: Selected = { resolved, label: app, slug: uniqueSlug(resolved), tools: [] };
        selection.set(resolved.id, sel);
        sel.tools = resolved.manifest.methods.map((m) => registerMethod(sel, m));

        const contexts = await contextsOf(resolved.id);
        const ids = contexts.map((c) => c.id);
        sel.context = pinned ?? (ids.length === 1 ? ids[0] : undefined);

        const toolCount = totalTools();
        return textResult({
          ...(await summarize(resolved, contexts)),
          tools: resolved.manifest.methods.map((m) => toolName(sel, m)),
          toolsNote: TOOLS_NOTE,
          context: sel.context ?? null,
          selected: selectionSummary(),
          toolCount,
          ...(sel.context ? {} : { note: ids.length ? severalContexts(app, ids) : noContexts(app) }),
          ...(toolCount > TOOL_WARNING_THRESHOLD
            ? { warning: `${toolCount} application tools are now registered; deselect_app trims the list if it gets hard to work with.` }
            : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'deselect_app',
    {
      description: 'Deselect an application: removes its tools and its pinned context. Other selected applications are untouched.',
      inputSchema: { app: z.string().describe('Application id or package name.') },
    },
    async ({ app }) => {
      try {
        const id = selection.has(app) ? app : (await loader.resolveAppId(app)).id;
        const removed = removeApp(id);
        if (!removed) throw new Error(`Application "${app}" is not selected. Selected: ${selectedLabels() || '(none)'}`);
        return textResult({
          deselected: removed.resolved.id,
          removedTools: removed.tools.length,
          selected: selectionSummary(),
          toolCount: totalTools(),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'call',
    {
      description:
        'Call an application method by name, validated against its ABI. Use this when the generated per-method tools are not visible.',
      inputSchema: {
        method: z.string().describe('ABI method name.'),
        args: z.record(z.string(), z.unknown()).optional().describe('Method arguments, keyed by parameter name.'),
        app: z.string().optional().describe('Application id or package name; required when several are selected.'),
        context: z.string().optional().describe('Context id or alias; defaults to the context pinned for that application.'),
        service: z.string().optional().describe('Service name; only used together with `app`.'),
      },
    },
    async ({ method, args, app, context, service }) => {
      try {
        if (!app && !selection.size) throw new Error('No application selected. Pass `app`, or run select_app first.');
        if (!app && selection.size > 1) {
          throw new Error(`Several applications are selected (${selectedLabels()}); pass \`app\` to choose one.`);
        }
        const ref: AppRef = app ? { resolved: await loader.load(app, service), label: app } : [...selection.values()][0];

        const abiMethod = ref.resolved.manifest.methods.find((m) => m.name === method);
        if (!abiMethod) {
          const available = ref.resolved.manifest.methods.map((m) => m.name).join(', ') || '(none)';
          throw new Error(`Method "${method}" not found on "${ref.label}". Available: ${available}`);
        }

        const input = z.object(inputShapeForMethod(abiMethod, ref.resolved.manifest)).parse(args ?? {}) as Record<string, unknown>;
        return execute(ref, abiMethod, input, context ?? targetFrom(abiMethod, input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
