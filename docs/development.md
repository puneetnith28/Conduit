# Development Guide

## Setup

```bash
npm install          # .npmrc sets legacy-peer-deps
npm run dev          # daemon + web + vite, http://localhost:5173
```

**Node 22+.** Node 20 runs the app but not the test suites, which execute TypeScript
directly via `--experimental-strip-types`.

`npm run dev` runs the built output with `--watch`, not the TypeScript — tsup rebuilds on
change. That is why a `.js` specifier in a `.ts` file works: tsup resolves it at bundle
time, even though `--experimental-strip-types` alone cannot.

## Layout

```
src/
  server.ts            Express + WS relay, auth, voice, health
  routes.ts            REST
  daemon/              the process owner — PTYs, status, watcher, Keeper
  strands/             the Supervisor: agent, tools, failure classification
  voice/               STT/TTS providers, Nova session, the approval guard
client/src/
  App.tsx              state owner
  components/          AgentGrid, Terminal, GroupChat, GateModal, …
scripts/               every check, as a plain Node script
```

More detail in [`ARCHITECTURE.md`](../ARCHITECTURE.md) and
[`CLAUDE.md`](../CLAUDE.md).

## The suites

No test framework. Each is a plain Node script that prints what it checked and exits
non-zero. Read them — they are the specification.

| Command | Checks | Needs |
|---|---|---|
| `npm test` | 292 unit checks | nothing |
| `npm run smoke` | 61 end-to-end | a running instance |
| `npm run check:ui` | every button, route, and write round-tripped | running + Chrome |
| `npm run browser-check` | real interaction, asserts no uncaught exceptions | running + Chrome |
| `npm run check:layout` | 11 surfaces × 4 widths: overflow, clipping, overlap, contrast | running + Chrome |
| `npm run check:org` | every daemon `/org/*` endpoint | running |
| `npm run check:lifecycle` | deleting a project mid-flight, restarting the daemon | running |
| `npm run check:abuse` | traversal, absurd input — no 5xx, no dropped connections | running |
| `npm run check:agents` | starts one of every CLI | running + the CLIs |
| `npm run check:multi` | four agents at once, gates, group chat, MCP | running + the CLIs |
| `npm run check:keeper` | the Keeper answers with working tools | running |
| `npm run check:voice-live` | the live voice path, end to end | AWS credentials |
| `npm run check:desktop` | 31 checks against the packaged app | a desktop build |
| `npm run check:bedrock` | which of the three Bedrock walls you are on | AWS credentials |

The unit checks are pure functions with no React import — that is deliberate, so they run
directly without a bundler.

## Other scripts

| Command | Does |
|---|---|
| `npm run seed:demo` | A project and one agent per **installed** CLI |
| `npm run demo:reset` | Reset a demo workspace, including clearing aider's chat history |
| `npm run icons` | Every favicon, the in-app mark and the desktop icon, from one source |
| `npm run architecture` | Re-render `architecture.png` from `scripts/architecture.html` |
| `npm run screenshots` | Regenerate the README images by driving the real UI |
| `npm run typecheck` | Both tsconfigs, no emit |

`npm run screenshots` seeds its own project, starts real agents, shoots each surface and
deletes what it made — so the README images cannot drift from what Conduit renders.

## Invariants

These are in [`CLAUDE.md`](../CLAUDE.md) because they are easy to break without noticing:

- **Gate resolution has one implementation** — `src/gate-resolve.ts`. The REST route and
  the voice path both call it. Two copies drift, and the half that drifts is the one
  answering a destructive prompt.
- **Approving by voice is enforced server-side** — `src/voice/approval-guard.ts`, never by
  telling the model to ask first. Do not add an approve action to `voiceRouting.ts` to
  match; that path has no such check.
- **Every route that mutates must broadcast.** `check:ui` asserts the round trip.
- **Never build a path from user input with `path.join`.** Use `storage.resolveInside`.
- **Everything rendered from model or agent text goes through `renderMarkdown`** (DOMPurify).
- **The Supervisor runs through Strands on every provider.** A fallback that bypasses the
  SDK means the framework is absent precisely when the primary provider is down.

## Adding a CLI

One edit to `src/cli-registry.ts`: the id, the binary, the install command, required env.
Then decide whether it is a PTY or something structured, and wire it in
`src/daemon/runtime.ts`. Everything else — preflight, status, gates, group chat — follows.

## Before a release

```bash
npm run build && npm test && npm run smoke
```

`npm run build` type-checks both sides first. Keep it green.
