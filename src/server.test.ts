import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';
import type { NodeSession } from './node.ts';
import { createServer } from './server.ts';
import { connect, ERAS, type Era } from '../test/support/connect.ts';

const CFG = loadConfig({ HOME: '/x' } as NodeJS.ProcessEnv);

const session = {
  url: 'http://localhost:2528',
  nodeName: 'test',
  authMode: 'none',
  mero: { admin: { lookupContextAlias: async (name: string) => ({ value: name === 'work' ? 'Ctx111' : null }) }, rpc: {} },
} as unknown as NodeSession;

const toolsIn = async (era: Era) => {
  const { client, close } = await connect(() => createServer(session, CFG), era);
  try {
    return (await client.listTools()).tools;
  } finally {
    await close();
  }
};

for (const era of Object.keys(ERAS) as Era[]) {
  test(`${era}: the client negotiates its own era and a tool call answers`, async () => {
    const { client, close } = await connect(() => createServer(session, CFG), era);
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), era);
      assert.equal(client.getServerVersion()?.name, 'mero-mcp');
      const res = (await client.callTool({ name: 'lookup_alias', arguments: { name: 'work' } })) as { content: Array<{ text: string }> };
      assert.deepEqual(JSON.parse(res.content[0].text), { alias: 'work', contextId: 'Ctx111' });
    } finally {
      await close();
    }
  });
}

test('both eras list wire-identical tool definitions', async () => {
  const [modern, legacy] = await Promise.all([toolsIn('2026-07-28'), toolsIn('2025-11-25')]);
  // JSON-normalize: legacy Tool carries an `execution: undefined` key the 2026 anchor type deleted, which JSON drops on both sides.
  assert.deepEqual(JSON.parse(JSON.stringify(modern)), JSON.parse(JSON.stringify(legacy)));
});
