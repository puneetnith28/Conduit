# Environment Configuration

Nothing is required to start Conduit. Every variable below adds a capability, and the app
tells you which are missing rather than failing obscurely.

## Where the files are

`src/env.ts` loads two files, in this order. **The first to define a key wins.**

| File | Read by |
|---|---|
| `./.env` | The dev server, because its working directory is the repo |
| `~/.conduit/.env` | Everything, including the packaged desktop app |

> The desktop app runs from its install directory, so **it never sees the repo's `.env`.**
> Anything that must reach the installed app has to be in `~/.conduit/.env`. This is the
> difference that produces a dev server with Bedrock and voice, and an installed app
> quietly without either.

`GET /api/health` reports `envFiles` — which ones were actually found.

Neither file is committed; `.env` is gitignored and `~/.conduit/` is outside the repo.

## Server

| Variable | Default | Does |
|---|---|---|
| `PORT` | `3200` | Web server port |
| `HOST` | `127.0.0.1` | Bind address. Change only behind a TLS proxy |
| `CONDUIT_AUTH` | *(none)* | `user:pass`. Basic auth over HTTP **and** the WebSocket upgrade. **Required before exposing the port** |
| `CONDUIT_DAEMON_PORT` | `3210` | Daemon port, loopback |
| `CONDUIT_DAEMON_HTTP` | derived | Where the web server reaches the daemon |
| `CONDUIT_HUB_URL` | `http://localhost:3200` | What agents are told to call back |

## The Supervisor

| Variable | Default | Does |
|---|---|---|
| `CONDUIT_SUPERVISOR` | `on` | `off`, `0` or `false` disables classification entirely |
| `SUPERVISOR_PROVIDER` | `auto` | `bedrock`, `anthropic`, or `auto` — Bedrock first, Anthropic when it cannot serve |
| `AWS_REGION` | `us-east-1` | |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | **Must be an inference profile**, not a bare `anthropic.*` id — those are retired. Must match your IAM policy |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | *(none)* | Omit on EC2 with an instance role |
| `ANTHROPIC_API_KEY` | *(none)* | The fallback provider. Without it, Conduit falls back to the Claude Code OAuth token on this machine |
| `ANTHROPIC_MODEL_ID` | *(ladder)* | Pins one model. Otherwise it walks `claude-opus-5` → `claude-sonnet-5` → `claude-haiku-4-5` and keeps the first that answers |

Both providers run through the Strands SDK. See [Architecture §3a](../ARCHITECTURE.md).

`npm run check:bedrock` tells the three Bedrock failure modes apart: a missing IAM
permission, a model the account never enabled, and a quota cap. They all surface as
`AccessDenied` or a bare 429, so the wrong fix gets attempted repeatedly otherwise.

## Agent CLIs

| Variable | Needed by |
|---|---|
| `GROQ_API_KEY` | The `gpt` agent (GPT-OSS via aider), and Groq Whisper speech-to-text |
| `OPENROUTER_API_KEY` | The `nemotron` agent |
| `OPENAI_API_KEY` | OpenAI voice |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini voice |

Claude Code, Codex, Gemini CLI and OpenCode use **their own logins**, not these keys —
`claude login`, `codex login`, and so on. Conduit never handles those credentials.

## Voice

| Variable | Default | Does |
|---|---|---|
| `NOVA_MODEL_ID` | `amazon.nova-2-sonic-v1:0` | The live speech model |

Voice provider keys live in `~/.conduit/api-keys.json`, not in `.env`, and
`GET /api/voice/config` returns booleans rather than secrets.

> Nova Sonic uses `InvokeModelWithBidirectionalStream`, which is a different quota pool
> from the text models. Voice keeps working when Bedrock text is capped.

## The Keeper

| Variable | Default | Does |
|---|---|---|
| `CONDUIT_KEEPER_ENGINE` | auto | `codex` or `claude` — which CLI backs the Keeper |
| `CONDUIT_AUTO_APPROVE` | *(unset)* | Auto-approve routine gates. Also settable at `PUT /api/gate-settings` |

## Set by Conduit, not by you

`CONDUIT_AGENT_ID`, `CONDUIT_AGENT_NAME`, `CONDUIT_PROJECT_ID` and `AGENT_ORG_AUTH` are
injected into each agent's environment so the MCP servers know who they are speaking for.
Do not set them yourself.

## A minimal file

Enough for a working install with one agent and a working Supervisor:

```bash
# ~/.conduit/.env
ANTHROPIC_API_KEY=sk-ant-...
```

Everything else is optional. Add `GROQ_API_KEY` for the hosted agents and Whisper, AWS
credentials to move the Supervisor onto Bedrock, and `CONDUIT_AUTH` before the port is
reachable by anyone else.
