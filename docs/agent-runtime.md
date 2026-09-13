# Agent Runtime

Six CLIs, two runtimes, one registry.

`src/cli-registry.ts` is the single source of truth: the id, the binary that must be on
PATH, the command that installs it, and any environment variable it needs. **Adding a CLI
is one edit there.**

## The six

| id | Label | Runs as | Status from | MCP messaging |
|---|---|---|---|---|
| `claude` | Claude Code | PTY | Lifecycle hooks | ✅ session-scoped |
| `codex` | Codex CLI | `codex app-server` thread | app-server events | ❌ |
| `gemini` | Gemini CLI | PTY | process liveness | ❌ |
| `opencode` | OpenCode | PTY | process liveness | ❌ |
| `gpt` | GPT-OSS 120B (Groq) | PTY via `aider` | process liveness | ❌ |
| `nemotron` | Nemotron (OpenRouter) | PTY via `aider` | process liveness | ❌ |

Only Claude and Codex report fine-grained status, because only they emit lifecycle events.
The others report whether the process is alive. See [Data Model](data-model.md#the-agent-status-machine).

## Two runtimes

`src/daemon/runtime.ts` routes every operation to one of two implementations.

**PTY agents** (`src/pty-manager.ts`) get a real pseudo-terminal via `node-pty`. Output is
buffered so a browser attaching later gets a replay rather than a blank screen. Input is
raw keystrokes — which is why the terminal is genuinely interactive and you can take over.

**Codex** (`src/daemon/codex-agents.ts`) is not a terminal. `codex app-server` speaks
JSON-RPC and emits structured items — tool calls, diffs, reasoning — which the UI renders
as a transcript rather than a terminal. `src/daemon/codex-server.ts` is the client.

## How each is told about the project

Every agent is given the project's shared folder and wiki, in whatever way that CLI accepts:

| CLI | Mechanism |
|---|---|
| Claude Code | `--add-dir` |
| Codex | writable roots |
| Gemini | `--include-directories` |
| OpenCode | `AGENTS.md` |
| aider (`gpt`, `nemotron`) | `--read AGENTS.md` |

Conduit appends a delimited section to `CLAUDE.md` (for Claude) or `AGENTS.md` (everything
else) in the project directory, so the agent starts knowing what Conduit is, who its
teammates are, and how to reach them. `src/instruction-files.ts` owns that, and removes its
section when the agent is deleted.

## aider, specifically

The two hosted models run through `aider`:

```
aider --model groq/openai/gpt-oss-120b --read AGENTS.md --no-auto-commits --no-check-update
```

Two flags are deliberate and worth not "fixing":

- **`--no-auto-commits`** — aider commits after every edit by default, which would slip
  changes past the approval gates and into your history.
- **`--yes-always` is NOT set.** It would auto-approve aider's own confirmations and defeat
  the gates entirely. Those confirmations are what the regex path detects.

aider stops to ask before creating files in a directory it has not been given, which is
worth knowing when you ask it for new files and nothing appears.

## Preflight

**Every type is checked before it is spawned.** A missing binary or an unset required
environment variable fails immediately with the command that installs it, rather than
opening a PTY that lands in a shell and looks alive.

That check happens on **start**, not on create. You can define your fleet now and install a
tool later — but it means an agent can exist and still refuse to run.

`npm run seed:demo` checks PATH first and only seeds agents that can actually run.

## Prompts Conduit answers for you

`src/gate-answer.ts` recognises prompts whose answer is mechanical and types it:

- **Claude Code's workspace trust prompt.** An arrow menu whose default row is *"No, exit"*
  — so a fresh agent would sit there forever. Conduit sends Down, then Enter, with real
  delays because the terminal needs time to redraw between them.
- **Plain `y/N` confirmations**, when routine auto-approval is on.

Destructive commands are never auto-answered. They raise a gate and wait.

## Agent-to-agent messaging

Claude agents get a session-scoped MCP server (`src/mcp-server.ts`, wired with
`--mcp-config`) exposing two tools:

- `message_agent` — send a teammate a message directly
- `list_teammates` — who else is on this project

Messages appear in the **MCP Messages** tab and the activity feed. The other five CLIs do
not support this; they coordinate through Group Chat and the Keeper instead.

## Lifecycle

```
create ──► start ──► running ⇄ awaiting_input ──► stop ──► delete
             │                                       │
             └── preflight fails ──► 400 with the install command
```

Stopping an agent kills its process tree. `check:desktop` asserts that quitting the app
leaves **no orphaned agents** — an orphan keeps spending your API budget after you believe
you have quit.
