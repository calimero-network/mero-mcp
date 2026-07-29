import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AbiMethod } from '@calimero-network/abi-codegen';
import { createAbiLoader, type ResolvedApp } from '../abi.ts';
import type { Config } from '../config.ts';
import type { NodeSession } from '../node.ts';
import { errorResult, textResult } from '../errors.ts';
import { CONTEXT_OPTION, inputShapeForMethod, renderMethodSignature } from '../schema.ts';

interface Selected {
  resolved: ResolvedApp;
  /** What the caller typed: a package name reads better in errors than a base58 id. */
  label: string;
}

// mero-js ships its admin types behind extensionless barrels NodeNext will not
// resolve, so `mero.admin` reaches us as `any`; these are the fields we read.
interface InstalledApp {
  package?: string;
  version?: string;
}

// One stdio server drives one node, so the selection is process-wide; core.ts reads it for node_status.
let selected: Selected | undefined;
let pinnedContext: string | undefined;
let dynamicTools: RegisteredTool[] = [];

export function getSelection(): { application?: string; service?: string; context?: string } {
  return { application: selected?.resolved.id, service: selected?.resolved.serviceName, context: pinnedContext };
}

const toolName = (app: ResolvedApp, method: AbiMethod) =>
  app.serviceName ? `app_${app.serviceName}_${method.name}` : `app_${method.name}`;

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
  selected = undefined;
  pinnedContext = undefined;
  dynamicTools = [];
  const loader = createAbiLoader(session);

  async function contextIds(applicationId: string): Promise<string[]> {
    const { contexts } = (await session.mero.admin.getContextsForApplication(applicationId)) as {
      contexts: Array<{ id: string }>;
    };
    return contexts.map((c) => c.id);
  }

  async function summarize(resolved: ResolvedApp) {
    const { application } = (await session.mero.admin.getApplication(resolved.id)) as { application: InstalledApp | null };
    return {
      application: resolved.id,
      package: application?.package,
      version: application?.version,
      service: resolved.serviceName ?? null,
      methods: resolved.manifest.methods.map(renderMethodSignature),
    };
  }

  async function resolveContext(sel: Selected, explicit?: string): Promise<string> {
    if (explicit) return explicit;
    // The pin belongs to the selected app, so a call against another app must not inherit it.
    if (pinnedContext && selected?.resolved.id === sel.resolved.id) return pinnedContext;
    const ids = await contextIds(sel.resolved.id);
    if (ids.length === 1) return ids[0];
    throw new Error(ids.length ? severalContexts(sel.label, ids) : noContexts(sel.label));
  }

  async function execute(sel: Selected, method: AbiMethod, input: Record<string, unknown>, explicit?: string) {
    try {
      const contextId = await resolveContext(sel, explicit);
      const result = await session.mero.rpc.execute({ contextId, method: method.name, argsJson: argsFrom(method, input) });
      return textResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }

  function registerMethod(sel: Selected, method: AbiMethod): RegisteredTool {
    return server.registerTool(
      toolName(sel.resolved, method),
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
        'For a multi-service app, omitting `service` returns an error naming the available services.',
      inputSchema: {
        app: z.string().describe('Application id or package name.'),
        service: z.string().optional().describe('Service name, for an app that bundles several.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ app, service }) => {
      try {
        return textResult(await summarize(await loader.load(app, service)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'select_app',
    {
      description:
        'Select an application: registers one tool per ABI method (app_*) and pins a default context. ' +
        'Replaces any previously selected app.',
      inputSchema: {
        app: z.string().describe('Application id or package name.'),
        service: z.string().optional().describe('Service name, for an app that bundles several.'),
        context: z.string().optional().describe('Context id or alias to pin; defaults to the application\'s only context.'),
      },
    },
    async ({ app, service, context }) => {
      try {
        const resolved = await loader.load(app, service);
        for (const tool of dynamicTools) tool.remove();
        const sel: Selected = { resolved, label: app };
        selected = sel;
        dynamicTools = resolved.manifest.methods.map((m) => registerMethod(sel, m));

        const ids = context ? [] : await contextIds(resolved.id);
        pinnedContext = context ?? (ids.length === 1 ? ids[0] : undefined);

        return textResult({
          ...(await summarize(resolved)),
          tools: resolved.manifest.methods.map((m) => toolName(resolved, m)),
          context: pinnedContext ?? null,
          ...(pinnedContext ? {} : { note: ids.length ? severalContexts(app, ids) : noContexts(app) }),
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
        'Call an application method by name, validated against its ABI. Use this when the app_* tools are not visible.',
      inputSchema: {
        method: z.string().describe('ABI method name.'),
        args: z.record(z.string(), z.unknown()).optional().describe('Method arguments, keyed by parameter name.'),
        app: z.string().optional().describe('Application id or package name; defaults to the selected app.'),
        context: z.string().optional().describe('Context id or alias; defaults to the selected context.'),
        service: z.string().optional().describe('Service name; only used together with `app`.'),
      },
    },
    async ({ method, args, app, context, service }) => {
      try {
        if (!app && !selected) throw new Error('No application selected. Pass `app`, or run select_app first.');
        const sel: Selected = app ? { resolved: await loader.load(app, service), label: app } : selected!;

        const abiMethod = sel.resolved.manifest.methods.find((m) => m.name === method);
        if (!abiMethod) {
          const available = sel.resolved.manifest.methods.map((m) => m.name).join(', ') || '(none)';
          throw new Error(`Method "${method}" not found on "${sel.label}". Available: ${available}`);
        }

        const input = z.object(inputShapeForMethod(abiMethod, sel.resolved.manifest)).parse(args ?? {}) as Record<string, unknown>;
        return execute(sel, abiMethod, input, context ?? targetFrom(abiMethod, input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
