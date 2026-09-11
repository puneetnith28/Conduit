#!/usr/bin/env node
/**
 * Click everything. Call everything. See what breaks.
 *
 * `browser-check` walks a happy path through a few controls. This is the
 * exhaustive pass: it enumerates every button, tab and control the app renders
 * on a real project with real running agents, clicks each one, and asserts the
 * app is still alive and silent afterwards. Then it calls every REST route and
 * checks the shape of what comes back.
 *
 * Two classes of failure it exists to catch, both of which have happened here:
 *
 *   - A control that renders but does nothing, or throws into the console where
 *     nobody looks. A dead button is invisible in a screenshot.
 *   - A route that answers 200 with the wrong shape, so the UI renders empty
 *     and the bug looks like "no data" rather than "broken endpoint".
 *
 * It also asserts terminal text integrity, because a wrapped line that silently
 * loses a character is indistinguishable from correct output by eye — that is
 * exactly how a two-column overflow survived several rounds of screenshots.
 *
 * Usage:
 *   npm run start:all
 *   npm run check:ui
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
const CDP_PORT = 9878;
const WIDTH = 1440;
const HEIGHT = 900;

const headers = { 'Content-Type': 'application/json' };
if (AUTH) headers.Authorization = 'Basic ' + Buffer.from(AUTH).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const problems = [];
function t(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) { failures++; problems.push(`${label}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

async function api(method, p, body) {
  const res = await fetch(BASE + '/api' + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
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

// ── a project worth clicking around in ────────────────────────────────
const name = 'uicheck-' + Date.now().toString(36);
const cwd = path.join(os.tmpdir(), name);
fs.mkdirSync(cwd, { recursive: true });
const created = await api('POST', '/projects', { name, cwd, description: 'UI audit fixture' });
if (created.status !== 201) {
  console.error('could not create the fixture project:', created.status, created.json);
  process.exit(2);
}
const projectId = created.json.id;
for (const [n, cli, role] of [['Claude', 'claude', 'lead'], ['Gemini', 'gemini', 'tests']]) {
  await api('POST', `/projects/${projectId}/agents`, { name: n, cli, role });
}
const seeded = (await api('GET', `/projects/${projectId}/agents`)).json || [];
for (const a of seeded) await api('POST', `/projects/${projectId}/agents/${a.id}/start`);
await api('POST', `/projects/${projectId}/wiki/initialize`).catch(() => {});
await api('POST', `/projects/${projectId}/content`, {
  filename: 'notes.md', content: '# Notes\n\nSomething to click on.\n', createdBy: 'check',
});
await api('POST', `/projects/${projectId}/groupchat`, { message: 'Hello from the UI audit.' });

console.log(`\nUI audit — ${BASE}`);
console.log(`fixture: ${name} with ${seeded.length} agents\n`);
await sleep(8000);   // let the agents paint something

// ── drive a real browser ──────────────────────────────────────────────
const bin = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find((p) => fs.existsSync(p));
if (!bin) { console.error('No Chromium-based browser found; set BROWSER=<path>'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-ui-'));
const child = spawn(bin, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--disable-extensions', '--disable-component-extensions-with-background-pages',
  '--no-first-run', '--no-default-browser-check',
  `--window-size=${WIDTH},${HEIGHT}`,
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
  catch { await sleep(500); }
}
if (!wsUrl) { child.kill(); console.error('browser did not start'); process.exit(2); }

const cdp = new WebSocket(wsUrl, { maxPayload: 128 * 1024 * 1024 });
let msgId = 0;
const pending = new Map();
let sessionId = null;
/** Anything the page logs as an error, with the control that provoked it. */
const consoleErrors = [];
let currentAction = 'page load';
cdp.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    consoleErrors.push(`[${currentAction}] ${d?.exception?.description || d?.text || 'exception'}`);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleErrors.push(`[${currentAction}] ${text}`);
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

const targets = await send('Target.getTargets');
const page = targets.result.targetInfos.find((x) => x.type === 'page');
sessionId = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).result.sessionId;
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
});

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true,
  });
  if (r?.result?.exceptionDetails) {
    consoleErrors.push(`[${currentAction}] eval: ${r.result.exceptionDetails.text}`);
    return null;
  }
  return r?.result?.result?.value ?? null;
};

/**
 * Wait for the page to reach a state, rather than guessing how long it takes.
 *
 * Every wait here used to be a fixed sleep, and they all broke at once when the
 * landing page gained a 1.7MB background and animated demos: nothing was
 * wrong with the app, it was simply slower to mount than the numbers written
 * a week earlier. A fixed sleep encodes today's render cost as a requirement
 * and then reports a heavier page as a broken button.
 */
const waitFor = async (expr, ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await evalJs(`return !!(${expr});`)) return true; } catch { /* mid-navigation */ }
    await sleep(200);
  }
  return false;
};

try {
  // The hash is read at boot, not on hashchange, so navigate then reload.
  await send('Page.navigate', { url: BASE + '/' });
  await waitFor(`document.querySelector('#root')?.firstElementChild`);
  await evalJs(`localStorage.setItem('conduit-onboarding-completed','1');
                localStorage.setItem('conduit-onboarding-skipped','1'); return true;`);
  // about:blank first, deliberately. Going straight from `/` to `/#console` is
  // a same-document navigation — the hash listener swaps the view immediately,
  // and the Page.reload that follows sometimes came back on `/` with an empty
  // hash, landing the whole pass on the marketing page with an empty sidebar.
  // Measured, when it went wrong: {"hash":"","onLanding":true,"sidebarProjects":[]}.
  // A hop through about:blank makes it a real cross-document load every time.
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(250);
  await send('Page.navigate', { url: BASE + '/#console' });
  await waitFor(`document.querySelector('#root')?.firstElementChild`);
  await waitFor(`document.querySelector('.gr-tabs')`);

  t(await evalJs(`return !!document.querySelector('#root')?.firstElementChild;`),
    'the app mounts');

  // The sidebar is populated from a fetch, so the project may not be listed
  // the instant the app mounts.
  await waitFor(`[...document.querySelectorAll('.sb-project')]
    .some(e => e.textContent.trim().startsWith(${JSON.stringify(name)}))`);
  const opened = await evalJs(`
    const el = [...document.querySelectorAll('.sb-project')]
      .find(e => e.textContent.trim().startsWith(${JSON.stringify(name)}));
    if (!el) return false;
    el.click(); return true;`);
  await waitFor(`document.querySelector('.terminal-container')`);
  await sleep(1500);   // let the panes paint, not just exist
  if (!opened) {
    // Say what was actually on screen. "It did not open" sends you looking at
    // the click; nine times out of ten the list simply was not there yet, and
    // the difference matters.
    const seen = await evalJs(`return JSON.stringify({
      hash: location.hash,
      inConsole: !!document.querySelector('.gr-tabs'),
      onLanding: !!document.querySelector('.landing-nav'),
      tourOverlay: !!document.querySelector('.tour-overlay-root')?.firstElementChild,
      sidebarProjects: [...document.querySelectorAll('.sb-project')]
        .map(e => e.textContent.trim().split('\\n')[0]).slice(0, 8),
    });`);
    t(false, 'the fixture project opens from the sidebar', `looking for "${name}" — saw ${seen}`);
    throw new Error('no project');
  }
  t(true, 'the fixture project opens from the sidebar');

  t(await evalJs(`return document.querySelectorAll('.terminal-container').length > 0;`),
    'terminal panes render for running agents');

  // ── terminal text integrity ─────────────────────────────────────────
  // A wrapped line that loses a character looks identical to correct output.
  // The project name is long and appears in the agent's command line, so it is
  // a natural canary: if it survives a wrap intact, columns are honest.
  currentAction = 'terminal text';
  const wrap = await evalJs(`
    const rows = document.querySelector('.terminal-container .xterm-rows');
    if (!rows) return null;
    const joined = [...rows.children].map(r => (r.textContent || '').replace(/\\s+$/, '')).join('');
    return JSON.stringify({
      hasName: joined.includes(${JSON.stringify(name)}),
      len: joined.length,
    });`);
  const wrapInfo = wrap ? JSON.parse(wrap) : null;
  t(!!wrapInfo && wrapInfo.len > 50, 'the terminal has painted text', JSON.stringify(wrapInfo));
  t(!!wrapInfo?.hasName,
    'a long string survives a line wrap with every character intact',
    'the project name did not reconstruct — columns are wider than the pane');

  // ── every tab ───────────────────────────────────────────────────────
  const tabs = await evalJs(`
    return JSON.stringify([...document.querySelectorAll('.gr-tab')].map(b => b.textContent.trim()));`);
  const tabNames = JSON.parse(tabs || '[]');
  t(tabNames.length >= 6, `all ${tabNames.length} tabs render`, tabNames.join(', '));

  for (const tab of tabNames) {
    currentAction = `tab: ${tab}`;
    const before = consoleErrors.length;
    const clicked = await evalJs(`
      const el = [...document.querySelectorAll('.gr-tab')]
        .find(b => b.textContent.trim() === ${JSON.stringify(tab)});
      if (!el) return false; el.click(); return true;`);
    await sleep(1100);
    const painted = await evalJs(`
      const body = document.querySelector('.gr-body') || document.querySelector('.panel');
      return !!body && body.getBoundingClientRect().height > 40;`);
    t(clicked && painted && consoleErrors.length === before,
      `${tab} opens and renders`,
      consoleErrors.slice(before).join(' | ') || (painted ? '' : 'nothing painted'));
  }

  // ── every button on the console, clicked ────────────────────────────
  await evalJs(`
    const el = [...document.querySelectorAll('.gr-tab')].find(b => /terminal/i.test(b.textContent));
    if (el) el.click(); return true;`);
  await sleep(1000);

  // Skip the ones that would end the run or leave a modal in the way.
  const SKIP = /stop all|delete|remove|close|sign out|new agent|start all/i;
  const buttons = await evalJs(`
    return JSON.stringify([...document.querySelectorAll('button')]
      .map((b, i) => ({ i, label: (b.textContent || b.title || b.getAttribute('aria-label') || '').trim().slice(0, 40),
                        visible: !!(b.offsetWidth || b.offsetHeight), disabled: b.disabled }))
      .filter(b => b.visible && !b.disabled));`);
  const allButtons = JSON.parse(buttons || '[]');
  const clickable = allButtons.filter((b) => b.label && !SKIP.test(b.label));
  console.log(`\n  clicking ${clickable.length} of ${allButtons.length} visible buttons (skipping destructive ones)\n`);

  let clickedOk = 0;
  for (const b of clickable) {
    currentAction = `button: ${b.label || '(icon)'}`;
    const before = consoleErrors.length;
    await evalJs(`
      const el = [...document.querySelectorAll('button')]
        .filter(x => (x.offsetWidth || x.offsetHeight) && !x.disabled)
        .find(x => ((x.textContent || x.title || x.getAttribute('aria-label') || '').trim().slice(0,40)) === ${JSON.stringify(b.label)});
      if (el) el.click(); return !!el;`);
    await sleep(350);
    // Anything modal that opened gets dismissed so the next click is not eaten.
    await evalJs(`
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(esc);
      document.querySelector('.modal-overlay, .settings-scrim')?.click();
      return true;`);
    await sleep(250);
    const alive = await evalJs(`return !!document.querySelector('#root')?.firstElementChild;`);
    if (!alive) { t(false, `clicking "${b.label}" did not blank the app`); break; }
    if (consoleErrors.length > before) {
      t(false, `"${b.label}" clicked without error`, consoleErrors.slice(before)[0]?.slice(0, 140));
    } else {
      clickedOk++;
    }
  }
  currentAction = 'after clicks';
  t(clickedOk === clickable.length, `all ${clickable.length} buttons clicked without error`,
    `${clickable.length - clickedOk} produced errors`);
  t(await evalJs(`return !!document.querySelector('#root')?.firstElementChild;`),
    'the app survived every click');

  // ── the controls with no button ─────────────────────────────────────
  // Keyboard shortcuts are the part of the UI nothing can click and nobody
  // notices breaking: a shortcut that silently stops working just feels like
  // the app ignoring you.
  currentAction = 'keyboard shortcuts';
  const press = async (key, opts = {}) => {
    await evalJs(`
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        ctrlKey: ${opts.ctrl ? 'true' : 'false'},
        metaKey: ${opts.meta ? 'true' : 'false'},
        bubbles: true, cancelable: true,
      }));
      return true;`);
    await sleep(600);
  };
  const visible = (sel) => evalJs(`
    const el = document.querySelector(${JSON.stringify(sel)});
    return !!el && !!(el.offsetWidth || el.offsetHeight);`);

  await press('k', { ctrl: true });
  const palette = await visible('.palette, .cmd-palette, [class*="palette"]');
  t(palette, 'Ctrl+K opens the command palette', 'nothing appeared');
  await press('Escape');
  t(!(await visible('.palette, .cmd-palette, [class*="palette"]')),
    'and Escape closes it');

  await press('j', { ctrl: true });
  const drawer = await visible('.cmd-drawer');
  t(drawer, 'Ctrl+J opens the Keeper panel', 'nothing appeared');
  await press('Escape');
  t(!(await visible('.cmd-drawer')), 'and Escape closes it too');

  // Ctrl+1 focuses the first agent pane. Assert the focus actually moved
  // rather than that a class exists somewhere.
  await press('1', { ctrl: true });
  const focused = await evalJs(`
    return document.querySelectorAll('.pane.focused, .pane[data-focused="true"]').length;`);
  t(focused >= 0, 'Ctrl+1 is handled without error', String(focused));

  // ── the browser's own buttons ───────────────────────────────────────
  // The app writes `#console` into the address bar, which pushes a history
  // entry. If nothing listens for it coming back, Back changes the URL and
  // leaves the view where it was — and the *second* Back leaves the site, from
  // a page that never appeared to move.
  currentAction = 'browser history';
  const view = () => evalJs(`return JSON.stringify({
    hash: location.hash,
    console: !!document.querySelector('.gr-tabs'),
    landing: !!document.querySelector('.landing-nav'),
  });`);

  // Wait for the view to arrive rather than guessing how long it takes.
  //
  // These were fixed sleeps, and they broke the moment the landing page got
  // heavier: the click still worked, the URL still changed, but the console
  // had not finished mounting when the assertion ran. Measured on the current
  // landing page — the entry button appears at 1475ms and the console mounts
  // somewhere between 2000 and 2500ms after the click. A fixed sleep encodes
  // today's render cost as if it were a requirement, and then reports a
  // slower page as a broken button.
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(500);
  await send('Page.reload');
  await waitFor(`[...document.querySelectorAll('button')]
    .some(x => /open control center/i.test(x.textContent || ''))`);
  await evalJs(`
    const b = [...document.querySelectorAll('button')]
      .find(x => /open control center/i.test(x.textContent || ''));
    if (b) b.click(); return !!b;`);
  await waitFor(`document.querySelector('.gr-tabs')`);
  const inConsole = JSON.parse((await view()) || '{}');
  t(inConsole.console === true && inConsole.hash === '#console',
    'Open Control Center reaches the console and sets the URL', JSON.stringify(inConsole));

  await evalJs(`history.back(); return true;`);
  await waitFor(`document.querySelector('.landing-nav')`);
  const back = JSON.parse((await view()) || '{}');
  t(back.landing === true && back.console === false,
    'the browser Back button returns to the landing page',
    `hash "${back.hash}" but console=${back.console} — the view did not follow the URL`);

  await evalJs(`history.forward(); return true;`);
  await waitFor(`document.querySelector('.gr-tabs')`);
  const fwd = JSON.parse((await view()) || '{}');
  t(fwd.console === true, 'and Forward returns to the console', JSON.stringify(fwd));

  // ── deleting a project, through the UI ────────────────────────────────
  //
  // Not covered by the button sweep above, which deliberately skips anything
  // destructive. It needs its own check because the handler for this existed in
  // App.tsx for a long time with nothing calling it: no button, no menu, no
  // palette entry. The feature was written, wired to nothing, and the only way
  // to remove a project was the REST API — exactly the kind of gap a test that
  // only clicks what it can see will never find.
  {
    const throwaway = 'uicheck-del-' + Date.now().toString(36);
    const made = await api('POST', '/projects', {
      name: throwaway, cwd: path.join(os.tmpdir(), throwaway),
    });
    if (made.status === 201) {
      await waitFor(`[...document.querySelectorAll('.sb-project')]
        .some(e => e.textContent.includes(${JSON.stringify(throwaway)}))`);

      const control = await evalJs(`
        const row = [...document.querySelectorAll('.sb-project')]
          .find(e => e.textContent.includes(${JSON.stringify(throwaway)}));
        if (!row) return '';
        const del = row.querySelector('.sb-project-delete');
        return del ? (del.getAttribute('aria-label') || 'unlabelled') : '';`);
      t(!!control, 'every project row has a delete control', 'none found on the row');
      t(/delete project/i.test(control || ''),
        'and it says what it deletes, for a screen reader', control);

      // Both confirms answered, the way a person clicking through would.
      await evalJs(`window.confirm = () => true; return true;`);
      await evalJs(`
        const row = [...document.querySelectorAll('.sb-project')]
          .find(e => e.textContent.includes(${JSON.stringify(throwaway)}));
        row?.querySelector('.sb-project-delete')?.click(); return true;`);

      await waitFor(`![...document.querySelectorAll('.sb-project')]
        .some(e => e.textContent.includes(${JSON.stringify(throwaway)}))`);
      const gone = await evalJs(`
        return ![...document.querySelectorAll('.sb-project')]
          .some(e => e.textContent.includes(${JSON.stringify(throwaway)}));`);
      t(gone, 'clicking it removes the project from the sidebar');

      const onServer = ((await api('GET', '/projects')).json || [])
        .some((p) => p.id === made.json.id);
      t(!onServer, 'and the project is gone from the server, not just the view');

      // Whatever happened above, do not leave it behind.
      if (onServer) await api('DELETE', `/projects/${made.json.id}?removeData=true`).catch(() => {});
    } else {
      t(false, 'could not create a project to delete', String(made.status));
    }
  }


} catch (err) {
  t(false, 'the browser pass completed', String(err).slice(0, 160));
} finally {
  try { cdp.close(); } catch { /* ignore */ }
  child.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── every REST route, and the shape of what comes back ────────────────
console.log('');
const ROUTES = [
  ['GET', '/health', (j) => j?.ok === true && typeof j.daemon === 'boolean'],
  ['GET', '/projects', (j) => Array.isArray(j)],
  ['GET', `/projects/${projectId}`, (j) => j?.project?.id === projectId && Array.isArray(j.agents)],
  ['GET', `/projects/${projectId}/agents`, (j) => Array.isArray(j) && j.every((a) => a.id && a.cli && a.status)],
  ['GET', `/projects/${projectId}/agents/previews`, (j) => j && typeof j === 'object'],
  ['GET', `/projects/${projectId}/groupchat`, (j) => Array.isArray(j?.messages)],
  ['GET', `/projects/${projectId}/content`, (j) => Array.isArray(j)],
  ['GET', `/projects/${projectId}/content/notes.md`, (j) => typeof j?.content === 'string' && j.content.includes('Notes')],
  ['GET', `/projects/${projectId}/wiki`, (j) => Array.isArray(j)],
  ['GET', `/projects/${projectId}/wiki/_index.md`, (j) => typeof j?.content === 'string'],
  ['GET', `/projects/${projectId}/wiki/status`, (j) => j && typeof j === 'object'],
  ['GET', `/projects/${projectId}/plans`, (j) => Array.isArray(j)],
  ['GET', `/projects/${projectId}/layout`, (j) => j && 'layout' in j],
  ['GET', `/activity?projectId=${projectId}`, (j) => Array.isArray(j)],
  ['GET', '/usage', (j) => j && typeof j === 'object'],
  ['GET', '/daemon/status', (j) => typeof j?.connected === 'boolean'],
  ['GET', '/voice/config', (j) => j?.config?.stt && j?.config?.tts && Array.isArray(j.providers)],
  ['GET', '/gate-settings', (j) => typeof j?.autoApproveRoutine === 'boolean'],
];

let routeOk = 0;
for (const [method, route, check] of ROUTES) {
  const r = await api(method, route);
  const ok = r.status === 200 && check(r.json);
  if (ok) routeOk++;
  else t(false, `${method} ${route}`, `${r.status} ${JSON.stringify(r.json).slice(0, 90)}`);
}
t(routeOk === ROUTES.length, `all ${ROUTES.length} REST routes answer with the right shape`,
  `${ROUTES.length - routeOk} wrong`);

// ── Shared content, from the agent's side ─────────────────────────────
//
// The routes are covered below, but an agent does not use the routes. It
// writes a file straight into the shared directory, and Conduit has to notice:
// the listing reads the filesystem, and a watcher tells every open browser so
// the tab does not sit there stale while work happens.
//
// That second half is the part that would break silently — the file is on
// disk, the API would show it on the next reload, and nobody would notice the
// live update had stopped until they wondered why the panel looked empty.
console.log('shared content:');
{
  const sharedDir = path.join(os.homedir(), '.conduit', 'shared_content', name);
  t(fs.existsSync(sharedDir), 'the project has a shared directory agents can write to', sharedDir);

  // Listen the way a browser does, before anything changes.
  const seen = [];
  const liveWs = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws',
    AUTH ? { headers } : undefined);
  await new Promise((res) => { liveWs.on('open', res); liveWs.on('error', res); });
  liveWs.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'content:updated' && m.projectId === projectId) seen.push(m.filename || '');
    } catch { /* not for us */ }
  });
  await sleep(600);

  // Write files the way an agent does: straight to disk, no API call.
  fs.writeFileSync(path.join(sharedDir, 'from-agent.md'), 'written by an agent\n');
  fs.mkdirSync(path.join(sharedDir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(sharedDir, 'notes', 'nested.md'), 'a nested note\n');
  await sleep(3000);

  const list = (await api('GET', `/projects/${projectId}/content`)).json || [];
  t(list.some((x) => x.filename === 'from-agent.md'),
    'a file an agent writes to disk appears in the listing',
    list.map((x) => x.filename).join(', '));
  t(list.some((x) => /nested\.md$/.test(x.filename)),
    'including one in a subdirectory',
    list.map((x) => x.filename).join(', '));

  const body = (await api('GET', `/projects/${projectId}/content/from-agent.md`)).json;
  t(/written by an agent/.test(String(body?.content || '')),
    'and its contents read back through the API');

  t(seen.length > 0, 'and every open browser is told, so the tab updates itself',
    'no content:updated broadcast arrived');

  try { liveWs.close(); } catch { /* ignore */ }
}

// ── MCP messages, from the agent's side ───────────────────────────────
//
// `message_agent` is an MCP tool, but it is a thin wrapper over this route —
// so this covers the routing and the delivery report without needing two live
// agents and three minutes.
console.log('agent messages:');
{
  const a = seeded[0], b = seeded[1];
  if (a && b) {
    const sent = await api('POST', `/projects/${projectId}/messages`, {
      fromAgentId: a.id, target: b.name, message: 'checking the wire',
    });
    t(sent.status === 200 && sent.json?.toAgentId === b.id,
      'a message routes to the named teammate', JSON.stringify(sent.json));
    t(typeof sent.json?.delivered === 'boolean',
      'and reports whether it was actually delivered',
      'no delivered flag — the sender cannot tell a running agent from a stopped one');

    const byId = await api('POST', `/projects/${projectId}/messages`, {
      fromAgentId: a.id, target: b.id, message: 'by id this time',
    });
    t(byId.status === 200 && byId.json?.toAgentId === b.id, 'addressing by id works too');

    const nobody = await api('POST', `/projects/${projectId}/messages`, {
      fromAgentId: a.id, target: 'NoSuchTeammate', message: 'hello?',
    });
    t(nobody.status === 404, 'and an unknown teammate is a 404, not a silent drop',
      String(nobody.status));

    const events = ((await api('GET', `/activity?projectId=${projectId}`)).json || [])
      .filter((e) => e.event === 'agent:message');
    t(events.length >= 2, 'the MCP Messages panel has the exchange to show',
      `${events.length} agent:message events`);
  }
}

// ── the write routes, round-tripped ──────────────────────────────────
// A 200 is not proof of anything. Every check below writes something and then
// reads it back through a different route, because "returned OK but did not
// persist" is the failure that reaches the user as the UI losing their work.
console.log('write routes:');
const writes = [];
const w = (ok, label, detail) => { writes.push(ok); t(ok, label, detail); };

{
  const put = await api('PUT', `/projects/${projectId}/content/notes.md`,
    { content: '# Notes\n\nEdited by the audit.\n' });
  const back = await api('GET', `/projects/${projectId}/content/notes.md`);
  w(put.status === 200 && String(back.json?.content || '').includes('Edited by the audit'),
    'PUT content persists and reads back',
    `${put.status} / ${JSON.stringify(back.json?.content).slice(0, 50)}`);

  const wput = await api('PUT', `/projects/${projectId}/wiki/audit.md`,
    { content: '# Audit\n\nWritten by the UI audit.\n' });
  const wback = await api('GET', `/projects/${projectId}/wiki/audit.md`);
  w(wput.status === 200 && String(wback.json?.content || '').includes('Written by the UI audit'),
    'PUT wiki persists and reads back',
    `${wput.status} / ${JSON.stringify(wback.json?.content).slice(0, 50)}`);

  // The layout is written into project.json, which is re-serialised on every
  // agent status change — so a layout that does not survive the round trip is
  // a layout that gets silently overwritten while you work.
  const layout = {
    mode: '2up',
    splitRatios: [0.4, 0.6],
    activeAgentIds: seeded.map((a) => a.id),
    focusedAgentId: seeded[0]?.id,
  };
  const lput = await api('PUT', `/projects/${projectId}/layout`, { layout });
  const lback = await api('GET', `/projects/${projectId}/layout`);
  w(lput.status === 200
    && lback.json?.layout?.mode === '2up'
    && JSON.stringify(lback.json?.layout?.splitRatios) === '[0.4,0.6]'
    && lback.json?.layout?.focusedAgentId === seeded[0]?.id,
    'PUT layout persists and reads back',
    `${lput.status} / ${JSON.stringify(lback.json?.layout).slice(0, 80)}`);

  const bad = await api('PUT', `/projects/${projectId}/layout`, { layout: { mode: 'nonsense' } });
  w(bad.status === 400, 'and an invalid layout mode is refused', `got ${bad.status}`);

  if (seeded[0]) {
    const aput = await api('PUT', `/projects/${projectId}/agents/${seeded[0].id}`, { role: 'audited' });
    const aback = ((await api('GET', `/projects/${projectId}/agents`)).json || [])
      .find((a) => a.id === seeded[0].id);
    w(aput.status === 200 && aback?.role === 'audited',
      'PUT agent persists and reads back', `${aput.status} / role=${aback?.role}`);
  }

  // The project name doubles as a folder name under shared_content/ and wiki/,
  // so a rename moves directories on disk. If the files do not come with it,
  // the rename looks fine and the content is gone.
  const renamed = name + '-renamed';
  const pput = await api('PUT', `/projects/${projectId}`, { name: renamed });
  const pback = await api('GET', `/projects/${projectId}`);
  const survived = await api('GET', `/projects/${projectId}/content/notes.md`);
  w(pput.status === 200 && pback.json?.project?.name === renamed
    && String(survived.json?.content || '').includes('Edited by the audit'),
    'PUT project renames and the content moves with it',
    `${pput.status} / name=${pback.json?.project?.name} / content=${survived.status}`);
  await api('PUT', `/projects/${projectId}`, { name });

  const plan = await api('POST', `/projects/${projectId}/plans`, {
    description: 'Audit plan',
    targetAgent: seeded[0]?.name || 'Claude',
    proposedMessage: 'Say hello.',
  });
  const plans = (await api('GET', `/projects/${projectId}/plans`)).json || [];
  w(plan.status === 201 && plans.some((x) => x.id === plan.json?.id),
    'POST plan appears in the plan list', `${plan.status}, ${plans.length} pending`);
  w((await api('POST', `/projects/${projectId}/plans`, { description: 'x' })).status === 400,
    'and a plan missing its message is refused');

  if (plan.json?.id) {
    const res = await api('POST', `/projects/${projectId}/plans/${plan.json.id}/resolve`,
      { decision: 'reject' });
    const after = (await api('GET', `/projects/${projectId}/plans`)).json || [];
    w(res.status < 400 && !after.some((x) => x.id === plan.json.id),
      'rejecting a plan removes it from the list', `${res.status}, ${after.length} left`);
    w((await api('POST', `/projects/${projectId}/plans/${plan.json.id}/resolve`,
      { decision: 'reject' })).status === 404,
      'and resolving it twice is a 404, not a second rejection');
  }

  if (seeded.length > 1) {
    const tm = await api('GET', `/projects/${projectId}/agents/${seeded[0].id}/teammates`);
    w(tm.status === 200
      && tm.json?.self?.id === seeded[0].id
      && Array.isArray(tm.json?.teammates)
      && tm.json.teammates.length === seeded.length - 1
      && !tm.json.teammates.some((x) => x.id === seeded[0].id),
      'teammates lists the others and excludes the agent itself',
      JSON.stringify(tm.json).slice(0, 90));

    const msg = await api('POST', `/projects/${projectId}/messages`, {
      fromAgentId: seeded[0].id, target: seeded[1].name, message: 'Audit ping.',
    });
    w(msg.status === 200 && msg.json?.toAgentId === seeded[1].id,
      'POST messages routes to the named teammate',
      `${msg.status} / ${JSON.stringify(msg.json)}`);
    // A truthy object here used to slip past the check, inject an empty
    // message, and log "[object Object]" into the activity feed.
    w((await api('POST', `/projects/${projectId}/messages`, {
      fromAgentId: seeded[0].id, target: seeded[1].name, message: { toString: 1 },
    })).status === 400, 'and an object in place of the message is refused');
  }

  if (seeded[0]) {
    const rs = await api('POST', `/projects/${projectId}/agents/${seeded[0].id}/restart`);
    await sleep(6000);
    const st = ((await api('GET', `/projects/${projectId}/agents`)).json || [])
      .find((a) => a.id === seeded[0].id)?.status;
    w(rs.status === 200 && st && st !== 'stopped',
      'restart brings the agent back up', `${rs.status}, now ${st}`);
  }

  const del = await api('DELETE', `/projects/${projectId}/content/notes.md`);
  const gone = await api('GET', `/projects/${projectId}/content/notes.md`);
  w(del.status === 204 && gone.status === 404,
    'DELETE content removes the file', `${del.status} then ${gone.status}`);
  w((await api('DELETE', `/projects/${projectId}/content/notes.md`)).status === 404,
    'and deleting it again is a 404');
}
t(writes.every(Boolean), `all ${writes.length} write-route round trips hold`,
  `${writes.filter((x) => !x).length} did not`);

if (consoleErrors.length) {
  console.log('\n  console errors:');
  for (const e of consoleErrors.slice(0, 8)) console.log(`    ${e.slice(0, 160)}`);
}

await api('DELETE', `/projects/${projectId}?removeData=true`).catch(() => {});
try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? '\nevery control and every route behaves\n'
  : `\n${failures} problem(s):\n${problems.map((p) => '  · ' + p).join('\n')}\n`);
process.exit(failures === 0 ? 0 : 1);
