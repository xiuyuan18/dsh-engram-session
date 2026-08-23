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
 */

import { createHash } from 'node:crypto'
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
  /** Engram executable to spawn. */
  binary: Schema.string().default('/home/xiuyuaned/.local/bin/engram'),
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

export async function apply(ctx, config) {
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
    const client = new Client({ name: 'dsh-engram-session', version: '0.3.0' })
    const transport = new StdioClientTransport({
      command: config.binary,
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
