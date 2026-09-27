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
  async function contextsOf(applicationId: string): Promise<AppContext[]> {
    return ((await session.mero.admin.getContextsForApplication(applicationId)) as { contexts: AppContext[] }).contexts;
  }

  const refuse = (app: AppIdentity, text = retry(app), withGuide = true) => ({
    refusal: { isError: true as const, content: [...(withGuide ? guideBlocks(app) : []), { type: 'text' as const, text }] },
  });

  return {
    contextsOf,
    issue: (app: ResolvedApp, contextId: string | null) => handles.issue(handlePayload(app, contextId)),
    read: handles.read,
    refuse,

    /** The context a call may run in, or the refusal: a handle must match the installed app, its guide and a live context. */
    async admit(app: ResolvedApp, handle: unknown): Promise<Admission> {
      const payload = handles.read(handle);
      const expected = handlePayload(app, null);
      if (!payload || (['a', 'p', 'v', 'g', 's'] as const).some((key) => payload[key] !== expected[key])) return refuse(app);
      if (payload.c === null) return refuse(app, noContext(app), false);
      const target = (await contextsOf(app.id)).find((c) => c.id === payload.c);
      const service = target && (target.serviceName ?? app.soleService);
      if (!target || (app.serviceName && service !== app.serviceName)) return refuse(app);
      return { contextId: target.id };
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
