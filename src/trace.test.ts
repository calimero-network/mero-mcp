import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { loadConfig } from './config.ts';
import { createSession } from './node.ts';
import { traceTools, tracedFetch } from './trace.ts';
import { connect, ERAS, type Era } from '../test/support/connect.ts';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/** A server whose only tool runs `body` inside a traced call. */
const traced = (body: () => Promise<unknown>) => () => {
  const server = new McpServer({ name: 'trace-test', version: '0.0.0' });
  traceTools(server);
  server.registerTool('probe', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text' as const, text: String(await body()) }] }));
  return server;
};

/** An HTTP server recording the traceparent header of every request, keyed by path in arrival order. */
async function recordHeaders() {
  const seen: Array<[string, string | undefined]> = [];
  const http = createHttpServer((req, res) => {
    seen.push([req.url!, req.headers.traceparent as string | undefined]);
    res.end('ok');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise((resolve) => http.close(resolve)) };
}

for (const era of Object.keys(ERAS) as Era[]) {
  test(`${era}: a node request inside a tool call carries the request's traceparent, and without one it carries none`, async () => {
    const node = await recordHeaders();
    const { client, close } = await connect(traced(async () => (await tracedFetch(`${node.url}/`)).text()), era);
    try {
      await client.callTool({ name: 'probe', arguments: {}, _meta: { traceparent: TRACEPARENT } });
      await client.callTool({ name: 'probe', arguments: {} });
      await tracedFetch(`${node.url}/`);
      assert.deepEqual(node.seen.map(([, header]) => header), [TRACEPARENT, undefined, undefined]);
    } finally {
      await close();
      await node.close();
    }
  });
}

test("concurrent tool calls do not leak one call's traceparent into another", async () => {
  const node = await recordHeaders();
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const server = new McpServer({ name: 'trace-test', version: '0.0.0' });
  traceTools(server);
  server.registerTool('probe', { inputSchema: z.object({ id: z.string() }) }, async ({ id }: { id: string }) => {
    if (id === 'first') await gate;
    await (await tracedFetch(`${node.url}/${id}`)).text();
    if (id === 'second') releaseFirst();
    return { content: [{ type: 'text' as const, text: id }] };
  });
  const { client, close } = await connect(() => server);
  try {
    const firstTrace = '00-11111111111111111111111111111111-1111111111111111-01';
    const secondTrace = '00-22222222222222222222222222222222-2222222222222222-01';
    await Promise.all([
      client.callTool({ name: 'probe', arguments: { id: 'first' }, _meta: { traceparent: firstTrace } }),
      client.callTool({ name: 'probe', arguments: { id: 'second' }, _meta: { traceparent: secondTrace } }),
    ]);
    assert.deepEqual(Object.fromEntries(node.seen), { '/first': firstTrace, '/second': secondTrace });
  } finally {
    await close();
    await node.close();
  }
});

test('tracedFetch drops a malformed, all-zero or reserved-version traceparent instead of forwarding it, and the call still succeeds', async () => {
  const node = await recordHeaders();
  const { client, close } = await connect(traced(async () => (await tracedFetch(`${node.url}/`)).text()));
  try {
    for (const traceparent of [
      '00-x\r\ny-00f067aa0ba902b7-01',
      '00-00000000000000000000000000000000-0000000000000000-01',
      'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    ]) {
      const res = (await client.callTool({ name: 'probe', arguments: {}, _meta: { traceparent } })) as { content: Array<{ text: string }> };
      assert.equal(res.content[0].text, 'ok');
    }
    assert.deepEqual(node.seen.map(([, header]) => header), [undefined, undefined, undefined]);
  } finally {
    await close();
    await node.close();
  }
});

test("a session's node client forwards the traceparent of the tool call it runs in", async () => {
  const node = await recordHeaders();
  const dir = mkdtempSync(join(tmpdir(), 'mcp-trace-'));
  try {
    const session = await createSession(loadConfig({ HOME: '/x', CALIMERO_MCP_STATE_DIR: dir, CALIMERO_NODE_URL: node.url } as NodeJS.ProcessEnv));
    const { client, close } = await connect(traced(() => session.mero.admin.healthCheck().catch(() => 'answered')));
    try {
      await client.callTool({ name: 'probe', arguments: {}, _meta: { traceparent: TRACEPARENT } });
    } finally {
      await close();
    }
    assert.deepEqual(node.seen.map(([, header]) => header), [TRACEPARENT]);
  } finally {
    await node.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
