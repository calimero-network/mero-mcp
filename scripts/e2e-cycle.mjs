#!/usr/bin/env node
// The whole product cycle, headless. The desktop app's contribution to it is one HTTP
// call plus one file write, so there is nothing here a GUI would add: log in as the
// admin, mint the agent its own client key, hand it over in agent.json, and let the
// server find the node and authenticate with nothing else to go on.
//
//   npm run e2e:cycle        MEROD_BINARY selects the merod to boot.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  FIXTURES,
  McpClient,
  NodeApi,
  assert,
  assertEqual,
  bootNode,
  createChecks,
  fatal,
  installServerBin,
  resolveMerod,
  sleep,
} from './e2e-lib.mjs';

const PLANNED = 8;

/** Client keys are filed under the `sub` of the tokens they mint. */
const clientIdOf = (accessToken) => JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url')).sub;

// Everything the server could authenticate or locate a node with. It must succeed on the handoff alone.
const CREDENTIAL_ENV = [
  'CALIMERO_AUTH_TOKEN',
  'CALIMERO_REFRESH_TOKEN',
  'CALIMERO_USERNAME',
  'CALIMERO_PASSWORD',
  'CALIMERO_PASSWORD_FILE',
  'CALIMERO_NODE_URL',
  'CALIMERO_NODE_NAME',
];

const HANDOFF = 'agent.json';

function serverEnv(stateDir) {
  const env = { ...process.env, CALIMERO_MCP_STATE_DIR: stateDir, CALIMERO_NODE_HOME: mkdtempSync(join(tmpdir(), 'mero-mcp-nodehome-')) };
  for (const key of CREDENTIAL_ENV) delete env[key];
  return env;
}

async function main() {
  const launcher = installServerBin();
  const checks = createChecks(PLANNED);
  const merod = resolveMerod();
  const logPath = join(process.cwd(), 'merod-cycle.log');

  console.log(`Booting merod (${merod}) on 2571; log -> ${logPath}`);
  const node = await bootNode({ merod, logPath });
  try {
    let admin;
    await checks.check('the admin logs in with user_password and gets a bearer', async () => {
      const tokens = await NodeApi.login(node.url, ADMIN_USER, ADMIN_PASSWORD);
      assert(tokens.access_token, `no access_token in the login response: ${JSON.stringify(tokens).slice(0, 200)}`);
      admin = new NodeApi(node.url, tokens.access_token);
      return `admin bearer for ${ADMIN_USER}`;
    });

    const appId = await admin.installBundle(join(FIXTURES, 'kv-store.mpk'));
    const contextId = await admin.createContext(appId, await admin.createNamespace(appId));

    const stateDir = mkdtempSync(join(tmpdir(), 'mero-mcp-state-'));
    const handoffPath = join(stateDir, HANDOFF);

    let firstKey;
    await checks.check('the desktop app mints the agent its own client key', async () => {
      // Core's /admin/client-key takes permissions only - it has no client_name field.
      const key = await admin.clientKey(['admin']);
      assert(key.access_token && key.refresh_token, `client-key returned no token pair: ${JSON.stringify(key).slice(0, 200)}`);
      assert(key.access_token !== admin.token, 'the client key is the admin bearer, not a key of its own');

      writeFileSync(handoffPath, JSON.stringify({ nodeUrl: node.url, accessToken: key.access_token, refreshToken: key.refresh_token }));
      firstKey = key;
      return `${handoffPath} written with a distinct access/refresh pair`;
    });

    // Compare digests, not contents: the file is a pair of live bearer tokens and this transcript is a CI artifact.
    const handoffDigest = () => createHash('sha256').update(readFileSync(handoffPath)).digest('hex').slice(0, 16);
    const handoffBefore = handoffDigest();

    const drive = async (label) => {
      const env = serverEnv(stateDir);
      const mcp = new McpClient(launcher, env);
      try {
        await mcp.initialize();
        const status = await mcp.call('node_status');
        const key = `${label}-${Date.now().toString(36)}`;
        await mcp.call('select_app', { app: 'kv-store' });
        await mcp.call('kv_store_set', { key, value: `written-${label}` });
        assertEqual(mcp.frameViolations, [], 'a non-protocol line reached stdout');
        return { status, key };
      } finally {
        mcp.close();
      }
    };

    let first;
    await checks.check('the server finds the node and authenticates from the handoff alone', async () => {
      for (const key of CREDENTIAL_ENV) assert(!(key in serverEnv(stateDir)), `${key} leaked into the server's environment`);
      first = await drive('first');
      assertEqual(first.status.discoverySource, 'handoff', 'the node was not discovered through the handoff file');
      assertEqual(first.status.authMode, 'handoff', 'the server did not authenticate from the handoff');
      assertEqual(first.status.url, node.url, 'the server connected to a different node than the handoff named');
      return `discoverySource=handoff, authMode=handoff, url=${first.status.url}, with none of ${CREDENTIAL_ENV.length} credential vars set`;
    });

    await checks.check('the round trip it drove is visible to a direct /jsonrpc read', async () => {
      assert(first, 'the server never completed a run to verify');
      const seen = await admin.execute(contextId, 'get', { key: first.key });
      assertEqual(seen, 'written-first', 'the node does not hold what the server wrote');
      return `${first.key} = ${seen}, read without the MCP server`;
    });

    await checks.check('agent.json is byte-identical after the run', () => {
      assertEqual(handoffDigest(), handoffBefore, 'the server rewrote the desktop app\'s handoff file');
      return `sha256:${handoffBefore} unchanged - the handoff is the desktop app's file and the server left it alone`;
    });

    await checks.check('the server persisted its own token file beside the handoff', () => {
      const own = readdirSync(stateDir).filter((f) => f !== HANDOFF);
      assert(own.length > 0, `the server stored no tokens of its own in ${stateDir}`);
      for (const f of own) assert(/^tokens-[0-9a-f]{16}\.json$/.test(f), `unexpected file in the state dir: ${f}`);
      return own.join(', ');
    });

    await checks.check('a second run against the same state dir authenticates again', async () => {
      const second = await drive('second');
      assertEqual(second.status.authMode, 'handoff', 'the second run did not authenticate');
      const seen = await admin.execute(contextId, 'get', { key: second.key });
      assertEqual(seen, 'written-second', 'the second run reached the node but wrote nothing');
      // The handoff is no newer than what the store holds, so this run reused its own persisted pair.
      assertEqual(handoffDigest(), handoffBefore, 'the second run rewrote the handoff file');
      return `${second.key} = ${seen}, on the tokens the first run persisted`;
    });

    // The bug this guards: the store being non-empty is not the same as the store being current.
    // Clicking "Connect AI agent" again mints a replacement and revokes the old key, and the
    // agent's cached copy of that key keeps its unexpired `exp` - so it looks valid and 401s.
    await checks.check('a re-connect that revokes the old key does not lock the agent out', async () => {
      // Core derives a client id from the second the key was minted, so a same-second
      // re-connect overwrites that key instead of adding one. Cross the boundary to get
      // a second key the first can actually be revoked independently of.
      await sleep(1100);
      const replacement = await admin.clientKey(['admin']);
      assert(
        clientIdOf(replacement.access_token) !== clientIdOf(firstKey.access_token),
        'the node re-issued the same client id, so there is no previous key to revoke',
      );
      // Write before revoking, exactly as the desktop app does.
      writeFileSync(handoffPath, JSON.stringify({ nodeUrl: node.url, accessToken: replacement.access_token, refreshToken: replacement.refresh_token }));
      await admin.revokeClientKey(clientIdOf(firstKey.access_token));

      // Without this pair the run could pass having exercised nothing: the whole point is that
      // what the store cached is dead and only the file the desktop app rewrote still works.
      assertEqual(await admin.accepts(firstKey.access_token), false, 'the revoked key still authenticates, so the run tests nothing');
      assertEqual(await admin.accepts(replacement.access_token), true, 'the replacement credential does not authenticate');

      const third = await drive('third');
      assertEqual(third.status.authMode, 'handoff', 'the run after the re-connect did not authenticate');
      const seen = await admin.execute(contextId, 'get', { key: third.key });
      assertEqual(seen, 'written-third', 'the run after the re-connect never reached the node');
      return `${third.key} = ${seen}, on the replacement credential rather than the revoked cached one`;
    });
  } finally {
    node.stop();
    launcher.cleanup();
  }

  checks.finish();
}

main().catch(fatal);
