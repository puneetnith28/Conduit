#!/usr/bin/env node
/**
 * Does the packaged desktop app actually work?
 *
 * The web checks all run against `npm run start:all`, which proves nothing
 * about the Electron build: the desktop app spawns its own daemon and web
 * server as child processes, runs from an install directory where the repo
 * `.env` is not visible, and loads node-pty as an unpacked native module. Each
 * of those has broken independently of anything the web app does.
 *
 * So this drives the real executable:
 *   - launches it with nothing else on the port, so it must start its own
 *     daemon rather than attaching to one that is already there
 *   - waits for /api/health to report `daemon: true`
 *   - creates a project and starts a real agent through the running app
 *   - asserts the terminal produced output — a pane that renders but prints
 *     nothing is the failure mode that looks like success
 *   - asserts the renderer logged no errors
 *   - closes the window and asserts the agent process died with it
 *
 * That last one matters most: an orphaned agent holds the user's CPU and their
 * API budget after they think they have quit.
 *
 * Usage:
 *   npm run build:desktop     # once
 *   npm run check:desktop
 *
 * Env: CONDUIT_EXE (path to Conduit.exe / Conduit), DESKTOP_CLI (comma-list of
 * agent types to try, default all six)
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3200;
const CDP_PORT = 9833;
const CLIS = (process.env.DESKTOP_CLI || 'claude,codex,gemini,opencode,gpt,nemotron').split(',');
/** Cheap, and it cannot answer without actually calling a tool. */
const KEEPER_QUESTION = 'List every project you can see, then stop. One line.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function t(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
  return ok;
}

async function api(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

function health() {
  return fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json()).catch(() => null);
}

// ── find the executable ───────────────────────────────────────────────
const candidates = [
  process.env.CONDUIT_EXE,
  path.join(ROOT, 'dist-desktop', 'win-unpacked', 'Conduit.exe'),
  path.join(ROOT, 'dist-desktop', 'mac', 'Conduit.app', 'Contents', 'MacOS', 'Conduit'),
  path.join(ROOT, 'dist-desktop', 'linux-unpacked', 'conduit'),
].filter(Boolean);
const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('No packaged app found. Build one with `npm run build:desktop`.');
  process.exit(2);
}

// The desktop app attaches to a Conduit already on the port instead of
// starting its own — which would test the wrong thing entirely.
const squatter = await health();
if (squatter) {
  console.error(`Something is already serving :${PORT}. Stop it first, or this checks that instead of the app.`);
  process.exit(2);
}

console.log(`\nDesktop app — ${path.relative(ROOT, exe)}\n`);

// ── launch ────────────────────────────────────────────────────────────
const env = { ...process.env };
// Set in a shell, this makes the Electron binary behave as plain node and the
// app never starts. It is not ours to inherit.
delete env.ELECTRON_RUN_AS_NODE;

const app = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`], {
  env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
});
let appOutput = '';
app.stdout.on('data', (d) => { appOutput += d.toString(); });
app.stderr.on('data', (d) => { appOutput += d.toString(); });
let appExited = false;
app.on('exit', () => { appExited = true; });

let projectId = null;
let fixtureName = null;
let fixtureCwd = null;
let descendants = [];
const agentIds = [];

try {
  // ── it comes up on its own ───────────────────────────────────────────
  let ready = null;
  for (let i = 0; i < 90 && !ready; i++) {
    if (appExited) break;
    const h = await health();
    if (h?.ok && h.daemon) ready = h;
    else await sleep(1000);
  }
  if (!t(!!ready, 'the app starts its own daemon and web server',
         appExited ? `process exited: ${appOutput.slice(-300)}` : 'timed out after 90s')) {
    throw new Error('never became ready');
  }

  t(ready.daemon === true, 'the web server reports the daemon is connected');
  // The packaged app runs from its install directory, so the repo .env is not
  // visible to it — ~/.conduit/.env is the only config file it can see.
  const userEnv = path.join(os.homedir(), '.conduit', '.env');
  const sawUserEnv = (ready.envFiles || []).some((f) => path.resolve(f) === path.resolve(userEnv));
  t(!fs.existsSync(userEnv) || sawUserEnv,
    'it loads ~/.conduit/.env, the only config file it can see',
    `envFiles: ${JSON.stringify(ready.envFiles)}`);
  // Credentials reaching the packaged app is the whole reason ~/.conduit/.env
  // exists — without them the Supervisor backs off and every gate falls to the
  // regex path, which the user would only discover from a log line.
  t(ready.supervisor === 'on' && (ready.anthropicCredential || ready.bedrockModel),
    'the Supervisor has a credential in the packaged app',
    `supervisor=${ready.supervisor} anthropic=${ready.anthropicCredential}`);

  // ── the renderer actually rendered ──────────────────────────────────
  let cdp = null;
  const pageErrors = [];
  try {
    const { WebSocket } = await import('ws');
    let wsUrl = null;
    let pageId = null;
    for (let i = 0; i < 20 && !wsUrl; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const page = targets.find((x) => x.type === 'page' && /:3200\//.test(x.url || ''));
        wsUrl = page?.webSocketDebuggerUrl || null;
        pageId = page?.id || null;
      } catch { /* not up yet */ }
      if (!wsUrl) await sleep(1000);
    }
    if (wsUrl) {
      cdp = new WebSocket(wsUrl);
      await new Promise((r, j) => { cdp.on('open', r); cdp.on('error', j); });
      let id = 0;
      const pending = new Map();
      cdp.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
        if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params?.exceptionDetails;
          pageErrors.push(d?.exception?.description || d?.text || 'exception');
        } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
          pageErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
        }
      });
      const send = (method, params = {}) => new Promise((resolve) => {
        const n = ++id; pending.set(n, resolve);
        cdp.send(JSON.stringify({ id: n, method, params }));
      });
      await send('Runtime.enable');
      const r = await send('Runtime.evaluate', {
        expression: `JSON.stringify({ mounted: !!document.querySelector('#root')?.firstElementChild, title: document.title })`,
        returnByValue: true,
      });
      const info = JSON.parse(r?.result?.result?.value || '{}');
      t(info.mounted === true, 'the React app mounted inside the Electron window',
        JSON.stringify(info));
      t(info.title === 'Conduit', 'the window is showing Conduit', info.title);

      // Agent output is rendered as markdown, and a markdown link becomes a
      // real <a target="_blank">. With no window-open handler Electron loaded
      // the remote page *inside the application*, preload and all, with no
      // address bar to say where the user had ended up — and `location.href`
      // navigated the control centre itself away, with no way back.
      const listTargets = async () =>
        await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json().catch(() => []);
      const probe = 'https://example.com/conduit-external-link-probe';
      await send('Runtime.evaluate', {
        expression: `(() => {
          const a = document.createElement('a');
          a.href = ${JSON.stringify(probe)}; a.target = '_blank'; a.rel = 'noopener noreferrer';
          document.body.appendChild(a); a.click(); a.remove();
          window.open(${JSON.stringify(probe)});
          return true;
        })()`,
        returnByValue: true,
      });
      await sleep(3000);
      const leaked = (await listTargets()).filter((x) => String(x.url || '').includes('example.com'));
      t(leaked.length === 0, 'an external link does not open inside the app',
        leaked.map((x) => `${x.type} ${x.url}`).join(', '));

      await send('Runtime.evaluate', {
        expression: `location.href = ${JSON.stringify(probe)}; true`,
        returnByValue: true,
      });
      await sleep(3000);
      const here = (await listTargets()).find((x) => x.id === pageId)?.url || '';
      t(/:3200\//.test(here), 'and cannot navigate the app window away from Conduit', here);
    } else {
      t(false, 'the renderer was reachable over CDP', `nothing on :${CDP_PORT}`);
    }
  } catch (err) {
    t(false, 'the renderer was reachable over CDP', String(err).slice(0, 160));
  }

  // ── a real agent, in a real terminal, inside the packaged app ────────
  fixtureName = 'desktop-check-' + Date.now().toString(36);
  fixtureCwd = path.join(os.tmpdir(), fixtureName);
  fs.mkdirSync(fixtureCwd, { recursive: true });

  const created = await api('POST', '/projects', { name: fixtureName, cwd: fixtureCwd });
  if (!t(created.status === 201, 'a project can be created through the running app',
         `${created.status} ${JSON.stringify(created.json)}`)) throw new Error('no project');
  projectId = created.json.id;

  // Every CLI, not just one. The packaged app inherits the PATH Windows gives
  // a double-clicked program, which is not the PATH of the shell the developer
  // tested in — an agent that works under `npm run dev` can be missing here.
  const { WebSocket: WS } = await import('ws');
  const stream = new WS(`ws://127.0.0.1:${PORT}/ws`);
  const output = new Map();
  stream.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'terminal:output') output.set(m.agentId, (output.get(m.agentId) || '') + m.data);
      if (m.type === 'codex:item') output.set(m.agentId, (output.get(m.agentId) || '') + '[item]');
    } catch { /* not for us */ }
  });
  await new Promise((r, j) => { stream.on('open', r); stream.on('error', j); });

  for (const cli of CLIS) {
    const made = await api('POST', `/projects/${projectId}/agents`, { name: cli, cli });
    if (!t(made.status === 201, `${cli.padEnd(9)} agent created`, String(made.status))) continue;
    const agentId = made.json.id;
    stream.send(JSON.stringify({ type: 'terminal:attach', agentId }));

    const started = await api('POST', `/projects/${projectId}/agents/${agentId}/start`);
    if (started.status !== 200) {
      // A missing CLI refused with an explanation is correct behaviour, and is
      // the whole point of the start-up preflight. Silence would not be.
      const why = String(started.json?.error || '').split('\n')[0];
      t(started.status === 400 && why.length > 10,
        `${cli.padEnd(9)} refused with a reason — ${why.slice(0, 70)}`,
        `${started.status} ${JSON.stringify(started.json)}`);
      continue;
    }
    agentIds.push(agentId);
    // A pane that renders but never prints is the failure that looks like
    // success, so count real bytes off the stream the browser uses.
    for (let i = 0; i < 40 && (output.get(agentId) || '').trim().length < 40; i++) await sleep(500);
    const bytes = (output.get(agentId) || '').trim().length;
    // Same trap as check-agents: the trust prompt is output, so a byte
    // count alone reports a blocked agent as a working one.
    const text = output.get(id) || '';
    const blocked = /trust\s*this\s*folder/i.test(text)
      || /Is\s*this\s*a\s*project\s*you\s*created/i.test(text);
    if (blocked) t(false, `${cli.padEnd(9)} is blocked on the workspace trust prompt`);
    t(bytes >= 40 && !blocked, `${cli.padEnd(9)} running — ${bytes} bytes of terminal output`,
      'started but printed nothing');
  }
  try { stream.close(); } catch { /* ignore */ }

  // ── The Keeper, from inside the packaged app ────────────────────────
  // It runs an external CLI (`codex exec` or `claude -p`) with an MCP server
  // whose path is resolved relative to the install directory. That resolution
  // has been wrong before — .js against an emitted .mjs — and the symptom was
  // an orchestrator with no tools that still answered, so it looked fine.
  const keeper = await askKeeper();
  t(keeper.answered, `The Keeper answered on the ${keeper.engine || 'unknown'} engine`,
    keeper.error || 'no reply before the timeout');
  t(keeper.tools > 0, 'The Keeper could reach its tools — the MCP server resolved',
    `${keeper.tools} tool call(s)`);

  // node-pty gives no usable pid on Windows, so ask the OS instead: every
  // process descending from the app is something the app is responsible for
  // killing when it quits.
  descendants = processTree(app.pid);
  t(descendants.length >= 2,
    `the app owns a process tree — daemon, web server and ${agentIds.length} agent(s)`,
    `${descendants.length} descendant process(es)`);

  t(pageErrors.length === 0, 'the renderer logged no errors',
    pageErrors.slice(0, 3).map((e) => String(e).split('\n')[0]).join(' | '));

  try { cdp?.close(); } catch { /* ignore */ }
} catch (err) {
  console.log(`  ! ${String(err).slice(0, 200)}`);
} finally {
  // ── quitting must take the agents with it ───────────────────────────
  // Deliberately NOT stopping the agent first: the question is whether closing
  // the window kills it, and deleting the project beforehand would answer a
  // different one. Storage is cleaned up from disk afterwards instead.
  const closed = closeGracefully(app.pid);
  for (let i = 0; i < 30 && !appExited; i++) await sleep(500);
  t(appExited, 'the app exits when its window is closed',
    closed ? 'still running after 15s' : 'could not send a close request');

  // Give them time to go, and *watch* them go.
  //
  // This used to sleep 3s and assert once. Six agent processes — two of them
  // Python under aider — do not always finish unwinding in three seconds, so a
  // slow exit was reported as an orphaned agent. Worse, the cleanup loop below
  // kills any survivor immediately afterwards, so the evidence was gone before
  // anyone could tell the two apart.
  //
  // An orphan is a process that is *still there*, not one that takes an extra
  // second. Poll for 20s and report how long the last one took.
  const ORPHAN_GRACE_MS = 20_000;
  const waitStarted = Date.now();
  let survivors = descendants.filter(isAlive);
  while (survivors.length && Date.now() - waitStarted < ORPHAN_GRACE_MS) {
    await sleep(500);
    survivors = descendants.filter(isAlive);
  }
  const tookMs = Date.now() - waitStarted;
  t(survivors.length === 0,
    'every process it started died with it — no orphaned agents',
    `${survivors.length} still alive after ${Math.round(ORPHAN_GRACE_MS / 1000)}s: ${survivors.join(', ')}`);
  if (survivors.length === 0 && tookMs > 3000) {
    console.log(`    (the last one took ${(tookMs / 1000).toFixed(1)}s to exit)`);
  }
  const stillServing = await health();
  t(!stillServing, 'nothing is left listening on the port');

  if (!appExited) { try { process.kill(app.pid); } catch { /* ignore */ } }
  for (const pid of descendants.filter(isAlive)) {
    try { process.kill(pid); } catch { /* ignore */ }
  }
  cleanUpStorage();
}

/** The app is gone, so remove what the check left in ~/.conduit by hand. */
function cleanUpStorage() {
  const home = path.join(os.homedir(), '.conduit');
  for (const p of [
    projectId && path.join(home, 'projects', projectId),
    fixtureName && path.join(home, 'shared_content', fixtureName),
    fixtureName && path.join(home, 'wiki', fixtureName),
    fixtureCwd,
  ]) {
    if (!p) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(`\n${failures === 0 ? 'the packaged app works' : `${failures} problem(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);

/** One Keeper turn, driven the way the UI drives it. */
async function askKeeper() {
  const { WebSocket: WS } = await import('ws');
  const ws = new WS(`ws://127.0.0.1:${PORT}/ws`);
  const out = { answered: false, tools: 0, engine: '', error: '' };
  let status = 'idle';
  let started = false;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type !== 'brain:event') return;
    const p = m.payload || {};
    if (p.kind === 'status') { status = p.status; if (p.status === 'thinking') started = true; }
    if (p.kind === 'state' && p.state?.engine) out.engine = p.state.engine;
    if (p.kind === 'append' && p.message) {
      if (p.message.tool) out.tools++;
      if (p.message.role === 'assistant' && String(p.message.text || '').trim()) out.answered = true;
      if (p.message.role === 'error') out.error = String(p.message.text || '').slice(0, 120);
    }
  });
  try {
    await new Promise((res, rej) => {
      ws.on('open', res); ws.on('error', rej);
      setTimeout(() => rej(new Error('socket never opened')), 10_000);
    });
    ws.send(JSON.stringify({ type: 'brain:send', message: KEEPER_QUESTION }));
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      if (out.error) break;
      if (started && status === 'idle') break;
    }
  } catch (err) {
    out.error = String(err).slice(0, 120);
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
  return out;
}

/** Ask the window to close, the way the user does — not a kill. */
function closeGracefully(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
    return true;
  } catch { return false; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Every process descending from `root`, however deep.
 *
 * node-pty reports no usable pid on Windows, so the only truthful way to ask
 * "did the app leave anything running" is to ask the operating system what it
 * started, before it is closed.
 */
function processTree(root) {
  const pairs = [];
  const parse = (text) => {
    for (const line of text.split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid) pairs.push([pid, ppid]);
    }
  };
  try {
    if (process.platform === 'win32') {
      parse(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.ParentProcessId }'],
        { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }));
    } else {
      parse(execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf-8' }));
    }
  } catch { return []; }

  const children = new Map();
  for (const [pid, ppid] of pairs) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const stack = [root];
  const seen = new Set([root]);
  while (stack.length) {
    for (const child of children.get(stack.pop()) || []) {
      if (seen.has(child)) continue;
      seen.add(child); out.push(child); stack.push(child);
    }
  }
  return out;
}
