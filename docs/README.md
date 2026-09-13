# Conduit documentation

Nine documents. The first four explain how it works, the next two are reference,
the last three are how to run it.

| # | Document | What it covers |
|---|---|---|
| 1 | [Architecture & Topology](../ARCHITECTURE.md) | The two processes, who owns what, the sequence diagrams, and why restarting the web server does not kill your agents |
| 2 | [Agent Runtime](agent-runtime.md) | The six CLIs, how each is spawned, and where their status comes from |
| 3 | [Data Model & State Machines](data-model.md) | Every type on disk, the agent status machine, and the gate and plan lifecycles |
| 4 | [Security & Authentication](security.md) | `CONDUIT_AUTH`, the approval gates, the four conditions on approving by voice, and what is deliberately not protected |
| 5 | [UI & Design System](ui.md) | The seven tabs, five terminal layouts, colour tokens, and how layout is measured rather than eyeballed |
| 6 | [API Reference](api.md) | Every REST route, every WebSocket event, and the daemon's `/org/*` API |
| 7 | [Deployment Guide](deployment.md) | Local, Docker, EC2 and the static landing page — and what cannot be deployed where |
| 8 | [Development Guide](development.md) | Scripts, the test suites, and the invariants that are easy to break |
| 9 | [Environment Configuration](environment.md) | Every variable Conduit reads, which are required, and where the files live |

## Start here instead

- **Evaluating or judging this?** → [`TESTING.md`](../TESTING.md) — three levels, from
  "watch it work in a browser with nothing installed" to full Docker.
- **Just want to know what it is?** → [`README.md`](../README.md).
- **Working on the code?** → [`CLAUDE.md`](../CLAUDE.md) has the invariants that must not
  be broken by accident.

Nothing here repeats the README. Where a topic is already covered well there, these pages
link to it rather than restate it.
