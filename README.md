# dsh-engram-session

Per-session [Engram](https://github.com/Gentleman-Programming/engram) memory for DeepSeek Harness — a standalone bundle project reusable across profiles and presets.

This package is a **bundle**: its `dsh.bundle.patch` (`cordis.patch.yml`) is the composition layer that inserts the plugin row and the Memory Protocol persona override, so installing it into any profile is one command:

```sh
# from anywhere; <path> may be absolute or relative to your invoking directory
dsh plugin --profile web add /home/xiuyuaned/dsh-plugins/dsh-engram-session
```

`dsh plugin` runs `pnpm add` and reconciles `dsh.profile.bundles` — a `dsh.bundle`-declaring package joins the layer stack automatically. The bundle owns everything (plugin row + persona override), so removing or disabling it leaves zero side effects (no tools, no orphaned memory instructions).

## Setup for a new profile or preset

1. Install dependencies once (self-contained — the project carries its own `node_modules`):

   ```sh
   cd /home/xiuyuaned/dsh-plugins/dsh-engram-session && pnpm install
   ```

2. Add the bundle to the profile (repeat per profile):

   ```sh
   dsh plugin --profile <name> add /home/xiuyuaned/dsh-plugins/dsh-engram-session
   ```

3. Restart the profile's app. A preset can also list the bundle directly in its
   `dsh.profile.bundles` plus a `link:` dependency in its `package.json`.

Removing is symmetric: `dsh plugin --profile <name> remove dsh-engram-session`.
Reinstall at any time with the add command — the source lives outside the
profile, so removing the bundle never deletes it.

## What it does

One `engram mcp` stdio child per agent session, spawned with `cwd = session.header.cwd` (the session's workspace), with the `mem_*` tools registered in that agent's own scope via `agent.ctx.tools.register()`. Scoped registration shadows the global tool layer, so concurrent sessions each see their own memory surface under the same `mcp__engram__mem_*` names without collisions.

Rooting the child at the session workspace makes Engram's project auto-detection (git root / `.engram/config.json`) deterministic per session — the documented fix for hosts whose MCP child cannot inherit a reliable cwd (DSH web GUI, VS Code, WSL, CI). No `--project` pinning needed.

## Config

| Field | Default | Description |
|---|---|---|
| `serverName` | `engram` | Namespace for model-facing tool names |
| `binary` | `/home/xiuyuaned/.local/bin/engram` | Engram executable |
| `args` | `['mcp']` | Arguments for the MCP stdio server |
| `toolCallTimeoutMs` | `60000` | Per `tools/call` timeout |

## Lifecycle

- `agent/created` (and a scan of already-live agents at mount) → spawn + register
- `agent/disposed` → unregister tools, close client (kills the child)
- plugin `dispose` → same teardown for every live entry

## Project layout

- `index.js` — the plugin: per-agent Engram MCP child + scoped `mem_*` tool registration
- `cordis.patch.yml` — the bundle composition layer (plugin row + Memory Protocol persona)
- `agents.md` — guidance for AI agents working on this project
- `package.json` / `pnpm-lock.yaml` — ESM manifest and lockfile

## Development

See [`agents.md`](./agents.md) for architecture details, conventions,
verification steps, and pitfalls. Quick checks:

```sh
node --check index.js
```

## Known limitations

- No reconnect supervision: if the child dies mid-session, its tools fail until the session ends; restart the GUI to recover.
- Text-only result projection: image/audio/embedded MCP blocks become diagnostics (Engram returns text results).
