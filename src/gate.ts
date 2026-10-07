import { z } from 'zod';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { packageKey, type AppIdentity, type ResolvedApp } from './abi.ts';
import { guideBlocks } from './guide.ts';
import { guideHash, handles } from './handle.ts';
import type { NodeSession } from './node.ts';

interface AppContext {
  id: string;
  serviceName?: string;
}

type Block = ReturnType<typeof guideBlocks>[number] | { type: 'text'; text: string };

// Tools behind the gate validate in their handler, after the app_handle check, so a missing handle is refused with the guide.
const ACCEPT_ALL = {
  getValidator: () => (input: unknown) => ({ valid: true as const, data: input as never, errorMessage: undefined }),
};

/** Advertises `json` as the tool's inputSchema while leaving validation to the handler. */
export const advertised = (json: Record<string, unknown>) => fromJsonSchema(json, ACCEPT_ALL);

/** The zod object advertised as JSON Schema, for a fixed tool behind the gate. */
export const advertisedObject = (schema: z.ZodObject) => {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return advertised(json);
};

export type Admission = { contextId: string } | { refusal: { isError: true; content: Block[] } };

/** Core hex-encodes every 32-byte id (context, group, namespace), always 64 lowercase hex chars. */
const CONTEXT_ID = /^[0-9a-f]{64}$/;

const contextsFor = (label: string, ids: string[]) => `Contexts for "${label}": ${ids.join(', ') || '(none)'}`;

const retry = (app: AppIdentity) => `Call select_app for ${packageKey(app)} and retry with the returned app_handle.`;

const noContext = (app: ResolvedApp) =>
  `This app_handle names no context. Call select_app for ${packageKey(app)} with a context and retry with the returned app_handle.`;

/** The handle select_app and describe_app give out for this app as installed right now. */
export const handlePayload = (app: ResolvedApp, contextId: string | null) => ({
  a: app.id,
  p: packageKey(app),
  v: app.version ?? '',
  g: guideHash(app.guide),
  c: contextId,
  s: app.serviceName ?? null,
});

export function createGate(session: NodeSession) {
  const aliases = new Map<string, string>();

  async function contextsOf(applicationId: string): Promise<AppContext[]> {
    return ((await session.mero.admin.getContextsForApplication(applicationId)) as { contexts: AppContext[] }).contexts;
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

  async function admitContextId(app: ResolvedApp, contextId: string): Promise<Admission> {
    const target = (await contextsOf(app.id)).find((c) => c.id === contextId);
    const service = target && (target.serviceName ?? app.soleService);
    if (!target || (app.serviceName && service !== app.serviceName)) return refuse(app);
    return { contextId: target.id };
  }

  const refuse = (app: AppIdentity, text = retry(app), withGuide = true) => ({
    refusal: { isError: true as const, content: [...(withGuide ? guideBlocks(app) : []), { type: 'text' as const, text }] },
  });

  return {
    contextsOf,
    chooseContext,
    issue: (app: ResolvedApp, contextId: string | null) => handles.issue(handlePayload(app, contextId)),
    read: handles.read,
    refuse,

    /** The context a call may run in, or the refusal: a handle must match the installed app, its guide and a live context. */
    async admit(app: ResolvedApp, handle: unknown): Promise<Admission> {
      const payload = handles.read(handle);
      const expected = handlePayload(app, null);
      if (!payload || (['a', 'p', 'v', 'g', 's'] as const).some((key) => payload[key] !== expected[key])) return refuse(app);
      if (payload.c === null) return refuse(app, noContext(app), false);
      return admitContextId(app, payload.c);
    },

    /** The same admission for a context named by id or alias instead of a handle. */
    async admitContext(app: ResolvedApp, context: string): Promise<Admission> {
      const contextId = await chooseContext(packageKey(app), (await contextsOf(app.id)).map((c) => c.id), context);
      return admitContextId(app, contextId!);
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
