#!/usr/bin/env node
// Drives the built MCP server over real stdio against a real node.
//
//   npm run e2e                                     provisions its own node, all assertions
//   npm run e2e -- --node http://localhost:2528 --app my-app
//                                                   attaches to a running node, read-only subset
//
// MEROD_BINARY selects the merod to boot (default: core's target/debug/merod).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  E2eError,
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
  toolText,
} from './e2e-lib.mjs';

const PLANNED = 17;

const { values: opts } = parseArgs({
  options: { node: { type: 'string' }, app: { type: 'string' } },
  allowPositionals: false,
});

const attached = Boolean(opts.node);
const FOREIGN = 'not run against a node this script did not provision';

const kvToolName = (slug, method) => `${slug}_${method}`;

async function main() {
  const launcher = installServerBin();
  const checks = createChecks(PLANNED);

  let node = null;
  let stop = () => {};
  try {
    let api;
    let kv;
    let second;

    if (attached) {
      if (!opts.app) throw new E2eError('--node requires --app: there is no fixture to fall back on against a foreign node.');
      node = { url: opts.node.replace(/\/+$/, '') };
      console.log(`Attached to ${node.url}; provisioning and teardown are skipped.\n`);
    } else {
      const merod = resolveMerod();
      const logPath = join(process.cwd(), 'merod-e2e.log');
      console.log(`Booting merod (${merod}) on 2571; log -> ${logPath}`);
      node = await bootNode({ merod, logPath });
      stop = node.stop;
    }

    // --- provisioning -----------------------------------------------------
    let serverEnv;
    if (!attached) {
      const { access_token: token } = await NodeApi.login(node.url, ADMIN_USER, ADMIN_PASSWORD);
      api = new NodeApi(node.url, token);

      const kvId = await api.installBundle(join(FIXTURES, 'kv-store.mpk'));
      const secondId = await api.installBundle(join(FIXTURES, 'scaffolding-e2e.mpk'));
      assert(kvId !== secondId, 'the two fixtures installed as one application');

      // Fails loudly here when merod predates GET /admin-api/applications/:id/abi.
      const kvAbi = await api.applicationAbi(kvId);
      const secondAbi = await api.applicationAbi(secondId);

      // Only kv-store gets a context up front: an app without one is the state assertion 11 needs.
      const kvContext = await api.createContext(kvId, await api.createNamespace(kvId));

      kv = { id: kvId, name: 'kv-store', slug: 'kv_store', abi: kvAbi, context: kvContext };
      second = { id: secondId, name: 'scaffolding-e2e', slug: 'scaffolding_e2e', abi: secondAbi, context: null };

      serverEnv = {
        ...process.env,
        CALIMERO_NODE_URL: node.url,
        CALIMERO_AUTH_TOKEN: token,
        CALIMERO_MCP_STATE_DIR: mkdtempSync(join(tmpdir(), 'mero-mcp-state-')),
        CALIMERO_NODE_HOME: mkdtempSync(join(tmpdir(), 'mero-mcp-nodehome-')),
      };
    } else {
      // Attach mode reproduces the reporter's setup, so their state dir and credentials pass
      // through untouched - a fresh one would hide exactly the handoff bug they are chasing.
      serverEnv = { ...process.env, CALIMERO_NODE_URL: node.url };
      kv = { name: opts.app };
    }

    const mcp = new McpClient(launcher, serverEnv);
    try {
      await runChecks({ checks, mcp, api, kv, second });
    } finally {
      mcp.close();
    }
  } finally {
    stop();
    launcher.cleanup();
  }

  checks.finish();
}

async function runChecks({ checks, mcp, api, kv, second }) {
  let before = [];

  await checks.check('initialize completes and the server advertises tools', async () => {
    const res = await mcp.initialize();
    assert(typeof res.protocolVersion === 'string' && res.protocolVersion, 'no protocolVersion in the initialize result');
    assert(res.capabilities?.tools, 'the server advertises no tools capability');
    return `protocol ${res.protocolVersion}, serverInfo ${res.serverInfo?.name}@${res.serverInfo?.version}`;
  });

  await checks.check('tools/list carries every installed app method before any select', async () => {
    before = await mcp.listTools();
    for (const fixed of ['node_status', 'describe_app', 'select_app', 'call']) {
      assert(
        before.some((t) => t.name === fixed),
        `the fixed toolset is missing ${fixed}`,
      );
    }
    if (kv.abi) {
      for (const m of kv.abi.methods) {
        const name = kvToolName(kv.slug, m.name);
        assert(before.some((t) => t.name === name), `${name} is not listed although ${kv.name} is installed`);
      }
    }
    return `${before.length} tools, the app tools listed without a select`;
  });

  await checks.check('every advertised tool carries a valid JSON Schema object', () => {
    for (const t of before) {
      assert(t.inputSchema, `${t.name} advertises no inputSchema`);
      assertEqual(t.inputSchema.type, 'object', `${t.name} inputSchema is not an object schema`);
      assert(typeof t.inputSchema.properties === 'object' && t.inputSchema.properties !== null, `${t.name} has no properties map`);
    }
    return `${before.length} schemas checked`;
  });

  let selected;
  await checks.check('select_app returns an app_handle and names the app tools', async () => {
    selected = await mcp.call('select_app', { app: kv.name });
    assert(typeof selected.app_handle === 'string' && selected.app_handle.includes('.'), `select_app returned no app_handle: ${JSON.stringify(selected).slice(0, 200)}`);
    if (kv.abi) {
      const expected = kv.abi.methods.map((m) => kvToolName(kv.slug, m.name)).sort();
      assertEqual([...selected.tools].sort(), expected, 'the named tools do not match the ABI read out of band');
      return `${expected.length} methods from the node's own ABI`;
    }
    assertEqual(selected.tools.length, selected.methods.length, 'select_app reported a different number of tools than methods');
    return `${selected.tools.length} methods (self-reported: no out-of-band ABI on a foreign node)`;
  });

  await checks.check('select_app leaves tools/list exactly as it was', async () => {
    const after = await mcp.listTools();
    assertEqual(after.map((t) => t.name), before.map((t) => t.name), 'selecting an app changed the tool list');
    for (const t of after) assertEqual(t.inputSchema?.type, 'object', `${t.name} inputSchema is not an object schema`);
    return `${after.length} tools, unchanged`;
  });

  if (!api) {
    for (const label of [
      'the derived schema matches the ABI: set(key, value)',
      'a round trip through MCP is visible to a direct /jsonrpc read',
      'the generic call tool reaches the same method',
      'a schema-violating argument is a validation error and changes nothing',
      "a real node rejection carries the node's own message, not a bare status line",
      "a plain-text node rejection also carries the node's own message",
      'a mutating tool without an app_handle is refused and changes nothing',
    ]) {
      checks.skip(label, FOREIGN);
    }
  } else {
    await checks.check('the derived schema matches the ABI: set(key, value)', async () => {
      const tools = await mcp.listTools();
      const set = tools.find((t) => t.name === kvToolName(kv.slug, 'set'));
      assert(set, `${kvToolName(kv.slug, 'set')} is not registered`);
      assertEqual(Object.keys(set.inputSchema.properties).sort(), ['app_handle', 'key', 'value'], 'set advertises the wrong properties');
      assertEqual([...(set.inputSchema.required ?? [])].sort(), ['app_handle', 'key', 'value'], 'set does not require exactly its handle, key and value');
      return 'app_handle, key and value, all required';
    });

    await checks.check('a round trip through MCP is visible to a direct /jsonrpc read', async () => {
      const key = `mcp-${Date.now().toString(36)}`;
      await mcp.call(kvToolName(kv.slug, 'set'), { app_handle: selected.app_handle, key, value: 'written-over-mcp' });
      // Direct /jsonrpc, no MCP server involved: a no-op write answered by a cache would pass a set/get pair.
      const seen = await api.execute(kv.context, 'get', { key });
      assertEqual(seen, 'written-over-mcp', 'the value the node holds is not the value written over MCP');
      return `${key} = ${seen}, read straight from the node`;
    });

    await checks.check('the generic call tool reaches the same method', async () => {
      const key = `call-${Date.now().toString(36)}`;
      await mcp.call('call', { app_handle: selected.app_handle, method: 'set', args: { key, value: 'written-via-call' } });
      const seen = await api.execute(kv.context, 'get', { key });
      assertEqual(seen, 'written-via-call', 'the call fallback did not reach the same method');
      return `${key} = ${seen}`;
    });

    await checks.check('a schema-violating argument is a validation error and changes nothing', async () => {
      const key = `guard-${Date.now().toString(36)}`;
      await api.execute(kv.context, 'set', { key, value: 'untouched' });

      const msg = await mcp.callRaw(kvToolName(kv.slug, 'set'), { app_handle: selected.app_handle, key, value: 123 });
      const text = toolText(msg);
      assert(msg.result?.isError, `a number for a string parameter was accepted: ${text}`);
      // The server validates after the handle check and reports zod's issue list, so the offending path is parseable.
      const issues = JSON.parse(text.replace(/^Error: /, ''));
      assertEqual(issues.map((i) => i.path.join('.')), ['value'], `not a validation error on value: ${text}`);

      const seen = await api.execute(kv.context, 'get', { key });
      assertEqual(seen, 'untouched', 'the rejected call still changed state');
      return `rejected at ${issues[0].path.join('.')}: ${issues[0].message}`;
    });

    await checks.check('a mutating tool without an app_handle is refused and changes nothing', async () => {
      const key = `nohandle-${Date.now().toString(36)}`;
      await api.execute(kv.context, 'set', { key, value: 'untouched' });
      for (const app_handle of [undefined, `${selected.app_handle.split('.')[0]}.AAAA`]) {
        const msg = await mcp.callRaw(kvToolName(kv.slug, 'set'), { ...(app_handle ? { app_handle } : {}), key, value: 'must-not-land' });
        assert(msg.result?.isError, `the call ran without a valid handle: ${toolText(msg)}`);
        assertEqual(
          msg.result.content.at(-1).text,
          `Call select_app for ${selected.package} and retry with the returned app_handle.`,
          'the refusal does not say how to get a handle',
        );
      }
      assertEqual(await api.execute(kv.context, 'get', { key }), 'untouched', 'a refused call still changed state');
      return 'missing and forged handles both refused; state unchanged';
    });

    // A real node rejection, not a fake in a unit test: core answers create_context with
    // {"error": "..."} on a syntactically invalid namespace, and that text must survive to the caller.
    await checks.check("a real node rejection carries the node's own message, not a bare status line", async () => {
      const msg = await mcp.callRaw('create_context', { application: kv.name, namespace: 'not-a-valid-hex-namespace' });
      const text = toolText(msg);
      assert(msg.result?.isError, `create_context with an invalid namespace succeeded: ${text}`);
      assert(/Invalid group_id: expected hex-encoded 32 bytes/.test(text), `the node's own message is missing: ${text}`);
      assert(!/^Error: HTTP \d+ [A-Za-z ]+$/.test(text), `a bare status line reached the caller instead: ${text}`);
      return text.slice(0, 140);
    });

    // core's install failure is a plain-text body, not its usual {"error": ...} envelope - the other
    // branch of the same extraction. These coordinates are never published, so the node's own
    // registry lookup fails fast and deterministically without depending on anything reachable.
    await checks.check("a plain-text node rejection also carries the node's own message", async () => {
      const msg = await mcp.callRaw('install_application', { coords: 'com.example.never-published@0.0.0' });
      const text = toolText(msg);
      assert(msg.result?.isError, `install_application with unpublished coordinates succeeded: ${text}`);
      assert(/has no application published at/.test(text), `the node's own message is missing: ${text}`);
      assert(!/^Error: HTTP \d+ [A-Za-z ]+$/.test(text), `a bare status line reached the caller instead: ${text}`);
      return text.slice(0, 140);
    });
  }

  await checks.check('an unknown app name errors listing the installed applications', async () => {
    const msg = await mcp.callRaw('select_app', { app: 'no-such-app-here' });
    const text = toolText(msg);
    assert(msg.result?.isError, `select_app on an unknown app succeeded: ${text}`);
    assert(/not found\. Installed: /.test(text), `the error does not list what is installed: ${text}`);
    assert(!/\n\s+at /.test(text), `the error leaked a stack trace: ${text}`);
    return text.slice(0, 110);
  });

  if (!api) {
    for (const label of [
      'an application with no context names the desktop app and create_context',
      'two handles are held at once, each naming its own app',
      'each handle routes its calls to its own app and context',
    ]) {
      checks.skip(label, FOREIGN);
    }
  } else {
    await checks.check('an application with no context names the desktop app and create_context', async () => {
      const res = await mcp.call('select_app', { app: second.name });
      assertEqual(res.context, null, 'the fixture unexpectedly already had a context');
      assertEqual(
        res.note,
        `Application "${second.name}" has no contexts on this node. Create one in the Calimero desktop app, or use create_context.`,
        'the no-context note is not the message desktop users need',
      );
      return res.note;
    });

    second.context = await api.createContext(second.id, await api.createNamespace(second.id));

    let secondHandle;
    await checks.check('two handles are held at once, each naming its own app', async () => {
      const res = await mcp.call('select_app', { app: second.name });
      secondHandle = res.app_handle;
      assertEqual(res.context, second.context, 'the second app did not pin its only context');
      assert(secondHandle !== selected.app_handle, 'two apps got the same handle');
      return `${kv.slug} and ${second.slug} each hold a handle`;
    });

    await checks.check('each handle routes its calls to its own app and context', async () => {
      const key = `route-${Date.now().toString(36)}`;
      await mcp.call(kvToolName(kv.slug, 'set'), { app_handle: selected.app_handle, key, value: 'in-kv' });
      await mcp.call(kvToolName(second.slug, 'authored_insert'), { app_handle: secondHandle, key, value: 'in-second' });

      assertEqual(await api.execute(kv.context, 'get', { key }), 'in-kv', 'the kv-store call did not land in the kv-store context');
      assertEqual(
        await api.execute(second.context, 'authored_get', { key }),
        'in-second',
        'the second application call did not land in its own context',
      );
      // A key only the second application ever saw: if the tools shared a target it would show up here too.
      const only = `second-only-${key}`;
      await mcp.call(kvToolName(second.slug, 'authored_insert'), { app_handle: secondHandle, key: only, value: 'x' });
      assertEqual(await api.execute(kv.context, 'get', { key: only }), null, 'a write through one application landed in the other');
      return `${key} resolves to "in-kv" in ${kv.slug} and "in-second" in ${second.slug}, and ${only} exists only in ${second.slug}`;
    });
  }

  await checks.check('stdout carried JSON-RPC frames and nothing else', () => {
    assertEqual(mcp.frameViolations, [], 'a non-protocol line reached stdout, which corrupts the stream for every client');
    return 'every stdout line parsed as a JSON-RPC 2.0 message';
  });
}

main().catch(fatal);
