/**
 * Supervisor watcher — the "watchdog" that observes each running agent.
 *
 * Two paths, both on ANSI-stripped text:
 *   fast path  — regex gates (y/n prompts, destructive commands) fire at once
 *   slow path  — batches of output go to the Strands Supervisor on Bedrock,
 *                which classifies them (progress / blocker / question /
 *                risky_action / noise) and speaks a one-line summary
 *
 * Runs inside the daemon (it owns the agents). Codex agents are observed via
 * their structured item stream; PTY agents via raw output.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import * as runtime from '../daemon/runtime.js';
import { createSupervisorAgent, type SupervisorUpdate } from './agent.js';
import { supervisorDisabled, supervisorProvider, BEDROCK_MODEL_ID } from './config.js';
import { isCredentialError, isModelUnavailable, shouldFallBack } from './failure.js';
import { isTrustPrompt } from '../gatePatterns.js';
import {
  appendGroupChat, appendAuditLog, updateAgent, getAgent, getProjectData, readRecentAudit,
  type GroupChatEntry,
} from '../storage.js';
import { checkGate, stripAnsi, gateQuestion } from '../gatePatterns.js';
import { shouldAutoApprove } from '../gate-policy.js';
import type { DaemonMessage } from '../daemon/protocol.js';
import { classifyWithAnthropic, hasAnthropicCredential, currentModel } from './anthropic.js';

type Broadcast = (msg: DaemonMessage) => void;

interface WatcherState {
  agentId: string;
  projectId: string;
  broadcast: Broadcast;
  /** Stripped text waiting for the next Supervisor call. */
  buffer: string;
  /** Rolling tail of stripped text for cross-chunk prompt detection. */
  tail: string;
  timer: ReturnType<typeof setTimeout> | null;
  isProcessing: boolean;
  lastCallAt: number;
  lastGateReason: string;
  lastGateAt: number;
  /** Last few summaries — gives the (stateless) Supervisor short-term memory. */
  recent: string[];
  teardown: () => void;
}

const watchers = new Map<string, WatcherState>();

const DEBOUNCE_MS = 10_000;          // quiet period before a batch goes to Bedrock
const MIN_CALL_INTERVAL_MS = 20_000; // never call Bedrock more often than this per agent
const MAX_BATCH_CHARS = 12_000;      // tail of the batch that is actually sent
const GATE_REPEAT_MS = 60_000;       // same gate reason within this window is ignored

const logPath = path.join(os.homedir(), '.conduit', 'supervisor-log.jsonl');

/** If Bedrock is unreachable (no creds, no access) back off instead of retrying every batch. */
let supervisorBackoffUntil = 0;
let supervisorWarned = false;

function logUpdate(entry: unknown) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[watcher] Failed to write supervisor-log.jsonl:', err);
  }
}

function supervisorEntry(text: string, classification: GroupChatEntry['classification']): GroupChatEntry {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    role: 'supervisor',
    sender: 'Supervisor',
    text,
    classification,
  };
}

/**
 * Post a supervisor line to the project's group chat and push it live.
 *
 * A classification takes seconds, and the user can delete the project inside
 * that window. Storage refuses the write in that case; there is nothing left to
 * say it about, so the broadcast is dropped too — a summary of an agent in a
 * project that no longer exists is noise at best.
 */
function postToGroupChat(state: WatcherState, entry: GroupChatEntry) {
  let stored = false;
  try { stored = appendGroupChat(state.projectId, entry); }
  catch (err) { console.error('[watcher] Failed to append to groupchat:', err); }
  if (!stored) { detachWatcher(state.agentId); return; }
  state.broadcast({ kind: 'event', event: 'groupchat:message', payload: { ...entry, projectId: state.projectId } });
}

/**
 * Raise a human-approval gate for an agent. Idempotent: an agent with a
 * pending gate keeps it until the human resolves it.
 */
export function triggerGate(
  projectId: string,
  agentId: string,
  prompt: string,
  source: 'regex' | 'supervisor',
  broadcast: Broadcast,
): boolean {
  const agent = getAgent(projectId, agentId);
  if (!agent) return false;
  if (agent.pendingGate) return false;

  let clean = trimToLineStart(prompt.trim(), 1500);

  // The trust prompt draws itself with cursor moves, so the raw slice of
  // terminal that matched is usually a fragment of the command line and tells
  // the user nothing about what they are being asked to allow. Say it plainly
  // instead. The wording keeps the phrase "trust this folder" because that is
  // what `isTrustPrompt` matches on when the decision is carried out.
  if (isTrustPrompt(clean)) {
    clean = [
      `${agent.name} is asking whether to trust this folder before it reads,`,
      'edits or runs anything in it:',
      '',
      `    ${agent.cwd}`,
      '',
      'Approve to let it start. Reject and it will exit.',
    ].join('\n');
  }

  // Ordinary y/n prompts — "create README.md?" — are answered here rather than
  // queued for a human. Harmful ones never take this path, whatever the
  // setting says. See src/gate-policy.ts for where the line is drawn.
  if (shouldAutoApprove(clean, source)) {
    runtime.writeToAgent(agentId, 'y\r');
    // One line: what was asked, and that it was allowed. Six lines of terminal
    // tail scrolling past on every file write is exactly the noise this feature
    // exists to remove.
    const note = supervisorEntry(
      `${agent.name} asked "${gateQuestion(clean)}" — allowed.`,
      'progress',
    );
    try {
      appendAuditLog(projectId, {
        event: 'gate_auto_approve', agentId, agentName: agent.name,
        gate: { prompt: clean, source }, action: 'sent y',
      });
      appendGroupChat(projectId, note);
    } catch { /* project may be gone */ }
    broadcast({ kind: 'event', event: 'groupchat:message', payload: { ...note, projectId } });
    return true;
  }

  updateAgent(projectId, agentId, { pendingGate: { prompt: clean, source } });

  const entry = supervisorEntry(
    source === 'regex'
      ? `[Gate] ${agent.name} needs your decision:\n${summariseTail(clean)}`
      : `[Gate] ${agent.name} is about to do something risky:\n${summariseTail(clean, 10)}`,
    'risky_action',
  );
  try { appendGroupChat(projectId, entry); } catch { /* ignore */ }
  broadcast({ kind: 'event', event: 'groupchat:message', payload: { ...entry, projectId } });
  broadcast({ kind: 'event', event: 'gate:triggered', agentId, projectId, prompt: clean, source });
  return true;
}

/**
 * Take the last `max` characters, but start on a line boundary. Slicing a
 * terminal tail by character count opens the gate modal mid-word, which reads
 * as corruption at the exact moment the user is being asked to trust it.
 */
function trimToLineStart(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  const nl = tail.indexOf('\n');
  // Only drop the partial line if a whole line survives it.
  return nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail;
}

/**
 * A terminal tail is mostly horizontal rules, spinners and blank lines. Pasted
 * verbatim into the group chat it renders as a tall empty box with one sentence
 * at the bottom. Keep only the lines that carry words — the untouched tail is
 * still in the gate modal, where the decision is actually made.
 */
function summariseTail(text: string, maxLines = 6): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => /[A-Za-z0-9]/.test(l));
  return lines.slice(-maxLines).join('\n');
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Consecutive Supervisor failures — drives the escalating backoff. */
let supervisorFailures = 0;

/**
 * What the Supervisor is really doing.
 *
 * `/api/health` used to report `supervisor: 'on'` whenever it was not
 * switched off by config — which it dutifully did for days while every single
 * classification was failing against a retired Bedrock model. A health check
 * that reports configuration rather than health is worse than none: it is the
 * thing you look at to find out whether the problem is real.
 */
let lastOkAt = 0;
let lastOkProvider: 'bedrock' | 'anthropic' | null = null;
let lastError: string | null = null;
let lastErrorAt = 0;

export interface SupervisorHealth {
  /** off = disabled by config; ok = classifying; degraded = on the fallback;
   *  failing = tried and could not; idle = nothing classified yet. */
  state: 'off' | 'ok' | 'degraded' | 'failing' | 'idle';
  provider: 'bedrock' | 'anthropic' | null;
  configured: string;
  model: string;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveFailures: number;
  pausedForMs: number;
}

export function supervisorHealth(): SupervisorHealth {
  if (supervisorDisabled()) {
    return {
      state: 'off', provider: null, configured: supervisorProvider(),
      model: '', lastOkAt: null, lastError: null, lastErrorAt: null,
      consecutiveFailures: 0, pausedForMs: 0,
    };
  }
  const pausedForMs = Math.max(0, supervisorBackoffUntil - Date.now());
  const state = supervisorFailures > 0 && !lastOkAt ? 'failing'
    : !lastOkAt ? 'idle'
      // Working, but not on the backend that was asked for. Worth surfacing:
      // the fallback is slower, billed elsewhere, and silent until you look.
      : lastOkProvider === 'anthropic' && supervisorProvider() !== 'anthropic' ? 'degraded'
        : supervisorFailures > 0 ? 'failing' : 'ok';
  return {
    state,
    provider: lastOkProvider,
    configured: supervisorProvider(),
    model: lastOkProvider === 'anthropic' ? currentModel() : BEDROCK_MODEL_ID,
    lastOkAt: lastOkAt || null,
    lastError,
    lastErrorAt: lastErrorAt || null,
    consecutiveFailures: supervisorFailures,
    pausedForMs,
  };
}

/**
 * How many classifications may be in flight at once, across every agent.
 *
 * Each agent has its own 20s throttle, so N working agents make N times the
 * requests and they arrive together. That is what trips a provider rate limit
 * in the first place — and the resulting backoff then silences supervision for
 * every agent at once. Queueing here prevents the burst instead of reacting
 * to it, which matters as soon as agents are worked in parallel.
 */
const MAX_CONCURRENT_CLASSIFICATIONS = 2;
let inFlight = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_CLASSIFICATIONS) { inFlight += 1; return; }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight += 1;
}

function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiting.shift();
  if (next) next();
}

/**
 * Is this failure the provider's fault rather than this agent's?
 *
 * A dead credential or an exhausted quota affects everyone, so pausing
 * globally is right. A one-off parse or tool error does not, and letting it
 * mute supervision for every other agent means gates silently stop being
 * raised across the whole conduit.
 */
function isProviderFailure(kind: string | undefined, msg: string): boolean {
  return kind === 'auth' || kind === 'rate-limit' || kind === 'model'
    || kind === 'network' || isCredentialError(msg);
}

/**
 * Back off after a failure so a permanently broken Supervisor (no credentials,
 * a bad model id, an exhausted rate limit) can't fire one request per batch
 * forever. 1 min, then 2, 4, 8, capped at 15.
 */
function backOff(reason: string, hint: string) {
  supervisorFailures += 1;
  const delay = Math.min(60_000 * 2 ** (supervisorFailures - 1), 15 * 60_000);
  supervisorBackoffUntil = Date.now() + delay;
  if (!supervisorWarned) {
    supervisorWarned = true;
    console.warn(
      `[watcher] Supervisor unavailable: ${reason}\n`
      + `          Pausing classification for ${Math.round(delay / 60_000)} min. ${hint}`,
    );
  }
}

/** Say it once per process, not once per batch. */
let fallbackAnnounced = false;

/**
 * Run one classification through the configured provider.
 *
 *   bedrock   — Strands + Bedrock only
 *   anthropic — the Anthropic Messages API only
 *   auto      — Bedrock, then Anthropic if Bedrock cannot serve the request
 *               (no credentials, a retired model, or a rate cap)
 */
async function classify(prompt: string, onUpdate: (u: SupervisorUpdate) => void): Promise<void> {
  const provider = supervisorProvider();

  if (provider === 'anthropic') {
    onUpdate(await classifyWithAnthropic(prompt));
    lastOkProvider = 'anthropic';
    return;
  }

  try {
    await createSupervisorAgent(onUpdate).invoke(prompt);
    lastOkProvider = 'bedrock';
  } catch (err) {
    const msg = describeError(err);
    if (provider === 'bedrock' || !shouldFallBack(msg) || !hasAnthropicCredential()) throw err;
    if (!fallbackAnnounced) {
      fallbackAnnounced = true;
      console.log(
        `[watcher] Bedrock unavailable (${msg})\n`
        + `          Falling back to the Anthropic API on ${currentModel()}. `
        + 'Set BEDROCK_MODEL_ID to a model your IAM policy allows to use Bedrock instead.',
      );
    }
    onUpdate(await classifyWithAnthropic(prompt));
    lastOkProvider = 'anthropic';
  }
}

async function processBuffer(state: WatcherState) {
  if (state.isProcessing || !state.buffer.trim()) return;
  if (supervisorDisabled()) { state.buffer = ''; return; }
  if (Date.now() < supervisorBackoffUntil) { state.buffer = ''; return; }

  const sinceLast = Date.now() - state.lastCallAt;
  if (sinceLast < MIN_CALL_INTERVAL_MS) {
    // Too soon — re-arm the timer for the remainder rather than dropping the batch.
    if (!state.timer) {
      state.timer = setTimeout(() => { state.timer = null; void processBuffer(state); }, MIN_CALL_INTERVAL_MS - sinceLast);
    }
    return;
  }

  state.isProcessing = true;
  state.lastCallAt = Date.now();
  let textToAnalyze = state.buffer;
  state.buffer = '';
  if (textToAnalyze.length > MAX_BATCH_CHARS) textToAnalyze = '…' + textToAnalyze.slice(-MAX_BATCH_CHARS);

  const project = getProjectData(state.projectId);
  const agent = project?.agents.find((a) => a.id === state.agentId);
  const projectName = project?.project.name || state.projectId;
  const agentName = agent?.name || state.agentId;

  const audit = readRecentAudit(state.projectId, 8)
    .filter((e) => typeof e.event === 'string' && String(e.event).startsWith('plan_'))
    .map((e) => {
      const plan = e.plan as { description?: string; targetAgent?: string } | undefined;
      return `- ${String(e.event).replace('plan_', '')}: ${plan?.description || ''} (→ ${plan?.targetAgent || '?'})${e.reason ? ` — reason: ${e.reason}` : ''}`;
    });

  const handleUpdate = (update: SupervisorUpdate) => {
    if (!update || update.classification === 'noise') return;
    const ts = new Date().toISOString();
    const payload = {
      agentId: state.agentId,
      projectId: state.projectId,
      classification: update.classification,
      summary: update.summary,
      ts,
    };
    logUpdate(payload);
    state.recent.push(`[${update.classification}] ${update.summary}`);
    if (state.recent.length > 5) state.recent.shift();

    if (update.classification === 'risky_action') {
      triggerGate(state.projectId, state.agentId, update.summary, 'supervisor', state.broadcast);
    } else {
      postToGroupChat(state, supervisorEntry(`${agentName}: ${update.summary}`, update.classification));
    }
    state.broadcast({ kind: 'event', event: 'supervisor:update', payload });
  };

  const prompt = [
    `Agent: ${agentName} (id ${state.agentId}) on project "${projectName}" (id ${state.projectId}).`,
    state.recent.length ? `Your recent reports for this agent:\n${state.recent.join('\n')}` : '',
    audit.length ? `Recent plan decisions by the human (do not re-propose rejected ones):\n${audit.join('\n')}` : '',
    'Classify the terminal output below and call report_update exactly once.',
    '',
    'Terminal output:',
    textToAnalyze,
  ].filter(Boolean).join('\n\n');

  try {
    // Bounded concurrency: several agents finishing together would otherwise
    // fire their classifications simultaneously.
    await acquireSlot();
    try {
      await classify(prompt, handleUpdate);
    } finally {
      releaseSlot();
    }
    // A good turn clears the failure streak and re-arms the warning.
    supervisorFailures = 0;
    supervisorWarned = false;
    lastOkAt = Date.now();
    lastError = null;
  } catch (err) {
    const msg = describeError(err);
    const kind = (err as { kind?: string })?.kind;
    lastError = msg.slice(0, 300);
    lastErrorAt = Date.now();
    let hint: string;
    if (isModelUnavailable(msg)) {
      // Not a credential problem, and saying so sends people to fix the wrong
      // thing. Bedrock retires model ids, and the default here will age out.
      hint = `BEDROCK_MODEL_ID (${BEDROCK_MODEL_ID}) cannot be invoked — usually retired, or an inference profile your IAM policy does not allow. Pick a current model, or set SUPERVISOR_PROVIDER=anthropic.`;
    } else if (kind === 'auth' || isCredentialError(msg)) {
      hint = 'Set AWS credentials for Bedrock, or ANTHROPIC_API_KEY with SUPERVISOR_PROVIDER=anthropic. CONDUIT_SUPERVISOR=off silences this.';
    } else if (kind === 'rate-limit') {
      hint = `Every candidate model is rate-limited on this credential. Pin a cheaper one with ANTHROPIC_MODEL_ID (currently trying ${currentModel()}), or use an ANTHROPIC_API_KEY.`;
    } else if (kind === 'model') {
      hint = `No usable model. Check ANTHROPIC_MODEL_ID (currently ${currentModel()}).`;
    } else {
      hint = 'This is usually transient; classification resumes automatically.';
    }
    if (isProviderFailure(kind, msg)) {
      backOff(`${msg} (agent ${agentName})`, hint);
    } else {
      // This agent's problem, not the Supervisor's — let everyone else carry on.
      console.warn(`[watcher] classification failed for ${agentName}: ${msg}`);
    }
  } finally {
    state.isProcessing = false;
    if (state.buffer.trim() && !state.timer) {
      state.timer = setTimeout(() => { state.timer = null; void processBuffer(state); }, DEBOUNCE_MS);
    }
  }
}

/** Milestones that justify calling the Supervisor right away. */
const MILESTONE_RE = /\b(error|exception|failed|fatal|panic|traceback|completed|finished|all tests pass|deployed)\b/i;

export function attachWatcher(agentId: string, projectId: string, broadcast: Broadcast) {
  if (watchers.has(agentId)) return; // Already watching
  if (!runtime.isAgentRunning(agentId)) return;

  const state: WatcherState = {
    agentId, projectId, broadcast,
    buffer: '', tail: '',
    timer: null, isProcessing: false,
    lastCallAt: 0, lastGateReason: '', lastGateAt: 0,
    recent: [],
    teardown: () => { /* set below */ },
  };
  watchers.set(agentId, state);

  const listener = (raw: string) => {
    const text = stripAnsi(raw);
    if (!text.trim()) return;

    // Rolling tail so a prompt split across chunks is still seen.
    state.tail = (state.tail + text).slice(-3000);

    // Fast path: prompts + destructive commands.
    const gate = checkGate(state.tail.slice(-800));
    if (gate.matches) {
      const now = Date.now();
      const repeat = gate.reason === state.lastGateReason && now - state.lastGateAt < GATE_REPEAT_MS;
      if (!repeat) {
        state.lastGateReason = gate.reason;
        state.lastGateAt = now;
        const context = state.tail.slice(-600).trim();
        triggerGate(projectId, agentId, context, 'regex', broadcast);
      }
    }

    // Slow path: batch for the Supervisor.
    state.buffer += text;
    if (state.buffer.length > MAX_BATCH_CHARS * 2) state.buffer = state.buffer.slice(-MAX_BATCH_CHARS);

    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (MILESTONE_RE.test(text)) {
      void processBuffer(state);
    } else {
      state.timer = setTimeout(() => { state.timer = null; void processBuffer(state); }, DEBOUNCE_MS);
    }
  };

  state.teardown = runtime.subscribeOutput(agentId, listener);
}

export function detachWatcher(agentId: string) {
  const state = watchers.get(agentId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  try { state.teardown(); } catch { /* ignore */ }
  watchers.delete(agentId);
}
