# agents.md — dsh-engram-session

Guidance for AI agents (and humans) working on this project. Read this before
modifying code, the bundle composition, or this project's docs.

## What this project is

A **DeepSeek Harness (DSH) plugin bundle** that gives every agent session its
own [Engram](https://github.com/Gentleman-Programming/engram) persistent-memory
surface. It spawns one `engram mcp` stdio child per agent session, rooted at
that session's workspace (`session.header.cwd`), and registers the resulting
`mcp__engram__mem_*` tools **in the agent's own scope** via
`agent.ctx.tools.register()`, so concurrent sessions each see exactly their own
memory without name collisions.

This is the session-level counterpart of a process-level `dsh-mcp-client` row.
Rooting the child at the session workspace makes Engram's project
auto-detection (git root / `.engram/config.json`) deterministic per session —
the documented fix for hosts whose MCP child cannot inherit a reliable cwd
(DSH web GUI, VS Code, WSL, CI).

## Key facts to keep in mind

- **It is a bundle, not just a plugin.** `package.json` declares
  `dsh.bundle.patch: ./cordis.patch.yml`. The bundle owns *both* the plugin row
  and the Memory Protocol persona override (`system-prompt`), so installing it
  into a profile is one command and removing it leaves zero side effects.
- **It runs inside a DSH host** (Cordis-based). It is not a standalone app and
  has no CLI of its own; you exercise it by running a DSH profile and opening
  agent sessions.
- **ESM only.** `"type": "module"`, plain JavaScript, no TypeScript, no build
  step. `index.js` is loaded directly.
- **Depends on the `agents` service** (`inject: ["agents"]`). If that service is
  absent, the plugin must not mount.
- **Machine-specific defaults.** `Config.binary` defaults to
  `/home/xiuyuaned/.local/bin/engram` and the patch pins the same absolute path.
  On another machine, change both (or override via the profile config).

## Repository layout

```
index.js            The plugin: per-agent Engram MCP child + scoped tool registration
cordis.patch.yml    The bundle layer: plugin row + Memory Protocol persona override
package.json        ESM package manifest; dsh.bundle.patch points at the patch
pnpm-lock.yaml      Lockfile — commit it; installs are reproducible
README.md           User-facing install/usage docs
agents.md           This file
node_modules/       Vendored by `pnpm install` — never commit, never edit
```

## How the plugin works (index.js)

### Registration and lifecycle

- `apply(ctx, config)` mounts with `inject: ["agents"]`.
- On mount: scans `ctx.agents.list()` for already-live agents and starts an
  Engram child for each (`void startForAgent(agent)` — fire-and-forget).
- `ctx.on('agent/created')` → `startForAgent` for the new agent.
- `ctx.on('agent/disposed')` → `stopForAgent`: dispose every registered tool via
  the stored disposer, close the MCP client (which kills the child).
- `ctx.on('dispose')` → teardown for every live entry.
- `startForAgent` **skips agents without a string, non-empty
  `agent.session.header.cwd`** (logged at debug level). The cwd is where the
  child is spawned, so a missing cwd means no memory tools for that agent.

### Per-agent MCP child

- `StdioClientTransport` with `command: config.binary`, `args: config.args`,
  `cwd: agent.session.header.cwd`, and a scrubbed env (see below).
- `stderr: 'inherit'` — Engram diagnostics surface in the host's stderr.
- On connect failure: the entry is removed, the client closed, and a warning is
  logged; the agent simply gets no memory tools (no crash, no retry).

### Tool registration

- `syncTools` paginates `tools/list` (honors `nextCursor`) and converts each
  MCP tool via `makeDefinition`.
- Public name mapping (`publicToolName`): `mcp__<serverName>__<rawName>`,
  normalized to `[A-Za-z0-9_-]`; if normalization changed anything or the name
  exceeds 64 chars, a 12-hex-char SHA-256 suffix (of `serverName\0rawName`) is
  appended. **Contract: DeepSeek function names are ≤ 64 chars and only
  `[A-Za-z0-9_-]`** — never loosen this without checking the harness contract.
- Registration is **scoped**: `agentCtx.tools.register(definition)` shadows the
  global tool layer for that agent only. Do not switch to global registration —
  that is the entire point of this plugin (per-session isolation).
- `execute` calls `client.callTool({name, arguments}, undefined, {signal:
  exec.signal, timeout: config.toolCallTimeoutMs})`. Pass `undefined` as the
  result schema on purpose: the SDK's raw request path crashes on an undefined
  `resultSchema` (safeParse touches `._zod`). `isError: true` becomes a thrown
  Error with the extracted text.
- `output.render` projects results to text (see `extractText`): `text` blocks
  are joined with newlines, `resource` becomes `name: uri`, `image/audio/
  embedded` become `[<type> block omitted]`, anything else is JSON-stringified,
  and an empty result becomes `(no output from <rawName>)`.

### Env scrubbing

`scrubbedEnv()` copies `process.env` and deletes every key that starts with
`DSH_` or matches `/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i`. Consequences:

- The Engram child cannot rely on `DSH_*` variables — do not pass needed
  configuration through the ambient env; use `Config` instead.
- Credential-shaped keys from the host must never leak into the child.

## The bundle layer (cordis.patch.yml)

- **Plugin row** (`insert`): id `engram-session`, name `dsh-engram-session`,
  config `serverName: engram`, `binary` (absolute path), `args: [mcp]`.
- **Persona override** (`system-prompt` → `config.persona`): restates the
  persona key owned by the base/web-app layers with the Engram Memory Protocol
  (when-to-save, when-to-search, session-close protocol, passive capture,
  after-compaction recovery, ambiguous-project handling). It deliberately uses
  DSH's `mcp__engram__mem_*` tool names and DSH project-resolution rules.
- If you change the protocol text, keep it consistent with upstream
  Gentleman-Programming/engram docs, keep the DSH tool-name adaptation, and
  keep the persona key (`system-prompt`) as-is so the layer stack still
  reconciles.

## Commands

```sh
# Install dependencies (self-contained; carries its own node_modules)
pnpm install

# Syntax check the plugin
node --check index.js

# Add the bundle to a DSH profile (repeat per profile)
dsh plugin --profile web add /home/xiuyuaned/dsh-plugins/dsh-engram-session

# Remove it again (zero side effects — the bundle owns everything it inserts)
dsh plugin --profile web remove dsh-engram-session
```

`dsh plugin add` runs `pnpm add` and reconciles `dsh.profile.bundles`; a
`dsh.bundle`-declaring package joins the layer stack automatically. A preset can
also list the bundle directly in its `dsh.profile.bundles` plus a `link:`
dependency in its `package.json`.

## Development workflow

1. Read this file, then `index.js` (plugin) and `cordis.patch.yml` (composition)
   before touching anything. The DSH editing-cordis-compositions skill governs
   changes to the patch; the cordis-plugin-development skill governs plugin code.
2. Make the change in `index.js` and/or `cordis.patch.yml`. Keep plain
   JavaScript, ESM, no new runtime deps without updating `package.json` and
   regenerating the lockfile (`pnpm install`).
3. `node --check index.js` for syntax.
4. Reinstall the bundle into the profile (`dsh plugin --profile web add ...`)
   or just restart the profile's app, then verify manually (see below).
5. Update `README.md` (user-facing) and/or `agents.md` (agent-facing) if
   behavior, config, or commands changed.

## Manual verification checklist

1. Start the DSH web GUI, open a session in a workspace that is a git repo (or
   has `.engram/config.json`).
2. In the agent's tool list, confirm the `mcp__engram__mem_*` tools exist
   (`mem_context`, `mem_search`, `mem_save`, `mem_session_summary`, …).
3. Call `mcp__engram__mem_context` — it should return recent sessions.
4. Call `mcp__engram__mem_save` with a test observation, then
   `mcp__engram__mem_search` for it; delete it afterwards.
5. Open a **second** session in a different workspace and confirm it gets its
   own tools rooted at *its* cwd (project auto-detection is per-session).
6. End a session and confirm the child is gone (no orphaned `engram mcp`
   processes; host logs show the registration count per agent).

## Known limitations and gotchas

- **No reconnect supervision**: if the child dies mid-session, its tools fail
  until the session ends; restarting the GUI recovers. Do not silently add a
  reconnect loop without first handling tool-registry re-registration and
  duplicate-disposer safety.
- **Text-only projection**: image/audio/embedded MCP blocks become diagnostics
  (Engram returns text results today, so this is fine).
- **Version drift**: `package.json` says `0.2.0` but the MCP `Client` in
  `index.js` reports `version: '0.1.0'` — keep them in sync next time the
  version bumps.
- **Absolute binary path** appears in both `Config.binary` default and
  `cordis.patch.yml`; they must stay consistent, and neither is portable across
  machines.
- **Never edit `node_modules/`** — it is vendored locally and regenerated by
  `pnpm install`; it is git-ignored.
- **Persona layering**: the patch restates a persona key owned by other layers;
  when editing the persona text, keep the key stable and keep the override
  additive in spirit (it must not break profiles that do not include this
  bundle — removing the bundle must leave no trace).

## Project conventions

- Plain JavaScript, ESM (`import`/`export`), no build step, no TypeScript.
- JSDoc block comments on every top-level function explaining *why* (see the
  name-mapping and resultSchema comments — they preserve hard-won knowledge).
- Constants for magic numbers with a comment naming the contract they encode
  (`MAX_PUBLIC_NAME_LENGTH`, `INVALID_NAME_CHARS`, `HASH_LENGTH`).
- Log via `ctx.logger` (info for successful registration, warn for failures,
  debug for skip decisions). No console noise.
- One plugin per file; config declared as a Schemastery `Schema.object` with
  defaults and doc comments per field.
