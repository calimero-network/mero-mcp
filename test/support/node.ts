import type { NodeSession } from '../../src/node.ts';

export interface FakeApp {
  id: string;
  package?: string;
  version?: string;
  signer_id?: string;
  metadata?: Record<string, unknown>;
  abi: unknown;
  /** Per-service ABIs for a multi-service bundle; `abi` is ignored when present. */
  services?: Record<string, unknown>;
  contexts?: Array<string | { id: string; serviceName?: string }>;
}

const utf8 = (value: unknown) => (value === undefined ? [] : [...Buffer.from(JSON.stringify(value), 'utf8')]);

/** A node holding `apps`; every contract call lands in `executed`, and `apps` can be edited to simulate installs. */
export function fakeNode(apps: FakeApp[], opts: { aliases?: Record<string, string>; execute?: (params: Record<string, unknown>) => unknown } = {}) {
  const executed: Array<Record<string, unknown>> = [];
  const session = {
    url: 'http://localhost:2528',
    nodeName: 'test',
    authMode: 'none',
    mero: {
      admin: {
        listApplications: async () => ({
          apps: apps.map((a) => ({
            id: a.id,
            package: a.package,
            version: a.version,
            signer_id: a.signer_id,
            metadata: utf8(a.metadata),
            blob: { bytecode: `${a.id}-${a.version}` },
            ...(a.services ? { services: Object.fromEntries(Object.keys(a.services).map((name) => [name, { bytecode: `${a.id}-${name}` }])) } : {}),
          })),
        }),
        getApplication: async (id: string) => ({ application: apps.find((a) => a.id === id) ?? null }),
        getApplicationAbi: async (id: string, service?: string) => {
          const app = apps.find((a) => a.id === id);
          if (!app?.services) return app?.abi;
          // Mirrors core: a multi-service app needs a service name, and the message lists the choices.
          if (!service) throw new Error(`application has multiple services; pass service_name (available: ${Object.keys(app.services).join(', ')})`);
          return app.services[service];
        },
        getContextsForApplication: async (id: string) => ({
          contexts: (apps.find((a) => a.id === id)?.contexts ?? []).map((c) => (typeof c === 'string' ? { id: c } : c)),
        }),
        lookupContextAlias: async (name: string) => ({ value: opts.aliases?.[name] ?? null }),
      },
      rpc: {
        execute: async (params: Record<string, unknown>) => {
          executed.push(params);
          return opts.execute ? opts.execute(params) : { ok: true };
        },
      },
    },
  } as unknown as NodeSession;
  return { session, executed, apps };
}

/** Context ids are base58 32-byte hashes and the alias path keys on that shape, so a fixture id must have it too. */
export const ctx = (label: string) => label.padEnd(44, 'z');

export const method = (name: string, params: Array<{ name: string; type: unknown; nullable?: boolean; doc?: string }> = [], extra: Record<string, unknown> = {}) => ({
  name,
  params,
  intent: 'mutating',
  ...extra,
});

export const manifest = (methods: unknown[], types: Record<string, unknown> = {}) => ({ schema_version: 'wasm-abi/1', types, methods, events: [] });
