#!/usr/bin/env node
/**
 * Loads the Conduit UI in a headless Chromium (Edge/Chrome) via the DevTools
 * protocol, waits for it to settle, and reports console errors + connection
 * state. Usage: node scripts/browser-check.mjs [url]
 * Env: BROWSER=path to chrome/msedge executable (auto-detected on Windows/mac/linux).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

// Only a bare argument is the URL — `--deep` and friends are flags, and
// treating one as the base made every request go to `--deep/api/...`.
const URL_ = process.argv.slice(2).find((a) => !a.startsWith('-'))
  || process.env.CONDUIT_URL
  || 'http://localhost:3200/';
const PORT = 9333 + Math.floor(Math.random() * 500);
const candidates = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);
const bin = candidates.find((p) => fs.existsSync(p));
if (!bin) { console.error('No Chromium-based browser found; set BROWSER=<path>'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-bc-'));
const child = spawn(bin, [
  '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nothing below can mean anything without a running instance, and failing at
// the browser stage blames the browser for a server that was never up.
const health = await fetch(URL_.replace(/\/$/, '') + '/api/health')
  .then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`\nConduit is not running on ${URL_} — start it with \`npm run start:all\`.`);
  process.exit(2);
}
async function browserWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('browser did not expose DevTools');
}

let exit = 0;
try {
  const ws = new WebSocket(await browserWs());
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const msgId = ++id;
    pending.set(msgId, res);
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  const evalText = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
    return r.result?.result?.value;
  };

  /**
   * Wait for the page to reach a state, rather than guessing how long it takes.
   *
   * These were all fixed sleeps, and they started failing intermittently when
   * the landing page gained a photographic background and animated demos —
   * three assertions going red in a row because the first one's 1500ms was no
   * longer enough for the sidebar to refresh, and everything after it depended
   * on that click landing. Nothing was wrong with the app.
   */
  const waitFor = async (expr, ms = 15_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if (await evalText(`!!(${expr})`)) return true; } catch { /* mid-navigation */ }
      await sleep(200);
    }
    return false;
  };

  await send('Page.navigate', { url: URL_ }, sessionId);
  await waitFor('document.querySelector("#root")?.firstElementChild');

  // `/` serves the marketing landing page; the dashboard is behind its CTA.
  // Click through so the rest of the checks run against the control center.
  const onLanding = await evalText('!!document.querySelector(".landing-btn-black")');
  if (onLanding) {
    console.log('  landing page shown — clicking "Open Control Center"');
    await evalText(`[...document.querySelectorAll('button')].find(b => /open control center/i.test(b.textContent))?.click()`);
    await waitFor('document.querySelector(".gr-tabs")');
  }

  const title = await evalText('document.title');
  const footer = await evalText('document.querySelector(".st-r")?.innerText || ""');
  const body = await evalText('document.body.innerText.slice(0, 300)');
  const hasApp = await evalText('!!document.querySelector(".app")');

  const errors = events.filter((e) =>
    e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'));

  console.log(`\nbrowser check → ${URL_}`);
  console.log(`  title:      ${title}`);
  console.log(`  app mounted: ${hasApp}`);
  console.log(`  footer:     ${footer.replace(/\s+/g, ' ').trim()}`);
  console.log(`  body:       ${String(body).replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  if (errors.length) {
    exit = 1;
    console.log(`  console errors (${errors.length}):`);
    for (const e of errors) {
      const d = e.params?.exceptionDetails?.exception?.description
        || e.params?.entry?.text
        || (e.params?.args || []).map((a) => a.value ?? a.description).join(' ');
      console.log('    - ' + String(d).split('\n')[0]);
    }
  } else {
    console.log('  console errors: none');
  }
  const connected = /(^|\s)connected/.test(footer) && !/reconnecting/.test(footer);
  console.log(`  websocket:  ${connected ? 'connected' : 'NOT connected'}`);
  if (!hasApp || !connected) exit = 1;

  // ── deep: drive the UI through a project ─────────────────────────────
  if (process.argv.includes('--deep')) {
    const api = URL_.replace(/\/$/, '') + '/api';
    const auth = process.env.CONDUIT_AUTH ? { Authorization: 'Basic ' + Buffer.from(process.env.CONDUIT_AUTH).toString('base64') } : {};
    const hdrs = { 'Content-Type': 'application/json', ...auth };
    const name = 'ui-check-' + Date.now().toString(36);
    const cwd = path.join(os.tmpdir(), 'conduit-smoke', name);
    const proj = await (await fetch(api + '/projects', { method: 'POST', headers: hdrs, body: JSON.stringify({ name, cwd }) })).json();
    let deepOk = true;
    const check = (cond, label) => { console.log(`  ${cond ? '✓' : '✗'} ${label}`); if (!cond) deepOk = false; };
    try {
      await fetch(`${api}/projects/${proj.id}/agents`, { method: 'POST', headers: hdrs, body: JSON.stringify({ name: 'Alpha', cli: 'claude' }) });
      // org:changed → sidebar refresh. A websocket round trip and a render,
      // so wait for the row rather than betting on how long that takes.
      await waitFor(`[...document.querySelectorAll('.sb-project .n')].some(e => e.textContent === ${JSON.stringify(name)})`);
      const inSidebar = await evalText(`[...document.querySelectorAll('.sb-project .n')].some(e => e.textContent === ${JSON.stringify(name)})`);
      check(inSidebar, 'new project appears in sidebar via org:changed');
      await evalText(`[...document.querySelectorAll('.sb-project')].find(b => b.textContent.includes(${JSON.stringify(name)}))?.click()`);
      await waitFor(`document.querySelector('.gr-tabs')`);
      check(await evalText(`!!document.querySelector('.gr-tabs')`), 'project view opens with tabs');
      await waitFor(`[...document.querySelectorAll('.pane-agent-name')].some(e => e.textContent === 'Alpha')`);
      check(await evalText(`[...document.querySelectorAll('.pane-agent-name')].some(e => e.textContent === 'Alpha')`), 'agent pane renders');
      // Match on what the pane *is*, not on how it is currently styled: a
      // refactor renamed the start button and this went red while the UI was
      // perfectly fine. A button inside the stopped pane that says "start" is
      // the actual contract.
      check(await evalText(`/agent stopped/i.test(document.body.innerText)
        && [...document.querySelectorAll('.pane-stopped button')]
             .some(b => /start/i.test(b.textContent || ''))`),
        'stopped agent shows start prompt');
      await evalText(`[...document.querySelectorAll('.gr-tab')].find(b => b.textContent.includes('Group Chat'))?.click()`);
      await sleep(800);
      check(await evalText(`!!document.querySelector('.gc-compose textarea')`), 'group chat composer renders');
      await evalText(`(() => { const t = document.querySelector('.gc-compose textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'hello from the browser check'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(200);
      await evalText(`document.querySelector('.gc-compose .send-btn')?.click()`);
      await sleep(1500);
      check(await evalText(`[...document.querySelectorAll('.gc-msg.mine .gc-body')].some(e => e.textContent.includes('hello from the browser check'))`), 'sent message shows in chat');
      check(await evalText(`[...document.querySelectorAll('.gc-msg .gc-body')].some(e => /not running/.test(e.textContent))`), 'delivery note shows agent not running');
      await evalText(`[...document.querySelectorAll('.gr-tab')].find(b => b.textContent.includes('Wiki'))?.click()`);
      await sleep(1200);
      check(await evalText(`!!document.querySelector('.wiki-body') && document.body.innerText.includes('Project Wiki')`), 'wiki tab renders a page');
      await evalText(`[...document.querySelectorAll('.gr-tab')].find(b => b.textContent.includes('Shared'))?.click()`);
      await sleep(1000);
      check(await evalText(`/new file/i.test(document.body.innerText) || !!document.querySelector('.sp-editor')`), 'shared content tab renders (empty state or editor)');
      // A plan arriving over the socket must open the approval modal.
      await fetch(`${api}/projects/${proj.id}/plans`, { method: 'POST', headers: hdrs, body: JSON.stringify({ description: 'UI check plan', targetAgent: 'Alpha', proposedMessage: 'say hi' }) });
      await sleep(1200);
      check(await evalText(`!!document.querySelector('.modal-plan') && document.body.innerText.includes('UI check plan')`), 'plan modal opens from plan:created');
      await evalText(`[...document.querySelectorAll('.modal-plan .modal-actions button')].find(b => b.textContent.trim() === 'Reject')?.click()`);
      await sleep(1200);
      check(await evalText(`!document.querySelector('.modal-plan')`), 'rejecting closes the plan modal');
      const late = events.filter((e) => e.method === 'Runtime.exceptionThrown');
      check(late.length === 0, 'no uncaught exceptions during interaction');
    } finally {
      await fetch(`${api}/projects/${proj.id}?removeData=true`, { method: 'DELETE', headers: hdrs }).catch(() => {});
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (!deepOk) exit = 1;
  }
  ws.close();
} catch (err) {
  console.error('browser check failed:', err);
  exit = 1;
} finally {
  child.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exit);
}
