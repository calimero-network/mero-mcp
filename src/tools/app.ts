import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AbiLoader, ResolvedApp } from '../abi.ts';
import type { Catalog } from '../catalog.ts';
import { errorResult, textResult } from '../errors.ts';
import { advertisedObject, packageKey, type Gate } from '../gate.ts';
import { guideBlocks } from '../guide.ts';
import type { NodeSession } from '../node.ts';
import { inputShapeForMethod, renderMethodSignature } from '../schema.ts';
import { toolNamesByApp } from './generated.ts';

/** Base58 of 32 bytes always lands in 32..45 chars, so this never misreads an id; a base58-only alias that long is the cost. */
const CONTEXT_ID = /^[1-9A-HJ-NP-Za-km-z]{32,45}$/;

const NO_GUIDE = 'This app ships no guide.';

const TOOLS_NOTE =
  'These are the server-side tool names. An MCP client may expose them under a prefix of its own ' +
  '(commonly mcp__<server>__<tool>), so if a name does not resolve, look for the prefixed form.';

const SERVICE_UNKNOWN =
  'Not discoverable: a node exposes no service list for an application, and this one has no context to read a service name from. ' +
  "Take it from the app's bundle or its docs when create_context asks for one.";

const CALL_INPUT = z.object({
  app_handle: z.string().describe('The app_handle select_app returned; it names the application and the context.'),
  method: z.string().describe('ABI method name.'),
  args: z.record(z.string(), z.unknown()).optional().describe('Method arguments, keyed by parameter name.'),
  app: z.string().optional().describe('Application id or package name; a refusal shows its guide, and a handle for another app is refused.'),
});

const noContexts = (label: string) =>
  `Application "${label}" has no contexts on this node. Create one in the Calimero desktop app, or use create_context.`;

const severalContexts = (label: string, ids: string[]) =>
  `Application "${label}" has ${ids.length} contexts; pass context with one of: ${ids.join(', ')}`;

/** A second content block onward, so the structured result in the first stays parseable JSON. */
const withBlocks = (data: unknown, blocks: Array<{ type: string }>) => ({ content: [...textResult(data).content, ...blocks] }) as ReturnType<typeof textResult>;

export function registerAppTools(server: McpServer, session: NodeSession, loader: AbiLoader, catalog: Catalog, gate: Gate): void {
  const aliases = new Map<string, string>();

  async function summarize(app: ResolvedApp, contextId: string | null) {
    const contexts = await gate.contextsOf(app.id);
    const contextServices = [...new Set(contexts.map((c) => c.serviceName).filter((s): s is string => !!s))];
    return {
      application: app.id,
      package: app.package,
      appVersion: app.version,
      // Nothing on the application record or in the ABI names its services, so an existing context is the only place to read one from.
      service: app.serviceName ?? (contextServices.length === 1 ? contextServices[0] : null),
      contextServices,
      ...(app.serviceName || contextServices.length ? {} : { serviceNote: SERVICE_UNKNOWN }),
      methods: app.manifest.methods.map(renderMethodSignature),
      app_handle: gate.issue(app, contextId),
    };
  }

  /**
   * Ids pass through untouched; anything else is an alias. Core answers a miss with a null value and
   * rejects a string no alias could be, so both mean unresolvable - and only a hit is worth keeping.
   */
  async function resolveContextValue(value: string, applicationId: string, label: string): Promise<string> {
    if (CONTEXT_ID.test(value)) return value;
    const cached = aliases.get(value);
    if (cached) return cached;
    let found: string | null | undefined;
    try {
      ({ value: found } = (await session.mero.admin.lookupContextAlias(value)) as { value?: string | null });
    } catch {
      found = null;
    }
    if (!found) {
      const ids = (await gate.contextsOf(applicationId)).map((c) => c.id);
      throw new Error(
        `Context "${value}" not found: it is neither a context id nor an alias on this node. Contexts for "${label}": ${ids.join(', ') || '(none)'}`,
      );
    }
    aliases.set(value, found);
    return found;
  }

  const describeBlocks = (app: ResolvedApp) => (app.guide ? guideBlocks(app) : [{ type: 'text' as const, text: NO_GUIDE }]);

  server.registerTool(
    'describe_app',
    {
      description:
        "Show an application's guide and ABI: the author's guide, then every method with its parameters and return type, plus an app_handle " +
        'for planning. Does not pick a context. For a multi-service app, omitting `service` returns an error naming the available services.',
      inputSchema: {
        app: z.string().describe('Application id or package name.'),
        service: z.string().optional().describe('Service name, for an app that bundles several.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ app, service }) => {
      try {
        const resolved = await loader.load(app, service);
        return withBlocks(await summarize(resolved, null), describeBlocks(resolved));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'select_app',
    {
      description:
        "Pick an application and the context to act in. Returns the app's guide and the app_handle every app tool and `call` require; " +
        'the handle names the context, so pass it unchanged.',
      inputSchema: {
        app: z.string().describe('Application id or package name.'),
        service: z.string().optional().describe('Service name, for a multi-service app when no context is chosen; a chosen context decides it.'),
        context: z.string().optional().describe("Context id or alias; defaults to the application's only context."),
      },
    },
    async ({ app, service, context }) => {
      try {
        const { id } = await loader.resolveAppId(app);
        const contexts = await gate.contextsOf(id);
        const ids = contexts.map((c) => c.id);
        const contextId = context ? await resolveContextValue(context, id, app) : ids.length === 1 ? ids[0] : null;
        // A context belongs to one service, so the chosen context decides which service the handle binds.
        const contextService = contexts.find((c) => c.id === contextId)?.serviceName;
        const resolved = await loader.load(app, contextService ?? service);
        const tools = [...toolNamesByApp(catalog.apps()).entries()].find(([a]) => a.id === resolved.id && a.serviceName === resolved.serviceName)?.[1] ?? [];
        return withBlocks(
          {
            ...(await summarize(resolved, contextId)),
            tools,
            toolsNote: TOOLS_NOTE,
            context: contextId,
            ...(contextId ? {} : { note: ids.length ? severalContexts(app, ids) : noContexts(app) }),
          },
          resolved.guide ? guideBlocks(resolved) : [],
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'call',
    {
      description:
        'Call an application method by name with the app_handle select_app returned, validated against its ABI. ' +
        'Use this when the generated per-method tools are not visible.',
      inputSchema: advertisedObject(CALL_INPUT),
    },
    async (raw: unknown) => {
      try {
        const { app_handle, app } = raw as { app_handle?: unknown; app?: unknown };
        const payload = gate.read(app_handle);
        const named = typeof app === 'string' ? await loader.resolveAppId(app) : undefined;
        if (!payload || (named && (named.package ?? named.id) !== payload.p)) {
          if (typeof app !== 'string') {
            return { isError: true, content: [{ type: 'text' as const, text: 'Call select_app for the application and retry with the returned app_handle.' }] };
          }
          const resolved = await loader.load(app);
          return gate.refuse(resolved, gate.retryText(resolved)).refusal;
        }
        // Installed versions of one package share its name, so the handle's version picks the entry to load.
        const listed = catalog.apps().find((a) => packageKey(a) === payload.p && (a.version ?? '') === payload.v && (a.serviceName ?? null) === payload.s);
        const resolved = await loader.load(listed?.id ?? payload.p, payload.s ?? undefined);
        const admitted = await gate.admit(resolved, app_handle);
        if ('refusal' in admitted) return admitted.refusal;
        const { method, args } = CALL_INPUT.parse(raw);

        const abiMethod = resolved.manifest.methods.find((m) => m.name === method);
        if (!abiMethod) {
          const available = resolved.manifest.methods.map((m) => m.name).join(', ') || '(none)';
          throw new Error(`Method "${method}" not found on "${resolved.package ?? resolved.id}". Available: ${available}`);
        }
        const argsJson = z.object(inputShapeForMethod(abiMethod, resolved.manifest)).parse(args ?? {});
        return textResult(await session.mero.rpc.execute({ contextId: admitted.contextId, method, argsJson }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
