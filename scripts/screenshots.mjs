#!/usr/bin/env node
/**
 * Regenerate every screenshot in the README by driving the real UI.
 *
 * The images cannot drift from what Conduit actually renders, because they are
 * produced by clicking through the running application in a real browser
 * rather than being captured by hand and forgotten.
 *
 * It seeds its own project and agents, shoots each surface, then deletes what
 * it made — so it is safe to run against an instance you care about, and does
 * not depend on whatever happens to be on screen.
 *
 * Usage:
 *   npm run start:all          # in one shell
 *   node scripts/screenshots.mjs
 *
 * Env: CONDUIT_URL, CONDUIT_AUTH, SHOTS_DIR (default docs/screenshots)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const BASE = process.env.CONDUIT_URL || 'http://localhost:3200';
const AUTH = process.env.CONDUIT_AUTH || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.env.SHOTS_DIR || 'docs/screenshots');
const PORT = 9822;
const WIDTH = 1440;
const HEIGHT = 900;

const headers = { 'Content-Type': 'application/json' };
if (AUTH) headers.Authorization = 'Basic ' + Buffer.from(AUTH).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, p, body) {
  const res = await fetch(BASE + '/api' + p, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`Conduit is not running on ${BASE} — start it with \`npm run start:all\`.`);
  process.exit(2);
}

const bin = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find((p) => fs.existsSync(p));
if (!bin) { console.error('No Chromium-based browser found; set BROWSER=<path>'); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });

// ── seed a project worth photographing ────────────────────────────────
const projName = 'demo-' + Date.now().toString(36);
const projCwd = path.join(os.tmpdir(), projName);
fs.mkdirSync(projCwd, { recursive: true });
fs.writeFileSync(path.join(projCwd, 'notes.md'),
  '# Release notes\n- auth: cookie expiry should be 7 days, not 30\n- ws: backoff should be exponential\n');

const created = await api('POST', '/projects', {
  name: projName, cwd: projCwd, description: 'Screenshot fixture',
});
if (created.status !== 201) {
  console.error('could not create the fixture project:', created.status, created.json);
  process.exit(2);
}
const projectId = created.json.id;

for (const [name, cli, role] of [
  ['Claude', 'claude', 'lead'],
  ['Gemini', 'gemini', 'tests'],
  ['Nemotron', 'nemotron', 'docs'],
]) {
  await api('POST', `/projects/${projectId}/agents`, { name, cli, role });
}
await api('POST', `/projects/${projectId}/wiki/initialize`).catch(() => {});

// Hold the routine approvals for a human, for the length of this run.
//
// Conduit answers y/n prompts itself now, and aider asks about the git repo
// within a few seconds of starting — so the one gate this fixture reliably
// produces was being raised, auto-approved and forgotten long before the gate
// screenshot was taken. Off before the agents boot, restored at the end, in a
// finally so an early exit cannot leave the user's own setting flipped.
const priorGateSettings = (await api('GET', '/gate-settings')).json;
await api('PUT', '/gate-settings', { autoApproveRoutine: false });
const restoreGateSettings = async () => {
  await api('PUT', '/gate-settings', {
    autoApproveRoutine: priorGateSettings?.autoApproveRoutine !== false,
  }).catch(() => { /* the server may already be gone */ });
};

// Start whichever agents this machine can actually run. An empty terminal is
// a photograph of nothing, and the point of these images is the real thing.
const seeded = (await api('GET', `/projects/${projectId}/agents`)).json || [];
const startable = [];
for (const a of seeded) {
  const r = await api('POST', `/projects/${projectId}/agents/${a.id}/start`);
  if (r.status === 200) startable.push(a);
}
if (startable.length) {
  console.log(`  (started ${startable.length} agent${startable.length === 1 ? '' : 's'} for the shots)`);
  await sleep(9000);            // let them paint their banners
}
// Shared files, written after the watcher is up so they appear in Activity.
for (const [filename, content] of [
  ['findings.md', '# Findings\n\n- `auth.ts` sets a 30-day cookie; the spec says 7.\n- The websocket reconnect is a fixed 1s, not exponential.\n'],
  ['plan.md', '# Plan\n\n1. Fix the cookie expiry and add a test.\n2. Make the reconnect back off.\n3. Hand the diff to review.\n'],
]) {
  await api('POST', `/projects/${projectId}/content`, { filename, content, createdBy: 'Claude' });
  await sleep(400);
}

await api('POST', `/projects/${projectId}/groupchat`, {
  message: 'Status check: what is everyone working on?',
});

// ── drive the browser ─────────────────────────────────────────────────
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-shots-'));
const child = spawn(bin, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
  // A system-installed extension (Malwarebytes Browser Guard) put its own
  // panel over the corner of a shot and swallowed the click underneath it.
  '--disable-extensions', '--disable-component-extensions-with-background-pages',
  '--disable-features=Translate,MediaRouter',
  '--no-first-run', '--no-default-browser-check',
  `--window-size=${WIDTH},${HEIGHT}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    wsUrl = v.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
  if (!wsUrl) await sleep(500);
}
if (!wsUrl) { child.kill(); console.error('browser did not start'); process.exit(2); }

const cdp = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
let msgId = 0;
const pending = new Map();
let sessionId = null;
// Anything the page throws while it is being photographed is a bug in the
// photograph as much as in the app — a screenshot of a broken render is worse
// than no screenshot, because it looks fine.
const pageErrors = [];
cdp.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    pageErrors.push(d?.exception?.description || d?.text || 'unknown exception');
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    pageErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
});
await new Promise((r) => cdp.on('open', r));

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

// Attach to the page target so screenshots come from the tab, not the browser.
const targets = await send('Target.getTargets');
const page = targets.result.targetInfos.find((t) => t.type === 'page');
const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
sessionId = attached.result.sessionId;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
});

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  });
  return r?.result?.result?.value ?? null;
};

async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(1200);
  // The tour pops up over the corner of every first-run screenshot.
  await evalJs(`
    localStorage.setItem('conduit-onboarding-completed', '1');
    localStorage.setItem('conduit-onboarding-skipped', '1');
    return true;
  `);
  await send('Page.reload');
  await sleep(2200);
}

/** Select the fixture project by exact name, not by being first in the list. */
async function openFixtureProject() {
  const ok = await evalJs(`
    const el = [...document.querySelectorAll('.sb-project')]
      .find(e => e.textContent.trim().startsWith(${JSON.stringify(projName)}));
    if (!el) return false;
    el.click();
    return true;
  `);
  await sleep(1800);
  return ok;
}

/** Poll for a gate an agent actually raised. aider asks before it edits. */
async function waitForGate(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const agents = (await api('GET', `/projects/${projectId}/agents`)).json || [];
    if (agents.some((a) => a.pendingGate)) return true;
    await sleep(700);
  }
  return false;
}

/** Clear every pending gate, so the modal stops covering the next screenshot. */
async function clearGates() {
  const agents = (await api('GET', `/projects/${projectId}/agents`)).json || [];
  let cleared = 0;
  for (const a of agents.filter((x) => x.pendingGate)) {
    await api('POST', `/projects/${projectId}/agents/${a.id}/gate/resolve`, { decision: 'approve' });
    cleared++;
  }
  // Resolving a gate unblocks the agent, and the terminal repaints for a
  // second or two afterwards. Let it settle before the next shot.
  if (cleared) await sleep(3000);
  return cleared;
}

async function shot(name, caption) {
  // Headless keeps stale compositor tiles under a backdrop-filter, which shows
  // up as a ghost of the previous frame behind a modal. Nudging the viewport
  // invalidates them, so what is captured is what is actually on screen.
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT + 1, deviceScaleFactor: 2, mobile: false,
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
  });
  await sleep(400);
  // JPEG, not PNG.
  //
  // PNG is lossless and therefore hopeless at photographs, and the landing
  // page has a full-bleed photographic background: the same shot is 3.4MB as a
  // PNG and about a tenth of that as a JPEG at quality 86, with no difference
  // anyone can see in a README. The whole set went from 2.7MB to 9MB the first
  // time it was regenerated against the new landing design, which is a lot of
  // repository to spend on eight pictures.
  //
  // Quality 86 at deviceScaleFactor 2 keeps small UI text crisp; below about
  // 80 the 10px labels start to fringe.
  const r = await send('Page.captureScreenshot', {
    format: 'jpeg', quality: 86, captureBeyondViewport: false,
  });
  if (!r?.result?.data) { console.log(`  ✗ ${name} — no image returned`); return false; }
  const file = path.join(OUT, `${name}.jpg`);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`  ✓ ${name}.jpg  ${String(kb).padStart(4)} KB  — ${caption}`);
  return true;
}

/** Click by visible text, the way a person would. */
const clickText = (selector, text) => evalJs(`
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(e => e.textContent.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
  if (el) { el.click(); return true; }
  return false;
`);

console.log(`\nScreenshots → ${path.relative(ROOT, OUT)}\n`);
let shots = 0;

try {
  // 1. The landing page.
  await goto(BASE + '/');
  if (await shot('landing', 'the front page')) shots++;

  // 2. The console, on the seeded project.
  await goto(BASE + '/#console');
  if (!(await openFixtureProject())) {
    console.log('  ! could not select the fixture project — shots may show another one');
  }
  // An approval gate — the real modal over the real terminals, not a mock.
  //
  // Routine y/n prompts are answered by Conduit itself now, so aider's "no git
  // repo, create one?" never reaches a human and this shot silently stopped
  // being taken. Turn auto-approval off for the length of the shot and put it
  // back afterwards: the gate is still a real one an agent actually raised,
  // it is just being shown to a person instead of answered.
  if (await waitForGate(25000)) {
    await sleep(900);
    if (await shot('gate', 'an agent is paused until you decide')) shots++;
  } else {
    console.log('  ! no agent raised a gate in 25s — keeping the previous gate shot');
  }
  await clearGates();
  if (await shot('console', 'agent panes, status strip and the Keeper bar')) shots++;

  // 3. Group chat — the Supervisor's stream.
  await clearGates();
  if (await clickText('.gr-tab', 'group chat')) {
    await sleep(1200);
    if (await shot('groupchat', 'one stream per project: your messages and Supervisor summaries')) shots++;
  }

  // 4. The wiki.
  await clearGates();
  if (await clickText('.gr-tab', 'wiki')) {
    await sleep(1200);
    if (await shot('wiki', "the project's living knowledge base, written by its agents")) shots++;
  }

  // 5. Activity.
  await clearGates();
  if (await clickText('.gr-tab', 'activity')) {
    await sleep(1000);
    if (await shot('activity', 'every file change and agent message, in order')) shots++;
  }

  // 6. Voice settings — where the engines are chosen.
  await clearGates();
  await clickText('.gr-tab', 'terminals');
  await sleep(600);
  await evalJs(`
    // The header was restyled and the button's title went from "Voice settings"
    // to "Settings"; matching the old string silently photographed the console
    // instead, which looks like a working shot until you read it.
    const btn = [...document.querySelectorAll('button')]
      .find(b => /^settings$/i.test((b.title || '').trim())
              || (b.title || '').toLowerCase().includes('settings'));
    if (btn) { btn.click(); return true; } return false;
  `);
  await sleep(1200);
  if (await shot('settings', 'speech engines: browser, Groq, OpenAI or Gemini')) shots++;
  await evalJs(`document.querySelector('.modal-overlay')?.click(); return true;`);
  await sleep(500);

  // 7. The download modal, listing what the server can actually serve.
  await goto(BASE + '/');
  await clickText('button', 'download');
  await sleep(1500);
  if (await shot('downloads', 'only builds that exist on disk, with their real sizes')) shots++;
} finally {
  await restoreGateSettings();
  cdp.close();
  child.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  await api('DELETE', `/projects/${projectId}?removeData=true`).catch(() => {});
  try { fs.rmSync(projCwd, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${shots} screenshot${shots === 1 ? '' : 's'} written to ${path.relative(ROOT, OUT)}`);
if (pageErrors.length) {
  console.log(`\n${pageErrors.length} console error${pageErrors.length === 1 ? '' : 's'} while shooting:`);
  for (const e of pageErrors.slice(0, 10)) console.log(`  ✗ ${String(e).split('\n')[0].slice(0, 160)}`);
} else {
  console.log('no console errors while driving the UI');
}
console.log('');
process.exit(shots > 0 && pageErrors.length === 0 ? 0 : 1);
