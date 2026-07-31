// Shared plumbing for the two e2e drivers: node provisioning over the admin HTTP API,
// an MCP stdio client that watches the frame stream, and the numbered check runner.
//
// Provisioning goes over HTTP rather than meroctl on purpose: meroctl's only auth path
// against an embedded-auth node is a browser round trip (crates/meroctl/src/auth.rs), so
// it cannot run unattended. One HTTP path runs identically locally and in CI.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURES = join(ROOT, 'test', 'fixtures');

// Non-default ports, so a run never collides with the node someone is actually using.
const SERVER_PORT = 2571;
const SWARM_PORT = 2671;
// Throwaway credentials for a throwaway node; core >= 0.11.0-rc.17 needs the admin to exist
// before the node listens, and enforces an 8-character minimum.
export const ADMIN_USER = 'dev';
export const ADMIN_PASSWORD = 'dev-password';

// Assumes core checked out beside this repo; MEROD_BINARY covers every other layout.
const DEFAULT_MEROD = join(ROOT, '..', 'core', 'target', 'debug', 'merod');

const BUILD_MEROD =
  'Build it from core master:\n' +
  '    cd <core> && cargo build -p merod\n' +
  '  then point MEROD_BINARY at target/debug/merod.';

/** Fails with an operator-readable message, never a stack trace. */
export class E2eError extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function resolveMerod() {
  const path = process.env.MEROD_BINARY?.trim() || DEFAULT_MEROD;
  if (!existsSync(path)) {
    throw new E2eError(`merod not found at ${path}.\n  Set MEROD_BINARY, or build it.\n  ${BUILD_MEROD}`);
  }
  return path;
}

/**
 * Packs and installs the tarball, then hands back the bin name and the directory to put on
 * PATH. Launching by name is the whole point: spawning dist/index.js by path resolves the
 * symlink npm installs, which is how a server that could never start shipped green.
 */
export function installServerBin() {
  const entry = join(ROOT, 'dist', 'index.js');
  if (!existsSync(entry)) throw new E2eError(`${entry} does not exist. Run \`npm run build\` first.`);

  const work = mkdtempSync(join(tmpdir(), 'mero-mcp-pack-'));
  try {
    execFileSync('npm', ['pack', '--pack-destination', work], { cwd: ROOT, stdio: 'pipe' });
    const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
    if (!tarball) throw new E2eError('npm pack produced no tarball');
    execFileSync('npm', ['init', '-y'], { cwd: work, stdio: 'ignore' });
    execFileSync('npm', ['install', '--no-audit', '--no-fund', join(work, tarball)], {
      cwd: work,
      stdio: 'pipe',
    });
  } catch (err) {
    rmSync(work, { recursive: true, force: true });
    throw err instanceof E2eError ? err : new E2eError(`could not install the packed server: ${err.message}`);
  }

  return {
    command: 'mero-mcp',
    binDir: join(work, 'node_modules', '.bin'),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  };
}

async function portIsFree(port) {
  try {
    await fetch(`http://localhost:${port}/admin-api/health`, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Node provisioning
// ---------------------------------------------------------------------------

/** Thin admin-API client. Deliberately raw fetch: an out-of-band read must not share a code path with the server. */
export class NodeApi {
  constructor(url, token) {
    this.url = url;
    this.token = token;
  }

  async #json(path, init = {}) {
    const res = await fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new E2eError(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  #post(path, body) {
    return this.#json(path, { method: 'POST', body: JSON.stringify(body) });
  }

  static async login(url, username, password) {
    const res = await fetch(`${url}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_method: 'user_password',
        public_key: username,
        client_name: 'mero-mcp-e2e',
        permissions: ['admin'],
        timestamp: Math.floor(Date.now() / 1000),
        provider_data: { username, password },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new E2eError(`admin login failed (${res.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text).data;
  }

  /** The exact call the desktop app's "Connect AI agent" makes. Core has no `client_name` field on this route. */
  async clientKey(permissions = ['admin']) {
    return (await this.#post('/admin/client-key', { permissions })).data;
  }

  /**
   * The cleanup half of a re-connect: the desktop app revokes the key the previous
   * connect minted, so the agent's cached copy of it dies server-side.
   * `root_key_id` comes from the listing - core rejects a delete filed under any other root.
   */
  async revokeClientKey(clientId) {
    const clients = (await this.#json('/admin/keys/clients')).data ?? [];
    const entry = clients.find((c) => c.client_id === clientId);
    if (!entry) throw new E2eError(`the node lists no client key ${clientId} to revoke`);
    await this.#json(`/admin/keys/${entry.root_key_id}/clients/${clientId}`, { method: 'DELETE' });
  }

  /** Whether the node still honours `token`, asked out of band so a credential's fate is not inferred from the server's behaviour. */
  async accepts(token) {
    const res = await fetch(`${this.url}/admin-api/applications`, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok;
  }

  async installBundle(mpkPath) {
    return (await this.#post('/admin-api/install-dev-application', { path: mpkPath, metadata: [] })).data.applicationId;
  }

  async applicationAbi(applicationId) {
    const res = await fetch(`${this.url}/admin-api/applications/${applicationId}/abi`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    const text = await res.text();
    // Core answers every handled failure with a body; a route it never registered has none.
    if (res.status === 404 && !text.trim()) {
      throw new E2eError(
        'This merod has no GET /admin-api/applications/:id/abi, which the whole server is built on.\n  ' + BUILD_MEROD,
      );
    }
    if (!res.ok) throw new E2eError(`abi fetch -> ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text).data;
  }

  async createNamespace(applicationId) {
    return (await this.#post('/admin-api/namespaces', { applicationId, upgradePolicy: 'Automatic' })).data.namespaceId;
  }

  async createContext(applicationId, groupId) {
    const body = { applicationId, groupId, protocol: 'none', initializationParams: [] };
    return (await this.#post('/admin-api/contexts', body)).data.contextId;
  }

  /** Direct /jsonrpc, sharing nothing with the MCP server - this is what makes a read out of band. */
  async execute(contextId, method, argsJson = {}) {
    const res = await fetch(`${this.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'execute', params: { contextId, method, argsJson } }),
    });
    const body = await res.json();
    if (body.error) throw new E2eError(`jsonrpc ${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
    return body.result?.output ?? null;
  }
}

/**
 * Boots a throwaway merod on non-default ports in a temp home, and returns it plus
 * a `stop` that is safe to call from a `finally` however far the run got.
 */
export async function bootNode({ merod, logPath }) {
  if (!(await portIsFree(SERVER_PORT))) {
    throw new E2eError(`Something is already listening on ${SERVER_PORT}. Stop it, or run with --node to attach instead.`);
  }
  const home = mkdtempSync(join(tmpdir(), 'mero-mcp-e2e-'));
  const url = `http://localhost:${SERVER_PORT}`;
  let child;

  const stop = () => {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    rmSync(home, { recursive: true, force: true });
  };

  try {
    const env = { ...process.env, MERO_AUTH_ADMIN_USER: ADMIN_USER, MERO_AUTH_ADMIN_PASSWORD: ADMIN_PASSWORD };
    const args = ['--home', home, '--node', 'mcp-e2e'];
    await run(merod, [...args, 'init', '--server-port', String(SERVER_PORT), '--swarm-port', String(SWARM_PORT), '--auth-mode', 'embedded'], env);

    const log = logPath ? openSync(logPath, 'w') : 'ignore';
    child = spawn(merod, [...args, 'run'], { env, stdio: ['ignore', log, log] });
    child.on('error', (err) => console.error(`[merod] ${err.message}`));

    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${url}/admin-api/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return { url, home, stop };
      } catch {
        /* not up yet */
      }
      await sleep(500);
    }
    throw new E2eError(`merod never became healthy on ${url}${logPath ? ` (see ${logPath})` : ''}.`);
  } catch (err) {
    stop();
    throw err;
  }
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => reject(new E2eError(`${cmd} failed to start: ${err.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new E2eError(`${cmd} ${args.join(' ')} exited ${code}\n${stderr.slice(-800)}`)),
    );
  });
}

// ---------------------------------------------------------------------------
// MCP stdio client
// ---------------------------------------------------------------------------

/**
 * Speaks MCP over stdio to the built server. Every stdout line is recorded, so a stray
 * console.log anywhere in the server shows up as a frame violation instead of silently
 * corrupting the stream for every real client.
 */
export class McpClient {
  constructor(launcher, env) {
    const PATH = `${launcher.binDir}:${env.PATH ?? process.env.PATH ?? ''}`;
    this.child = spawn(launcher.command, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, PATH } });
    this.pending = new Map();
    this.frameViolations = [];
    this.nextId = 1;
    this.exited = false;

    let buf = '';
    this.child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.#onLine(line);
      }
    });
    this.child.stdout.on('end', () => {
      // A trailing unterminated line is still output on the protocol stream.
      if (buf.trim()) this.#onLine(buf);
    });

    this.child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) console.error(`  [server] ${line}`);
    });
    this.child.on('exit', (code) => {
      this.exited = true;
      for (const { reject } of this.pending.values()) reject(new E2eError(`server exited (${code}) with a request in flight`));
      this.pending.clear();
    });
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.frameViolations.push(line.slice(0, 200));
      return;
    }
    if (msg.jsonrpc !== '2.0') {
      this.frameViolations.push(line.slice(0, 200));
      return;
    }
    const waiter = msg.id != null && this.pending.get(msg.id);
    if (!waiter) return; // a notification, or a response nobody is waiting on
    this.pending.delete(msg.id);
    waiter.resolve(msg);
  }

  /** Resolves with the raw envelope: a protocol-level error is an assertion subject here, not a throw. */
  send(method, params) {
    if (this.exited) return Promise.reject(new E2eError(`server already exited; cannot send ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      // unref'd: an answered request must not hold the loop open for the rest of its timeout.
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new E2eError(`timed out waiting for ${method}`));
      }, 30_000).unref();
    });
  }

  async request(method, params) {
    const msg = await this.send(method, params);
    if (msg.error) throw new E2eError(`${method}: ${JSON.stringify(msg.error).slice(0, 300)}`);
    return msg.result;
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mero-mcp-e2e', version: '0' },
    });
    this.notify('notifications/initialized', {});
    return result;
  }

  async listTools() {
    return (await this.request('tools/list', {})).tools;
  }

  /** The tool-result envelope, unparsed: `isError` and the raw text are both assertion subjects. */
  callRaw(name, args = {}) {
    return this.send('tools/call', { name, arguments: args });
  }

  async call(name, args = {}) {
    const msg = await this.callRaw(name, args);
    if (msg.error) throw new E2eError(`tools/call ${name}: ${JSON.stringify(msg.error).slice(0, 300)}`);
    const text = (msg.result.content ?? []).map((c) => c.text ?? '').join('');
    if (msg.result.isError) throw new E2eError(`${name} returned an error: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  close() {
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export const toolText = (msg) => (msg.result?.content ?? []).map((c) => c.text ?? '').join('');

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

/**
 * Numbered pass/fail transcript. `planned` makes a vacuous pass impossible: the run only
 * succeeds when every declared assertion either ran or was explicitly skipped.
 */
export function createChecks(planned) {
  let n = 0;
  const failures = [];
  const skipped = [];

  const line = (verdict, label, detail) => {
    console.log(`${String(++n).padStart(2)} ${verdict}  ${label}`);
    if (detail) for (const d of String(detail).split('\n')) console.log(`      ${d}`);
  };

  return {
    async check(label, fn) {
      try {
        const note = await fn();
        line('PASS', label, note);
      } catch (err) {
        failures.push(label);
        line('FAIL', label, err instanceof Error ? err.message : String(err));
      }
    },

    skip(label, reason) {
      skipped.push(label);
      line('SKIP', label, reason);
    },

    /** Exits the process: every caller's next action would be the same. */
    finish() {
      const ran = n - skipped.length;
      const passed = ran - failures.length;
      console.log(`\n${passed} passed, ${failures.length} failed, ${skipped.length} skipped (of ${planned} planned)`);
      for (const f of failures) console.log(`  FAILED: ${f}`);

      if (n !== planned) {
        console.log(`\nFAIL: ${n} of ${planned} assertions accounted for - the run stopped early or an assertion was dropped.`);
        process.exit(1);
      }
      process.exit(failures.length ? 1 : 0);
    },
  };
}

/** Turns an E2eError into the message it was written to be, and anything else into a stack. */
export function fatal(err) {
  if (err instanceof E2eError) console.error(`\nFAIL: ${err.message}`);
  else console.error('\nFAIL:', err);
  process.exit(1);
}

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export function assertEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}\n  expected: ${e}\n  actual:   ${a}`);
}
