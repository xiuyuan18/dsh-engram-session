/**
 * The Engram Memory Protocol text injected into every agent's system prompt
 * as the `engram:memory-protocol` section (order 10: after the deployment
 * persona at 0, before tool guidance at 100+).
 *
 * Adapted from upstream Gentleman-Programming/engram docs/DOCS.md
 * (#memory-protocol) to DSH's `mcp__engram__mem_*` tool names and DSH
 * project-resolution rules. The deployment persona is deliberately left
 * untouched — the protocol is this bundle's own contribution, registered by
 * the plugin, not a rewrite of the deployment's identity.
 *
 * The SEARCH SCOPING paragraph is bundle-local: it documents mem_search /
 * mem_context scoping verified hands-on (default = current project only;
 * all_projects=true crosses projects; scope=global filters machine-wide
 * facts) — upstream MCP doc strings omit `global`, so this fills the gap.
 */

export const MEMORY_PROTOCOL = `You have persistent memory tools registered as mcp__engram__mem_* (cross-session persistent
memory). Use them proactively — never wait to be asked.

WHEN TO SAVE (mandatory): call mcp__engram__mem_save immediately after a bug fix completed,
an architecture or design decision made, a non-obvious discovery about the codebase, a
configuration change or environment setup, a pattern established, or a user preference or
constraint learned. Format: title = verb + what (short, searchable); type =
bugfix|decision|architecture|discovery|pattern|config|preference; scope = project (default) |
personal | global; topic_key = stable key for evolving topics — call
mcp__engram__mem_suggest_topic_key when unsure, then reuse it; use mcp__engram__mem_update
with an exact observation id to correct. content uses **What** / **Why** / **Where** /
**Learned** sections.

WHEN TO SEARCH MEMORY: when the user asks to recall anything ("remember", "recall", "what
did we do", "how did we solve", references to past work), first call mcp__engram__mem_context
(fast recent history), then mcp__engram__mem_search with relevant keywords, then
mcp__engram__mem_get_observation for full untruncated content. Also search proactively when
starting work that might have been done before or when the user mentions a topic you have no
context on.

SEARCH SCOPING: mem_search and mem_context see only the current project by default. Pass
all_projects=true to search across every project (e.g. machine-wide facts saved with
scope=global), optionally combined with scope=global (global-only), scope=project
(project-only), or scope=personal. Use this when the user asks about configuration or
setup that may have been recorded under another project.

SESSION CLOSE PROTOCOL (mandatory): before ending a session or saying "done", call
mcp__engram__mem_session_summary with ## Goal, ## Instructions, ## Discoveries,
## Accomplished, ## Next Steps, and ## Relevant Files sections. Skipping it leaves the next
session blind.

PASSIVE CAPTURE: when completing a task, end your response with a "## Key Learnings:" section
of numbered items — Engram extracts and saves them automatically. You can also call
mcp__engram__mem_capture_passive directly with text containing such a section.

AFTER COMPACTION: when you see a compaction or context-reset notice, first call
mcp__engram__mem_session_summary with the compacted summary content, then
mcp__engram__mem_context to recover prior context, and only then continue working.

PROJECT HANDLING: if mcp__engram__mem_save returns ambiguous_project, do not guess — ask the
user to choose exactly one value from available_projects, then retry with BOTH
project=<chosen value> and project_choice_reason=user_selected_after_ambiguous_project.

SESSION HANDLING: mcp__engram__mem_save rejects session_id values that were never
created, with unknown_session. Sessions are lifecycle entities: create one with
mcp__engram__mem_session_start (parameters: id, directory), attach saves by passing
that same value as mem_save's session_id, and close it with mcp__engram__mem_session_end
(parameter: id). For ad-hoc saves omit session_id (a default session is created
automatically); for a long-running session start once with a chosen id and reuse it.`
