#!/usr/bin/env node
/**
 * Every page, every width, measured — not eyeballed.
 *
 * Screenshots are how UI bugs get missed. A monospace character is about five
 * pixels in a downscaled shot, so "the text is clipped" and "the text is fine"
 * look identical, and I have called it both ways on the same screenshot. The
 * browser already knows the answer exactly, so ask it:
 *
 *   overflow   the page scrolls sideways, or an element sticks out of its own
 *              container — the classic "there's a horizontal scrollbar" bug
 *   clipped    an element's content is wider than its box and overflow hides
 *              it, so text is silently cut off mid-word
 *   overlap    two things that both want to be read or clicked are drawn on
 *              top of each other — what "misaligned" almost always means
 *   offscreen  a visible element sits outside the viewport
 *   tiny       a touch target below 44px on a phone-sized screen
 *   contrast   text within a hair of its own background
 *
 * Each finding names a selector path, so it can be fixed rather than admired.
 *
 * Usage: node scripts/check-layout.mjs [--json] [--only=<page>]
 *        needs `npm run start:all`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const BASE = process.env.CONDUIT_URL || 'http://localhost:3200';
const AUTH = process.env.CONDUIT_AUTH || '';
const CDP_PORT = 9873;
const JSON_OUT = process.argv.includes('--json');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';

const headers = { 'Content-Type': 'application/json' };
if (AUTH) headers.Authorization = 'Basic ' + Buffer.from(AUTH).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The widths that matter: a phone, a small tablet, a laptop, a desktop. */
const VIEWPORTS = [
  { name: 'phone', w: 390, h: 844, mobile: true },
  { name: 'tablet', w: 768, h: 1024, mobile: true },
  { name: 'laptop', w: 1280, h: 800, mobile: false },
  { name: 'desktop', w: 1600, h: 900, mobile: false },
];

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

// ── something worth looking at ────────────────────────────────────────
const projName = 'layout-' + Date.now().toString(36);
const projCwd = path.join(os.tmpdir(), projName);
fs.mkdirSync(projCwd, { recursive: true });
const created = await api('POST', '/projects', {
  name: projName, cwd: projCwd, description: 'Layout audit fixture',
});
if (created.status !== 201) {
  console.error('could not create the fixture project:', created.status);
  process.exit(2);
}
const projectId = created.json.id;
for (const [n, cli, role] of [['Claude', 'claude', 'lead'], ['Gemini', 'gemini', 'tests']]) {
  await api('POST', `/projects/${projectId}/agents`, { name: n, cli, role });
}
const agents = (await api('GET', `/projects/${projectId}/agents`)).json || [];
for (const a of agents) await api('POST', `/projects/${projectId}/agents/${a.id}/start`);
await api('POST', `/projects/${projectId}/wiki/initialize`).catch(() => {});
await api('POST', `/projects/${projectId}/content`, {
  filename: 'notes.md',
  content: '# Notes\n\nA reasonably long line of shared content so the panel has something to lay out.\n',
  createdBy: 'layout-audit',
});
// A few messages, including a long one — short chats hide overflow bugs.
for (const m of [
  'Hello from the layout audit.',
  'This is a deliberately long message written to make the group chat wrap across several lines so that any bubble that cannot contain its own text has a chance to demonstrate that clearly.',
  '@Claude can you look at the auth module?',
]) {
  await api('POST', `/projects/${projectId}/groupchat`, { message: m });
}

console.log(`\nLayout audit — ${BASE}`);
console.log(`fixture: ${projName}\n`);
await sleep(7000);

// ── a real browser ────────────────────────────────────────────────────
const bin = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && fs.existsSync(p));
if (!bin) { console.error('no Chromium-based browser found'); process.exit(2); }

const userDir = path.join(os.tmpdir(), 'conduit-layout-' + Date.now().toString(36));
const browser = spawn(bin, [
  `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--disable-gpu',
  // A browser extension once painted over a shot and swallowed a click.
  '--disable-extensions', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' });

let ws = null;
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.delete(id)) rej(new Error(method + ' timed out')); }, 30_000);
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { ${expr} })()`, returnByValue: true, awaitPromise: true,
  });
  if (r.result?.exceptionDetails) return null;
  return r.result?.result?.value;
};
const waitFor = async (expr, ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await evalJs(`return !!(${expr});`)) return true; } catch { /* navigating */ }
    await sleep(200);
  }
  return false;
};
const clickText = (selector, text) => evalJs(`
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(e => (e.textContent || '').trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
  if (el) { el.click(); return true; } return false;`);

for (let i = 0; i < 40 && !ws; i++) {
  await sleep(400);
  try {
    const targets = await fetch(`http://localhost:${CDP_PORT}/json/list`).then((r) => r.json());
    const page = targets.find((t) => t.type === 'page');
    if (!page) continue;
    ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => {
      ws.on('open', res); ws.on('error', rej);
      setTimeout(() => rej(new Error('cdp did not open')), 5000);
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); }
    });
  } catch { ws = null; }
}
if (!ws) { console.error('could not attach to the browser'); process.exit(2); }

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');

/**
 * The measurement itself, run inside the page.
 *
 * Everything here is deliberately conservative: a false finding costs more
 * than a missed one, because a report full of noise stops being read.
 */
const MEASURE = `
const out = { overflow: [], clipped: [], overlap: [], offscreen: [], tiny: [], contrast: [] };
const vw = window.innerWidth, vh = window.innerHeight;

const pathOf = (el) => {
  const bits = [];
  for (let e = el; e && e.nodeType === 1 && bits.length < 4; e = e.parentElement) {
    let s = e.tagName.toLowerCase();
    if (e.id) { bits.unshift(s + '#' + e.id); break; }
    const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\\s+/)
      .filter(Boolean).slice(0, 2).join('.');
    if (cls) s += '.' + cls;
    bits.unshift(s);
  }
  return bits.join(' > ');
};
const label = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 45);

/**
 * The part of an element a person can actually see.
 *
 * getBoundingClientRect returns where an element *is*, which inside a scroll
 * container is not where it is *visible*. The group chat scrolls to the
 * bottom, so earlier messages sit above the list's viewport with rects that
 * reach up behind the panel header — and comparing raw rects reported the
 * header as overlapping the messages by 98%, on a layout that measured
 * perfectly: header 99-183, list 183-713, nothing touching.
 *
 * Intersecting with every clipping ancestor gives the rect that is on screen.
 * An element clipped away entirely comes back with no area, and is skipped.
 */
const visRect = (el) => {
  const r = el.getBoundingClientRect();
  let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
  for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
    const c = getComputedStyle(e);
    if (!/hidden|clip|auto|scroll/.test(c.overflowX + c.overflowY)) continue;
    const pr = e.getBoundingClientRect();
    left = Math.max(left, pr.left);
    top = Math.max(top, pr.top);
    right = Math.min(right, pr.right);
    bottom = Math.min(bottom, pr.bottom);
  }
  return { left, top, right, bottom,
    width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
};

const visible = (el) => {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

// When a dialog is open, the page behind it is not part of the layout under
// test — it is covered, inert, and overlapping it is the entire point of a
// dialog. Measuring both together produced 262 "overlaps" that were the
// onboarding tour card sitting correctly on top of a terminal.
const OVERLAY = '.modal-overlay, [role=dialog], .tour-welcome-card, .palette, .cmd-drawer, .settings-modal, .plan-modal, .gate-modal';
const openOverlay = [...document.querySelectorAll(OVERLAY)].find(visible) || null;
const scope = openOverlay || document.body;

const all = [...scope.querySelectorAll('*')].filter(visible);
if (openOverlay) all.unshift(openOverlay);

// ── the page itself must not scroll sideways ─────────────────────────
// Always the real document: a dialog does not change whether the page has a
// horizontal scrollbar.
const de = document.documentElement;
if (de.scrollWidth > de.clientWidth + 1) {
  out.overflow.push({ what: 'the page scrolls sideways',
    by: de.scrollWidth - de.clientWidth, path: 'document' });
  // Name the widest offenders, or this is unactionable.
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.right > de.clientWidth + 2 && r.width < de.clientWidth * 1.5) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') continue;
      out.overflow.push({ what: 'sticks out past the right edge',
        by: Math.round(r.right - de.clientWidth), path: pathOf(el), text: label(el) });
      if (out.overflow.length > 8) break;
    }
  }
}

// ── text cut off by its own box ──────────────────────────────────────
for (const el of all) {
  const cs = getComputedStyle(el);
  const hidesX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
  if (!hidesX) continue;
  // Only leaf-ish elements that actually hold text.
  const own = [...el.childNodes].filter((n) => n.nodeType === 3)
    .map((n) => n.textContent.trim()).join('');
  if (!own) continue;
  if (cs.textOverflow === 'ellipsis') continue;      // deliberate
  if (cs.whiteSpace === 'nowrap' && el.scrollWidth > el.clientWidth + 2) {
    out.clipped.push({ path: pathOf(el), text: label(el),
      by: el.scrollWidth - el.clientWidth });
  }
}

// ── two readable things drawn on top of each other ───────────────────
// Only compare things a person is meant to read or click, only when neither
// contains the other, and only when the shared area is a real fraction of the
// smaller one — a 1px touch is a rounding artefact, not a bug.
const INTERACTIVE = 'a,button,input,select,textarea,[role=button],[role=tab],[role=link]';
const candidates = all.filter((el) => {
  const r = visRect(el);
  if (r.width < 8 || r.height < 8) return false;
  if (el.matches(INTERACTIVE)) return true;
  const own = [...el.childNodes].filter((n) => n.nodeType === 3)
    .map((n) => n.textContent.trim()).join('');
  return own.length > 0;
}).slice(0, 700);

const seen = new Set();
for (let i = 0; i < candidates.length; i++) {
  for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i], b = candidates[j];
    if (a.contains(b) || b.contains(a)) continue;
    const ra = visRect(a), rb = visRect(b);
    const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (ox <= 2 || oy <= 2) continue;
    const area = ox * oy;
    const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
    if (area < smaller * 0.30) continue;
    const ca = getComputedStyle(a), cb = getComputedStyle(b);
    // An overlay on purpose: modals, dropdowns, the Keeper orb. Only a
    // complaint when the thing underneath is meant to be used right now.
    // Floating is inherited in practice: a button inside a fixed bottom nav
    // has position:static itself, so asking only about the element missed
    // every one of them and reported the nav's own labels as overlapping the
    // terminal underneath.
    const floats = (el) => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const pos = getComputedStyle(e).position;
        if (pos === 'fixed' || pos === 'sticky') return true;
      }
      return false;
    };
    const fa = floats(a), fb = floats(b);
    if (fa && fb) continue;
    // A fixed bar with content passing beneath it is how a fixed bar works —
    // the mobile bottom nav over terminal rows is not a misalignment, and the
    // text scrolls clear of it.
    //
    // It stops being fine the moment the thing underneath is something you
    // have to click. A link pinned under the nav bar cannot be reached at all,
    // however far you scroll, and that is exactly the shape of the bug where
    // the Keeper orb sat on top of the group chat's send button.
    if (fa !== fb) {
      const under = fa ? b : a;
      if (!under.matches(INTERACTIVE)) continue;
    }
    const key = pathOf(a) + '|' + pathOf(b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.overlap.push({
      a: pathOf(a), aText: label(a), b: pathOf(b), bText: label(b),
      area: Math.round(area), pct: Math.round((area / smaller) * 100),
      floating: fa || fb,
    });
    if (out.overlap.length > 25) break;
  }
  if (out.overlap.length > 25) break;
}

// ── drawn outside the window ─────────────────────────────────────────
//
// An element some ancestor clips is contained, not spilling: nobody can see
// it, and that is usually the entire design. The ecosystem marquee is a whole
// row of logos parked outside the viewport on purpose, and reporting those as
// layout bugs buried the real findings under nine of them per page.
for (const el of all) {
  const r = visRect(el);
  if (r.width < 12 || r.height < 12) continue;   // clipped away, or decorative
  const cs = getComputedStyle(el);
  if (cs.position === 'fixed') continue;
  if (r.right < 4 || r.left > vw - 4) {
    out.offscreen.push({ path: pathOf(el), text: label(el),
      left: Math.round(r.left), right: Math.round(r.right) });
    if (out.offscreen.length > 8) break;
  }
}

// ── things too small to tap ──────────────────────────────────────────
if (window.innerWidth <= 820) {
  for (const el of all) {
    if (!el.matches(INTERACTIVE)) continue;
    const r = visRect(el);
    if (r.width >= 40 && r.height >= 40) continue;
    if (r.width < 6 || r.height < 6) continue;   // decorative
    out.tiny.push({ path: pathOf(el), text: label(el),
      w: Math.round(r.width), h: Math.round(r.height) });
    if (out.tiny.length > 12) break;
  }
}

// ── text you cannot read against its own background ──────────────────
const lum = (c) => {
  const m = c.match(/[\\d.]+/g); if (!m) return null;
  const [r, g, b, a] = m.map(Number);
  if (a !== undefined && a < 0.5) return null;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const bgOf = (el) => {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    const l = lum(c);
    if (l !== null) return l;
  }
  return 1;
};
for (const el of all) {
  // Terminal output is the agent's own ANSI colours, painted by xterm through
  // a renderer the DOM does not describe — measuring it reports ratio 1.0 for
  // text that is plainly readable on screen. Not ours to style either way.
  if (el.closest('.xterm')) continue;
  const own = [...el.childNodes].filter((n) => n.nodeType === 3)
    .map((n) => n.textContent.trim()).join('');
  if (own.length < 2) continue;
  const cs = getComputedStyle(el);
  const fg = lum(cs.color);
  if (fg === null) continue;
  const bg = bgOf(el);
  const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  const size = parseFloat(cs.fontSize) || 16;
  const bold = Number(cs.fontWeight) >= 700;
  const large = size >= 24 || (size >= 18.66 && bold);
  if (ratio < (large ? 3 : 4.5)) {
    out.contrast.push({ path: pathOf(el), text: label(el),
      ratio: Math.round(ratio * 100) / 100, size: Math.round(size) });
    if (out.contrast.length > 12) break;
  }
}

return JSON.stringify(out);
`;

const findings = [];
const record = (page, vp, data) => {
  for (const kind of Object.keys(data)) {
    for (const f of data[kind]) findings.push({ page, viewport: vp, kind, ...f });
  }
};

/** The pages worth measuring, and how to reach each one. */
const PAGES = [
  { name: 'landing', go: async () => {
    await send('Page.navigate', { url: BASE + '/' });
    await waitFor(`document.querySelector('.landing-nav')`);
    // The onboarding tour opens a welcome card over everything on first visit.
    // It is correct behaviour and it is not what this audit is measuring.
    await evalJs(`localStorage.setItem('conduit-onboarding-completed','1');
                  localStorage.setItem('conduit-onboarding-skipped','1'); return true;`);
    await send('Page.reload');
    await waitFor(`document.querySelector('.landing-nav')`);
    await sleep(1200);
  } },
  { name: 'console/terminals', go: async () => {
    // about:blank first, deliberately. Going straight from `/` to `/#console`
    // is a same-document navigation — the hash listener swaps the view
    // immediately, so a wait for `.gr-tabs` passes against the *old* DOM and
    // then Page.reload tears it down underneath the measurement. That raced,
    // and on two of four widths the audit ended up measuring the landing page
    // while claiming to measure the console.
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(250);
    await send('Page.navigate', { url: BASE + '/#console' });
    await waitFor(`document.querySelector('.gr-tabs')`);
    await waitFor(`[...document.querySelectorAll('.sb-project')]
      .some(e => e.textContent.trim().startsWith(${JSON.stringify(projName)}))`);
    await evalJs(`
      const el = [...document.querySelectorAll('.sb-project')]
        .find(e => e.textContent.trim().startsWith(${JSON.stringify(projName)}));
      if (el) el.click(); return true;`);
    await waitFor(`document.querySelector('.terminal-container')`);
    await sleep(1500);
  } },
  { name: 'console/group-chat', tab: 'group chat' },
  { name: 'console/shared', tab: 'shared' },
  { name: 'console/wiki', tab: 'wiki' },
  { name: 'console/activity', tab: 'activity' },
  { name: 'console/usage', tab: 'usage' },
  { name: 'console/mcp', tab: 'mcp' },
  { name: 'command-palette', go: async () => {
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); return true;`);
    await sleep(900);
  }, after: async () => {
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true, cancelable: true })); return true;`);
    await sleep(500);
  } },
  { name: 'keeper-panel', go: async () => {
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'j', ctrlKey: true, bubbles: true, cancelable: true })); return true;`);
    await sleep(900);
  }, after: async () => {
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true, cancelable: true })); return true;`);
    await sleep(500);
  } },
  { name: 'settings', go: async () => {
    const ok = await evalJs(`
      const b = [...document.querySelectorAll('button')].find(x =>
        /settings/i.test(x.getAttribute('title') || '') ||
        /settings/i.test(x.getAttribute('aria-label') || '') ||
        /^\\s*settings\\s*$/i.test(x.textContent || ''));
      if (b) { b.click(); return true; } return false;`);
    await waitFor(`document.querySelector('.settings-card, .settings-modal .settings-h')`);
    await sleep(900);
    return ok;
  }, after: async () => {
    await evalJs(`document.querySelector('.modal-overlay')?.click();
      document.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Escape', bubbles: true, cancelable: true })); return true;`);
    await sleep(500);
  } },
];

for (const vp of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile,
  });
  console.log(`\n── ${vp.name} (${vp.w}×${vp.h})`);

  for (const page of PAGES) {
    if (ONLY && !page.name.includes(ONLY)) continue;
    try {
      if (page.go) {
        const reached = await page.go();
        if (reached === false) { console.log(`   ${page.name.padEnd(22)} (not reachable here)`); continue; }
      } else if (page.tab) {
        const ok = await clickText('.gr-tab', page.tab);
        if (!ok) { console.log(`   ${page.name.padEnd(22)} (tab not present)`); continue; }
        await sleep(1200);
      }
      const raw = await evalJs(MEASURE);
      if (!raw) { console.log(`   ${page.name.padEnd(22)} (could not measure)`); continue; }
      const data = JSON.parse(raw);
      const n = Object.values(data).reduce((s, a) => s + a.length, 0);
      record(page.name, vp.name, data);
      const bits = Object.entries(data).filter(([, a]) => a.length)
        .map(([k, a]) => `${k} ${a.length}`).join('  ');
      console.log(`   ${page.name.padEnd(22)} ${n === 0 ? 'clean' : bits}`);
      if (page.after) await page.after();
    } catch (err) {
      console.log(`   ${page.name.padEnd(22)} ! ${String(err.message || err).slice(0, 60)}`);
    }
  }
}

// ── report ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(72)}`);
if (findings.length === 0) {
  console.log('no layout defects found at any width\n');
} else {
  const byKind = {};
  for (const f of findings) (byKind[f.kind] ||= []).push(f);
  const distinct = new Set(findings.map((f) => f.kind + '|'
    + (f.kind === 'overlap' ? f.a + '|' + f.b : f.path))).size;
  console.log(`${distinct} distinct defect(s), ${findings.length} occurrence(s)\n`);
  for (const [kind, list] of Object.entries(byKind)) {
    console.log(`${kind.toUpperCase()} (${list.length})`);
    // Collapse the same defect appearing at several widths.
    // Group by the element, not by the page. The header sits on all eight
    // console pages, so a 32px button there is one defect to fix, not eight
    // findings to read.
    const groups = new Map();
    for (const f of list) {
      const key = kind === 'overlap' ? `${f.a}|${f.b}` : f.path;
      if (!groups.has(key)) groups.set(key, { ...f, widths: [], pages: [] });
      groups.get(key).widths.push(f.viewport);
      groups.get(key).pages.push(f.page);
    }
    for (const g of [...groups.values()].slice(0, 20)) {
      const pages = [...new Set(g.pages)];
      const where = `${pages.length > 2 ? pages.length + ' pages' : pages.join(',')}`
        + ` [${[...new Set(g.widths)].join(',')}]`;
      if (kind === 'overlap') {
        console.log(`  ${where}`);
        console.log(`    ${g.pct}% overlap${g.floating ? ' (one is floating)' : ''}`);
        console.log(`      A ${g.a}  "${g.aText}"`);
        console.log(`      B ${g.b}  "${g.bText}"`);
      } else if (kind === 'overflow') {
        console.log(`  ${where}  ${g.what} by ${g.by}px`);
        console.log(`    ${g.path}${g.text ? `  "${g.text}"` : ''}`);
      } else if (kind === 'clipped') {
        console.log(`  ${where}  cut off by ${g.by}px`);
        console.log(`    ${g.path}  "${g.text}"`);
      } else if (kind === 'tiny') {
        console.log(`  ${where}  ${g.w}×${g.h}px target`);
        console.log(`    ${g.path}  "${g.text}"`);
      } else if (kind === 'contrast') {
        console.log(`  ${where}  ratio ${g.ratio} at ${g.size}px`);
        console.log(`    ${g.path}  "${g.text}"`);
      } else {
        console.log(`  ${where}  ${g.path}  "${g.text || ''}"`);
      }
    }
    if (groups.size > 20) console.log(`  … and ${groups.size - 20} more`);
    console.log('');
  }
}

if (JSON_OUT) {
  const out = path.join(os.tmpdir(), 'conduit-layout.json');
  fs.writeFileSync(out, JSON.stringify(findings, null, 2));
  console.log(`full findings: ${out}`);
}

// ── cleanup ───────────────────────────────────────────────────────────
try { ws.close(); } catch { /* ignore */ }
try { browser.kill(); } catch { /* ignore */ }
await api('DELETE', `/projects/${projectId}?removeData=true`).catch(() => {});
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* windows */ }
process.exit(0);
