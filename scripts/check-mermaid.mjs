#!/usr/bin/env node
/**
 * Parse every mermaid block in the markdown docs (npm run check:mermaid).
 *
 * A diagram with a syntax error does not fail loudly — GitHub renders a red
 * error box where the picture should be, and you only find out when someone
 * tells you. These are the architecture docs, so that someone is a reader
 * deciding whether the project is serious.
 *
 * Renders each block with the real mermaid parser in a headless browser, so
 * this agrees with what GitHub will do rather than approximating it.
 *
 * Usage:
 *   npm run check:mermaid
 *   node scripts/check-mermaid.mjs ARCHITECTURE.md docs/api.md
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9825;

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['ARCHITECTURE.md', 'README.md', ...fs.existsSync(path.join(ROOT, 'docs'))
      ? fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f)
      : []];

const blocks = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const txt = fs.readFileSync(abs, 'utf8');
  const lines = txt.split('\n');
  let inBlock = false, buf = [], startLine = 0;
  lines.forEach((line, i) => {
    if (!inBlock && /^```mermaid\s*$/.test(line)) { inBlock = true; buf = []; startLine = i + 1; return; }
    if (inBlock && /^```\s*$/.test(line)) {
      inBlock = false;
      blocks.push({ file: rel, line: startLine, code: buf.join('\n') });
      return;
    }
    if (inBlock) buf.push(line);
  });
}

if (!blocks.length) { console.log('No mermaid blocks found.'); process.exit(0); }
console.log(`${blocks.length} mermaid block(s) across ${new Set(blocks.map((b) => b.file)).size} file(s)\n`);

const bin = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find((p) => fs.existsSync(p));
if (!bin) { console.error('No Chromium-based browser found; set BROWSER=<path>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(ROOT, '.mermaid-profile');

const page = `<!doctype html><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<body><div id="out"></div><script>
  window.__ready = false;
  mermaid.initialize({ startOnLoad: false });
  window.__check = async (code) => {
    try { await mermaid.parse(code); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e && e.message || e).split('\\n').slice(0,3).join(' ') }; }
  };
  window.__ready = true;
</script></body>`;
const pagePath = path.join(ROOT, '.mermaid-check.html');
fs.writeFileSync(pagePath, page);

const chrome = spawn(bin, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const reachable = () => new Promise((res) => {
  const s = net.connect(PORT, '127.0.0.1');
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
});
let up = false;
for (let i = 0; i < 60; i++) { if (await reachable()) { up = true; break; } await sleep(250); }
if (!up) { chrome.kill(); console.error('browser did not start'); process.exit(2); }

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let msgId = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'file:///' + pagePath.replace(/\\/g, '/') });

let loaded = false;
for (let i = 0; i < 40; i++) {
  const r = await send('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true });
  if (r?.result?.result?.value === true) { loaded = true; break; }
  await sleep(400);
}
if (!loaded) {
  console.error('mermaid did not load (no network to the CDN?)');
  ws.close(); chrome.kill(); process.exit(2);
}

let bad = 0;
for (const b of blocks) {
  const r = await send('Runtime.evaluate', {
    expression: `window.__check(${JSON.stringify(b.code)})`,
    awaitPromise: true, returnByValue: true,
  });
  const v = r?.result?.result?.value || { ok: false, error: 'no result' };
  const where = `${b.file}:${b.line}`;
  const kind = b.code.trim().split('\n')[0].slice(0, 18);
  if (v.ok) {
    console.log(`  ok    ${where.padEnd(30)} ${kind}`);
  } else {
    bad++;
    console.log(`  FAIL  ${where.padEnd(30)} ${kind}`);
    console.log(`        ${v.error}`);
  }
}

console.log(`\n${blocks.length - bad} of ${blocks.length} parse.`);
ws.close(); chrome.kill();
await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
try { fs.rmSync(pagePath, { force: true }); } catch { /* ignore */ }
process.exit(bad ? 1 : 0);
