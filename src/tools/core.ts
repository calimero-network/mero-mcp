import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Application, ContextWithGroup, SignedGroupOpenInvitation } from '@calimero-network/mero-js';
import type { Config } from '../config.ts';
import { discoverLocalNodes, listConfiguredNodes, resolveNode } from '../config.ts';
import type { NodeSession } from '../node.ts';
import type { Catalog } from '../catalog.ts';
import { createAbiLoader } from '../abi.ts';
import { errorResult, textResult } from '../errors.ts';
import { listing } from '../guide.ts';

/** Runs an admin call and folds its result or throw into the MCP text-result convention. */
function wrap<Args>(fn: (args: Args) => Promise<unknown>) {
  return async (args: Args) => {
    try {
      return textResult(await fn(args));
    } catch (err) {
      return errorResult(err);
    }
  };
}

// An invitation is signed over its own bytes, so declaring its fields would reshape it
// (and zod would strip the ones we failed to declare) and the signature would stop verifying.
const opaqueInvitation = z
  .record(z.string(), z.unknown())
  .describe('The invitation object returned by invite_to_namespace, passed through unchanged.');

// Hex matches how this codebase already renders bytes for display (see schema.ts's bytesSchema).
const toHex = (bytes: number[]) => Buffer.from(bytes).toString('hex');

export function registerCoreTools(server: McpServer, session: NodeSession, cfg: Config, catalog: Catalog): void {
  const admin = session.mero.admin;
  const { resolveAppId } = createAbiLoader(session);
  // The install already happened; a failed refresh only delays the new tools until the next poll.
  const refreshApps = () => catalog.sync().catch((err: unknown) => console.error('[mero-mcp] app list refresh failed:', err));

  // core: always registered, regardless of CALIMERO_MCP_TOOLSETS.

  server.registerTool(
    'node_status',
    {
      description: 'Health and identity of the node this session is connected to.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async (_args: Record<string, never>) => {
      const [health, discovered] = await Promise.all([admin.healthCheck(), resolveNode(cfg)]);
      return {
        health,
        url: session.url,
        nodeName: session.nodeName ?? null,
        discoverySource: discovered.source,
        authMode: session.authMode,
      };
    }),
  );

  server.registerTool(
    'list_nodes',
    {
      description: 'Calimero nodes known on this machine, plus a live local probe; marks the one this session is using.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async (_args: Record<string, never>) => {
      const named = listConfiguredNodes(cfg).filter((n): n is { name: string; url: string } => n.url !== undefined);
      const probed = await discoverLocalNodes();
      const byUrl = new Map<string, string | undefined>(named.map((n) => [n.url, n.name]));
      for (const url of probed) if (!byUrl.has(url)) byUrl.set(url, undefined);
      return [...byUrl.entries()].map(([url, name]) => ({ url, name, active: url === session.url }));
    }),
  );

  server.registerTool(
    'list_applications',
    { description: 'Applications installed on this node.', inputSchema: {}, annotations: { readOnlyHint: true } },
    wrap(async (_args: Record<string, never>) => {
      const { apps } = await admin.listApplications();
      return { apps: apps.map((app: Application) => ({ ...app, appVersion: app.version ?? null, ...listing(app.metadata) })) };
    }),
  );

  server.registerTool(
    'list_namespaces',
    { description: 'Namespaces on this node.', inputSchema: {}, annotations: { readOnlyHint: true } },
    wrap(async (_args: Record<string, never>) => admin.listNamespaces()),
  );

  server.registerTool(
    'list_contexts',
    {
      description: 'Contexts on this node, optionally filtered to one application.',
      inputSchema: { application: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ application }: { application?: string }) => {
      const { contexts } = application ? await admin.getContextsForApplication(application) : await admin.getContexts();
      return { contexts: contexts.map((ctx: ContextWithGroup) => ({ ...ctx, dagHeads: ctx.dagHeads?.map(toHex) })) };
    }),
  );

  server.registerTool(
    'create_context',
    {
      description: 'Create a new context for an application under a namespace.',
      inputSchema: {
        application: z.string().describe('Application id or package name.'),
        namespace: z.string(),
        name: z.string().optional(),
        service: z.string().optional(),
      },
    },
    wrap(async ({ application, namespace, name, service }: { application: string; namespace: string; name?: string; service?: string }) =>
      admin.createContext({ applicationId: (await resolveAppId(application)).id, groupId: namespace, name, serviceName: service }),
    ),
  );

  server.registerTool(
    'delete_context',
    {
      description: 'Delete a context from this node, including its data. Use this to clear a context left behind by a deleted namespace.',
      inputSchema: { context: z.string() },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ context }: { context: string }) => admin.deleteContext(context)),
  );

  server.registerTool(
    'create_alias',
    { description: 'Create a human-friendly alias for a context id.', inputSchema: { alias: z.string(), contextId: z.string() } },
    wrap(async ({ alias, contextId }: { alias: string; contextId: string }) => {
      // Core answers with an empty body, and a bare `null` reads as a failure.
      await admin.createContextAlias({ alias, contextId });
      return `Alias "${alias}" now resolves to context ${contextId}.`;
    }),
  );

  server.registerTool(
    'lookup_alias',
    {
      description: 'Resolve a context alias to its context id.',
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ name }: { name: string }) => {
      const { value } = await admin.lookupContextAlias(name);
      // A miss is a true answer to a fair question, so it is a result rather than an error - but it has to say so.
      return value ? { alias: name, contextId: value } : `No alias named "${name}" on this node.`;
    }),
  );

  if (cfg.toolsets.has('blobs')) {
    server.registerTool(
      'install_application',
      {
        description: "Install a published application from the node's registry, by package@version coordinates (e.g. com.example.myapp@1.0.0).",
        inputSchema: { coords: z.string().describe('Coordinates of a published application: package@version.') },
      },
      wrap(async ({ coords }: { coords: string }) => {
        const [pkg, version] = coords.split('@');
        if (!pkg || !version) throw new Error(`Expected package@version, got "${coords}".`);
        const installed = await admin.installApplication({ package: pkg, version });
        await refreshApps();
        return installed;
      }),
    );

    server.registerTool(
      'uninstall_application',
      {
        description: 'Uninstall an application from this node.',
        inputSchema: { application: z.string() },
        annotations: { destructiveHint: true },
      },
      wrap(async ({ application }: { application: string }) => {
        const removed = await admin.uninstallApplication(application);
        await refreshApps();
        return removed;
      }),
    );

    server.registerTool(
      'upload_blob',
      {
        description: 'Upload a blob to this node.',
        inputSchema: {
          data: z.string().describe('Base64-encoded blob bytes'),
          hash: z.string().optional(),
          context: z.string().optional(),
        },
      },
      wrap(async ({ data, hash, context }: { data: string; hash?: string; context?: string }) =>
        admin.uploadBlob({ data: Buffer.from(data, 'base64'), hash, contextId: context }),
      ),
    );

    server.registerTool(
      'list_blobs',
      { description: 'Blobs stored on this node.', inputSchema: {}, annotations: { readOnlyHint: true } },
      wrap(async (_args: Record<string, never>) => admin.listBlobs()),
    );

    server.registerTool(
      'delete_blob',
      { description: 'Delete a blob from this node.', inputSchema: { blob: z.string() }, annotations: { destructiveHint: true } },
      wrap(async ({ blob }: { blob: string }) => admin.deleteBlob(blob)),
    );
  }

  if (cfg.toolsets.has('governance')) {
    server.registerTool(
      'create_namespace',
      {
        description: 'Create a namespace for an application.',
        inputSchema: {
          application: z.string().describe('Application id or package name.'),
          name: z.string().optional(),
        },
      },
      wrap(async ({ application, name }: { application: string; name?: string }) =>
        admin.createNamespace({ applicationId: (await resolveAppId(application)).id, name }),
      ),
    );

    server.registerTool(
      'delete_namespace',
      {
        description: 'Delete a namespace. Its contexts outlive it and stay uncallable until delete_context removes them.',
        inputSchema: { namespace: z.string() },
        annotations: { destructiveHint: true },
      },
      wrap(async ({ namespace }: { namespace: string }) => admin.deleteNamespace(namespace)),
    );

    server.registerTool(
      'invite_to_namespace',
      { description: 'Create an invitation to join a namespace.', inputSchema: { namespace: z.string() } },
      wrap(async ({ namespace }: { namespace: string }) => admin.createNamespaceInvitation(namespace)),
    );

    server.registerTool(
      'join_namespace',
      {
        description:
          'Join a namespace using an invitation minted by invite_to_namespace. Pass that invitation object through unchanged - it is signed, and any reshaping invalidates it.',
        inputSchema: { namespace: z.string(), invitation: opaqueInvitation, groupName: z.string().optional() },
      },
      wrap(async ({ namespace, invitation, groupName }: { namespace: string; invitation: Record<string, unknown>; groupName?: string }) =>
        // mero-js declares a camelCase mirror of the invitation, but core's wire keys are snake_case;
        // the payload is signed, so it goes back exactly as it arrived rather than being reshaped to fit.
        admin.joinNamespace(namespace, { invitation: invitation as unknown as SignedGroupOpenInvitation, groupName }),
      ),
    );

    server.registerTool(
      'leave_namespace',
      { description: 'Leave a namespace.', inputSchema: { namespace: z.string() }, annotations: { destructiveHint: true } },
      wrap(async ({ namespace }: { namespace: string }) => {
        await admin.leaveNamespace(namespace);
        return `Left namespace ${namespace}.`;
      }),
    );

    server.registerTool(
      'list_group_members',
      // listGroupMembers returns a flat {members, selfIdentity?} object, unlike its siblings' {data} envelope.
      { description: 'List members of a group.', inputSchema: { group: z.string() }, annotations: { readOnlyHint: true } },
      wrap(async ({ group }: { group: string }) => admin.listGroupMembers(group)),
    );

    server.registerTool(
      'add_group_members',
      {
        description: 'Add members to a group.',
        inputSchema: { group: z.string(), members: z.array(z.object({ identity: z.string(), role: z.string() })) },
      },
      wrap(async ({ group, members }: { group: string; members: Array<{ identity: string; role: string }> }) => {
        await admin.addGroupMembers(group, { members });
        return `Added ${members.map((m) => `${m.identity} (${m.role})`).join(', ')} to group ${group}.`;
      }),
    );
  }
}
