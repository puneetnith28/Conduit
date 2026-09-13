# Data Model & State Machines

Everything is plain JSON and JSONL under `~/.conduit`. No database, no migrations. You can
read the whole state of a project with `cat`, which is the point — when something is wrong,
you can see it.

## On disk

```
~/.conduit/
├── .env                         the only config the desktop app sees
├── api-keys.json                voice provider keys
├── supervisor-log.jsonl         every classification, across all projects
├── brain-private/               the Keeper's own state, deliberately outside any cwd
│   ├── state.json
│   └── codex-home/
├── shared_content/<project>/    the folder agents pass files through
├── wiki/<project>/              long-term project memory
└── projects/<id>/
    ├── project.json             the project, its agents, and pending plans
    ├── groupchat.jsonl          one line per message
    └── audit.jsonl              one line per decision you made
```

`brain-private` is outside any project working directory on purpose. It used to live in the
Keeper's cwd, where the Keeper would grep its own history and answer questions about
projects you had deleted.

## Types

From `src/types.ts`.

```ts
Project {
  id: string;
  name: string;        // also the folder name under shared_content/ and wiki/
  description?: string;
  cwd: string;         // where the agents actually run
  createdAt: string;
}
```

Renaming a project **moves those folders**. That is why rename is a real operation and not
a label change.

```ts
Agent {
  id: string;
  projectId: string;
  name: string;
  role?: string;       // free text, shown as a chip
  cli: CliId;          // claude | codex | gemini | opencode | gpt | nemotron
  cwd: string;
  status: AgentStatus; // derived live, never written by hand
  pid?: number;
  codexThreadId?: string;
  flags?: string[];
  pendingGate?: Gate;
}
```

```ts
Plan {
  id: string;
  projectId: string;
  description: string;
  targetAgent: string;
  targetProject: string;
  proposedMessage: string;   // the exact text that would be sent
  createdAt: string;
}
```

Pending plans live in `project.json`. Decisions go to `audit.jsonl` and the plan is removed.

```ts
GroupChatEntry {
  id: string;
  ts: string;
  role: 'user' | 'supervisor' | 'agent';
  sender: string;
  text: string;
  classification?: 'progress' | 'blocker' | 'question' | 'risky_action';
}
```

---

## The agent status machine

```
            start ──────► running ──────► awaiting_input ──► idle
              ▲              │                   │            │
              │              │                   └────────────┘
              │              ▼                   (a message sent here
            stopped ◄─── stop / exit              puts it back to running)
```

| Status | Means |
|---|---|
| `running` | Actively working |
| `awaiting_input` | Finished a turn, or asked something — needs you |
| `idle` | `awaiting_input` for a while with no attention |
| `stopped` | Not running |

**`awaiting_input` and `idle` are ready states, not stuck states.** They are exactly when
you, the Keeper, or an approved plan sends the next instruction. Only a `pendingGate` means
the agent is waiting on a specific answer.

Where each status comes from:

| CLI | Source |
|---|---|
| Claude Code | Lifecycle hooks — Conduit passes `--settings` pointing at its own hook server |
| Codex | `codex app-server` events |
| Gemini, OpenCode, GPT-OSS, Nemotron | Process liveness only |

The four on the bottom row report `running` or `stopped` and nothing between. The UI does
not smooth that over — a dot that claims to know more than it does is worse than one that
admits it.

---

## The gate lifecycle

```
agent prints something
        │
        ├─ regex match ──────────────────► gate raised (source: "regex")
        │                                        │
        └─ Supervisor says risky_action ──► gate raised (source: "supervisor")
                                                 │
                                    agent is FROZEN, pendingGate set
                                                 │
                    ┌────────────────────────────┼────────────────────────────┐
                    ▼                            ▼                            ▼
                 approve                      reject                       custom
          keystrokes typed in        Escape, then "stop"          your own text typed in
                    │                            │                            │
                    └────────────────────────────┴────────────────────────────┘
                                                 │
                            pendingGate cleared, gate:resolved broadcast,
                                   decision appended to audit.jsonl
```

Two things are true of every path:

- Resolution has **one implementation** (`src/gate-resolve.ts`). The REST route and the
  voice path both call it. Two copies would drift, and the half that drifts is the one
  answering a destructive prompt.
- Approving and rejecting are **equally one click**. A safety valve that is tedious to
  refuse gets approved by reflex.

While a gate is open, `/org/inject` and `/org/broadcast` return 400. A message delivered
then would be typed in as the answer to that prompt.

---

## The plan lifecycle

```
Supervisor wants an agent to do something
        │
        └─ plan_action ──► Plan created, shown to you with the exact message
                                │
                   ┌────────────┴────────────┐
                   ▼                         ▼
                approve                   reject
        message sent to the agent    nothing sent, reason recorded
                   │                         │
                   └────────────┬────────────┘
                                ▼
                  removed from project.json,
                   appended to audit.jsonl
```

`plan_action` is the Supervisor's **only** write tool. It cannot reach an agent any other
way. Rejected plans are included in the context of later turns, so it does not re-propose
something you already refused unless the situation changed.

---

## Concurrency

`project.json` is written by two processes. `mutateProjectData` takes a lock with
`fs.openSync(file, 'wx')` — atomic create, fails if it exists — around read-modify-write.

`scripts/test-storage-concurrency.mjs` runs two processes doing 150 writes each and asserts
the file is valid JSON at every read, never observed empty, and loses under 1% of writes.
Measured: **0 lost out of 300**.

The lock does **not** call `ensureDir`. It did once, and that recreated the directory of a
project you had just deleted — resurrecting it on the next write.
