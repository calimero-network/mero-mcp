import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { currentTraceparent, traceTools, tracedFetch } from './trace.ts';
import { connect, ERAS, type Era } from '../test/support/connect.ts';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/** A server whose only tool runs `body` inside a traced call. */
const traced = (body: () => Promise<string>) => () => {
  const server = new McpServer({ name: 'trace-test', version: '0.0.0' });
  traceTools(server);
  server.registerTool('probe', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text' as const, text: await body() }] }));
  return server;
};

for (const era of Object.keys(ERAS) as Era[]) {
  test(`${era}: a tool call runs with the request's traceparent in scope, and without one it has none`, async () => {
    const { client, close } = await connect(traced(async () => currentTraceparent() ?? 'none'), era);
    try {
      const withTrace = (await client.callTool({ name: 'probe', arguments: {}, _meta: { traceparent: TRACEPARENT } })) as { content: Array<{ text: string }> };
      const without = (await client.callTool({ name: 'probe', arguments: {} })) as { content: Array<{ text: string }> };
      assert.equal(withTrace.content[0].text, TRACEPARENT);
      assert.equal(without.content[0].text, 'none');
    } finally {
      await close();
    }
  });
}

test('concurrent tool calls do not leak one call\'s traceparent into another', async () => {
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const seen: Record<string, string | undefined> = {};
  const server = new McpServer({ name: 'trace-test', version: '0.0.0' });
  traceTools(server);
  server.registerTool('probe', { inputSchema: z.object({ id: z.string() }) }, async ({ id }: { id: string }) => {
    if (id === 'first') await gate;
    seen[id] = currentTraceparent();
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
    assert.equal(seen.first, firstTrace);
    assert.equal(seen.second, secondTrace);
  } finally {
    await close();
  }
});

test('tracedFetch sends the traceparent header only from inside a traced call', async () => {
  const seen: Array<string | undefined> = [];
  const http = createHttpServer((req, res) => {
    seen.push(req.headers.traceparent as string | undefined);
    res.end('ok');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
  try {
    await tracedFetch(url);
    const { client, close } = await connect(traced(async () => (await tracedFetch(url)).text()));
    try {
      await client.callTool({ name: 'probe', arguments: {}, _meta: { traceparent: TRACEPARENT } });
    } finally {
      await close();
    }
    assert.deepEqual(seen, [undefined, TRACEPARENT]);
  } finally {
    http.close();
  }
});

test('tracedFetch drops a malformed traceparent instead of forwarding it, and the call still succeeds', async () => {
  const seen: Array<string | undefined> = [];
  const http = createHttpServer((req, res) => {
    seen.push(req.headers.traceparent as string | undefined);
    res.end('ok');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
  try {
    const { client, close } = await connect(traced(async () => (await tracedFetch(url)).text()));
    try {
      const malformed = (await client.callTool({ name: 'probe', arguments: {}, _meta: { traceparent: '00-x\r\ny-00f067aa0ba902b7-01' } })) as { content: Array<{ text: string }> };
      const allZero = (await client.callTool({ name: 'probe', arguments: {}, _meta: { traceparent: '00-00000000000000000000000000000000-0000000000000000-01' } })) as { content: Array<{ text: string }> };
      assert.equal(malformed.content[0].text, 'ok');
      assert.equal(allZero.content[0].text, 'ok');
      assert.deepEqual(seen, [undefined, undefined]);
    } finally {
      await close();
    }
  } finally {
    http.close();
  }
});
