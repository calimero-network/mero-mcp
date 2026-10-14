import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDelegatedClient,
  learnRelayNodeKey,
  mintDeviceId,
  signDeviceCert,
  signerFromSecret,
  verifyDeviceCredential,
  type MeroJs,
} from '@calimero-network/mero-js';

/**
 * mero-mcp for an account of its own: a cloud agent that is a member of the
 * contexts its owner invited it to, writing there under its own name.
 *
 * The account is mero-bot's (`MERO_BOT_ACCOUNT_DIR`), named here by
 * `CALIMERO_ACCOUNT_DIR`: mero-bot makes it, and joins each namespace from an
 * invitation. mero-mcp only reads what it needs from that directory:
 *
 * - `account.json`: the account id and its root, which certifies devices;
 * - `joined.json`: the namespaces joined and the relay that admitted each.
 *
 * It signs with a device of its own (`mero-mcp-device.json`), certified by the
 * same root. A relay spends each device's warrant nonces in its own window, so
 * two processes sharing one device would spend each other's nonces; with one
 * each they never meet. A delegated write's device need not be bound in the
 * namespace, only certified by a member account's root and not revoked.
 * mero-js's nonces and relay keys for that device are kept in
 * `mero-mcp-storage.json`.
 */

interface Account {
  account: string;
  rootSecret: string;
}

interface Device {
  account: string;
  device: string;
  deviceSecret: string;
  kemSecret: string;
  kemPublicKey: string;
  credential: string;
}

interface Joined {
  namespaceId: string;
  relayUrl: string;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** A `localStorage` in a file, for mero-js: each write is on disk before it returns. */
export class FileStorage implements Storage {
  private readonly items: Map<string, string>;

  constructor(readonly path: string) {
    this.items = new Map(Object.entries(readJson<Record<string, string>>(path) ?? {}));
  }

  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
    writeAtomic(this.path, JSON.stringify(Object.fromEntries(this.items)));
  }
  removeItem(key: string): void {
    if (this.items.delete(key)) writeAtomic(this.path, JSON.stringify(Object.fromEntries(this.items)));
  }
  clear(): void {
    this.items.clear();
    writeAtomic(this.path, '{}');
  }
}

/** `sessionStorage`: this run only. */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  clear(): void {
    this.items.clear();
  }
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** mero-mcp's own device in the account kept in `dir`, certified on first use. */
export async function loadOrCreateDevice(dir: string): Promise<Device> {
  const account = readJson<Account>(join(dir, 'account.json'));
  if (!account?.account || !account.rootSecret) {
    throw new Error(`no account in ${dir} yet: mero-bot makes it on its first start`);
  }
  const path = join(dir, 'mero-mcp-device.json');
  const kept = readJson<Device>(path);
  if (kept?.account === account.account && kept.credential) return kept;
  if (kept && existsSync(path)) {
    throw new Error(`${path} is for account ${kept.account}, not ${account.account}; move it away`);
  }
  const deviceSecret = hex(randomBytes(32));
  const device = await mintDeviceId(account.account, new Uint8Array(randomBytes(16)));
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const kemSecret = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url').toString('hex');
  const kemPublicKey = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');
  const credential = await signDeviceCert({
    rootSecret: account.rootSecret,
    device,
    signPublicKey: (await signerFromSecret(deviceSecret)).publicKey,
    kemPublicKey,
    deviceEpoch: 1,
  });
  // Refuse a root that does not name this account rather than sign with a device nobody will accept.
  if ((await verifyDeviceCredential(credential)).account !== account.account) {
    throw new Error(`the root in ${dir}/account.json does not name account ${account.account}`);
  }
  const made: Device = { account: account.account, device, deviceSecret, kemSecret, kemPublicKey, credential };
  writeAtomic(path, JSON.stringify(made, null, 2));
  return made;
}

/** The relay that admitted the account to its first namespace, as mero-bot works through it. */
export function relayOf(dir: string): string | null {
  return readJson<Joined[]>(join(dir, 'joined.json'))?.[0]?.relayUrl ?? null;
}

export interface AccountSession {
  url: string;
  account: string;
  mero: MeroJs;
}

/** A relay client signed by mero-mcp's own device in the account kept in `dir`. */
export async function connectAccount(dir: string): Promise<AccountSession> {
  const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
  g.localStorage = new FileStorage(join(dir, 'mero-mcp-storage.json'));
  g.sessionStorage ??= new MemoryStorage();
  const device = await loadOrCreateDevice(dir);
  const relayUrl = relayOf(dir);
  if (!relayUrl) {
    throw new Error(`account ${device.account} is a member of nothing yet: invite it, and mero-bot joins on its next start`);
  }
  // A hosted relay answers admin reads only to a session addressed to its node key.
  await learnRelayNodeKey(relayUrl).catch(() => null);
  const client = buildDelegatedClient(
    { account: device.account, credential: device.credential, deviceSecret: device.deviceSecret, relayUrl, executorAccount: null },
    null,
  );
  if (!client) throw new Error(`no client for relay ${relayUrl}`);
  // A relay client reads and executes as a node client does: .admin and .rpc are all mero-mcp uses.
  return { url: relayUrl, account: device.account, mero: client as unknown as MeroJs };
}
