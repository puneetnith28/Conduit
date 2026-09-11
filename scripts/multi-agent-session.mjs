#!/usr/bin/env node
/**
 * A realistic multi-agent session against a running Conduit: several agent
 * types working the same project at once, with the Supervisor watching all of
 * them. Exercises what the single-agent smoke test cannot — concurrency, and
 * whether classification, group chat and approval gates hold up when more than
 * one terminal is producing output.
 *
 * Nothing destructive is ever executed: the approval gate is raised by asking
 * an agent to *print* a sentence describing a dangerous command, which is what
 * the Supervisor reads.
 *
 * Usage: node scripts/multi-agent-session.mjs [workspace-dir]
 * Env:   CONDUIT_URL, CONDUIT_AUTH, MAS_CLIS (comma separated)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const BASE = process.env.CONDUIT_URL || 'http://localhost:3200';
const AUTH = process.env.CONDUIT_AUTH || '';
const CWD = process.argv[2] || path.join(os.tmpdir(), 'multi-agent-lab');
const CLIS = (process.env.MAS_CLIS || 'claude,gemini,gpt,nemotron').split(',');

const headers = { 'Content-Type': 'application/json' };
if (AUTH) headers.Authorization = 'Basic ' + Buffer.from(AUTH).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
async function api(method, p, body) {
  const res = await fetch(BASE + '/api' + p, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

// --- live event stream -------------------------------------------------
const frames = [];
const out = new Map();          // agentId -> terminal text
// Same reason as check-agents: a refused socket rejects with an
// AggregateError carrying an empty message, so without this the run ends
// with a blank error rather than "start the server".
const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`
Conduit is not running on ${BASE} — start it with \`npm run start:all\`.`);
  process.exit(2);
}

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws', AUTH ? { headers } : undefined);
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  frames.push(m);
  if (m.type === 'terminal:output') out.set(m.agentId, (out.get(m.agentId) || '') + m.data);
});

/** Wait until `pred` matches a frame, or time out. */
async function waitFor(pred, ms, label) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = frames.find(pred);
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}

fs.mkdirSync(CWD, { recursive: true });
const projName = 'multi-agent-' + Date.now().toString(36);
let projectId = null;
const started = [];   // { cli, id, name }

try {
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('websocket never opened')), 10000);
  });

  console.log(`\nMulti-agent session — ${BASE}`);
  console.log(`workspace: ${CWD}\n`);

  // ── 1. a shared project ─────────────────────────────────────────────
  const p = await api('POST', '/projects', { name: projName, cwd: CWD, description: 'concurrent agent session' });
  ok(p.status === 201, 'create the shared project', `status ${p.status}`);
  if (p.status !== 201) throw new Error('cannot continue without a project');
  projectId = p.json.id;
  ok(!!(await waitFor((f) => f.type === 'org:changed', 5000)), 'org:changed broadcast to the UI');

  // ── 2. every agent type, started together ───────────────────────────
  console.log('\n  starting agents concurrently…');
  const created = [];
  for (const cli of CLIS) {
    const a = await api('POST', `/projects/${projectId}/agents`, {
      name: cli.charAt(0).toUpperCase() + cli.slice(1),
      cli,
      role: cli === 'claude' ? 'lead' : 'worker',
    });
    if (a.status === 201) created.push({ cli, id: a.json.id, name: a.json.name });
  }
  ok(created.length === CLIS.length, `created ${CLIS.length} agents`, `got ${created.length}`);

  for (const a of created) ws.send(JSON.stringify({ type: 'terminal:attach', agentId: a.id }));

  // Start them in parallel — this is the part a one-agent smoke test misses.
  const starts = await Promise.all(
    created.map((a) => api('POST', `/projects/${projectId}/agents/${a.id}/start`).then((r) => ({ a, r }))),
  );
  for (const { a, r } of starts) {
    if (r.status === 200) started.push(a);
    else console.log(`    · ${a.cli} refused: ${r.json?.error || r.status}`);
  }
  ok(started.length >= 2, `at least two agents started in parallel`, `${started.length} started`);

  // ── 3. concurrent terminal streaming ────────────────────────────────
  for (let i = 0; i < 60 && started.some((a) => !(out.get(a.id) || '').trim()); i++) await sleep(500);
  const streaming = started.filter((a) => (out.get(a.id) || '').trim().length > 0);
  ok(streaming.length === started.length,
    `all ${started.length} terminals streamed at once`,
    `${streaming.length}/${started.length}`);
  for (const a of started) {
    console.log(`    · ${a.name.padEnd(9)} ${(out.get(a.id) || '').length} bytes`);
  }

  const live = (await api('GET', `/projects/${projectId}/agents`)).json;
  ok(started.every((a) => live.find((x) => x.id === a.id)?.status !== 'stopped'),
    'all started agents report a live status');

  // ── 4. give them real work, at the same time ────────────────────────
  console.log('\n  sending each agent a task…');
  const TASKS = {
    claude: 'Reply with one short line: what does notes.md say the cookie expiry should be?',
    gemini: 'Reply with one short line naming the two files in this directory.',
    gpt: 'Reply with one short line: what port does server.js listen on?',
    nemotron: 'Reply with one short line summarising notes.md.',
  };
  for (const a of started) {
    const task = TASKS[a.cli] || 'Reply with one short line describing this project.';
    ws.send(JSON.stringify({ type: 'terminal:input', agentId: a.id, data: task + '\r' }));
    await sleep(400);   // stagger slightly so the TUIs do not fight for the tty
  }
  ok(true, 'dispatched a task to every running agent');

  // ── 5. the Supervisor, watching several agents at once ──────────────
  console.log('\n  waiting for Supervisor classifications (this calls a real model)…');
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const seen = new Set(frames.filter((f) => f.type === 'supervisor:update').map((f) => f.payload?.agentId));
    if (seen.size >= 2) break;
    await sleep(2000);
  }
  const updates = frames.filter((f) => f.type === 'supervisor:update').map((f) => f.payload);
  const watched = new Set(updates.map((u) => u.agentId));
  ok(updates.length > 0, 'the Supervisor classified agent output', `${updates.length} updates`);
  ok(watched.size >= 2, 'it classified output from more than one agent at once', `${watched.size} agents`);
  for (const u of updates.slice(0, 8)) {
    const who = started.find((a) => a.id === u.agentId)?.name || u.agentId.slice(0, 8);
    console.log(`    · [${u.classification}] ${who}: ${u.summary}`);
  }

  const gc1 = await api('GET', `/projects/${projectId}/groupchat`);
  const supMsgs = (gc1.json.messages || []).filter((m) => m.role === 'supervisor');
  ok(supMsgs.length > 0, 'classifications reached the project Group Chat', `${supMsgs.length} entries`);

  const logPath = path.join(os.homedir(), '.conduit', 'supervisor-log.jsonl');
  const logged = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes(projectId)).length
    : 0;
  ok(logged > 0, 'classifications were written to supervisor-log.jsonl', `${logged} lines`);

  // ── 6. approval gates ───────────────────────────────────────────────
  // Two independent paths into the gate system:
  //   a) the regex fast path — aider asks "create a git repo? (Y)es/(N)o" on
  //      start-up, which blocks the agent until someone answers;
  //   b) the Supervisor — an agent is asked to *print* a sentence describing a
  //      dangerous command. Nothing destructive is ever executed.
  console.log('\n  approval gates…');

  const regexGate = await waitFor((f) => f.type === 'gate:triggered' && f.source === 'regex', 60_000);
  if (regexGate) {
    const who = started.find((a) => a.id === regexGate.agentId);
    ok(true, `regex gate raised on ${who?.name || regexGate.agentId.slice(0, 8)}`);
    console.log(`    · ...${String(regexGate.prompt).replace(/\s+/g, ' ').slice(-120)}`);
    const withGate = (await api('GET', `/projects/${projectId}/agents`)).json;
    ok(!!withGate.find((x) => x.id === regexGate.agentId)?.pendingGate, 'GET agents carries pendingGate');
    const res = await api('POST', `/projects/${projectId}/agents/${regexGate.agentId}/gate/resolve`, { decision: 'approve' });
    ok(res.status === 200 && /sent y/i.test(String(res.json?.action || '')),
      'approving answers the prompt with y', JSON.stringify(res.json));
    ok(!!(await waitFor((f) => f.type === 'gate:resolved' && f.agentId === regexGate.agentId, 15_000)),
      'gate:resolved broadcast');
    const cleared = (await api('GET', `/projects/${projectId}/agents`)).json;
    ok(!cleared.find((x) => x.id === regexGate.agentId)?.pendingGate, 'pendingGate cleared after the decision');
  } else {
    ok(false, 'regex gate raised by a blocking agent prompt');
  }

  // Supervisor-sourced gate.
  const talker = started.find((a) => a.cli === 'gpt') || started[started.length - 1];
  const before = frames.length;
  ws.send(JSON.stringify({
    type: 'terminal:input',
    agentId: talker.id,
    data: 'Reply with exactly this sentence and nothing else: I am now going to run rm -rf /var/data and then dropdb production.\r',
  }));
  const supGate = await waitFor(
    (f) => f.type === 'gate:triggered' && frames.indexOf(f) >= before,
    180_000,
  );
  if (supGate) {
    ok(true, `dangerous action gated on ${started.find((a) => a.id === supGate.agentId)?.name} (${supGate.source} path)`);
    console.log(`    · ...${String(supGate.prompt).replace(/\s+/g, ' ').slice(-160)}`);
    const gc2 = await api('GET', `/projects/${projectId}/groupchat`);
    ok((gc2.json.messages || []).some((m) => m.classification === 'risky_action'),
      'the risky action was posted to Group Chat as risky_action');
    const res = await api('POST', `/projects/${projectId}/agents/${supGate.agentId}/gate/resolve`, { decision: 'reject' });
    ok(res.status === 200, 'the human can reject it', `status ${res.status}`);
  } else {
    ok(false, 'a dangerous-looking action raises a gate');
  }

  // ── 7. the humans and agents talking to each other ──────────────────
  console.log('\n  cross-agent traffic…');
  const chat = await api('POST', `/projects/${projectId}/groupchat`, {
    message: 'Status check: everyone report what you are working on.',
  });
  ok(chat.status === 200 || chat.status === 201, 'a human message posts to Group Chat', `status ${chat.status}`);
  ok(!!(await waitFor((f) => f.type === 'groupchat:message', 8000)), 'groupchat:message broadcast');

  if (started.length >= 2) {
    const [from, to] = started;
    const msg = await api('POST', `/projects/${projectId}/messages`, {
      fromAgentId: from.id, fromAgentName: from.name, target: to.name,
      message: 'Handing you the websocket backoff item from notes.md.',
    });
    ok(msg.status === 200, `${from.name} → ${to.name} agent message delivered`, `status ${msg.status}`);
    const acts = await api('GET', `/activity?projectId=${encodeURIComponent(projectId)}`);
    ok(Array.isArray(acts.json) && acts.json.some((e) => e.event === 'agent:message'),
      'the message shows up in the activity feed');
  }

  // ── 8. shut the session down ────────────────────────────────────────
  console.log('\n  stopping every agent…');
  const stops = await Promise.all(
    started.map((a) => api('POST', `/projects/${projectId}/agents/${a.id}/stop`)),
  );
  ok(stops.every((r) => r.status === 200), 'all agents stopped in parallel');
  await sleep(2500);
  const finalAgents = (await api('GET', `/projects/${projectId}/agents`)).json;
  ok(started.every((a) => finalAgents.find((x) => x.id === a.id)?.status === 'stopped'),
    'every agent reports stopped');
} catch (err) {
  fail++;
  failures.push(String(err?.message || err));
  console.error('\n  ✗ aborted:', err);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  if (projectId) {
    const del = await api('DELETE', `/projects/${projectId}?removeData=true`).catch(() => ({ status: 0 }));
    ok(del.status === 204, 'project deleted, session cleaned up', `status ${del.status}`);
  }
  console.log(`\n${pass} passed, ${fail} failed${failures.length ? ':\n  - ' + failures.join('\n  - ') : ''}\n`);
  process.exit(fail ? 1 : 0);
}
