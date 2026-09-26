#!/usr/bin/env node
// Packs, installs, and drives the server the way a client does: by bin name on
// PATH. Everything else in this repo reaches dist/index.js by path, which
// resolves the symlink npm installs and cannot catch a dead entrypoint.
//
// Runs without a node. Every assertion here answers "did the process start and
// register its tools", which is exactly what a broken entrypoint fails.
import { PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY, SERVER_INFO_META_KEY } from '@modelcontextprotocol/server';
import { installServerBin, McpClient, E2eError } from './e2e-lib.mjs';

// A broken entrypoint exits immediately, so this only trips on a genuine hang.
const TIMEOUT_MS = 60_000;
// Present regardless of node reachability: registration happens before any connect.
const EXPECTED_TOOLS = ['node_status', 'list_contexts', 'select_app'];
// A request's per-request envelope: on stdio, this claim (not a header) is what pins a connection to the 2026-07-28 era.
const MODERN_PARAMS = { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} } };

const deadline = setTimeout(() => {
  console.error(`FAIL - no verdict within ${TIMEOUT_MS}ms`);
  process.exit(1);
}, TIMEOUT_MS).unref?.() ?? null;

let launcher;
let mcp;
let mcpModern;
const failures = [];

try {
  launcher = installServerBin();
  const env = { ...process.env, MERO_MCP_NODE_URL: 'http://127.0.0.1:1' };
  mcp = new McpClient(launcher, env);

  const init = await mcp.initialize();
  const name = init?.serverInfo?.name;
  if (name !== 'mero-mcp') failures.push(`serverInfo.name was ${JSON.stringify(name)}, expected "mero-mcp"`);

  const tools = await mcp.listTools();
  if (!tools?.length) failures.push('tools/list returned nothing, so no tool ever registered');
  const names = new Set((tools ?? []).map((t) => t.name));
  const missing = EXPECTED_TOOLS.filter((t) => !names.has(t));
  if (missing.length) failures.push(`tools/list is missing ${missing.join(', ')}`);

  // A fresh connection: an era pins to whatever its first message claims, and this one already pinned 2025-11-25.
  mcpModern = new McpClient(launcher, env);
  const discover = await mcpModern.request('server/discover', MODERN_PARAMS);
  const modernName = discover?._meta?.[SERVER_INFO_META_KEY]?.name;
  if (modernName !== 'mero-mcp') failures.push(`2026-07-28 server/discover answered serverInfo.name ${JSON.stringify(modernName)}, expected "mero-mcp"`);

  const modernTools = (await mcpModern.request('tools/list', MODERN_PARAMS))?.tools;
  if (modernTools?.length !== tools?.length) {
    failures.push(`2026-07-28 tools/list returned ${modernTools?.length ?? 0} tools, expected ${tools?.length ?? 0} (the 2025-11-25 count)`);
  }

  // Anything non-JSON-RPC on stdout corrupts the stream for every real client.
  const frameViolations = [...mcp.frameViolations, ...mcpModern.frameViolations];
  if (frameViolations.length) {
    failures.push(`stdout carried ${frameViolations.length} non-protocol line(s): ${frameViolations[0]}`);
  }

  if (!failures.length) console.log(`ok - mero-mcp on PATH answered initialize and listed ${tools.length} tools in both eras`);
} catch (err) {
  failures.push(err instanceof E2eError ? err.message : (err?.stack ?? String(err)));
} finally {
  clearTimeout(deadline);
  mcp?.close();
  mcpModern?.close();
  launcher?.cleanup();
}

if (failures.length) {
  console.error('FAIL - the installed package does not start as a bin:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
