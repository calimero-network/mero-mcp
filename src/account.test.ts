import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { accountForRoot, signerFromSecret, verifyDeviceCredential } from '@calimero-network/mero-js';
import { FileStorage, connectAccount, loadOrCreateDevice, relayOf } from './account.ts';
import { loadConfig } from './config.ts';
import { createSession } from './node.ts';

/** An account directory as mero-bot leaves it: the account, and what it joined. */
async function accountDir(joined: { namespaceId: string; relayUrl: string }[] = []): Promise<{ dir: string; account: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mero-mcp-account-'));
  const rootSecret = randomBytes(32).toString('hex');
  const account = await accountForRoot(rootSecret);
  writeFileSync(join(dir, 'account.json'), JSON.stringify({ account, rootSecret, credential: 'mero-bot-device' }));
  writeFileSync(join(dir, 'joined.json'), JSON.stringify(joined));
  return { dir, account };
}

test('mero-mcp signs with a device of its own, certified by the account root, and keeps it', async () => {
  const { dir, account } = await accountDir();
  const device = await loadOrCreateDevice(dir);
  const cert = await verifyDeviceCredential(device.credential);
  assert.equal(cert.account, account);
  assert.equal(cert.signPublicKey, (await signerFromSecret(device.deviceSecret)).publicKey);
  assert.notEqual(device.credential, 'mero-bot-device', "never mero-bot's device: each spends its own nonces");
  assert.deepEqual(await loadOrCreateDevice(dir), device);
});

test('no account yet says mero-bot makes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mero-mcp-account-'));
  await assert.rejects(loadOrCreateDevice(dir), /mero-bot makes it/);
});

test('a device kept for another account is never replaced', async () => {
  const { dir } = await accountDir();
  writeFileSync(join(dir, 'mero-mcp-device.json'), JSON.stringify({ account: 'f'.repeat(64), credential: 'x' }));
  await assert.rejects(loadOrCreateDevice(dir), /move it away/);
  assert.match(readFileSync(join(dir, 'mero-mcp-device.json'), 'utf8'), /"x"/);
});

test('the relay is the one that admitted the account first', async () => {
  const { dir } = await accountDir([
    { namespaceId: 'a'.repeat(64), relayUrl: 'https://relay-1.example' },
    { namespaceId: 'b'.repeat(64), relayUrl: 'https://relay-2.example' },
  ]);
  assert.equal(relayOf(dir), 'https://relay-1.example');
});

test('an account invited nowhere is refused with what to do', async () => {
  const { dir } = await accountDir();
  await assert.rejects(connectAccount(dir), /member of nothing yet: invite it/);
  await assert.rejects(createSession(loadConfig({ CALIMERO_ACCOUNT_DIR: dir, HOME: dir })), /member of nothing yet/);
});

test('file storage keeps what is written across a restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mero-mcp-storage-')), 's.json');
  new FileStorage(path).setItem('nonce', '9');
  assert.equal(new FileStorage(path).getItem('nonce'), '9');
});
