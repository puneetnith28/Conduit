# Conduit — Coding Agent Management Platform

## What This Is

A web dashboard for running and supervising several coding CLI agents (Claude Code, Codex, Gemini CLI, OpenCode, plus GPT-OSS on Groq and Nemotron on OpenRouter — both driven through `aider`) in parallel, organised by project. Every agent runs in a real terminal the user can see and type into. A Supervisor (AWS Strands Agents SDK on Amazon Bedrock) watches agent output, summarises it into a per-project Group Chat, raises **approval gates** for risky actions, and can only *propose* instructions (plans) that the human approves.

Human-driven: the user decides. The Supervisor never sends an instruction to an agent without an approved plan.

## Processes and ports

| Process | Entry | Port | Owns |
|---|---|---|---|
| Web server | `src/server.ts` | `:3200` (`PORT`, `HOST`) | React UI, REST, browser WebSocket, voice proxy, optional Basic auth (`CONDUIT_AUTH=user:pass`) |
| Daemon | `src/daemon/daemon.ts` | `:3210` loopback | Every agent process, status engine, Supervisor watcher, The Keeper |
| Per-agent MCP server | `src/mcp-server.ts` | stdio | `message_agent` / `list_teammates` for Claude agents |
| Keeper MCP server | `src/conduit-mcp-server.ts` | stdio | Org-level tools for the orchestrator (Codex or Claude Code) |

The web server never owns processes; it relays to the daemon over a local WebSocket (`src/daemon/protocol.ts`) and auto-reconnects. Restarting the web server does not kill agents.

## Source map

```
src/
  server.ts            Express + WS relay, auth, voice, health
  routes.ts            REST: projects, agents, gates, plans, group chat, content, wiki
  auth.ts              CONDUIT_AUTH Basic auth (HTTP + WS upgrade + helper header)
  storage.ts           ~/.conduit JSON/JSONL storage; path-traversal-safe helpers
  env.ts               .env loading (cwd + ~/.conduit/.env); import first in every entry point
  cli-registry.ts      the six CLI ids, their binaries, install hints and required env
  pty-manager.ts       PTY agents (claude/gemini/opencode/gpt/nemotron): spawn, buffer, inject, quoting
  gatePatterns.ts      stripAnsi + regex gates (y/N prompts, destructive commands)
  gate-resolve.ts      resolving a gate — the ONE implementation, shared by the
                       REST route and the voice path; do not add a second
  gate-policy.ts       harmful vs routine; which gates auto-approve
  activity.ts, usage.ts, hook-config.ts, mcp-config.ts, instruction-files.ts
  daemon/
    daemon.ts          WS/HTTP server, status engine, terminal attach, org HTTP API
    runtime.ts         routes ops to PTY vs Codex runtime; subscribeOutput/getReplay
    codex-agents.ts    Codex agents as `codex app-server` threads (structured items)
    codex-server.ts    JSON-RPC client for app-server
    orchestrator.ts    The Keeper (codex exec / claude -p loop, conversations)
    conduit.ts         ask_agent / start_agent / broadcast dispatch
  strands/
    agent.ts           Supervisor agent (Bedrock/Anthropic model + report_update /
                       plan_action tools). buildModel() picks the provider; both are Strands.
    watcher.ts         per-agent watchdog: fast regex gates + batched Supervisor calls
    failure.ts         is a failure worth falling back on? (pure, no imports)
    anthropic.ts       the Anthropic credential (shared with the Strands AnthropicModel)
                       and a raw Messages API path kept only as the last resort
    tools.ts, config.ts
  voice/               STT/TTS providers + settings (browser | groq | openai | gemini;
                       groq is STT-only and the recommended engine)
    nova.ts            the live Nova 2 Sonic bidirectional session
    nova-tools.ts      the 8 tools the voice Keeper gets, and its system prompt
    approval-guard.ts  the four conditions on approving a gate by voice (pure)
    gate-bridge.ts     finds and resolves real gates for the voice tools
client/src/
  App.tsx              state owner; ws events → agents/gates/plans; modals
  hooks/useWebSocket   reconnecting socket; subscribe(); ws:open/ws:close frames
  components/          AgentGrid (layouts), Terminal, CodexAgentView, GroupChat,
                       GateModal, PlanModal, CommandPanel, JarvisHud, …
  utils/md.ts          marked + DOMPurify (all model/agent markdown goes through this)
scripts/
  smoke.mjs            end-to-end test against a running instance (npm run smoke)
  test-gates.mjs       unit checks for gate patterns (npm test)
  check-ui.mjs         every button, every REST route, every write round-tripped
  check-org.mjs        every daemon /org/* endpoint (npm run check:org)
  check-nova.mjs       the live voice model with the shipped tool set
```

## Rules that are easy to break by accident

- **Gate resolution has one implementation.** `src/gate-resolve.ts`. The REST route and the
  voice path both call it. Two copies of "what actually reaches the agent" will drift, and
  the half that drifts is the one answering a destructive prompt.
- **The Supervisor must run through Strands on every provider.** `classify()` in
  `strands/watcher.ts` routes both backends through `createSupervisorAgent`. The raw
  Messages API path in `anthropic.ts` is a last resort beneath both, not a peer of them.
  A fallback that bypasses the SDK means the framework is absent precisely when the
  primary provider is down, which is when you are most likely to be looking.
- **Approving a gate by voice is enforced server-side**, in `src/voice/approval-guard.ts`,
  never by telling the model to ask first. The confirmation is read from the transcript
  stream so the model cannot supply its own. Do not add an approve action to
  `client/src/utils/voiceRouting.ts` to match — that path has no such check.

## Data model (src/types.ts)

- `Project { id, name, description?, cwd, createdAt }` — `name` doubles as the folder name under `shared_content/` and `wiki/` (sanitised; rename moves folders).
- `Agent { id, projectId, name, role?, cli, cwd, status, pid?, codexThreadId?, flags?, pendingGate? }` — status is `stopped | running | awaiting_input | idle`, derived live by the daemon (Claude lifecycle hooks; Codex events; process liveness).
- `Plan { id, projectId, description, targetAgent, targetProject, proposedMessage, createdAt }` — pending plans live in `project.json`; decisions go to `audit.jsonl`.
- Group chat entries: `{ id, ts, role: 'user'|'supervisor'|'agent', sender, text, classification? }` in `groupchat.jsonl`.

## Event flow that must keep working

- Daemon → web: `agent:status`, `terminal:output`, `codex:item`, `groupchat:message`, `gate:triggered`/`gate:resolved`, `supervisor:update`, `brain:event`, `org:changed`.
- Web → browser: same names plus `plan:created`/`plan:resolved`, `activity`, `content:updated`, `hello`.
- `createRouter(daemon, broadcast)` — every route that changes state broadcasts. Do not add a route that mutates without broadcasting.
- A browser attaching to an agent before it runs is remembered by the daemon (`clientWanted`) and bound on start.

## Conventions

- Never build a path from user input with `path.join`; use `storage.resolveInside` / `sharedDirFor` / `wikiDirFor`.
- Everything rendered as HTML from model or agent text goes through `renderMarkdown` (DOMPurify).
- `npm run build` type-checks both sides first; keep it green. `npm test` and `npm run smoke` must pass before a release.
- Voice defaults are English (`en-US`); the wake word default is `jarvis`.

## Environment

See `.env.example`. `src/env.ts` loads `./.env` **and** `~/.conduit/.env` (first to define a key wins) — the packaged desktop app runs from its install directory, so the repo `.env` is not visible to it and `~/.conduit/.env` is the only config file it sees. `/api/health` reports `envFiles`. Nothing is required locally. `CONDUIT_AUTH` is required before exposing the port. `CONDUIT_SUPERVISOR=off` disables Bedrock calls. `BEDROCK_MODEL_ID` must match the IAM policy.

## Development

```bash
npm install          # .npmrc sets legacy-peer-deps (Strands wants Express 5; we use 4)
npm run dev          # daemon + web + vite (http://localhost:5173)
npm run build && npm run start:all   # production (http://localhost:3200)
npm test             # gate pattern checks
npm run smoke        # end-to-end against a running instance
```
