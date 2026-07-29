# mero-mcp

A stdio MCP server that drives any application installed on a local Calimero node.
It exposes node administration (contexts, namespaces, blobs) as MCP tools, and once you point it at an application, generates a tool for every method in that application's ABI.

## Setup

Add this to your MCP client's config:

```json
{
  "mcpServers": {
    "calimero": {
      "command": "npx",
      "args": ["-y", "@calimero-network/mero-mcp"]
    }
  }
}
```

| Client | Where |
| --- | --- |
| Claude Code | `.mcp.json` in the project, or `~/.claude.json` for a user-wide server |
| Claude Desktop | `claude_desktop_config.json` |
| Cursor / Windsurf | `.cursor/mcp.json` |
| Codex CLI | `~/.codex/config.toml`, same fields in TOML: `[mcp_servers.calimero]` / `command = "npx"` / `args = ["-y", "@calimero-network/mero-mcp"]` |

### Prerequisites

- A Calimero node running (the desktop app, or `merod` directly).
- An application installed on that node.
- **A context created for that application.**
  This is the step people miss: installing an application from the registry does not create a context, and most of this server's app tools need one to run against.
  Create one in the desktop app, or via the `create_context` tool.

## Environment variables

All optional; the server tries to discover a node and an identity on its own.

| Variable | Purpose | Default |
| --- | --- | --- |
| `CALIMERO_NODE_URL` | Connect to this node directly, skipping discovery | - |
| `CALIMERO_NODE_NAME` | Select a node by name out of `CALIMERO_NODE_HOME` | - |
| `CALIMERO_NODE_HOME` | Directory of node configs to scan | `~/.calimero` |
| `CALIMERO_AUTH_TOKEN` | Bearer access token | - |
| `CALIMERO_REFRESH_TOKEN` | Refresh token paired with `CALIMERO_AUTH_TOKEN` | - |
| `CALIMERO_USERNAME` | Username for credential auth | - |
| `CALIMERO_PASSWORD` | Password for credential auth | - |
| `CALIMERO_PASSWORD_FILE` | File to read the password from, used when `CALIMERO_PASSWORD` is unset | - |
| `CALIMERO_MCP_STATE_DIR` | Where the token cache and the desktop app's handoff file live | `~/.config/calimero/mcp` |
| `CALIMERO_MCP_TOOLSETS` | Comma-separated toolsets to enable (`core`, `blobs`, `governance`); `core` is always on | all three |

## Node discovery

The server resolves which node to talk to in this order, stopping at the first match:

1. `CALIMERO_NODE_URL`, if set.
2. The desktop app's handoff file (`agent.json` in the state dir), if it names a node.
3. A node under `CALIMERO_NODE_HOME` matching `CALIMERO_NODE_NAME`, if that variable is set.
4. The single node under `CALIMERO_NODE_HOME`, if there's exactly one - or the one named `default`, if there are several.
5. A live probe of common local ports.

For steps 3 and 4, the port comes from that node's own `config.toml` (its `[server]` listen address), not from an assumed default.
Only the last-resort probe in step 5 guesses at conventional ports.

## Authentication

The server picks the first of these that applies:

1. **Handoff** - a token written by the desktop app's "Connect AI agent" action.
2. **Token** - `CALIMERO_AUTH_TOKEN` (with an optional `CALIMERO_REFRESH_TOKEN`).
3. **Credentials** - `CALIMERO_USERNAME` and `CALIMERO_PASSWORD` (or `CALIMERO_PASSWORD_FILE`).
4. **None** - no auth is attempted; this only works against a node with no auth requirement.

Tokens are cached per node and identity under `CALIMERO_MCP_STATE_DIR`, so re-authentication only happens once.

**The agent credential carries `admin` permission on the node.**
It is a separate, revocable credential - not the same one the desktop app uses - but it is not scoped down, and every action it takes is attributed to the node's own identity exactly the way the desktop app's actions are.
Anything an agent does through this server (installing an application, creating a context, calling a mutating method) is indistinguishable, on the node, from you having done it yourself.

## Tools

**Core** (always registered):
`node_status`, `list_nodes`, `list_applications`, `list_namespaces`, `list_contexts`, `create_context`, `create_alias`, `lookup_alias`.

**Blobs** (in `CALIMERO_MCP_TOOLSETS` by default):
`install_application`, `uninstall_application`, `upload_blob`, `list_blobs`, `delete_blob`.

**Governance** (in `CALIMERO_MCP_TOOLSETS` by default):
`create_namespace`, `delete_namespace`, `invite_to_namespace`, `join_namespace`, `leave_namespace`, `list_group_members`, `add_group_members`.

**Application** (always registered):
`describe_app` shows an application's ABI without selecting it.
`select_app` picks an application and a context to run it against.
`deselect_app` drops one application again, leaving any others selected.
`call` invokes a method on a selected (or an explicitly named) application.

Several applications can be selected at once, so one instruction can span two of them without losing the first one's tools.
Each keeps its own pinned context, and `deselect_app` or a re-`select_app` affects only the application named.

Anywhere an application is named you can pass its id, its full package name, or just the last dot-separated segment of that package (`kv-store` for `com.calimero.kv-store`), as long as that segment is unambiguous among the installed applications.

Once `select_app` has run, one more tool appears per ABI method for as long as this server process stays up.
Those tools are named `<app>_<method>`, or `<app>_<service>_<method>` for a multi-service application, where `<app>` is that same trailing package segment: `com.calimero.kv-store` yields `kv_store_get`.

## Verifying it works

Two harnesses drive the built server over real MCP stdio against a real node.
Both boot their own `merod` on port 2571 in a temp home and tear it down on the way out, so neither touches `~/.calimero` or your real state directory.

```bash
npm run e2e          # 14 assertions: the protocol, the ABI-derived tools, and a round trip verified out of band
npm run e2e:cycle    # 7 assertions: admin login -> client key -> agent.json handoff, with zero credentials in the environment
```

`MEROD_BINARY` selects the binary to boot, and defaults to core's `target/debug/merod`.
Until a core release carries `GET /admin-api/applications/:id/abi`, that binary has to come from core master:

```bash
cd <core> && cargo build -p merod
MEROD_BINARY=<core>/target/debug/merod npm run e2e
```

To reproduce a problem against a node you already have running, point the harness at it:

```bash
npm run e2e -- --node http://localhost:2528 --app my-app
```

In that mode it provisions nothing and tears nothing down; it attaches to what is there and prints `SKIP` for each assertion that needs a node it controls.
