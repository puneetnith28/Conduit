# Security & Authentication

Conduit runs coding agents with real shell access in directories you choose. That is the
product, not a flaw — but it means the threat model is worth stating plainly rather than
implying.

## What is protected

### `CONDUIT_AUTH`

```bash
export CONDUIT_AUTH=user:a-strong-password
```

Basic auth over **both** HTTP and the WebSocket upgrade. Credentials are compared with a
constant-time function, so a wrong password does not leak its length by timing.

**Required before the port is reachable by anyone but you.** The Docker compose file
refuses to start without it.

### Path containment

Filenames from a request never reach `path.join` directly. `storage.resolveInside`,
`sharedDirFor` and `wikiDirFor` resolve and then assert the result is still inside the
directory it should be. `npm run check:abuse` throws traversal attempts, absurd lengths and
malformed bodies at every route and asserts no 5xx and no dropped connections.

### Rendered output

Everything from a model or an agent goes through `renderMarkdown` — `marked` piped into
DOMPurify. Agent output is untrusted input that arrives at a browser, which is the shape of
an XSS bug if you let it be.

### Secrets never reach the client

`GET /api/voice/config` returns booleans, not keys. The AWS credentials for Nova stay in
Node; the browser talks to `/ws/voice` and never sees them. Voice provider keys live in
`~/.conduit/api-keys.json`, outside the repo.

---

## The safety loop

Covered fully in [`README.md`](../README.md#the-safety-loop). The short version:

1. **23 regexes**, in-process, no model call — a prompt waiting on a human, or a command
   expensive to undo. Instant, because a destructive command must not wait on a network
   round trip.
2. **The Supervisor**, batched — classifies and can raise a gate on anything risky.

A gate **freezes the agent** until you answer. The Supervisor's only write tool creates a
*proposal*; nothing reaches an agent without you.

---

## Approving by voice

This is the one place a mishearing could start something destructive, so it is worth
understanding exactly.

**Rejecting out loud always works.** Stopping something is always safe, so there is no
check on it at all.

**Approving depends on which voice path you are on.**

### The pipeline path (browser or Whisper transcription — the default)

Cannot approve. Not "disabled" — **absent**. There is no approve action in the router's
type (`client/src/utils/voiceRouting.ts`), so no transcript can produce one, and the unit
tests assert it. Saying "approve" produces a spoken refusal:

> *"I can't approve that by voice. Approve it on screen, or say reject."*

This path sees one sentence with no memory of what was read out, so there is nothing it
could meaningfully check.

### The live path (Nova Sonic)

Can approve, because it has the context to make it survivable. Enforced on the server in
`src/voice/approval-guard.ts` — **never** by telling the model to be careful. All four must
hold:

| # | Condition |
|---|---|
| 1 | `describe_gate` was called for this exact gate id, and the command was played as audio |
| 2 | That was under 60 seconds ago |
| 3 | Your own recorded speech since then contains "approve", un-negated — **a bare "yes" is not enough** |
| 4 | The gate is still open, with its text unchanged |

The confirmation is read from the transcript stream, so the model cannot supply its own.
Every voice approval writes the authorising words verbatim to `audit.jsonl`.

Say "yes" and you hear:

> *"Say 'approve it' out loud and I will. A yes on its own is not enough for this."*

`scripts/test-approval-guard.mjs` spends most of its 38 checks on the refusals, not the
approvals.

---

## What is deliberately **not** protected

### The daemon's `/org/*` API is unauthenticated on loopback

Any local process — **including an agent Conduit is running** — can drive any agent through
`http://127.0.0.1:3210/org/*`, bypassing gates and plan approval.

That is a deliberate trade for a single-user local tool, and it is the wrong trade on a
shared machine. `CONDUIT_AUTH` covers the web server on `:3200`; it does not cover this.

If you put Conduit on a machine other people can log into, or run agents you do not trust,
this is the thing to fix first.

### Agents can do anything you can

An agent's working directory is a real directory and its terminal is a real shell. The gates
catch *patterns* — they are a seatbelt, not a sandbox. Run agents in a scratch repo when you
are trying something out, which is why `npm run demo:reset` exists.

### There is no multi-user model

No accounts, no roles, no per-project permissions. `CONDUIT_AUTH` is one shared credential.
Conduit assumes one human.

---

## Deploying it somewhere public

Don't, unless you have read the above and accepted it. If you must:

- `CONDUIT_AUTH` with a strong password, given only to the people who need it
- Port **3200 open to addresses you trust**, port **3210 closed**
- TLS in front — Basic auth over plain HTTP sends the password in every request
- An IAM role scoped to `InvokeModel` on exactly the model in `BEDROCK_MODEL_ID`
- Throwaway API keys with spend caps, not your own
- Terminate the instance when you are done with it

See [Deployment](deployment.md).

## Reporting something

Open an issue. If it is exploitable, say so without a working exploit in the title.
