import { z } from 'zod';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { ResolvedApp } from './abi.ts';
import { guideBlocks } from './guide.ts';
import { guideHash, handles, type HandleKeeper, type HandlePayload } from './handle.ts';
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

/** What a generated tool knows when a handle names another installed version of its package. */
export interface Sibling {
  toolVersion: string;
  /** The tool of the handle's version for the same method, when that version has one. */
  tool?: string;
}

export type Admission = { contextId: string } | { refusal: { isError: true; content: Block[] } };

export const packageKey = (app: ResolvedApp) => app.package ?? app.id;

const retry = (app: ResolvedApp) => `Call select_app for ${packageKey(app)} and retry with the returned app_handle.`;

const noContext = (app: ResolvedApp) =>
  `This app_handle names no context. Call select_app for ${packageKey(app)} with a context and retry with the returned app_handle.`;

/** Names the tool that takes this handle, and how to get a handle for this tool, so a crossed call ends in one retry. */
function otherVersion(app: ResolvedApp, handleVersion: string, { toolVersion, tool }: Sibling): string {
  const pkg = packageKey(app);
  const select = `call select_app for ${pkg} with a context of ${pkg} ${toolVersion} and retry with the returned app_handle.`;
  const redirect = tool ? `Pass it to ${tool} instead, or ${select}` : `${select.charAt(0).toUpperCase()}${select.slice(1)}`;
  return `This app_handle is for ${pkg} ${handleVersion}, but this tool belongs to ${pkg} ${toolVersion}. ${redirect}`;
}

/** The handle select_app and describe_app give out for this app as installed right now. */
export const handlePayload = (app: ResolvedApp, contextId: string | null) => ({
  p: packageKey(app),
  v: app.version ?? '',
  g: guideHash(app.guide),
  c: contextId,
  s: app.serviceName ?? null,
});

export function createGate(session: NodeSession, keeper: HandleKeeper = handles) {
  async function contextsOf(applicationId: string): Promise<AppContext[]> {
    return ((await session.mero.admin.getContextsForApplication(applicationId)) as { contexts: AppContext[] }).contexts;
  }

  const refuse = (app: ResolvedApp, text: string, withGuide = true) => ({
    refusal: { isError: true as const, content: [...(withGuide ? guideBlocks(app) : []), { type: 'text' as const, text }] },
  });

  return {
    contextsOf,
    issue: (app: ResolvedApp, contextId: string | null) => keeper.issue(handlePayload(app, contextId)),
    read: keeper.read,
    retryText: retry,
    refuse,

    /**
     * The context a call may run in, or the refusal: a handle must match the installed app, its guide and a live context.
     * `sibling` answers for a readable handle naming another installed version, so the refusal says where it does work.
     */
    async admit(app: ResolvedApp, handle: unknown, sibling?: (payload: HandlePayload) => Sibling | undefined): Promise<Admission> {
      const payload = keeper.read(handle);
      const expected = handlePayload(app, null);
      const other = payload && sibling?.(payload);
      if (payload && other) return refuse(app, otherVersion(app, payload.v, other));
      if (!payload || (['p', 'v', 'g', 's'] as const).some((key) => payload[key] !== expected[key])) return refuse(app, retry(app));
      if (payload.c === null) return refuse(app, noContext(app), false);
      const target = (await contextsOf(app.id)).find((c) => c.id === payload.c);
      const service = target && (target.serviceName ?? app.soleService);
      if (!target || (app.serviceName && service !== app.serviceName)) return refuse(app, retry(app));
      return { contextId: target.id };
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
