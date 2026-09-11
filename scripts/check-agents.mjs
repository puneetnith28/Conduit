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

/**
 * Describe an error that may not have anything useful in `.message`.
 *
 * AggregateError — which is what a refused socket produces — carries an empty
 * message and puts the real reason in `.errors`. Printing `err.message` alone
 * is how a total failure comes out as a blank line.
 */
function describeError(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`(${err.code})`);
  if (Array.isArray(err.errors) && err.errors.length) {
    parts.push(err.errors.map((e) => e?.message || String(e)).join('; '));
  }
  if (!parts.length) parts.push(err.constructor?.name || String(err));
  return parts.join(' ');
}

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

/**
 * Say plainly when there is nothing to check against.
 *
 * Without this the first failure was the WebSocket, and `ws` rejects a refused
 * connection with an AggregateError whose `.message` is the empty string — it
 * aggregates the IPv6 and IPv4 attempts and keeps the detail in `.errors`. So
 * running this without `npm run start:all` printed
 *
 *     ✗ aborted:
 *     0 ok, 1 problems
 *
 * which names neither the problem nor the fix, and reads like the script
 * itself is broken.
 */
const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`\nConduit is not running on ${BASE} — start it with \`npm run start:all\`.`);
  process.exit(2);
}
if (!health.daemon) {
  console.error(`\nThe web server on ${BASE} is up but the daemon is not connected.`);
  console.error('Agents live in the daemon, so nothing can start. Check the `npm run start:all` output.');
  process.exit(2);
}

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
      // "It printed something" is not "it is working".
      //
      // Claude Code's first-run trust prompt is itself terminal output, so an
      // agent blocked on it satisfied a byte count and was reported as
      // running while it was waiting for a keypress and would wait forever.
      // Conduit raises a gate for this now; the point here is that a blocked
      // agent must never again be counted as a working one.
      const text = output.get(id) || '';
      const blocked = /trust\s*this\s*folder/i.test(text)
        || /Is\s*this\s*a\s*project\s*you\s*created/i.test(text);
      if (blocked) {
        console.log(`  ✗ ${cli.padEnd(9)} is blocked on the workspace trust prompt, not running`);
        fail++;
      } else if (bytes > 0 && live) {
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
  console.error('\n  ✗ aborted:', describeError(err));
} finally {
  try { ws.close(); } catch { /* ignore */ }
  if (projectId) await api('DELETE', `/projects/${projectId}?removeData=true`).catch(() => {});
  try { fs.rmSync(projCwd, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${pass} ok, ${fail} problems\n`);
  process.exit(fail ? 1 : 0);
}
