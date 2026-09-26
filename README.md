# mero-mcp

A stdio MCP server that drives any application installed on a local Calimero node.
It exposes node administration (contexts, namespaces, blobs) as MCP tools, and once you point it at an application, generates a tool for every method in that application's ABI.

> **Full documentation**: <https://calimero-network.github.io/mero-mcp/> — organized into four tracks: **Get Started** (register it with a harness), **Guides** (selecting apps, contexts, troubleshooting), **Understand** (architecture, discovery, auth), and **Reference** (every tool, variable, and ABI mapping).

| I want to… | Go to |
| --- | --- |
| Register the server with my AI harness | [Setup](https://calimero-network.github.io/mero-mcp/get-started/setup/) |
| Verify it works end to end | [Your first session](https://calimero-network.github.io/mero-mcp/get-started/first-session/) |
| Look up a tool or an environment variable | [Reference](https://calimero-network.github.io/mero-mcp/reference/tools/) |
| Understand what the agent credential can do | [Authentication](https://calimero-network.github.io/mero-mcp/understand/authentication/) |
| Fix an error I am seeing | [Troubleshooting](https://calimero-network.github.io/mero-mcp/guides/troubleshooting/) |
| Work on the server itself | [Development](https://calimero-network.github.io/mero-mcp/contribute/development/) |

## Quickstart

Paste this into any AI harness (Claude Code, Cursor, Codex CLI, Claude Desktop, Zed, ...) and let it register the server for you:

```text
Set up the mero-mcp MCP server for me.

It is on npm as @calimero-network/mero-mcp and runs over stdio. Register a
server named "calimero" that runs `npx -y @calimero-network/mero-mcp`.

In Claude Code that is one command:
  claude mcp add -s local calimero -- npx -y @calimero-network/mero-mcp

Otherwise find where your own harness keeps its MCP server config - Claude
Desktop uses claude_desktop_config.json, Cursor/Windsurf use .cursor/mcp.json,
Codex CLI uses ~/.codex/config.toml (same fields, TOML syntax).
(If I tell you I'm running this from a local clone instead of the published
package, use `node /abs/path/to/dist/index.js` as the command instead, with
no args.)

Before adding any environment variables, check whether
~/.config/calimero/mcp/agent.json exists on my machine. If it does, register
the server with no env vars at all - that file is a handoff from the
Calimero desktop app and the server picks up the node URL and credentials
from it automatically. If it does not exist, ask me for CALIMERO_NODE_URL
(the node to connect to) and how I want to authenticate - either
CALIMERO_AUTH_TOKEN (plus optional CALIMERO_REFRESH_TOKEN), or
CALIMERO_USERNAME plus CALIMERO_PASSWORD - and set those instead. If I don't
know, ask me to check whether the node has auth enabled at all before
assuming I need any of this.

Once it's registered, verify the connection yourself: call the node_status
tool, then list_applications, then list_contexts. Report back what each one
returned.

If anything fails, don't guess - show me the server's stderr output so we
can see the actual error.
```

Prefer to wire it up by hand? See [manual setup](#manual-setup) below.

## Manual setup

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
`node_status`, `list_nodes`, `list_applications`, `list_namespaces`, `list_contexts`, `create_context`, `delete_context`, `create_alias`, `lookup_alias`.

**Blobs** (in `CALIMERO_MCP_TOOLSETS` by default):
`install_application`, `uninstall_application`, `upload_blob`, `list_blobs`, `delete_blob`.

**Governance** (in `CALIMERO_MCP_TOOLSETS` by default):
`create_namespace`, `delete_namespace`, `invite_to_namespace`, `join_namespace`, `leave_namespace`, `list_group_members`, `add_group_members`.

**Application** (always registered):
`describe_app` shows an application's methods and guide and gives a planning handle.
`select_app` picks an application and a context and returns its guide and `app_handle`.
`call` invokes a method with that handle.

Handles are per application, so one instruction can span several apps by holding a handle for each.

Anywhere an application is named you can pass its id, its full package name, or just the last dot-separated segment of that package (`kv-store` for `com.calimero.kv-store`), as long as that segment is unambiguous among the installed applications.
The same package from two signers is two apps; name either by its application id.

**Generated** (always registered): one tool per method of every installed app, from the moment a client connects, and each takes that app's `app_handle`.
Those tools are named `<app>_<method>`, or `<app>_<service>_<method>` for a multi-service application, where `<app>` is that same trailing package segment: `com.calimero.kv-store` yields `kv_store_get`.
The list changes only when an app is installed, upgraded or uninstalled.

Each app's guide is also a resource at `calimero://apps/<application id>/<version>/guide`, keyed by application id so two signers of one package never share one.

## Verifying it works

Two harnesses drive the built server over real MCP stdio against a real node.
Both boot their own `merod` on port 2571 in a temp home and tear it down on the way out, so neither touches `~/.calimero` or your real state directory.

```bash
npm run e2e          # 17 assertions: the protocol, the ABI-derived tools, and a round trip verified out of band
npm run e2e:cycle    # 8 assertions: admin login -> client key -> agent.json handoff, with zero credentials in the environment
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
