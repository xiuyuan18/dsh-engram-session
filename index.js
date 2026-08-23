/**
 * dsh-engram-session — per-session Engram memory for DeepSeek Harness.
 *
 * Spawns one `engram mcp` child per agent session, rooted at that session's
 * workspace (`session.header.cwd`), and registers the `mem_*` tools in the
 * agent's own scope via `agent.ctx.tools.register()`. Scoped registration
 * shadows the global tool layer, so concurrent sessions each see exactly
 * their own memory surface without name collisions.
 *
 * This is the session-level counterpart of a process-level `dsh-mcp-client`
 * row: Engram's own project auto-detection (git root / `.engram/config.json`)
 * becomes deterministic per session — the documented fix for hosts whose MCP
 * child cannot inherit a reliable cwd (DSH web GUI, VS Code, WSL, CI).
 *
 * Known limitation: no reconnect supervision. If the child dies mid-session,
 * its tools fail until the session ends; restart the GUI to recover.
 *
 * The Engram Memory Protocol is injected as its own system-prompt section
 * (`engram:memory-protocol`, order 10) via `ctx.systemPrompt.section()`,
 * never as a persona override — the deployment persona stays user-owned and
 * other system-prompt patchers cannot drop the protocol by replacing the row.
 *
 * The Engram executable is auto-detected at mount (PATH, then ~/.local/bin,
 * /usr/local/bin, /opt/homebrew/bin) unless the profile config pins `binary` —
 * no machine-specific path is baked in anymore.
 */

import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import Schema from '@deepseek-ai/schemastery'
import { MEMORY_PROTOCOL } from './protocol.js'

export const name = 'engram-session'
export const inject = ['agents', 'systemPrompt']

export const Config = Schema.object({
  /** Namespace for model-facing tool names (`mcp__<serverName>__<rawName>`). */
  serverName: Schema.string().default('engram'),
  /**
   * Engram executable to spawn. Empty (default) means auto-detect: PATH
   * lookup first, then ~/.local/bin, /usr/local/bin, /opt/homebrew/bin.
   * Set an absolute path (or a bare command name) to override detection;
   * a set-but-missing value warns and falls back to detection.
   */
  binary: Schema.string().default(''),
  /** Arguments passed to the binary (the MCP stdio server). */
  args: Schema.array(Schema.string()).default(['mcp']),
  /** Per-call timeout for each `tools/call` invocation, in milliseconds. */
  toolCallTimeoutMs: Schema.number().default(60_000),
})

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/**
 * Resolve the Engram executable to spawn.
 *
 * Why: the historical default was a machine-specific absolute path
 * (`/home/xiuyuaned/.local/bin/engram`), which broke on every other host.
 * Now an empty `binary` config means "detect": PATH lookup first (a normal
 * install like `~/.local/bin/engram` is on PATH), then the common per-user
 * and system locations. An explicit config value is tried first; if it does
 * not exist (e.g. a stale path pinned by a pre-0.4 bundle) we fall through to
 * detection, so profiles created by earlier versions self-heal. Returns null
 * when nothing is found — the caller then skips Engram entirely.
 */
export function resolveBinary(custom) {
  if (typeof custom === 'string' && custom.length > 0) {
    try {
      accessSync(custom, fsConstants.X_OK)
      return custom
    } catch {
      // configured path is missing (stale or mistyped) — fall through to detection
    }
  }
  const names = process.platform === 'win32' ? ['engram.exe', 'engram.cmd'] : ['engram']
  const candidates = []
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue
    for (const name of names) candidates.push(path.join(dir, name))
  }
  if (process.platform !== 'win32') {
    const home = homedir()
    for (const name of names) {
      candidates.push(
        path.join(home, '.local', 'bin', name),
        path.join('/usr/local/bin', name),
        path.join('/opt/homebrew/bin', name), // macOS (Apple Silicon) Homebrew
      )
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

/** Same deterministic (serverName, rawName) -> public-name mapping as dsh-mcp-client. */
function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Ambient env minus credential-shaped and stale DSH_* names (mirrors dsh-mcp-client's scrub). */
function scrubbedEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('DSH_') || /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete env[key]
  }
  return env
}

/** Text projection of MCP content blocks; unsupported blocks become diagnostics. */
function extractText(content, rawName) {
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'resource' && typeof block.resource?.uri === 'string') {
      parts.push(`${block.resource.name ?? block.resource.uri}: ${block.resource.uri}`)
    } else if (block.type === 'image' || block.type === 'audio' || block.type === 'embedded') {
      parts.push(`[${block.type} block omitted]`)
    } else {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.length > 0 ? parts.join('\n') : `(no output from ${rawName})`
}

/** Build one scoped ToolDefinition bridging an MCP tool to the harness registry. */
function makeDefinition(client, tool, config) {
  const rawName = tool.name
  const publicName = publicToolName(config.serverName, rawName)
  return {
    name: publicName,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.inputSchema ?? {},
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: {},
        },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args, value) {
        const content = Array.isArray(value?.content) ? value.content : []
        return [{ type: 'text', text: extractText(content, rawName) }]
      },
    },
    async execute(args, exec) {
      const argsObj = typeof args === 'object' && args !== null ? args : {}
      // callTool defaults to CallToolResultSchema; the SDK's raw request()
      // path crashes on an undefined resultSchema (safeParse touches ._zod).
      const result = await client.callTool(
        { name: rawName, arguments: argsObj },
        undefined,
        { signal: exec.signal, timeout: config.toolCallTimeoutMs },
      )
      const content = Array.isArray(result?.content) ? result.content : []
      if (result?.isError === true) {
        throw new Error(extractText(content, rawName))
      }
      return {
        content,
        ...(result?.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
      }
    },
  }
}

/** Discover the server's tools and register them in the agent's scope. */
async function syncTools(client, agentCtx, disposers, config) {
  let cursor
  const definitions = []
  do {
    const response = await client.request(
      { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema,
    )
    for (const tool of response.tools) definitions.push(makeDefinition(client, tool, config))
    cursor = response.nextCursor
  } while (cursor !== undefined)
  for (const definition of definitions) {
    disposers.set(definition.name, agentCtx.tools.register(definition))
  }
}

export function apply(ctx, config) {
  const binary = resolveBinary(config.binary)
  if (binary === null) {
    // No executable anywhere. Do not register the protocol section either,
    // or agents would be told about mem_* tools that cannot exist.
    ctx.logger.warn(
      'engram-session: no Engram executable found (checked config, PATH, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin); ' +
        'install Engram or set "binary" in the profile config — memory tools and protocol disabled',
    )
    return
  }
  if (typeof config.binary === 'string' && config.binary.length > 0 && binary !== config.binary) {
    ctx.logger.warn(`engram-session: configured binary "${config.binary}" not found; using detected "${binary}"`)
  }
  ctx.logger.info(`engram-session: using Engram binary: ${binary}`)

  // The Memory Protocol rides as its own system-prompt section (after the
  // deployment persona at order 0, before tool guidance at 100+), not as a
  // persona override: the deployment persona stays fully user-owned, and
  // other system-prompt patchers replacing the row cannot drop the protocol.
  // The effect is context-owned, so plugin disposal unregisters it.
  ctx.systemPrompt.section({
    name: 'engram:memory-protocol',
    order: 10,
    text: MEMORY_PROTOCOL,
  })

  /** agent id -> live server entry. */
  const servers = new Map()

  function stopForAgent(agent) {
    const entry = servers.get(agent.id)
    if (entry === undefined) return
    servers.delete(agent.id)
    for (const dispose of entry.disposers.values()) dispose()
    void entry.client.close().catch(() => {})
  }

  async function startForAgent(agent) {
    if (servers.has(agent.id)) return
    const cwd = agent.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      ctx.logger.debug(`engram-session: agent ${agent.id} has no session cwd; skipping`)
      return
    }
    const client = new Client({ name: 'dsh-engram-session', version: '0.4.1' })
    const transport = new StdioClientTransport({
      command: binary,
      args: config.args,
      cwd,
      env: scrubbedEnv(),
      stderr: 'inherit',
    })
    const entry = { client, disposers: new Map(), agent }
    servers.set(agent.id, entry)
    try {
      await client.connect(transport)
      await syncTools(client, agent.ctx, entry.disposers, config)
      ctx.logger.info(`engram-session: agent ${agent.id}: ${entry.disposers.size} tools registered (cwd=${cwd})`)
    } catch (error) {
      servers.delete(agent.id)
      await client.close().catch(() => {})
      ctx.logger.warn(`engram-session: agent ${agent.id}: connect failed: ${String(error)}`)
    }
  }

  // Cover agents already alive when this plugin mounts, then every later one.
  const live = ctx.agents.list()
  for (const agent of live) void startForAgent(agent)
  ctx.on('agent/created', ({ agent }) => { void startForAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => { stopForAgent(agent) })
  ctx.on('dispose', () => { for (const entry of [...servers.values()]) stopForAgent(entry.agent) })
}
