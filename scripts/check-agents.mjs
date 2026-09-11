#!/usr/bin/env node
/**
 * Starts one agent of every CLI type against a running Conduit and reports
 * whether each reaches a live terminal — or, when its CLI is unavailable,
 * whether it fails with the actionable preflight message instead of a
 * dead-looking shell.
 *
 * Usage: node scripts/check-agents.mjs        (needs `npm run start:all`)
 * Env:   CONDUIT_URL, CONDUIT_AUTH
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const BASE = process.env.CONDUIT_URL || 'http://localhost:3200';
const AUTH = process.env.CONDUIT_AUTH || '';
const CLIS = ['claude', 'codex', 'gemini', 'opencode', 'gpt', 'nemotron'];

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

const projName = 'agent-check-' + Date.now().toString(36);
const projCwd = path.join(os.tmpdir(), projName);
fs.mkdirSync(projCwd, { recursive: true });

let projectId = null;
let pass = 0, fail = 0;

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws', AUTH ? { headers } : undefined);
const output = new Map();   // agentId -> accumulated terminal text
ws.on('message', (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    if (m.type === 'terminal:output') output.set(m.agentId, (output.get(m.agentId) || '') + m.data);
    if (m.type === 'codex:item') output.set(m.agentId, (output.get(m.agentId) || '') + '[codex item]');
  } catch { /* ignore */ }
});

try {
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('websocket did not open')), 10000);
  });

  const p = await api('POST', '/projects', { name: projName, cwd: projCwd });
  if (p.status !== 201) throw new Error(`could not create project: ${p.status} ${JSON.stringify(p.json)}`);
  projectId = p.json.id;

  console.log(`\nAgent types — one of each, against ${BASE}\n`);

  for (const cli of CLIS) {
    const a = await api('POST', `/projects/${projectId}/agents`, { name: `probe-${cli}`, cli });
    if (a.status !== 201) {
      console.log(`  ✗ ${cli.padEnd(9)} could not be created (${a.status})`);
      fail++;
      continue;
    }
    const id = a.json.id;
    ws.send(JSON.stringify({ type: 'terminal:attach', agentId: id }));

    const st = await api('POST', `/projects/${projectId}/agents/${id}/start`);

    if (st.status === 200) {
      // Give the CLI a moment to paint something.
      for (let i = 0; i < 30 && !(output.get(id) || '').trim(); i++) await sleep(500);
      const bytes = (output.get(id) || '').length;
      const live = (await api('GET', `/projects/${projectId}/agents`)).json
        .find((x) => x.id === id)?.status !== 'stopped';
      if (bytes > 0 && live) {
        console.log(`  ✓ ${cli.padEnd(9)} running — ${bytes} bytes of terminal output`);
        pass++;
      } else {
        console.log(`  ✗ ${cli.padEnd(9)} started but produced ${bytes} bytes and is ${live ? 'alive' : 'stopped'}`);
        fail++;
      }
      await api('POST', `/projects/${projectId}/agents/${id}/stop`);
    } else {
      // A refusal is a pass only if it explains itself.
      const msg = String(st.json?.error || '');

      // "Agent not found" is not a refusal — it means the agent we just
      // created is no longer in the project, which is a different and much
      // more interesting failure than a missing CLI. Say what the project
      // actually holds, so it is not mistaken for a preflight message.
      if (st.status === 404) {
        const now = (await api('GET', `/projects/${projectId}/agents`)).json || [];
        console.log(`  ✗ ${cli.padEnd(9)} vanished after being created`);
        console.log(`      created ${id}, project now holds ${now.length}: `
          + `${now.map((x) => `${x.cli}/${x.id.slice(0, 8)}`).join(', ') || '(none)'}`);
        console.log(`      still listed: ${now.some((x) => x.id === id)}`);
        fail++;
        continue;
      }
      // Any refusal that says something specific is the intended behaviour;
      // only a silent or generic failure is a problem.
      const actionable = msg.length > 20 && !/^(internal|unknown)/i.test(msg);
      console.log(`  ${actionable ? '✓' : '✗'} ${cli.padEnd(9)} refused (${st.status}) — ${msg || 'no message'}`);
      actionable ? pass++ : fail++;
    }
    ws.send(JSON.stringify({ type: 'terminal:detach', agentId: id }));
  }
} catch (err) {
  fail++;
  console.error('\n  ✗ aborted:', err.message);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  if (projectId) await api('DELETE', `/projects/${projectId}?removeData=true`).catch(() => {});
  try { fs.rmSync(projCwd, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${pass} ok, ${fail} problems\n`);
  process.exit(fail ? 1 : 0);
}
