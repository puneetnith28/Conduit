# API Reference

Three surfaces: the web server's REST API, the browser WebSocket, and the daemon's
`/org/*` HTTP API.

All REST responses are JSON. Every route that changes state also broadcasts a WebSocket
event — a route that mutates without broadcasting is a bug, and `check:ui` asserts the
round trip.

`CONDUIT_AUTH=user:pass` puts Basic auth in front of everything on `:3200`, including the
WebSocket upgrade.

---

## 1. REST — `http://localhost:3200/api`

### Server

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | Version, uptime, which `.env` files were found, and `supervisorHealth` |
| `GET` | `/daemon/status` | Whether the web server can reach the daemon |
| `GET` | `/activity` | The activity feed |
| `GET` | `/usage` | Claude and Codex subscription utilisation |
| `GET` | `/brain` | The Keeper's conversation state |
| `GET` `PUT` | `/gate-settings` | `{ autoApproveRoutine: boolean }` |
| `GET` `PUT` | `/voice/config` | Voice settings. **Returns booleans, never secrets** |
| `POST` | `/voice/tts` | Server-side speech synthesis |
| `GET` | `/codex/models` | Models the local Codex CLI offers |
| `POST` | `/strands/ping` | One-shot Supervisor connectivity test |

`GET /health` is the one to check first:

```json
{
  "supervisorHealth": {
    "state": "ok",
    "provider": "bedrock",
    "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "strands": true
  }
}
```

`strands` is whether the last good classification went through the Strands SDK.
`state` is `ok`, `degraded` (working, but not on the configured provider), `failing`,
`idle` or `off`.

### Projects

| Method | Path | Notes |
|---|---|---|
| `GET` | `/projects` | Every project with its agents |
| `POST` | `/projects` | `{ name, cwd, description? }` → 201 |
| `GET` `PUT` | `/projects/:id` | Renaming moves the wiki and shared folders |
| `DELETE` | `/projects/:id` | `?removeData=true` also deletes wiki and shared content |
| `GET` `PUT` | `/projects/:id/layout` | Terminal layout, per project |

### Agents

| Method | Path | Notes |
|---|---|---|
| `GET` | `/projects/:id/agents` | Includes `status` and `pendingGate` |
| `POST` | `/projects/:id/agents` | `{ name, cli, role? }`. **Does not check the CLI exists** — that happens on start |
| `PUT` `DELETE` | `/projects/:id/agents/:aid` | |
| `POST` | `/projects/:id/agents/:aid/start` | 400 with the install command if the CLI is missing |
| `POST` | `/projects/:id/agents/:aid/stop` | |
| `POST` | `/projects/:id/agents/:aid/restart` | |
| `GET` | `/projects/:id/agents/previews` | Last terminal lines, for the grid |
| `GET` | `/projects/:id/agents/:aid/teammates` | What `list_teammates` returns over MCP |

### Gates and plans

| Method | Path | Body |
|---|---|---|
| `POST` | `/projects/:id/agents/:aid/gate/resolve` | `{ decision: "approve" \| "reject" \| "custom", customInput? }` |
| `GET` `POST` | `/projects/:id/plans` | |
| `POST` | `/projects/:id/plans/:planId/resolve` | `{ decision: "approve" \| "reject", reason? }` |

Resolving a gate returns what actually reached the agent:

```json
{ "success": true, "action": "interrupted", "agentName": "Gpt" }
```

`action` is whatever `gate-answer.ts` describes the keystrokes as — `"answered the prompt"`,
`"trusted the workspace"`, `"interrupted"`, `"sent custom input"`. There is one
implementation of this (`src/gate-resolve.ts`) and the voice path calls the same one.

### Messages, chat, content

| Method | Path | Notes |
|---|---|---|
| `POST` | `/projects/:id/messages` | `{ agentId, text }` — to one agent |
| `GET` `POST` | `/projects/:id/groupchat` | `POST { message }`. Reaches every running agent; `@name` targets one |
| `GET` `POST` | `/projects/:id/content` | The shared folder |
| `GET` `PUT` `DELETE` | `/projects/:id/content/:filename` | |
| `GET` | `/projects/:id/wiki`, `/wiki/status` | |
| `GET` `PUT` | `/projects/:id/wiki/:filename` | |
| `POST` | `/projects/:id/wiki/initialize` | Scaffolds the wiki template |

Filenames never reach `path.join` directly — `storage.resolveInside` enforces containment.

---

## 2. WebSocket — `ws://localhost:3200/ws`

Connect and you get `hello`. Frames are JSON with a `type`.

**From the browser:**

| Type | Fields |
|---|---|
| `terminal:attach` | `agentId` — start streaming this agent |
| `terminal:input` | `agentId`, `data` — keystrokes |
| `terminal:resize` | `agentId`, `cols`, `rows` |

> Send text and Enter as **separate** writes. Claude Code's TUI reads a CR arriving in the
> same burst as the text as a literal newline — a paste, not a submit. A human keyboard
> never hits this; a script always does.

**To the browser:**

| Event | When |
|---|---|
| `agent:status` | An agent changed state |
| `terminal:output` | Bytes from an attached agent |
| `codex:item` | A structured item from a Codex thread |
| `gate:triggered` / `gate:resolved` | An approval gate opened or closed |
| `plan:created` / `plan:resolved` | The Supervisor proposed something, or you answered |
| `groupchat:message` | A new group chat entry |
| `supervisor:update` | A classification — **`noise` is dropped and never sent** |
| `supervisor:health` | Provider or state changed |
| `brain:event` | The Keeper is thinking, or answered |
| `org:changed` | Projects or agents were added, renamed or removed |
| `activity` | Any activity-feed entry |
| `content:updated` | Shared content changed on disk |

Attaching to an agent that is not running is remembered (`clientWanted`) and bound when it
starts, so the UI does not have to poll.

### `ws://localhost:3200/ws/voice`

Binary audio to and from Amazon Nova Sonic. Send `{"type":"start"}`, wait for
`{"type":"ready"}`, then stream PCM16. The AWS credentials never leave Node.

---

## 3. Daemon — `http://127.0.0.1:3210/org/*`

What the Keeper and the voice tools drive. **Loopback only, and unauthenticated** — see
[Security](security.md), this is a deliberate trade and the wrong one on a shared machine.

| Path | Body |
|---|---|
| `POST /org/create-project` | `{ name, cwd, description? }` |
| `POST /org/create-agent` | `{ project, name, cli, role? }` |
| `POST /org/start-agent`, `/org/stop-agent` | `{ project, agent }` |
| `POST /org/ask-agent` | `{ project, agent, question }` — up to 3 minutes |
| `POST /org/inject` | `{ project, agent, message, fromName? }` |
| `POST /org/broadcast` | `{ project, message, fromName? }` |
| `GET /org/snapshot` | Every project, agent and status in one call |
| `GET /org/wiki`, `/org/shared` | Read project memory |

`/org/inject` and `/org/broadcast` refuse with 400 when the agent has a **pending gate** —
a message delivered then would become the answer to that prompt. They do *not* refuse
merely because an agent is `awaiting_input` or `idle`: those are the ordinary states of an
agent that finished a turn, which is exactly when you send the next instruction.

---

## Errors

| Status | Means |
|---|---|
| 400 | Bad body, or a state that makes the request wrong (a gate is open) |
| 401 | `CONDUIT_AUTH` is set and you did not send it |
| 404 | No such project, agent or file |
| 409 | No pending gate to resolve |
| 503 | The web server cannot reach the daemon |

Error bodies are `{ "error": "..." }` and the message is meant to be shown to a person.
