import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as meroJs from '@calimero-network/mero-js';
import type { NodeSession } from './node.ts';
import { createAbiLoader } from './abi.ts';

// HTTPError is absent from mero-js's resolvable types but real at runtime; the
// mapping under test keys on its fields, so use the genuine class, not a stand-in.
type HttpErrorCtor = new (status: number, statusText: string, url: string, headers: Headers, bodyText?: string) => Error;
const { HTTPError } = meroJs as unknown as { HTTPError: HttpErrorCtor };

const MANIFEST = {
  schema_version: 'wasm-abi/1',
  types: {},
  methods: [{ name: 'set', params: [{ name: 'key', type: { kind: 'string' } }], returns: { kind: 'unit' }, intent: 'mutating' }],
  events: [],
};

const APP_ID = 'CmvPBb4hL9ZmT3xw5aFyQ2sK8nJd6RgUvX1eYtWcMpZo';

const app = (over: Partial<ReturnType<typeof baseApp>> = {}) => ({ ...baseApp(), ...over });
const baseApp = () => ({
  id: APP_ID,
  blob: { bytecode: 'blob-v1', compiled: 'compiled-v1' },
  size: 1024,
  source: 'file:///tmp/kv.wasm',
  metadata: [] as number[],
  signer_id: 'signer',
  package: 'kv-store',
  version: '0.1.0',
});

/** `{"error": ...}` is what core's ApiError serializes to; a route axum never matched has no body. */
const httpError = (status: number, message?: string) =>
  new HTTPError(status, 'Err', 'http://node/abi', new Headers(), message === undefined ? undefined : JSON.stringify({ error: message }));

function fake(opts: { apps?: ReturnType<typeof app>[]; abi?: (id: string, serviceName?: string) => unknown } = {}) {
  const calls = { list: 0, abi: 0, abiArgs: [] as Array<[string, string | undefined]> };
  let apps = opts.apps ?? [app()];
  const session = {
    url: 'http://localhost:2528',
    nodeName: 'test',
    authMode: 'none',
    mero: {
      admin: {
        listApplications: async () => {
          calls.list++;
          return { apps };
        },
        getApplicationAbi: async (id: string, serviceName?: string) => {
          calls.abi++;
          calls.abiArgs.push([id, serviceName]);
          return opts.abi ? opts.abi(id, serviceName) : MANIFEST;
        },
      },
    },
  } as unknown as NodeSession;
  return { loader: createAbiLoader(session), calls, setApps: (next: ReturnType<typeof app>[]) => { apps = next; } };
}

test('resolveAppId matches an exact application id', async () => {
  const { loader } = fake();
  assert.deepEqual(await loader.resolveAppId(APP_ID), { id: APP_ID, blobId: 'blob-v1' });
});

test('resolveAppId matches a package name', async () => {
  const { loader } = fake();
  assert.deepEqual(await loader.resolveAppId('kv-store'), { id: APP_ID, blobId: 'blob-v1' });
});

test('resolveAppId on a miss lists what is installed', async () => {
  const { loader } = fake({ apps: [app(), app({ id: 'other', package: 'mero-drive' })] });
  await assert.rejects(loader.resolveAppId('nope'), /not found\. Installed: kv-store, mero-drive/);
});

test('resolveAppId on an empty node says (none)', async () => {
  const { loader } = fake({ apps: [] });
  await assert.rejects(loader.resolveAppId('kv-store'), /Installed: \(none\)/);
});

test('load parses the manifest and passes the service name through', async () => {
  const { loader, calls } = fake();
  const resolved = await loader.load('kv-store', 'api');
  assert.equal(resolved.manifest.methods[0].name, 'set');
  assert.equal(resolved.blobId, 'blob-v1');
  assert.equal(resolved.serviceName, 'api');
  assert.deepEqual(calls.abiArgs, [[APP_ID, 'api']]);
});

test('load caches by blob id so a second call does not refetch the ABI', async () => {
  const { loader, calls } = fake();
  const first = await loader.load('kv-store');
  const second = await loader.load('kv-store');
  assert.equal(calls.abi, 1);
  assert.equal(first.manifest, second.manifest);
});

test('load treats a different service name as a separate entry', async () => {
  const { loader, calls } = fake();
  await loader.load('kv-store', 'api');
  await loader.load('kv-store', 'worker');
  assert.equal(calls.abi, 2);
});

test('an upgraded app gets a new blob id and refetches', async () => {
  const { loader, calls, setApps } = fake();
  await loader.load('kv-store');
  setApps([app({ blob: { bytecode: 'blob-v2', compiled: 'compiled-v2' } })]);
  assert.equal((await loader.load('kv-store')).blobId, 'blob-v2');
  assert.equal(calls.abi, 2);
});

test('a failed fetch is not cached', async () => {
  let fail = true;
  const { loader, calls } = fake({
    abi: () => {
      if (fail) throw httpError(400, 'transient');
      return MANIFEST;
    },
  });
  await assert.rejects(loader.load('kv-store'), /transient/);
  fail = false;
  assert.equal((await loader.load('kv-store')).manifest.schema_version, 'wasm-abi/1');
  assert.equal(calls.abi, 2);
});

test('a bodyless 404 means the route is missing, so ask for a merod upgrade', async () => {
  const { loader } = fake({ abi: () => { throw httpError(404); } });
  await assert.rejects(loader.load('kv-store'), /does not support the ABI endpoint/);
});

test("a structured 404 keeps the node's message", async () => {
  const { loader } = fake({ abi: () => { throw httpError(404, 'Application bytecode not found'); } });
  await assert.rejects(loader.load('kv-store'), (err: Error) => {
    assert.equal(err.message, 'Application bytecode not found');
    return true;
  });
});

test('a 400 for an absent ABI propagates unchanged', async () => {
  const body = 'application has no usable embedded ABI (absent or malformed); rebuild it with `cargo mero build`';
  const { loader } = fake({ abi: () => { throw httpError(400, body); } });
  await assert.rejects(loader.load('kv-store'), (err: Error) => {
    assert.equal(err.message, body);
    return true;
  });
});

test('a 400 for an ambiguous service propagates unchanged', async () => {
  const body = 'application has multiple services; pass service_name (available: api, worker)';
  const { loader } = fake({ abi: () => { throw httpError(400, body); } });
  await assert.rejects(loader.load('kv-store'), (err: Error) => {
    assert.equal(err.message, body);
    return true;
  });
});

test('a network failure is rethrown as-is, not as a merod upgrade prompt', async () => {
  const boom = new HTTPError(0, 'Network Error', 'http://node/abi', new Headers(), 'fetch failed');
  const { loader } = fake({ abi: () => { throw boom; } });
  await assert.rejects(loader.load('kv-store'), (err: unknown) => err === boom);
});

test('a malformed manifest surfaces the parser error', async () => {
  const { loader } = fake({ abi: () => ({ schema_version: 'wasm-abi/1' }) });
  await assert.rejects(loader.load('kv-store'), /ABI schema validation failed/);
});
