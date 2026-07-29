import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.ts';
import { discoverLocalNodes, listConfiguredNodes, resolveNode } from '../config.ts';
import type { NodeSession } from '../node.ts';
import { errorResult, textResult } from '../errors.ts';

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

// Mirrors core's SignedGroupOpenInvitation wire shape (the object invite_to_namespace
// returns) so join_namespace can validate it instead of accepting an opaque blob.
const signedInvitation = z.object({
  invitation: z.object({
    inviterIdentity: z.array(z.number()),
    groupId: z.array(z.number()),
    expirationTimestamp: z.number(),
    secretSalt: z.array(z.number()),
    invitedRole: z.number().optional(),
  }),
  inviterSignature: z.string(),
});

export function registerCoreTools(server: McpServer, session: NodeSession, cfg: Config): void {
  const admin = session.mero.admin;

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
      return { health, url: session.url, nodeName: session.nodeName, discoverySource: discovered.source, authMode: session.authMode };
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
    wrap(async (_args: Record<string, never>) => admin.listApplications()),
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
    wrap(async ({ application }: { application?: string }) =>
      application ? admin.getContextsForApplication(application) : admin.getContexts(),
    ),
  );

  server.registerTool(
    'create_context',
    {
      description: 'Create a new context for an application under a namespace.',
      inputSchema: {
        application: z.string(),
        namespace: z.string(),
        name: z.string().optional(),
        service: z.string().optional(),
      },
    },
    wrap(async ({ application, namespace, name, service }: { application: string; namespace: string; name?: string; service?: string }) =>
      admin.createContext({ applicationId: application, groupId: namespace, name, serviceName: service }),
    ),
  );

  server.registerTool(
    'create_alias',
    { description: 'Create a human-friendly alias for a context id.', inputSchema: { alias: z.string(), contextId: z.string() } },
    wrap(async ({ alias, contextId }: { alias: string; contextId: string }) => admin.createContextAlias({ alias, contextId })),
  );

  server.registerTool(
    'lookup_alias',
    {
      description: 'Resolve a context alias to its context id.',
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ name }: { name: string }) => admin.lookupContextAlias(name)),
  );

  if (cfg.toolsets.has('blobs')) {
    server.registerTool(
      'install_application',
      { description: 'Install an application from a URL.', inputSchema: { url: z.string(), hash: z.string().optional() } },
      wrap(async ({ url, hash }: { url: string; hash?: string }) => admin.installApplication({ url, hash, metadata: [] })),
    );

    server.registerTool(
      'uninstall_application',
      {
        description: 'Uninstall an application from this node.',
        inputSchema: { application: z.string() },
        annotations: { destructiveHint: true },
      },
      wrap(async ({ application }: { application: string }) => admin.uninstallApplication(application)),
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
          application: z.string(),
          upgradePolicy: z.enum(['Automatic', 'LazyOnAccess']).optional(),
          name: z.string().optional(),
        },
      },
      wrap(
        async ({ application, upgradePolicy, name }: { application: string; upgradePolicy?: 'Automatic' | 'LazyOnAccess'; name?: string }) =>
          admin.createNamespace({ applicationId: application, upgradePolicy: upgradePolicy ?? 'Automatic', name }),
      ),
    );

    server.registerTool(
      'delete_namespace',
      { description: 'Delete a namespace.', inputSchema: { namespace: z.string() }, annotations: { destructiveHint: true } },
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
        description: 'Join a namespace using an invitation minted by invite_to_namespace.',
        inputSchema: { namespace: z.string(), invitation: signedInvitation, groupName: z.string().optional() },
      },
      wrap(async ({ namespace, invitation, groupName }: { namespace: string; invitation: z.infer<typeof signedInvitation>; groupName?: string }) =>
        admin.joinNamespace(namespace, { invitation, groupName }),
      ),
    );

    server.registerTool(
      'leave_namespace',
      { description: 'Leave a namespace.', inputSchema: { namespace: z.string() }, annotations: { destructiveHint: true } },
      wrap(async ({ namespace }: { namespace: string }) => admin.leaveNamespace(namespace)),
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
      wrap(async ({ group, members }: { group: string; members: Array<{ identity: string; role: string }> }) =>
        admin.addGroupMembers(group, { members }),
      ),
    );
  }
}
