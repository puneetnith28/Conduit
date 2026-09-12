# Testing Conduit

Written for hackathon judges and anyone evaluating this without wanting to set up six
coding CLIs first.

**There are three ways in, from zero effort to full power.** Start at Level 1. Each level
takes longer and shows more. You do not need Level 3 to judge whether this works.

| Level | Effort | What you see | Needs |
|---|---|---|---|
| **1. Scripted walkthrough** | 0 min | The whole workflow, including an approval gate, as an animation | A browser |
| **2. Run it locally** | ~10 min | The real UI, real terminals, real agents | Node 22+, one CLI, one API key |
| **3. Docker** | ~15 min | Everything, isolated from your machine | Docker |

---

## Level 1 — See it work without installing anything

Open the live demo link in the submission and **stay on the landing page**.

Scroll to the animated walkthrough. It plays a real four-step workflow end to end:
Claude refactors auth, Codex writes tests, Gemini audits the API, and then Claude attempts
a force-push — **and gets stopped by an approval gate** that waits for a human.

That is the core idea of the project in about a minute, with nothing installed. If you only
have a few minutes, this is the part to watch.

Click **Open Console** to see the real interface behind it.

---

## Level 2 — Run it locally

### What you need

- **Node.js 22 or newer** (`node --version`). Node 20 runs the app fine, but the unit
  suites use `--experimental-strip-types` to execute TypeScript directly, which only
  exists from 22.6 — on 20 they fail to start.
- **git**
- **At least one agent CLI.** You do not need all six. Claude Code is the best single
  choice because it reports the most detail:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```
- **One key for the Supervisor**, so the watching half works. Either:
  - `ANTHROPIC_API_KEY`, **or**
  - being logged into Claude Code (above) — Conduit reuses that token

### Install and run

```bash
git clone <repo-url>
cd Conduit
npm install
npm run build
npm run start:all
```

Open **http://localhost:3200**.

> `npm install` uses `legacy-peer-deps` (set in `.npmrc`). Strands wants Express 5;
> this project is on Express 4. That is expected, not a broken install.

### Give yourself something to look at

A fresh install has no projects, so the console starts empty. Seed one:

```bash
npm run seed:demo
```

That creates a **Demo** project, a scratch workspace with a README in it, and one agent of
each of the six types. It does **not** start them — starting spends your API budget, so
that is your call.

Then open http://localhost:3200/#console and press **Start** on the Claude agent.

> Agents are created without checking whether their CLI is installed — that check happens
> when you press Start, which then tells you the exact command to install it. So seeing all
> six listed is normal even if you only installed one.

### Five minutes that show the point

1. **Type into a terminal.** It is a real shell. Take over at any time.
2. **Ask an agent to do something** — "read README.md and summarise it".
3. **Trigger a gate.** In the agent's terminal, ask it to run `rm -rf ./build`.
   It stops and asks. That is the whole idea: the agent is *frozen*, not merely reported.
   Approve, reject, or answer in your own words.
4. **Watch Group Chat.** The Supervisor's summaries land there, labelled by what kind of
   thing happened.
5. **Check the Supervisor is real:**
   ```bash
   curl http://localhost:3200/api/health
   ```
   Look at `supervisorHealth`. `"strands": true` means the last classification ran through
   the AWS Strands Agents SDK. `provider` says whether Bedrock or Anthropic served it.

### Optional extras

| Want | Add |
|---|---|
| The two hosted models (`gpt`, `nemotron`) | `uv tool install --python 3.12 aider-chat`, plus `GROQ_API_KEY` / `OPENROUTER_API_KEY` |
| Codex agents | `npm install -g @openai/codex && codex login` |
| Gemini agents | `npm install -g @google/gemini-cli` |
| Supervisor on Bedrock instead of Anthropic | AWS credentials + the policy in `docs/bedrock-iam-policy.json`. Verify with `npm run check:bedrock` |
| Voice | Open Settings → Voice. Groq Whisper is the recommended engine (`GROQ_API_KEY`) |

Put keys in a `.env` file at the repo root, or in `~/.conduit/.env`.

---

## Level 3 — Docker

Nothing touches your machine except Docker, and the image already contains all six CLIs
plus `aider`.

```bash
export CONDUIT_AUTH=admin:pick-a-password      # required by the compose file
docker compose up -d --build
```

Open **http://localhost:3200** and sign in with what you set above.

The agents still need to be logged in. Either mount your existing logins (the compose file
already does this for `~/.claude`, `~/.codex`, `~/.gemini`), or log in inside the container:

```bash
docker compose exec conduit claude login
```

Seed a project:

```bash
docker compose exec conduit node scripts/seed-demo.mjs
```

Your own code goes in `./workspace`, which is mounted at `/workspace` inside the container.
**Project paths must point at `/workspace/...`, not at a host path** — the container cannot
see your host filesystem otherwise.

Logs and teardown:

```bash
docker compose logs -f conduit
docker compose down          # add -v to delete Conduit's data too
```

---

## Verifying it rather than taking our word for it

Every claim in the README has a script behind it. With Conduit running:

```bash
npm test                 # 292 unit checks, no network (needs Node 22+)
npm run smoke            # 61 end-to-end checks against the running instance
npm run check:ui         # every button, every REST route, every write round-tripped
npm run check:layout     # 11 pages x 4 widths: overflow, clipping, overlap, contrast
npm run browser-check    # real Chromium, asserts no uncaught exceptions
npm run check:agents     # starts one agent of every type
npm run check:lifecycle  # delete a project mid-flight, restart the daemon, etc.
```

They print what they checked and exit non-zero on failure. There is no test framework —
they are plain Node scripts you can read.

---

## Known limits, stated up front

- **The daemon's `/org/*` endpoints are unauthenticated on loopback.** Any local process
  can drive any agent through them, bypassing gates. That is a deliberate trade for a
  single-user local tool, and the wrong one on a shared machine. `CONDUIT_AUTH` covers the
  web server, not this.
- **Only Claude and Codex report fine-grained status.** The others report whether the
  process is alive. The UI does not pretend otherwise.
- **The Supervisor may run on Anthropic rather than Bedrock.** Both go through the Strands
  SDK — `supervisorHealth.strands` tells you it did. A new AWS account is capped near
  10,000 Bedrock tokens/day until the quota is raised, which is why the fallback exists.
- **Browser speech recognition does not work in the desktop app.** Electron ships no keys
  for the Google service Chromium proxies it to. Use Groq Whisper.

---

## If something does not work

| Symptom | Cause |
|---|---|
| `port 3200 is already in use` | Conduit is already running. Stop it, or set `PORT`. |
| Console is empty | Nothing is seeded. Run `npm run seed:demo`. |
| Agent refuses to start | Its CLI is not installed. The error names the command that installs it. |
| Group Chat stays empty | The Supervisor has no credential. Check `supervisorHealth` in `/api/health`. |
| `ThrottlingException: Too many tokens per day` | A new AWS account's Bedrock quota. Conduit falls back to Anthropic automatically. |
| Everything is slow to first response | Claude Code's first turn includes an MCP handshake (~13s). Later turns are 3–5s. |
| `npm test` exits immediately with a flag error | Node is older than 22.6. The app still runs; the suites do not. |

Questions about a specific behaviour: the README explains the reasoning, and
`CLAUDE.md` documents the invariants that must not be broken.
