import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLazySession } from './session.ts';
import type { Config } from './config.ts';
import type { NodeSession } from './node.ts';

const CFG = {} as Config;

function fakeReal(url: string): NodeSession {
  return {
    url,
    nodeName: 'fake',
    authMode: 'none',
    mero: { admin: { healthCheck: async () => 'ok' }, rpc: {} } as unknown as NodeSession['mero'],
  };
}

test('a failed attempt is not memoized: the next call retries', async () => {
  let calls = 0;
  const session = createLazySession(CFG, async () => {
    calls++;
    if (calls === 1) throw new Error('node down');
    return fakeReal('http://node');
  });

  const admin = session.mero.admin as unknown as { healthCheck(): Promise<string> };
  await assert.rejects(() => admin.healthCheck(), /node down/);
  await assert.doesNotReject(() => admin.healthCheck());
  assert.equal(calls, 2);
});

test('a successful attempt is memoized: later calls do not recreate the session', async () => {
  let calls = 0;
  const session = createLazySession(CFG, async () => {
    calls++;
    return fakeReal('http://node');
  });

  const admin = session.mero.admin as unknown as { healthCheck(): Promise<string> };
  await admin.healthCheck();
  await admin.healthCheck();
  assert.equal(calls, 1);
});

test('url/nodeName/authMode start as placeholders and adopt the real values once resolved', async () => {
  const session = createLazySession(CFG, async () => fakeReal('http://resolved'));
  assert.equal(session.url, '');

  const admin = session.mero.admin as unknown as { healthCheck(): Promise<string> };
  await admin.healthCheck();
  assert.equal(session.url, 'http://resolved');
  assert.equal(session.nodeName, 'fake');
});
