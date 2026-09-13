#!/usr/bin/env node
/**
 * Render architecture.png from scripts/architecture.html (npm run architecture).
 *
 * The old diagram was a PNG with no source, and it had drifted into being wrong
 * about the one thing it most needed to be right about: it drew the Express
 * server owning the agent PTYs, with start/stop arrows to each CLI. The daemon
 * owns them. That is the difference the README explains, the invariant
 * CLAUDE.md states, and the thing the demo proves by killing the web server and
 * showing the agents still running.
 *
 * Keeping the source in the repo means the next person can fix a box instead of
 * reverse-engineering an image.
 *
 * Usage:
 *   npm run architecture
 *   BROWSER=/path/to/chrome npm run architecture
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'scripts', 'architecture.html');
const OUT = path.join(ROOT, 'architecture.png');
const PORT = 9823;

const bin = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find((p) => fs.existsSync(p));

if (!bin) { console.error('No Chromium-based browser found; set BROWSER=<path>'); process.exit(2); }
if (!fs.existsSync(SRC)) { console.error(`Missing ${SRC}`); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(ROOT, '.arch-profile');

const chrome = spawn(bin, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--hide-scrollbars',
  '--force-device-scale-factor=2',   // retina-sharp text in the PNG
  '--window-size=1500,1100',
  '--no-first-run', '--no-default-browser-check',
  'about:blank',
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
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));

let msgId = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: 'file:///' + SRC.replace(/\\/g, '/') });
await sleep(1200);

// Size the capture to the sheet, so there is no dead space and no clipping.
const box = await send('Runtime.evaluate', {
  expression: `(() => { const el = document.getElementById('sheet');
    const r = el.getBoundingClientRect();
    return JSON.stringify({ w: Math.ceil(r.width), h: Math.ceil(el.scrollHeight) }); })()`,
  returnByValue: true,
});
const { w, h } = JSON.parse(box.result.result.value);

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: w, height: h, scale: 2 },
});

if (!shot?.result?.data) {
  console.error('no image returned');
  ws.close(); chrome.kill(); process.exit(1);
}

fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`architecture.png  ${w}x${h} at 2x  ${kb} KB`);

ws.close();
chrome.kill();
await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
