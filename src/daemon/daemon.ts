/**
 * conduit-daemon — owns every agent PTY process and outlives the web server.
 *
 * Two interfaces on one port (127.0.0.1:3210):
 *   - WebSocket  — the web server connects here (see protocol.ts)
 *   - HTTP       — agent lifecycle hooks POST here (POST /hook/:agentId/:event)
 *
 * Because the PTYs live here, restarting the web server no longer kills agents.
 * The HTTP hook endpoint feeds the status engine, which derives precise agent
 * status (running / awaiting_input / idle / stopped) from Claude Code hooks.
 *
 * Run standalone:  node dist/daemon/daemon.js   (or: npm run daemon)
 */

import '../env.js'; // agent CLIs inherit this process's env (GROQ/OPENROUTER keys, CONDUIT_AUTH)
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as runtime from './runtime.js';
import * as storage from '../storage.js';
import { hookEventToStatus } from '../hook-config.js';
import { cleanStaleCodexMcp } from '../mcp-config.js';
import { Orchestrator } from './orchestrator.js';
import { hookEvents } from './hook-events.js';
import { attachWatcher, detachWatcher, supervisorHealth } from '../strands/watcher.js';
import { resetGateSettingsCache } from '../gate-policy.js';
import {
  orgSnapshot,
  askAgentDispatch,
  startAgentDispatch,
  readWiki,
  projectOverview,
  readShared,
  broadcastDispatch,
  createProjectDispatch,
  createAgentDispatch,
  stopAgentDispatch,
  forgetAgentReady,
} from './conduit.js';
import {
  DAEMON_HOST,
  DAEMON_PORT,
  type DaemonRequest,
  type DaemonMessage,
  type BrainEvent,
  type AgentDispatch,
} from './protocol.js';

const startedAt = new Date().toISOString();

/** Every connected web client. Normally one, but tolerate reconnects. */
const clients = new Set<WebSocket>();

/** Per-client attach teardown fns, keyed by agentId, for clean teardown. */
const clientListeners = new WeakMap<WebSocket, Map<string, () => void>>();
/** Agents each client wants to watch — so an attach that arrives before the
 *  agent is running (or across a restart) is bound the moment it comes up. */
const clientWanted = new WeakMap<WebSocket, Set<string>>();

function send(ws: WebSocket, msg: DaemonMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: DaemonMessage) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ─────────────────────────── Status engine ───────────────────────────
// Derives precise status from Claude lifecycle hooks + process liveness.
//   running         — actively working (SessionStart/UserPromptSubmit/Pre|PostToolUse)
//   awaiting_input  — Stop / Notification fired — needs the user
//   idle            — awaiting_input for longer than IDLE_AFTER_MS
//   stopped         — process exited / SessionEnd

const IDLE_AFTER_MS = 3 * 60 * 1000;
const agentStatus = new Map<string, string>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setStatus(agentId: string, status: string) {
  const prev = agentStatus.get(agentId);

  // Any transition clears a pending idle timer
  const timer = idleTimers.get(agentId);
  if (timer) { clearTimeout(timer); idleTimers.delete(agentId); }

  if (status === 'stopped') {
    agentStatus.delete(agentId);
  } else {
    agentStatus.set(agentId, status);
  }

  if (prev !== status) {
    broadcast({ kind: 'event', event: 'agent:status', agentId, status });
  }

  // Awaiting input → after a while, demote to idle
  if (status === 'awaiting_input') {
    idleTimers.set(agentId, setTimeout(() => {
      idleTimers.delete(agentId);
      if (agentStatus.get(agentId) === 'awaiting_input') {
        setStatus(agentId, 'idle');
      }
    }, IDLE_AFTER_MS));
  }
}

/**
 * Clear a gate the agent has plainly moved past.
 *
 * A gate is raised from what the terminal printed, and nothing used to take it
 * back down except a human resolving it. If the agent answered the prompt
 * itself, or the match was a false positive, the gate stayed pending forever
 * and the UI went on reporting an agent as waiting for input that was not
 * waiting for anything.
 *
 * A lifecycle hook saying "running" is proof: Claude only reports PreToolUse /
 * PostToolUse / UserPromptSubmit while it is executing, and it cannot be
 * executing and blocked on a prompt at the same time.
 */
function clearStaleGate(agentId: string) {
  const projectId = findAgentProject(agentId);
  if (!projectId) return;
  const agent = storage.getAgent(projectId, agentId);
  if (!agent?.pendingGate) return;
  storage.updateAgent(projectId, agentId, { pendingGate: undefined });
  broadcast({ kind: 'event', event: 'gate:resolved', agentId });
}

/** Status callback handed to the runtimes — 'running' on spawn, 'stopped' on exit. */
function onAgentStatus(agentId: string, status: string) {
  setStatus(agentId, status);
  if (status === 'stopped') {
    detachWatcher(agentId);
    // A restarted agent boots from scratch, so the readiness it earned before
    // does not carry over.
    forgetAgentReady(agentId);
    // Drop dead listeners so a later attach binds to the fresh process.
    for (const ws of clients) {
      const teardowns = clientListeners.get(ws);
      const t = teardowns?.get(agentId);
      if (t) { t(); teardowns!.delete(agentId); }
    }
    return;
  }
  // Any live status — attachWatcher is idempotent per agent.
  const projId = findAgentProject(agentId);
  if (projId) attachWatcher(agentId, projId, broadcast);
  // Bind viewers that asked for this agent before it was running.
  for (const ws of clients) {
    if (clientWanted.get(ws)?.has(agentId) && !clientListeners.get(ws)?.has(agentId)) {
      attachTerminal(ws, agentId);
    }
  }
}

function findAgentProject(agentId: string): string | null {
  for (const project of storage.listProjects()) {
    if (storage.getAgent(project.id, agentId)) return project.id;
  }
  return null;
}

/** Fine-grained status for one agent, with a process-liveness floor. */
function liveStatus(agentId: string): string {
  const s = agentStatus.get(agentId);
  if (s) return s;
  return runtime.isAgentRunning(agentId) ? 'running' : 'stopped';
}

// ─────────────────────────── Orchestrator brain ───────────────────────────
// "The Keeper" — the v2.3 orchestrator. It lives in the daemon because the
// daemon is the long-lived process that also owns the agents it dispatches to.

function broadcastBrainEvent(ev: BrainEvent) {
  broadcast({ kind: 'event', event: 'brain:event', payload: ev });
}
const orchestrator = new Orchestrator(broadcastBrainEvent);

/** Announce an orchestrator→agent dispatch so the web server can log it. */
function emitAgentDispatch(d: AgentDispatch) {
  broadcast({ kind: 'event', event: 'agent:dispatch', payload: d });
}

// One-time cleanup: drop stale PTY-era Codex MCP entries from the global
// ~/.codex/config.toml — Codex agents now load MCP via codex app-server.
{
  const removed = cleanStaleCodexMcp();
  if (removed > 0) {
    console.log(`[daemon] cleaned ${removed} stale Codex MCP `
      + `entr${removed === 1 ? 'y' : 'ies'} from ~/.codex/config.toml`);
  }
}

// ─────────────────────────── Terminal streaming ───────────────────────────

function attachTerminal(ws: WebSocket, agentId: string) {
  const teardowns = clientListeners.get(ws);
  if (!teardowns) return;
  clientWanted.get(ws)?.add(agentId);
  const existing = teardowns.get(agentId);
  if (existing) { existing(); teardowns.delete(agentId); }

  // Not running yet — onAgentStatus binds us when it starts.
  if (!runtime.isAgentRunning(agentId)) return;

  // PTY agents stream text; Codex agents stream structured items.
  const teardown = runtime.attach(agentId, {
    onText: (data) => send(ws, { kind: 'event', event: 'terminal:output', agentId, data }),
    onItem: (item) => send(ws, { kind: 'event', event: 'codex:item', agentId, item }),
  });
  teardowns.set(agentId, teardown);
}

function detachTerminal(ws: WebSocket, agentId: string) {
  clientWanted.get(ws)?.delete(agentId);
  const teardowns = clientListeners.get(ws);
  const teardown = teardowns?.get(agentId);
  if (teardown) {
    teardown();
    teardowns!.delete(agentId);
  }
}

// ─────────────────────────── WebSocket requests ───────────────────────────

async function handleRequest(ws: WebSocket, req: DaemonRequest): Promise<void> {
  if (!('id' in req)) {
    switch (req.op) {
      case 'terminal:attach': attachTerminal(ws, req.agentId); return;
      case 'terminal:detach': detachTerminal(ws, req.agentId); return;
      case 'terminal:input':
        if (typeof req.data === 'string') runtime.writeToAgent(req.agentId, req.data);
        return;
      case 'terminal:interrupt': runtime.interruptAgent(req.agentId); return;
      case 'terminal:resize': runtime.resizeAgent(req.agentId, req.cols, req.rows); return;
      case 'codex:send':
        runtime.sendCodexTurn(req.agentId, req.text, req.model, req.effort);
        return;
      case 'codex:new-thread':
        runtime.newCodexThread(req.agentId).catch((err) =>
          console.error('[daemon] codex new-thread error:', err));
        return;
      case 'brain:send':
        orchestrator.send(req.message).catch((err) =>
          console.error('[daemon] brain send error:', err));
        return;
      case 'brain:new': orchestrator.newConversation(); return;
      case 'brain:abort':
        console.log('[daemon] received brain:abort');
        orchestrator.abortTurn();
        return;
      case 'brain:switch': orchestrator.switchConversation(req.conversationId); return;
      case 'brain:delete': orchestrator.deleteConversation(req.conversationId); return;
      case 'gates:reload': resetGateSettingsCache(); return;
    }
    return;
  }

  const reply = (result: unknown) => send(ws, { kind: 'reply', id: req.id, ok: true, result });
  const fail = (error: string) => send(ws, { kind: 'reply', id: req.id, ok: false, error });

  try {
    switch (req.op) {
      case 'agent:start': {
        const agent = storage.getAgent(req.projectId, req.agentId);
        if (!agent) return fail('Agent not found');
        try {
          const ok = await runtime.startAgent(agent, onAgentStatus);
          return reply({ ok });
        } catch (err) {
          // A start failure is expected (CLI missing, no API key, bad cwd) —
          // return the reason so the UI can show it, rather than a bare false.
          const error = err instanceof Error ? err.message : String(err);
          console.warn(`[daemon] could not start ${agent.name} (${agent.cli}): ${error}`);
          return reply({ ok: false, error });
        }
      }
      case 'agent:stop': {
        const ok = runtime.stopAgent(req.agentId);
        detachWatcher(req.agentId);
        setStatus(req.agentId, 'stopped');
        return reply({ ok });
      }
      case 'agent:restart': {
        const agent = storage.getAgent(req.projectId, req.agentId);
        if (!agent) return fail('Agent not found');
        runtime.stopAgent(req.agentId);
        setStatus(req.agentId, 'stopped');
        setTimeout(() => {
          const fresh = storage.getAgent(req.projectId, req.agentId);
          if (fresh) {
            runtime.startAgent(fresh, onAgentStatus).catch((err) =>
              console.error('[daemon] restart error:', err));
          }
        }, 500);
        return reply({ ok: true });
      }
      case 'agent:cleanup': {
        const agent = storage.getAgent(req.projectId, req.agentId);
        if (agent) runtime.cleanupMcpConfig(agent);
        return reply({ ok: true });
      }
      case 'agent:inject': {
        const status = agentStatus.get(req.agentId);
        if (status === 'awaiting_input' || status === 'idle') {
          return reply({ delivered: false, error: 'Agent is waiting at a prompt' });
        }
        const delivered = runtime.injectMessage(req.agentId, req.fromName, req.message);
        return reply({ delivered });
      }
      case 'agent:isRunning':
        return reply({ running: runtime.isAgentRunning(req.agentId) });
      case 'agent:preview':
        return reply({ preview: runtime.getAgentPreview(req.agentId) });
      case 'agent:runningIds':
        return reply({ ids: runtime.getRunningAgentIds() });
      case 'agent:statuses': {
        // Full fine-grained status map. Any pty-alive agent without a status
        // engine entry defaults to 'running'.
        const statuses: Record<string, string> = {};
        for (const id of runtime.getRunningAgentIds()) statuses[id] = 'running';
        for (const [id, s] of agentStatus) statuses[id] = s;
        return reply({ statuses });
      }
      case 'agent:replay':
        return reply(runtime.getReplay(req.agentId));
      case 'supervisor:health':
        return reply(supervisorHealth());
      case 'brain:state':
        return reply(orchestrator.getState());
      case 'codex:models':
        return reply({ models: await runtime.listCodexModels() });
      default:
        return fail('Unknown op');
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// ─────────────────────────── HTTP endpoints ───────────────────────────
// Two HTTP surfaces on the daemon port:
//   POST /hook/:agentId/:event   — Claude lifecycle hooks → status engine
//   GET  /org/snapshot           — Conduit MCP: whole-conduit view
//   POST /org/ask-agent          — Conduit MCP: dispatch a message to an agent
//   GET  /health

/** Collect a request body (capped to guard against runaway uploads). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Read a JSON object body, or say the client got it wrong.
 *
 * Every `/org/*` POST used to `JSON.parse` inside a try whose catch answered
 * 500. A malformed body is the client's mistake, and reporting it as a server
 * fault sends whoever is debugging to look in the wrong process — which is
 * exactly what a 5xx is *for* telling them. Measured: `{`, `null` and a bare
 * string all produced 500s here.
 *
 * Anything that is not a JSON object is refused, including `null`, arrays and
 * bare strings, because every caller reads named fields off it.
 */
/**
 * A field from a JSON body, as a string — only if it really is one.
 *
 * `String(v)` looks safe and is not. Given `{"project": {"toString": 1}}` —
 * valid JSON, and something any client can send — it throws
 * `Cannot convert object to primitive value`, which surfaced here as a 500 on
 * `/org/ask-agent`. The REST side already learned this: a truthy object used
 * to slip past a check, inject an empty message, and log "[object Object]"
 * into the activity feed.
 *
 * Anything that is not a string is not a name, a path, or a message. Treat it
 * as absent and let the caller's own required-field check reject it.
 */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const raw = (await readBody(req)) || '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Body must be valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Body must be a JSON object.' };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

function sendJson(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleHttp(httpReq: IncomingMessage, res: ServerResponse) {
  const url = httpReq.url || '';
  const parsed = new URL(url, 'http://daemon');
  const route = parsed.pathname;
  const query = parsed.searchParams;

  // POST /hook/<agentId>/<event> — Claude lifecycle hooks
  if (httpReq.method === 'POST' && route.startsWith('/hook/')) {
    const parts = route.split('/'); // ['', 'hook', agentId, event]
    const agentId = parts[2];
    const event = parts[3];
    if (agentId && event) {
      // Feed the dispatch layer's turn detector (ask_agent) first.
      hookEvents.emit('hook', agentId, event);
      const status = hookEventToStatus(event);
      if (status && runtime.isAgentRunning(agentId)) {
        setStatus(agentId, status);
        // Executing and blocked on a prompt are mutually exclusive, so a
        // 'running' hook retires any gate still standing against this agent.
        if (status === 'running') clearStaleGate(agentId);
      }
    }
    res.writeHead(204); // empty body — keeps `curl -s` output silent
    res.end();
    return;
  }

  // GET /org/snapshot — whole-conduit view for the Conduit Orchestrator MCP
  if (httpReq.method === 'GET' && route === '/org/snapshot') {
    sendJson(res, 200, orgSnapshot(liveStatus));
    return;
  }

  // POST /org/ask-agent — dispatch a message to an agent and await its reply
  if (httpReq.method === 'POST' && route === '/org/ask-agent') {
    try {
      const parsed = await readJsonBody(httpReq);
      if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
      const body = parsed.body as any;
      const project = str(body.project);
      const agent = str(body.agent);
      const message = str(body.message);
      if (!project || !agent || !message) {
        sendJson(res, 400, {
          ok: false, status: 'not-found',
          error: 'project, agent, and message are required',
        });
        return;
      }
      const result = await askAgentDispatch(project, agent, message);
      if (result.projectId && result.agentName) {
        emitAgentDispatch({
          projectId: result.projectId,
          projectName: result.projectName || '',
          agentName: result.agentName,
          fromName: 'Conduit Orchestrator',
          message,
          status: result.status,
          reply: result.reply ?? null,
        });
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        ok: false, status: 'not-found',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // POST /org/start-agent — boot a stopped agent and wait until it is ready
  if (httpReq.method === 'POST' && route === '/org/start-agent') {
    try {
      const parsed = await readJsonBody(httpReq);
      if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
      const body = parsed.body as any;
      const project = str(body.project);
      const agent = str(body.agent);
      if (!project || !agent) {
        sendJson(res, 400, {
          ok: false, status: 'not-found',
          error: 'project and agent are required',
        });
        return;
      }
      const result = await startAgentDispatch(
        project, agent,
        (ag) => runtime.startAgent(ag, onAgentStatus),
      );
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        ok: false, status: 'not-found',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // GET /org/wiki?project=&page=&overview=1 — project wiki / overview
  if (httpReq.method === 'GET' && route === '/org/wiki') {
    const project = (query.get('project') || '').trim();
    if (!project) {
      sendJson(res, 400, { ok: false, error: 'project is required' });
      return;
    }
    if (query.get('overview') === '1') {
      sendJson(res, 200, projectOverview(project));
    } else {
      sendJson(res, 200, readWiki(project, query.get('page') || undefined));
    }
    return;
  }

  // GET /org/shared?project=&file= — project shared content
  if (httpReq.method === 'GET' && route === '/org/shared') {
    const project = (query.get('project') || '').trim();
    if (!project) {
      sendJson(res, 400, { ok: false, error: 'project is required' });
      return;
    }
    sendJson(res, 200, readShared(project, query.get('file') || undefined));
    return;
  }

  // POST /org/broadcast — ask every running agent at once
  if (httpReq.method === 'POST' && route === '/org/broadcast') {
    try {
      const parsed = await readJsonBody(httpReq);
      if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
      const body = parsed.body as any;
      const message = str(body.message);
      const project = str(body.project) || undefined;
      if (!message) {
        sendJson(res, 400, { ok: false, error: 'message is required', replies: [], skipped: [] });
        return;
      }
      const result = await broadcastDispatch(project, message);
      for (const r of result.replies) {
        emitAgentDispatch({
          projectId: r.projectId,
          projectName: r.projectName,
          agentName: r.agentName,
          fromName: 'Conduit Orchestrator',
          message,
          status: r.status,
          reply: r.reply ?? null,
        });
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        ok: false, replies: [], skipped: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // POST /org/stop-agent — stop a running agent
  if (httpReq.method === 'POST' && route === '/org/stop-agent') {
    try {
      const parsed = await readJsonBody(httpReq);
      if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
      const body = parsed.body as any;
      const project = str(body.project);
      const agent = str(body.agent);
      if (!project || !agent) {
        sendJson(res, 400, {
          ok: false, status: 'not-found',
          error: 'project and agent are required',
        });
        return;
      }
      const result = stopAgentDispatch(project, agent);
      if (result.status === 'stopped' && result.agentId) {
        setStatus(result.agentId, 'stopped');
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        ok: false, status: 'not-found',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // POST /org/inject — inject a message into a running agent (for supervisor)
  if (httpReq.method === 'POST' && route === '/org/inject') {
    try {
      const parsed = await readJsonBody(httpReq);
      if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
      const body = parsed.body as any;
      const project = str(body.project);
      const agent = str(body.agent);
      const fromName = str(body.fromName, 'Supervisor');
      const message = str(body.message);
      
      if (!project || !agent || !message) {
        sendJson(res, 400, {
          ok: false, status: 'not-found',
          error: 'project, agent, and message are required',
        });
        return;
      }

      const proj = storage.getProjectData(project);
      if (!proj) {
        sendJson(res, 404, { ok: false, error: 'Project not found' });
        return;
      }

      // Allow matching by name or id
      const targetAgent = proj.agents.find(a => a.id === agent || a.name.toLowerCase() === agent.toLowerCase());
      if (!targetAgent) {
        sendJson(res, 404, { ok: false, error: 'Agent not found' });
        return;
      }

      const status = agentStatus.get(targetAgent.id);
      if (status === 'awaiting_input' || status === 'idle') {
        sendJson(res, 400, { ok: false, error: 'Agent is waiting at a prompt. Delivering a message now would type it into the prompt.' });
        return;
      }

      const delivered = runtime.injectMessage(targetAgent.id, fromName, message);
      if (delivered) {
        emitAgentDispatch({
          projectId: proj.project.id,
          projectName: proj.project.name,
          agentName: targetAgent.name,
          fromName,
          message,
          status: 'delivered'
        });
      }
      
      sendJson(res, 200, { ok: true, delivered, agentId: targetAgent.id });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // POST /org/create-project — create a new project/team
  if (httpReq.method === 'POST' && route === '/org/create-project') {
    try {
      const parsed = await readJsonBody(httpReq);
      if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
      const body = parsed.body as any;
      const result = createProjectDispatch(
        str(body.name),
        str(body.cwd),
        str(body.description) || undefined,
      );
      if (result.ok) broadcast({ kind: 'event', event: 'org:changed' });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        ok: false, status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // POST /org/create-agent — add an agent to a project
  if (httpReq.method === 'POST' && route === '/org/create-agent') {
    try {
      const parsed = await readJsonBody(httpReq);
      if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
      const body = parsed.body as any;
      const result = createAgentDispatch(
        str(body.project),
        str(body.name),
        str(body.cli),
        str(body.role) || undefined,
        str(body.cwd) || undefined,
      );
      if (result.ok) broadcast({ kind: 'event', event: 'org:changed' });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        ok: false, status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (httpReq.method === 'GET' && route === '/health') {
    sendJson(res, 200, { ok: true, pid: process.pid, startedAt });
    return;
  }

  res.writeHead(404);
  res.end();
}

// ─────────────────────────── Server bootstrap ───────────────────────────

const httpServer = createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    console.error('[daemon] http error:', err);
    try { res.writeHead(500); res.end(); } catch { /* already sent */ }
  });
});
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  clients.add(ws);
  clientListeners.set(ws, new Map());
  clientWanted.set(ws, new Set());
  console.log(`[daemon] web client connected (${clients.size} total)`);

  send(ws, { kind: 'hello', pid: process.pid, startedAt });

  // Replay current statuses so a freshly (re)started web server is in sync
  for (const [agentId, status] of agentStatus) {
    send(ws, { kind: 'event', event: 'agent:status', agentId, status });
  }

  ws.on('message', (raw) => {
    let req: DaemonRequest;
    try {
      req = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleRequest(ws, req).catch((err) => console.error('[daemon] request error:', err));
  });

  ws.on('close', () => {
    const teardowns = clientListeners.get(ws);
    if (teardowns) {
      for (const [, teardown] of teardowns) teardown();
      teardowns.clear();
    }
    clients.delete(ws);
    console.log(`[daemon] web client disconnected (${clients.size} total)`);
  });
});

httpServer.listen(DAEMON_PORT, DAEMON_HOST, () => {
  console.log(`[daemon] conduit-daemon listening on ${DAEMON_HOST}:${DAEMON_PORT} (pid ${process.pid})`);
  console.log(`[daemon]   ws://${DAEMON_HOST}:${DAEMON_PORT}  — web client`);
  console.log(`[daemon]   http://${DAEMON_HOST}:${DAEMON_PORT}/hook/:agentId/:event  — lifecycle hooks`);
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[daemon] port ${DAEMON_PORT} is already in use — is another conduit-daemon running? (set CONDUIT_DAEMON_PORT to change it)`);
  } else {
    console.error('[daemon] server error:', err);
  }
  process.exit(1);
});

// Graceful shutdown — kill every PTY so nothing is orphaned.
function shutdown(signal: string) {
  console.log(`[daemon] ${signal} — killing all agents...`);
  for (const agentId of runtime.getRunningAgentIds()) {
    try { runtime.stopAgent(agentId); } catch { /* best-effort */ }
  }
  process.exit(0);
}

// Never let one bad event take the whole daemon (and every agent) down.
process.on('uncaughtException', (err) => {
  console.error('[daemon] uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[daemon] unhandled rejection:', err);
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}
