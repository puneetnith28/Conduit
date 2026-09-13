# Conduit System Architecture & Design Specification

This document provides a comprehensive, production-grade technical overview of the **Conduit** multi-agent control center architecture. It details the runtime lifecycle, inter-process communication (IPC), terminal virtualization, Amazon Bedrock supervision, Model Context Protocol (MCP) inter-agent messaging, and human-in-the-loop safety gates.

---

> **The one-page version is [`architecture.png`](architecture.png)**, rendered from
> `scripts/architecture.html` by `npm run architecture`. This file is the long form:
> the sequence diagrams, the storage layout and the verification matrix.

## 1. High-Level System Architecture

Conduit decouples the graphical user interface (Electron/Browser) from the long-running process manager (Conduit Daemon). This guarantees that terminal sessions, agent compilations, and git workflows never terminate if the frontend is refreshed, closed, or updated.

```mermaid
graph TB
    subgraph UI_Layer ["Presentation & Workspace Layer"]
        ElectronApp["Electron Shell (Desktop App)"]
        BrowserUI["Web Browser (React + Vite SPA)"]
    end

    subgraph Server_Layer ["Conduit API & Hub Server (:3200)"]
        ExpressServer["Express HTTP / REST API"]
        WSServer["WebSocket Hub (:3200/ws)"]
        StaticServer["Vite Static Asset Server"]
    end

    subgraph Daemon_Layer ["Conduit Daemon Process (:3210)"]
        DaemonCore["Daemon Engine (daemon.ts)"]
        PTYManager["PTY Manager (node-pty)"]
        HookServer["Hook Callback Server (HTTP /hook/:id/:event)"]
        SupervisorWatcher["Supervisor Watcher (ANSI Stripper + Watchdog)"]
    end

    subgraph Agents_Layer ["Active Subprocess Pool"]
        AgentClaude["Claude Code (Interactive CLI)"]
        AgentCodex["Codex CLI (App-Server)"]
        AgentGemini["Gemini CLI (PTY Shell)"]
        AgentOpenCode["OpenCode (PTY Shell)"]
        AgentGpt["GPT-OSS via aider (PTY Shell, Groq)"]
        AgentNemotron["Nemotron via aider (PTY Shell, OpenRouter)"]
    end

    subgraph Storage_Layer ["Local Persistence (~/.conduit)"]
        ProjectsJSON["project.json (per project: state & layout)"]
        AuditLogs["supervisor-log.jsonl (Audit Trail)"]
        WikiStore["Shared Content & Markdown Wiki"]
    end

    ElectronApp -->|IPC / HTTP| ExpressServer
    BrowserUI -->|REST / WebSocket| ExpressServer
    ExpressServer <-->|Internal WS / IPC| DaemonCore
    DaemonCore --> PTYManager
    DaemonCore -->|JSON-RPC over app-server| AgentCodex
    PTYManager -->|Spawns Pseudo-Terminals| AgentClaude
    PTYManager -->|Spawns Pseudo-Terminals| AgentGemini
    PTYManager -->|Spawns Pseudo-Terminals| AgentOpenCode
    PTYManager -->|Spawns Pseudo-Terminals| AgentGpt
    PTYManager -->|Spawns Pseudo-Terminals| AgentNemotron
    AgentClaude -->|Lifecycle HTTP Hooks| HookServer
    HookServer --> DaemonCore
    DaemonCore <--> Storage_Layer
    SupervisorWatcher -.->|Observe stdout| PTYManager
```

### Architectural Highlights:
1. **Daemon Survivability**: The daemon runs on `127.0.0.1:3210`. If the web server or Electron UI restarts, all agent sub-shells continue running without dropping state.
2. **Dual-Channel Protocol**: The frontend connects to the server via WebSocket for sub-10ms xterm.js streaming and state broadcasts, and uses REST for project CRUD and configuration.
3. **Zero External Dependencies**: All state is persisted locally in `~/.conduit` (JSON and JSONL), ensuring offline capability and zero third-party database overhead.

---

## 2. Process Lifecycle & Terminal Virtualization (PTY Engine)

Conduit virtualizes terminals using native C++ bindings (`node-pty`) connected via streaming WebSocket multiplexers to browser xterm.js instances.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Software Engineer
    participant WebUI as UI / Terminal.tsx (xterm.js)
    participant Hub as Web Server (:3200)
    participant Daemon as Daemon (:3210)
    participant PTY as node-pty Subprocess
    participant Shell as Agent CLI (Claude / Codex)

    Dev->>WebUI: Click "Start Agent" / Input Prompt
    WebUI->>Hub: POST /api/projects/:id/agents/:agentId/start
    Hub->>Daemon: WS Request: { type: "agent:start", agentId }
    Daemon->>PTY: spawn(shell, [args], { cwd, env })
    PTY->>Shell: Exec CLI with MCP and Hook flags
    Daemon-->>Hub: WS Broadcast: { type: "agent:status", status: "running" }
    Hub-->>WebUI: Status Indicator updates to green

    loop Real-time Output Streaming
        Shell->>PTY: stdout / stderr chunk
        PTY->>Daemon: onData(chunk)
        Daemon->>Daemon: Append to in-memory scrollback buffer (1MB)
        Daemon->>Hub: WS Message: { type: "agent:output", data: chunk }
        Hub->>WebUI: Direct WebSocket stream
        WebUI->>Dev: xterm.js renders terminal output
    end

    opt Late Client Reconnect
        WebUI->>Hub: WS Connect: attach to agentId
        Hub->>Daemon: Request replay
        Daemon-->>WebUI: Replay cached scrollback buffer
    end
```

### Key Technical Details:
- **Scrollback Replay Buffer**: The daemon retains an in-memory ring buffer of the last 1MB of terminal output per agent. Late reconnects or tab switches instantly replay the terminal state without waiting for a new process event.
- **PTY Environment Sanitization**: Each PTY shell is injected with custom `CONDUIT_PROJECT_ID`, `CONDUIT_AGENT_ID`, and session-scoped MCP configurations.

---

## 3. Human-in-the-Loop Safety Loop & Approval Gate

Conduit protects codebases from destructive autonomous actions through a dual-layer watchdog architecture combining **zero-latency regex pattern matching** with **Amazon Bedrock AI classification**.

```mermaid
flowchart TD
    Stdout["Agent Terminal stdout Stream"] --> Strip["Strip ANSI Codes & Escape Sequences"]
    Strip --> FastPath{"Fast-Path Pattern Matcher"}

    FastPath -->|Matches rm -rf, git push force, DROP TABLE| TriggerGate["Trigger Critical Approval Gate"]
    FastPath -->|Matches y/N prompts or confirm question| TriggerPromptGate["Trigger Interactive Prompt Gate"]
    FastPath -->|No high-risk pattern detected| BatchBuffer["Debounce Buffer: 10s Window"]

    BatchBuffer --> SlowPath["Supervisor: AWS Strands Agent"]
    SlowPath -.->|BedrockModel, first choice| Bedrock["Amazon Bedrock"]
    SlowPath -.->|AnthropicModel, when Bedrock cannot serve| Anthropic["Anthropic API"]
    SlowPath --> BedrockCheck{"Classify Output Stream"}

    BedrockCheck -->|Destructive Intent Detected| TriggerGate
    BedrockCheck -->|Blocker or Build Error| PostGroupChat["Post Warning in Universal Group Chat"]
    BedrockCheck -->|Normal Engineering Progress| UpdateTelemetry["Update Living Activity Telemetry"]

    TriggerGate --> PauseAgent["Send SIGSTOP / Freeze PTY Ingestion"]
    PauseAgent --> SurfaceModal["Surface Urgent Gate Modal in UI"]

    SurfaceModal --> Decision{"Human Decision"}
    Decision -->|Reject| KillCommand["Send Ctrl+C to Agent PTY"]
    Decision -->|Approve with Lease| ResumeLease["Inject --force-with-lease flag and Resume"]
    Decision -->|Standard Approve| ResumeAgent["Unfreeze PTY & Resume Execution"]

    KillCommand --> LogAudit["Write to ~/.conduit/supervisor-log.jsonl"]
    ResumeLease --> LogAudit
    ResumeAgent --> LogAudit
```

### Safety Engine Guarantees:
1. **Zero Execution Before Veto**: When a destructive pattern is detected, the daemon halts keystroke input to the PTY before the command executes.
2. **Audit Accountability**: All decisions, whether human-approved or human-rejected, are written immutably to `supervisor-log.jsonl` with timestamps and commit SHAs.

---

## 3a. The Supervisor, and which provider serves it

The Supervisor is a Strands agent: `Agent` + `tool()` from `@strands-agents/sdk`, with
`report_update` and `plan_action` as its tools plus four read-only ones. What changes
between providers is only the model object handed to it.

| `SUPERVISOR_PROVIDER` | Behaviour |
|---|---|
| `bedrock` | `BedrockModel` only |
| `anthropic` | `AnthropicModel` only |
| `auto` (default) | Bedrock first; Anthropic when Bedrock cannot serve the request |

Both run through the SDK, so losing a provider costs a provider rather than the
framework. That matters on a new AWS account, where Bedrock is capped near 10,000
tokens a day until the quota is raised — before this, the fallback called the Messages
API by hand and the SDK dropped out of the running system exactly when Bedrock was
unavailable.

`GET /api/health` reports `supervisorHealth`:

```json
{ "state": "ok", "provider": "bedrock", "model": "us.anthropic...", "strands": true }
```

`strands` is whether the last good classification actually went through the SDK.
"The Supervisor works" and "the Supervisor works as a Strands agent" are different
claims, and only one of them is the one this project makes.

Beneath both sits a hand-rolled Messages API call, used only if the optional
`@anthropic-ai/sdk` peer is missing at runtime or the SDK path fails outright.

## 4. MCP Inter-Agent Autonomous Communication

Agents running concurrently within a project communicate and discover each other peer-to-peer using the **Model Context Protocol (MCP)** specification.

```mermaid
sequenceDiagram
    autonumber
    participant AgentA as Agent Alpha (Frontend - Claude Code)
    participant LocalMCPA as Session MCP Server A (stdio)
    participant ConduitHub as Conduit Daemon / Hub (:3200)
    participant LocalMCPB as Session MCP Server B (stdio)
    participant AgentB as Agent Beta (Backend - Codex)

    AgentA->>LocalMCPA: Call MCP Tool: list_teammates()
    LocalMCPA->>ConduitHub: HTTP GET /api/projects/:id/teammates
    ConduitHub-->>LocalMCPA: 200 OK: [{ name: "Backend", cli: "codex", status: "running" }]
    LocalMCPA-->>AgentA: Return available teammates

    AgentA->>LocalMCPA: Call MCP Tool: message_agent(target="Backend", message="Token schema updated")
    LocalMCPA->>ConduitHub: HTTP POST /api/projects/:id/messages
    ConduitHub->>ConduitHub: Append to Project Group Chat & Activity Feed
    ConduitHub->>LocalMCPB: Route packet to Agent B session pipe
    LocalMCPB->>AgentB: Inject formatted teammate broadcast into terminal input
    AgentB-->>ConduitHub: Acknowledge receipt
    ConduitHub-->>AgentA: Message Delivered Confirmation
```

### MCP Infrastructure Details:
- **Session Isolation**: Each agent gets a dedicated JSON-RPC stdio server configured automatically in its working directory (`.claude.json` / `codex.json`).
- **No Shared Network Ports**: Agents communicate exclusively through Conduit's local IPC hub, eliminating rogue socket exposure.

---

## 5. Storage & State Persistence Architecture

Conduit operates as a local-first system with a deterministic filesystem layout under `~/.conduit/`.

```mermaid
graph TD
    subgraph RootDir ["~/.conduit/ (Root Storage Directory)"]
        ProjectsConfig["projects.json (Project Definitions, Window Layouts, Agent Configs)"]
        SupervisorAudit["supervisor-log.jsonl (Gate Audit Trail, Bedrock Telemetry Classifications)"]
        
        subgraph ProjectSubdirs ["projects/{projectId}/"]
            SharedContent["shared_content/ (Cross-agent specs, schema definitions, shared code)"]
            ProjectWiki["wiki/ (_index.md, Architecture markdown, living project docs)"]
            AgentLogs["logs/ (Session replay dumps, agent output logs)"]
        end
    end

    Engine["Conduit Storage Engine (storage.ts)"] --> ProjectsConfig
    Engine --> SupervisorAudit
    Engine --> SharedContent
    Engine --> ProjectWiki
    Engine --> AgentLogs
```

### State Storage Specifications:
| Entity | Location | Serialization | Concurrency Strategy |
| :--- | :--- | :--- | :--- |
| **Projects & Agents** | `~/.conduit/projects.json` | JSON | Atomic write via tempfile rename |
| **Audit Logs** | `~/.conduit/supervisor-log.jsonl` | Append-only JSONL | Synchronous stream append |
| **Project Wiki** | `~/.conduit/projects/:id/wiki/` | Markdown (`.md`) | File-system watch via `chokidar` |
| **Shared Content** | `~/.conduit/projects/:id/shared/` | Plain text / Code | Path-traversal sanitized filesystem API |

---

## 6. End-to-End Verification Matrix

| Subsystem | Test Command | Coverage Area | Status |
| :--- | :--- | :--- | :--- |
| **Safety Gates** | `npm test` | Regex fast path, ANSI stripping, destructive command traps | 19 / 19 Passed |
| **Core End-to-End** | `npm run smoke` | WebSocket hub, PTY dispatch, Project Wiki, MCP routing | 51 / 51 Passed |
| **Static Types** | `npm run typecheck` | Strict TypeScript across client, server, and daemon | 0 Errors |
| **Client Bundler** | `npm run build:client` | Production Vite minification & rollup chunking | 0 Errors |
| **Desktop Packaging** | `npm run build:desktop` | Electron packaging, Windows NSIS installer | Ready |
