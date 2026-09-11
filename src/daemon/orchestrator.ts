/**
 * The Keeper — Conduit's orchestrator brain.
 *
 * A long-lived conversational agent hosted inside the daemon. The user talks
 * to it from the Command panel; it inspects the conduit through the Conduit
 * Orchestrator MCP and reports back.
 *
 * Runtime: **Codex or Claude Code**, whichever is on PATH
 * (`CONDUIT_KEEPER_ENGINE` pins one). Codex runs a `codex exec` per turn.
 * Claude Code holds one process open for the whole conversation and streams
 * turns into it — spawning per turn cost ~15s of start-up and MCP handshake
 * before any thinking began.
 *
 * The brain keeps **multiple conversations** (like chat threads); each has its
 * own thread/session. All of them persist to ~/.conduit/brain/state.json and
 * survive daemon restarts.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type { BrainEngine, BrainEvent, BrainMessage, BrainState, BrainStatus } from './protocol.js';
import { findOnPath } from '../cli-registry.js';
import * as storage from '../storage.js';
import { DAEMON_HTTP_URL } from './protocol.js';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

/** Cap each conversation's transcript so state.json stays small. */
const MAX_HISTORY = 240;
/** Cap how many conversations are kept (oldest dropped beyond this). */
const MAX_CONVERSATIONS = 50;

const BRAIN_DIR = path.join(os.homedir(), '.conduit', 'brain');
const CODEX_HOME = path.join(BRAIN_DIR, 'codex-home');
const STATE_PATH = path.join(BRAIN_DIR, 'state.json');
const AGENTS_MD_PATH = path.join(BRAIN_DIR, 'AGENTS.md');

/**
 * Appended to every turn's input. Codex bakes AGENTS.md in at conversation
 * creation — `exec resume` does NOT re-read it — so a rule that must apply to
 * existing conversations has to ride on the turn itself.
 */
/**
 * What exists right now, restated on every turn.
 *
 * The Keeper keeps one long conversation and resumes it across turns, so a
 * project it listed an hour ago is still sitting in its transcript after the
 * project is deleted — and it goes on offering the agents that used to be in
 * it. Its tools would tell it the truth, but nothing makes it ask before it
 * assumes, and a model rarely re-checks something it believes it already knows.
 *
 * So the truth rides on the turn, the same way the spoken-summary rule does.
 * It is deliberately terse: names and statuses, no ids, no paths. A conduit
 * with five projects and twenty agents costs a few hundred characters, which
 * is far less than one wrong suggestion costs the person reading it.
 */
function currentRoster(): string {
  let projects;
  try {
    projects = storage.listProjects();
  } catch {
    return '';   // storage unreadable — better to say nothing than to guess
  }

  if (!projects.length) {
    return '\n\n---\n[Current state] There are no projects. Anything you '
      + 'remember from earlier in this conversation has been deleted.';
  }

  const lines = projects.map((proj) => {
    let agents: ReturnType<typeof storage.listAgents> = [];
    try { agents = storage.listAgents(proj.id); } catch { /* keep empty */ }
    const who = agents.length
      ? agents.map((a) => `${a.name} (${a.cli})`).join(', ')
      : 'no agents';
    return `- ${proj.name}: ${who}`;
  });

  return '\n\n---\n[Current state] These are the only projects and agents that '
    + 'exist right now:\n' + lines.join('\n')
    + '\nAnything else you remember from earlier in this conversation has been '
    + 'deleted. Never offer, reference, or send work to a project or agent that '
    + 'is not on this list.';
}

const TURN_SUFFIX =
  '\n\n---\n[System reminder] You are being heard, not read. Talk like a ' +
  'colleague standing next to the user: short, direct, no preamble.\n' +
  '(1) Do NOT narrate routine tool calls. Say one short line first only when ' +
  'a step will genuinely take a while (asking an agent, starting one) — ' +
  'e.g. "Asking Claude now." Otherwise go straight to the answer.\n' +
  '(2) End with a line starting with 🔊 — ONE short sentence, about 15 to 25 ' +
  'words. Add a second sentence only if the user has to decide something. ' +
  'Never repeat what you already wrote above it.\n' +
  'Write both in the language the user is speaking to you in. Plain speech, ' +
  'no markdown, no file paths, no lists.';

/** The brain's persona + operating rules — loaded by Codex as AGENTS.md. */
const AGENTS_MD = `# The Keeper — Conduit Orchestrator Brain

You are **The Keeper**, the orchestrator brain of Conduit — a command center
for a team of coding CLI agents. The user talks to you in plain language; you
inspect the conduit and report back. Act like a sharp chief-of-staff: concise,
accurate, and proactive about what needs the user's attention.

## Your tools (MCP server \`conduit\`)

- \`list_projects\` — every project and its agents, with live status.
- \`list_agents\` — the agents of one project, in detail.
- \`get_agent_status\` — the live status of one agent.
- \`get_project_overview\` — read a project's wiki overview to learn what it does.
- \`read_wiki\` — read a project's wiki pages (its knowledge base).
- \`read_shared\` — read a project's shared content files.
- \`create_project\` — create a new project/team (needs a name + working directory).
- \`create_agent\` — add an agent to a project (claude / codex / gemini / opencode / gpt / nemotron).
- \`start_agent\` — start a stopped agent (it resumes its previous session).
- \`stop_agent\` — stop a running agent (its session is kept; start_agent resumes it).
- \`ask_agent\` — send a question or instruction to one agent and get its reply.
- \`broadcast\` — ask every running agent at once (optionally scoped to a project).

## How to work

1. Use the tools — never guess. Start with \`list_projects\` to see the teams.
   \`get_project_overview\` tells you what a project is about without bothering
   an agent; \`broadcast\` collects status from every running agent in one shot.
2. To get something from an agent, call \`ask_agent(project, agent, message)\`.
   It delivers your message into that agent's live session and returns its reply.
   **When several agents are involved, act on them together, not one after
   another.** Asking the same thing of everyone is one \`broadcast\` call, which
   fans out in parallel. For different instructions to different agents, issue
   those \`ask_agent\` calls in the same step rather than waiting for each reply
   before starting the next — agents run independently and a serial round trip
   makes the user wait for the sum of them.
3. **A stopped agent is never a dead end.** If an agent you need is stopped,
   you MUST call \`start_agent\` on it and then \`ask_agent\` — in the same turn.
   \`start_agent\` boots it and resumes its previous session, so it keeps its
   prior context. Starting agents is safe and pre-approved: never ask the user
   for permission first, and never answer with just "the agent is stopped".
   If you started an agent only to check on it, offer to \`stop_agent\` it
   again afterwards so the conduit isn't left cluttered with processes the user
   didn't intend to keep running.
4. To set up a new team, use \`create_project\` — it needs a working directory,
   so if the user didn't give one, ask. To add a team member, use
   \`create_agent\` (then \`start_agent\` it if they want it running). These
   create lasting structure — confirm the name, directory, and CLI with the
   user if anything is unclear.
5. **Keep project wikis current — by delegation, not by hand.** A project's
   wiki is its living memory, and the project's own agents own it: they have
   first-hand knowledge and are already instructed to update their wiki when
   asked. To record progress, decisions, or architecture, \`ask_agent\` the
   relevant agent to update its own wiki. Never author a project wiki yourself
   — your information is second-hand.
6. Synthesize. Don't dump raw tool output — answer the question that was
   asked. Surface a blocker only when there is one.
7. **Be brief.** Most answers are one line. The user is listening, not
   reading, and the details are already on screen. Specifically:
   - No preamble. Never open with "I'll take a look" or "Sure, let me".
   - Don't restate the question before answering it.
   - Don't offer follow-up work unless the user asked what to do next.
   - A list only when the user asked for a list.
8. **End every reply with a spoken line starting with 🔊** — ONE sentence,
   roughly 15 to 25 words, in the language the user is speaking. It is read
   aloud, so plain speech: no markdown, no file paths, no lists. Add a second
   sentence only when the user must decide something. Do not repeat the text
   above it — this replaces it out loud, it does not summarise it.

   Good: \`🔊 Three agents, all stopped.\`
   Good: \`🔊 Claude finished the auth fix and is waiting — do you want it to
   run the tests?\`
   Bad:  \`🔊 There is a single project called ewdsf3se with three agents in
   it. They are named gere on Claude, cdlcnkdc on GPT, and dsdcwae on
   Nemotron, and all three are currently stopped. Just say the word and I
   will start any of them up and put them to work.\`

## Boundaries (Phase 1)

- You are **advisory**. Inspecting agents, starting and stopping them, asking
  them questions, and creating projects/agents **when the user asks** are all safe.
- Never create a project or agent the user didn't ask for.
- Relay an instruction that changes code or deploys only when the user
  explicitly asks. Do not invent work on your own.
- Do not run shell commands. Use only the \`conduit\` tools.
- Never pretend you reached an agent you didn't.
`;

/** One brain conversation — its own Codex thread and transcript. */
interface Conversation {
  id: string;
  title: string;
  threadId: string | null;
  messages: BrainMessage[];
  createdAt: string;
  updatedAt: string;
}

interface PersistedState {
  conversations: Conversation[];
  currentId: string;
}

/** TOML basic-string literal with proper escaping (Windows paths included). */
function tomlStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** cmd.exe-safe quoting — only needed when spawning with `shell: true`. */
/**
 * Absolute path to the Keeper's MCP server entry.
 *
 * This was hardcoded to `conduit-mcp-server.js`, but tsup emits ESM as
 * `.mjs` — so the file never existed, the MCP server failed to start, and the
 * Keeper ran with **no tools at all**. It would then answer questions about
 * projects and agents from nothing, which reads as the model being unhelpful
 * rather than as a broken path. Probe instead, and say so if it is missing.
 */
function findConduitMcpServer(): string {
  const candidates = [
    path.resolve(__dirname_, '..', 'conduit-mcp-server.mjs'),
    path.resolve(__dirname_, 'conduit-mcp-server.mjs'),
    path.resolve(__dirname_, '..', 'conduit-mcp-server.js'),
    path.resolve(__dirname_, 'conduit-mcp-server.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  console.warn(
    `[orchestrator] Conduit MCP server not found (looked in ${path.dirname(candidates[0])}). `
    + 'The Keeper will have no tools — run `npm run build`.',
  );
  return candidates[0];
}

/** One long-lived Claude Code process serving a conversation's turns. */
interface ClaudeSession {
  child: ReturnType<typeof spawn>;
  convId: string;
  stdoutBuf: string;
  stderrBuf: string;
  producedAssistant: boolean;
  onTurnEnd: ((ok: boolean, detail: string) => void) | null;
}

/** A single turn should never outlast this. */
const CLAUDE_TURN_TIMEOUT_MS = 5 * 60 * 1000;

function winQuote(arg: string): string {
  if (arg === '') return '""';
  if (!/[ \t"&|<>()^%]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

export class Orchestrator {
  private conversations: Conversation[] = [];
  private currentId = '';
  private status: BrainStatus = 'idle';
  private busy = false;
  /** The child for the in-flight turn, so abortTurn() can kill it. */
  private currentChild: ReturnType<typeof spawn> | null = null;
  /** Long-lived Claude Code process, reused across turns of one conversation. */
  private claudeSession: ClaudeSession | null = null;
  /** True between an abortTurn() call and the next send() — keeps repeated
   *  Stop presses from spamming "Cancelled by user" messages. */
  private aborting = false;

  private readonly conduitMcpPath = findConduitMcpServer();

  constructor(private readonly emit: (ev: BrainEvent) => void) {
    this.load();
  }

  // ─────────────────────────── Public API ───────────────────────────

  getState(): BrainState {
    const cur = this.current();
    return {
      messages: cur.messages,
      status: this.status,
      engine: this.engine(),
      currentId: this.currentId,
      conversations: [...this.conversations]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          messageCount: c.messages.length,
        })),
    };
  }

  /** Start a fresh conversation (keeps the existing ones). */
  newConversation(): void {
    const conv = this.makeConversation();
    this.conversations.push(conv);
    this.trimConversations();
    this.currentId = conv.id;
    this.save();
    this.emitState();
  }

  /** Switch the active conversation. */
  switchConversation(id: string): void {
    if (id === this.currentId) return;
    if (!this.conversations.some((c) => c.id === id)) return;
    this.currentId = id;
    this.save();
    this.emitState();
  }

  /** Delete a conversation. Always keeps at least one. */
  deleteConversation(id: string): void {
    const idx = this.conversations.findIndex((c) => c.id === id);
    if (idx < 0) return;
    this.conversations.splice(idx, 1);
    if (this.conversations.length === 0) {
      this.conversations.push(this.makeConversation());
    }
    if (this.currentId === id) {
      this.currentId = [...this.conversations]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id;
    }
    this.save();
    this.emitState();
  }

  /** Run one brain turn for a user message. */
  async send(message: string): Promise<void> {
    const text = message.trim();
    if (!text) return;

    // The turn targets whichever conversation is current right now; capture it
    // so a mid-turn switch doesn't misroute the streamed messages.
    const conv = this.current();

    if (this.busy) {
      this.append(conv, {
        role: 'system',
        text: 'The Keeper is still working on the previous request — one moment.',
      });
      return;
    }

    this.busy = true;
    this.aborting = false;
    if (conv.messages.length === 0) conv.title = makeTitle(text);
    this.append(conv, { role: 'user', text });
    this.setStatus('thinking');

    try {
      await this.runTurn(conv, text);
    } catch (err) {
      this.append(conv, {
        role: 'error',
        text: 'Brain turn failed: ' + (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      this.busy = false;
      this.setStatus('idle');
      this.save();
      this.emitState(); // refresh the conversation list (title / updatedAt / count)
    }
  }

  /**
   * Cancel the in-flight Keeper turn. Kills the running codex child; its
   * `close` handler then resolves runCodexTurn, send()'s finally block runs,
   * busy clears, status flips back to idle. A system marker is appended so
   * the conversation shows what happened.
   */
  abortTurn(): boolean {
    const child = this.currentChild;
    console.log('[orchestrator] abortTurn called — busy:', this.busy, 'child pid:', child?.pid ?? null);
    if (!child || !this.busy) {
      console.log('[orchestrator] abortTurn: nothing to kill (no child or not busy)');
      return false;
    }
    // Don't null currentChild here — let the child's 'close' handler clear
    // it when the process actually dies. That way a second Stop press can
    // retry the kill if the first attempt missed (e.g. taskkill raced).

    if (process.platform === 'win32' && child.pid) {
      // shell: true → child IS cmd.exe, with codex spawned underneath it.
      // child.kill() would only kill cmd.exe and orphan codex (which keeps
      // running until it finishes its task). taskkill /T /F kills the whole
      // tree in one shot — that's the only thing that actually works here.
      try {
        const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        tk.on('exit', (code) => console.log('[orchestrator] taskkill exited with code', code));
        tk.on('error', (err) => console.warn('[orchestrator] taskkill spawn failed:', err));
      } catch (err) { console.warn('[orchestrator] taskkill spawn threw:', err); }
    } else {
      // Non-Windows: shell: false → child IS codex. SIGTERM works.
      try { child.kill(); console.log('[orchestrator] child.kill() called on pid', child.pid); }
      catch (err) { console.warn('[orchestrator] child.kill() threw:', err); }
    }

    if (!this.aborting) {
      this.aborting = true;
      this.append(this.current(), {
        role: 'system',
        text: 'Cancelled by user — the Keeper stopped mid-turn.',
      });
    }
    return true;
  }

  // ─────────────────────────── engine choice ───────────────────────────

  /**
   * Which CLI backs the Keeper.
   *
   * Codex remains the default. Claude Code is a first-class alternative
   * because it needs neither an OpenAI subscription nor API credits when the
   * user is already signed in to Claude — and `codex` not being installed is
   * otherwise a hard stop for the whole Command panel.
   */
  private engine(): BrainEngine {
    const v = (process.env.CONDUIT_KEEPER_ENGINE || '').trim().toLowerCase();
    if (v === 'claude') return 'claude';
    if (v === 'codex') return 'codex';
    // Auto: prefer Codex when it is actually usable, else fall back to Claude
    // rather than failing every turn.
    if (findOnPath('codex')) return 'codex';
    if (findOnPath('claude')) return 'claude';
    return 'codex';
  }

  private runTurn(conv: Conversation, prompt: string): Promise<void> {
    return this.engine() === 'claude'
      ? this.runClaudeTurn(conv, prompt)
      : this.runCodexTurn(conv, prompt);
  }

  // ─────────────────────────── Claude turn ───────────────────────────

  /**
   * One Keeper turn on Claude Code.
   *
   * Mirrors the Codex path exactly: a non-interactive run, NDJSON events on
   * stdout, session continuity across turns, the Conduit MCP toolset, and the
   * Keeper persona. `bypassPermissions` is the counterpart of Codex's
   * `--dangerously-bypass-approvals-and-sandbox` and is safe for the same
   * reason — the Keeper's only capability is the Conduit MCP tools, and real
   * write actions still go through sandboxed agents behind approval gates.
   */
  private runClaudeTurn(conv: Conversation, prompt: string): Promise<void> {
    this.ensureBrainEnv();
    const sess = this.ensureClaudeSession(conv);
    if (!sess) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        sess.onTurnEnd = null;
        sess.producedAssistant = false;
        resolve();
      };

      sess.onTurnEnd = (ok, detail) => {
        if (!ok) {
          this.append(conv, {
            role: 'error',
            text: detail || 'The Keeper turn ended without an answer.',
          });
        }
        finish();
      };

      // A turn that never returns must not wedge the Keeper forever.
      const guard = setTimeout(() => {
        if (settled) return;
        this.append(conv, { role: 'error', text: 'The Keeper timed out. Ask again.' });
        this.killClaudeSession();
        finish();
      }, CLAUDE_TURN_TIMEOUT_MS);

      const done = () => clearTimeout(guard);
      const originalResolve = resolve;
      resolve = ((v?: unknown) => { done(); originalResolve(v as void); }) as typeof resolve;

      try {
        // The spoken-summary rule rides on every turn — the persona file is
        // only read at session start.
        sess.child.stdin?.write(JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: prompt + TURN_SUFFIX + currentRoster() }],
          },
        }) + '\n');
      } catch (err) {
        this.append(conv, {
          role: 'error',
          text: 'Could not reach the Keeper process: ' + (err instanceof Error ? err.message : String(err)),
        });
        this.killClaudeSession();
        finish();
      }
    });
  }

  /**
   * A long-lived `claude` process for this conversation.
   *
   * Spawning one per turn cost about 15 seconds every time — 5.5s of CLI
   * start-up, 3s to read the persona, and 6.5s for the MCP handshake — before
   * any thinking began. Measured against the same process reused: turn one
   * 15.9s, turn two 2.1s, turn three 4.7s with a tool call. Holding the
   * process open is worth ~12s on every turn after the first, and the model
   * choice barely moves it (haiku measured no faster than opus), so this is
   * the only lever that matters.
   */
  private ensureClaudeSession(conv: Conversation): ClaudeSession | null {
    const live = this.claudeSession;
    if (live && live.convId === conv.id && live.child.exitCode === null && !live.child.killed) {
      return live;
    }
    this.killClaudeSession();

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--append-system-prompt-file', AGENTS_MD_PATH,
      '--mcp-config', this.writeClaudeMcpConfig(),
    ];
    // Resume the transcript when the process died but the conversation lives.
    if (conv.threadId) args.push('--resume', conv.threadId);

    const isWin = process.platform === 'win32';
    let child;
    try {
      child = spawn('claude', isWin ? args.map(winQuote) : args, {
        cwd: BRAIN_DIR,
        env: { ...process.env },
        shell: isWin,
        windowsHide: true,
      });
    } catch (err) {
      this.append(conv, {
        role: 'error',
        text: 'Could not start Claude Code. Is the `claude` CLI installed and on PATH? '
          + (err instanceof Error ? err.message : String(err)),
      });
      return null;
    }

    const sess: ClaudeSession = {
      child, convId: conv.id, stdoutBuf: '', stderrBuf: '',
      producedAssistant: false, onTurnEnd: null,
    };
    this.claudeSession = sess;
    this.currentChild = child;

    child.stdin?.on('error', () => { /* ignore broken pipe */ });

    child.stdout?.on('data', (d: Buffer) => {
      sess.stdoutBuf += d.toString();
      let nl: number;
      while ((nl = sess.stdoutBuf.indexOf('\n')) >= 0) {
        const line = sess.stdoutBuf.slice(0, nl).trim();
        sess.stdoutBuf = sess.stdoutBuf.slice(nl + 1);
        if (!line) continue;
        if (this.handleClaudeLine(conv, line)) sess.producedAssistant = true;
        // `result` closes one turn; the process stays up for the next.
        if (/"type"\s*:\s*"result"/.test(line)) {
          const ok = sess.producedAssistant;
          const detail = ok ? '' : 'The Keeper finished without answering.';
          sess.onTurnEnd?.(ok, detail);
        }
      }
    });

    child.stderr?.on('data', (d: Buffer) => {
      sess.stderrBuf += d.toString();
      if (sess.stderrBuf.length > 8000) sess.stderrBuf = sess.stderrBuf.slice(-8000);
    });

    child.on('error', (err) => {
      sess.onTurnEnd?.(false, 'Claude Code failed (`claude` CLI not found?): ' + err.message);
      if (this.claudeSession === sess) this.claudeSession = null;
    });

    child.on('close', (code) => {
      if (this.currentChild === child) this.currentChild = null;
      if (this.claudeSession === sess) this.claudeSession = null;
      if (sess.onTurnEnd) {
        const detail = sess.stderrBuf.trim().split('\n').slice(-4).join('\n');
        sess.onTurnEnd(false, `The Keeper process exited (code ${code}).` + (detail ? `\n${detail}` : ''));
      }
    });

    return sess;
  }

  /** Drop the persistent Keeper process, if any. */
  private killClaudeSession(): void {
    const sess = this.claudeSession;
    if (!sess) return;
    this.claudeSession = null;
    if (this.currentChild === sess.child) this.currentChild = null;
    try {
      if (process.platform === 'win32' && sess.child.pid) {
        // shell:true means the child is cmd.exe with claude underneath it.
        spawn('taskkill', ['/PID', String(sess.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        sess.child.kill();
      }
    } catch { /* already gone */ }
  }

  /**
   * The Conduit MCP server, in Claude's config shape. Codex gets the same
   * server through its own `config.toml`; this is the identical command line
   * expressed as JSON.
   */
  private writeClaudeMcpConfig(): string {
    const file = path.join(BRAIN_DIR, 'claude-mcp.json');
    const cfg = {
      mcpServers: {
        conduit: {
          command: process.execPath,
          args: [this.conduitMcpPath, '--daemon', DAEMON_HTTP_URL],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf-8');
    return file;
  }

  /** Parse one Claude Code `stream-json` line. Returns true if it was an answer. */
  private handleClaudeLine(conv: Conversation, line: string): boolean {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { return false; }

    // Every event carries the session id; keep the newest so the next turn
    // resumes this conversation.
    const sid = obj.session_id;
    if (typeof sid === 'string' && sid && conv.threadId !== sid) {
      conv.threadId = sid;
      this.save();
    }

    const type = String(obj.type || '');

    if (type === 'assistant') {
      const msg = obj.message as { content?: unknown } | undefined;
      const content = Array.isArray(msg?.content) ? msg!.content : [];
      let text = '';
      for (const block of content as Record<string, unknown>[]) {
        if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
        if (block?.type === 'tool_use') {
          const name = String(block.name || 'tool');
          const input = JSON.stringify(block.input ?? {}).slice(0, 600);
          this.append(conv, { role: 'tool', tool: name, text: input });
        }
      }
      if (text.trim()) {
        this.append(conv, { role: 'assistant', text: text.trim() });
        return true;
      }
      return false;
    }

    if (type === 'result') {
      const subtype = String(obj.subtype || '');
      const result = typeof obj.result === 'string' ? obj.result.trim() : '';
      if (subtype !== 'success') {
        this.append(conv, {
          role: 'error',
          text: result || `Claude Code turn failed (${subtype || 'unknown'}).`,
        });
        return false;
      }
      // The streamed assistant message is normally already appended; this is
      // the safety net for a turn that only produced a final result.
      return false;
    }

    return false;
  }

  // ─────────────────────────── Codex turn ───────────────────────────

  private runCodexTurn(conv: Conversation, prompt: string): Promise<void> {
    this.ensureBrainEnv();

    const outFile = path.join(BRAIN_DIR, `lastmsg-${Date.now()}.txt`);
    // The brain runs non-interactively, so nobody can answer Codex approval
    // prompts — and under the default `never` policy every gated call (which
    // includes MCP tool calls) is auto-cancelled. `--dangerously-bypass-...`
    // is Codex's supported flag for headless automation. It is safe here: the
    // brain's only capability is the Conduit MCP toolset (its AGENTS.md forbids
    // shell use), and real write-actions still flow through sandboxed agents.
    const turnArgs = [
      '--dangerously-bypass-approvals-and-sandbox',
      '--json', '--skip-git-repo-check', '-o', outFile, '-',
    ];
    const args = conv.threadId
      ? ['exec', 'resume', conv.threadId, ...turnArgs]
      : ['exec', '--cd', BRAIN_DIR, ...turnArgs];

    const isWin = process.platform === 'win32';
    const spawnArgs = isWin ? args.map(winQuote) : args;

    return new Promise<void>((resolve) => {
      let child;
      try {
        child = spawn('codex', spawnArgs, {
          cwd: BRAIN_DIR,
          env: { ...process.env, CODEX_HOME },
          shell: isWin,
          windowsHide: true,
        });
      } catch (err) {
        this.append(conv, {
          role: 'error',
          text: 'Could not start Codex. Is the `codex` CLI installed and on PATH? ' +
            (err instanceof Error ? err.message : String(err)),
        });
        resolve();
        return;
      }

      // Track the child so abortTurn() can find and kill it.
      this.currentChild = child;

      let stdoutBuf = '';
      let stderrBuf = '';
      let producedAssistant = false;

      child.stdin?.on('error', () => { /* ignore broken pipe */ });
      // The spoken-summary rule rides on every turn — exec resume won't pick
      // it up from AGENTS.md.
      child.stdin?.write(prompt + TURN_SUFFIX + currentRoster());
      child.stdin?.end();

      child.stdout?.on('data', (d: Buffer) => {
        stdoutBuf += d.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line && this.handleCodexLine(conv, line)) producedAssistant = true;
        }
      });

      child.stderr?.on('data', (d: Buffer) => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
      });

      child.on('error', (err) => {
        this.append(conv, {
          role: 'error',
          text: 'Could not start Codex (`codex` CLI not found?): ' + err.message,
        });
        resolve();
      });

      child.on('close', (code) => {
        if (this.currentChild === child) this.currentChild = null;
        // Safety net: if no agent_message streamed through, fall back to the
        // canonical last-message file Codex wrote.
        if (!producedAssistant) {
          let last = '';
          try {
            if (fs.existsSync(outFile)) last = fs.readFileSync(outFile, 'utf-8').trim();
          } catch { /* ignore */ }
          if (last) {
            this.append(conv, { role: 'assistant', text: last });
          } else if (code !== 0) {
            const detail = stderrBuf.trim().split('\n').slice(-4).join('\n');
            this.append(conv, {
              role: 'error',
              text: `Codex exited with code ${code}.` + (detail ? `\n${detail}` : ''),
            });
          }
        }
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* ignore */ }
        resolve();
      });
    });
  }

  /** Parse one Codex `--json` event line. Returns true if it was an answer. */
  private handleCodexLine(conv: Conversation, line: string): boolean {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { return false; }

    const type = obj.type;
    if (type === 'thread.started') {
      const id = obj.thread_id;
      if (typeof id === 'string' && id) { conv.threadId = id; this.save(); }
      return false;
    }
    if (type === 'item.completed') {
      const msg = this.itemToMessage(obj.item as Record<string, unknown> | undefined);
      if (msg) {
        this.append(conv, msg);
        return msg.role === 'assistant';
      }
      return false;
    }
    if (type === 'turn.failed' || type === 'error') {
      const e = (obj.error || obj) as { message?: string };
      this.append(conv, { role: 'error', text: e.message || 'Brain turn failed.' });
      return false;
    }
    return false;
  }

  /** Map a Codex turn item to a renderable brain message (or null to skip). */
  private itemToMessage(item: Record<string, unknown> | undefined): Omit<BrainMessage, 'id' | 'ts'> | null {
    if (!item) return null;
    const type = String(item.type || '');

    if (type === 'agent_message') {
      const text = String(item.text || '').trim();
      return text ? { role: 'assistant', text } : null;
    }
    if (type === 'reasoning') {
      const text = String(item.text || item.summary || '').trim();
      return text ? { role: 'reasoning', text } : null;
    }
    if (type === 'command_execution') {
      const cmd = String(item.command || item.cmd || '(command)');
      return { role: 'tool', tool: 'shell', text: '$ ' + cmd };
    }
    if (type === 'mcp_tool_call' || type.includes('mcp') || type.includes('tool_call')) {
      const name = String(item.tool || item.name || item.tool_name || 'tool');
      const server = item.server ? `${item.server}/` : '';
      let summary = '';
      const rawArgs = item.arguments ?? item.input ?? item.args;
      if (rawArgs !== undefined) {
        try { summary = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs); }
        catch { summary = ''; }
      }
      return { role: 'tool', tool: server + name, text: summary.slice(0, 600) };
    }
    if (type === 'error') {
      return { role: 'error', text: String(item.message || 'error') };
    }
    // todo_list / file_change / web_search / etc. — not surfaced in Phase 1.
    return null;
  }

  // ─────────────────────────── Brain environment ───────────────────────────

  /** Write the brain's AGENTS.md + dedicated Codex home (config + auth). */
  private ensureBrainEnv(): void {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });
    fs.mkdirSync(CODEX_HOME, { recursive: true });

    fs.writeFileSync(AGENTS_MD_PATH, AGENTS_MD, 'utf-8');

    // Dedicated Codex config — only the Conduit MCP server + the user's model.
    const config = [
      '# Conduit Orchestrator brain — managed by Conduit. Do not edit.',
      this.userCodexModelConfig(),
      '',
      '[mcp_servers.conduit]',
      `command = ${tomlStr(process.execPath)}`,
      `args = [${[this.conduitMcpPath, '--daemon', DAEMON_HTTP_URL].map(tomlStr).join(', ')}]`,
      '',
    ].filter((l) => l !== '').join('\n') + '\n';
    fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), config, 'utf-8');

    // Copy the user's Codex auth so the brain inherits their subscription.
    try {
      const src = path.join(os.homedir(), '.codex', 'auth.json');
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(CODEX_HOME, 'auth.json'));
      }
    } catch { /* the brain may still authenticate via env / OPENAI_API_KEY */ }
  }

  /** Inherit `model` / `service_tier` from the user's Codex config, if set. */
  private userCodexModelConfig(): string {
    const out: string[] = [];
    try {
      const userCfg = path.join(os.homedir(), '.codex', 'config.toml');
      if (fs.existsSync(userCfg)) {
        for (const raw of fs.readFileSync(userCfg, 'utf-8').split('\n')) {
          const line = raw.trim();
          if (line.startsWith('[')) break; // top-level scalars only
          if (/^(model|service_tier)\s*=/.test(line)) out.push(line);
        }
      }
    } catch { /* fall back to Codex defaults */ }
    return out.join('\n');
  }

  // ─────────────────────────── State ───────────────────────────

  private current(): Conversation {
    return this.conversations.find((c) => c.id === this.currentId) || this.conversations[0];
  }

  private makeConversation(): Conversation {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      title: 'New conversation',
      threadId: null,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Drop the oldest conversations beyond the cap. */
  private trimConversations(): void {
    if (this.conversations.length <= MAX_CONVERSATIONS) return;
    this.conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.conversations = this.conversations.slice(0, MAX_CONVERSATIONS);
  }

  private append(conv: Conversation, m: Omit<BrainMessage, 'id' | 'ts'>): void {
    const message: BrainMessage = { id: randomUUID(), ts: new Date().toISOString(), ...m };
    conv.messages.push(message);
    if (conv.messages.length > MAX_HISTORY) {
      conv.messages.splice(0, conv.messages.length - MAX_HISTORY);
    }
    conv.updatedAt = message.ts;
    this.emit({ kind: 'append', conversationId: conv.id, message });
  }

  private setStatus(status: BrainStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ kind: 'status', status });
  }

  private emitState(): void {
    this.emit({ kind: 'state', state: this.getState() });
  }

  private load(): void {
    try {
      if (fs.existsSync(STATE_PATH)) {
        const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
        if (Array.isArray(data.conversations) && data.conversations.length > 0) {
          this.conversations = data.conversations;
          this.currentId = typeof data.currentId === 'string' ? data.currentId : '';
        } else if (Array.isArray(data.messages)) {
          // Migrate the old single-conversation shape ({ threadId, messages }).
          const conv = this.makeConversation();
          conv.threadId = typeof data.threadId === 'string' ? data.threadId : null;
          conv.messages = data.messages;
          const firstUser = data.messages.find((m: BrainMessage) => m?.role === 'user');
          if (firstUser) conv.title = makeTitle(firstUser.text);
          this.conversations = [conv];
          this.currentId = conv.id;
        }
      }
    } catch {
      this.conversations = [];
    }
    if (this.conversations.length === 0) {
      const conv = this.makeConversation();
      this.conversations = [conv];
      this.currentId = conv.id;
    }
    if (!this.conversations.some((c) => c.id === this.currentId)) {
      this.currentId = this.conversations[0].id;
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(BRAIN_DIR, { recursive: true });
      const data: PersistedState = {
        conversations: this.conversations,
        currentId: this.currentId,
      };
      fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch { /* best-effort persistence */ }
  }
}

/** Make a short conversation title from the first user message. */
function makeTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'New conversation';
  return t.length > 48 ? t.slice(0, 48) + '…' : t;
}
