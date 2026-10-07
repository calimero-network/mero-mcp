import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { AppNotFoundError, INIT_METHOD, packageKey, type AbiLoader, type ResolvedApp } from '../abi.ts';
import type { Catalog } from '../catalog.ts';
import { errorResult, textResult } from '../errors.ts';
import { advertisedObject, type Gate } from '../gate.ts';
import { guideBlocks, guideUri } from '../guide.ts';
import type { NodeSession } from '../node.ts';
import { methodReference, parseArgs } from '../schema.ts';
import { toolNamesByApp } from './generated.ts';

/** Core hex-encodes every 32-byte id (context, group, namespace), always 64 lowercase hex chars. */
const CONTEXT_ID = /^[0-9a-f]{64}$/;

const NO_GUIDE = 'This app ships no guide.';

const NO_HANDLE = 'Call select_app for the application and retry with the returned app_handle.';

const INIT_REFUSED =
  "init runs once, when create_context creates the context; pass its arguments as create_context's args. It cannot be called on a context.";

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
  app: z
    .string()
    .optional()
    .describe('Application id, package name, or display name; a refusal shows its guide, and a handle for another app is refused.'),
});

const noContexts = (label: string) =>
  `Application "${label}" has no contexts on this node. Create one in the Calimero desktop app, or use create_context.`;

const contextsFor = (label: string, ids: string[]) => `Contexts for "${label}": ${ids.join(', ') || '(none)'}`;

const severalContexts = (label: string, ids: string[]) =>
  `Application "${label}" has ${ids.length} contexts; pass context with one of: ${ids.join(', ')}`;

const refusal = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });

/** A second content block onward, so the structured result in the first stays parseable JSON. */
const withBlocks = (data: unknown, blocks: Array<{ type: string }>) =>
  ({ content: [...textResult(data).content, ...blocks] }) as ReturnType<typeof textResult>;

export function registerAppTools(
  server: McpServer,
  session: NodeSession,
  loader: AbiLoader,
  catalog: Catalog,
  gate: Gate,
  reserved: ReadonlySet<string>,
): void {
  const aliases = new Map<string, string>();
  const guidesShown = new Set<string>();

  /** The guide in full, remembered as shown for this server session. */
  function showGuide(app: ResolvedApp) {
    const uri = guideUri(app);
    if (uri) guidesShown.add(uri);
    return guideBlocks(app);
  }

  /** The full guide the first time this session shows it; a pointer to its resource after, for a client that kept it out of context. */
  function guideOnce(app: ResolvedApp) {
    const uri = guideUri(app);
    if (!uri || !guidesShown.has(uri)) return showGuide(app);
    return [{ type: 'text' as const, text: `This app's guide was shown earlier this session; read ${uri} if it is not in your context.` }];
  }

  async function summarize(app: ResolvedApp, contextId: string | null) {
    const contexts = await gate.contextsOf(app.id);
    const contextServices = [...new Set(contexts.map((c) => c.serviceName).filter((s): s is string => !!s))];
    return {
      application: app.id,
      package: app.package,
      appVersion: app.version,
      // Nothing on the application record or in the ABI names its services, so an existing context is the only place to read one.
      service: app.serviceName ?? (contextServices.length === 1 ? contextServices[0] : null),
      contextServices,
      ...(app.serviceName || contextServices.length ? {} : { serviceNote: SERVICE_UNKNOWN }),
      ...(app.guide ? { guide: guideUri(app) } : {}),
      app_handle: gate.issue(app, contextId),
    };
  }

  /**
   * Ids pass through untouched; anything else is an alias. Core answers a miss with a null value and
   * rejects a string no alias could be, so both mean unresolvable - and only a hit is worth keeping.
   */
  async function resolveContextValue(value: string, label: string, candidates: string[]): Promise<string> {
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
      // A candidate equal to the rejected value would tell the caller to retry the very thing just refused.
      throw new Error(
        `Context "${value}" not found: it is neither a context id nor an alias on this node. ${contextsFor(label, candidates.filter((c) => c !== value))}`,
      );
    }
    aliases.set(value, found);
    return found;
  }

  /** The chosen context, resolved from an id or alias and checked to belong to `label`, or the only context there is. */
  async function chooseContext(label: string, ids: string[], context?: string): Promise<string | null> {
    if (!context) return ids.length === 1 ? ids[0] : null;
    const contextId = await resolveContextValue(context, label, ids);
    if (!ids.includes(contextId)) throw new Error(`Context "${context}" does not belong to "${label}". ${contextsFor(label, ids)}`);
    return contextId;
  }

  /** The catalog entry `match` picks; a miss (node down at connect, or an install made elsewhere) syncs once first. */
  async function catalogued(match: (a: ResolvedApp) => boolean): Promise<ResolvedApp | undefined> {
    const hit = catalog.apps().find(match);
    if (hit) return hit;
    // A transient node error here must not fail the caller: the miss/not-found path below still applies.
    await catalog.sync().catch(() => {});
    return catalog.apps().find(match);
  }

  const sameUnit = (app: ResolvedApp) => (a: ResolvedApp) =>
    a.id === app.id && a.serviceName === app.serviceName && a.version === app.version;

  /** The refusal for a call its handle does not cover, with the guide of the app `app` names when it names one. */
  async function refuseWithout(app: unknown) {
    if (typeof app !== 'string') return refusal(NO_HANDLE);
    const named = await loader.identify(app);
    return gate.refuse(named).refusal;
  }

  const describeBlocks = (app: ResolvedApp) => (app.guide ? showGuide(app) : [{ type: 'text' as const, text: NO_GUIDE }]);

  server.registerTool(
    'describe_app',
    {
      description:
        "Show an application's guide and ABI: the author's guide, then every method with its parameters and return type, " +
        'plus an app_handle for planning. Always includes the guide. Does not pick a context. ' +
        'For a multi-service app, omitting `service` returns an error naming the available services.',
      inputSchema: {
        app: z.string().describe('Application id, package name, or display name.'),
        service: z.string().optional().describe('Service name, for an app that bundles several.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ app, service }) => {
      try {
        const resolved = await loader.load(app, service);
        await catalogued(sameUnit(resolved));
        const methods = resolved.manifest.methods.map(methodReference);
        return withBlocks({ ...(await summarize(resolved, null)), methods }, describeBlocks(resolved));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'select_app',
    {
      description:
        "Pick an application and the context to act in. Returns the app_handle every app tool and `call` require; " +
        "the handle names the context, so pass it unchanged. Shows the app's guide the first time only, then a note with its resource uri; " +
        'methods are in describe_app, or pass verbose to include them here.',
      inputSchema: {
        app: z.string().describe('Application id, package name, or display name.'),
        service: z
          .string()
          .optional()
          .describe('Service name, for a multi-service app when no context is chosen; a chosen context decides it.'),
        context: z.string().optional().describe("Context id or alias; defaults to the application's only context."),
        verbose: z.boolean().optional().describe('Also return the methods list and the guide, as describe_app does.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ app, service, context, verbose }) => {
      try {
        const { id } = await loader.identify(app);
        const contexts = await gate.contextsOf(id);
        const ids = contexts.map((c) => c.id);
        const contextId = await chooseContext(app, ids, context);
        // A context belongs to one service, so the chosen context decides which service the handle binds.
        const contextService = contexts.find((c) => c.id === contextId)?.serviceName;
        const resolved = await loader.load(id, contextService ?? service);
        const entry = await catalogued(sameUnit(resolved));
        const tools = entry ? [...toolNamesByApp(catalog.apps(), reserved).get(entry)!.values()] : [];
        return withBlocks(
          {
            ...(await summarize(resolved, contextId)),
            ...(verbose ? { methods: resolved.manifest.methods.map(methodReference) } : {}),
            tools,
            toolsNote: TOOLS_NOTE,
            context: contextId,
            ...(contextId ? {} : { note: ids.length ? severalContexts(app, ids) : noContexts(app) }),
          },
          verbose ? showGuide(resolved) : resolved.guide ? guideOnce(resolved) : [],
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
        if (!payload) return await refuseWithout(app);
        // With a valid handle `app` only matters when it names another app; a name that resolves to nothing is ignored.
        const named = typeof app === 'string' ? await loader.identify(app).catch(() => undefined) : undefined;
        if (named && named.id !== payload.a) return await refuseWithout(app);
        const resolved = await loader.load(payload.a, payload.s ?? undefined).catch((err: unknown) => {
          if (err instanceof AppNotFoundError) return undefined;
          throw err;
        });
        if (!resolved) return refusal(NO_HANDLE);
        await catalogued(sameUnit(resolved));
        const admitted = await gate.admit(resolved, app_handle);
        if ('refusal' in admitted) return admitted.refusal;
        const { method, args } = CALL_INPUT.parse(raw);
        if (method === INIT_METHOD) return refusal(INIT_REFUSED);

        const abiMethod = resolved.manifest.methods.find((m) => m.name === method);
        if (!abiMethod) {
          const available = resolved.manifest.methods.map((m) => m.name).join(', ') || '(none)';
          throw new Error(`Method "${method}" not found on "${packageKey(resolved)}". Available: ${available}`);
        }
        const argsJson = parseArgs(abiMethod, resolved.manifest, args ?? {});
        return textResult(await session.mero.rpc.execute({ contextId: admitted.contextId, method, argsJson }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
