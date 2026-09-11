#!/usr/bin/env node
/**
 * Throw malformed input at the REST API and report anything that 500s, hangs
 * or takes the process down.
 *
 * A 400 or a 404 is a pass — refusing bad input is the job. A 500 is a bug,
 * because it says Conduit broke when the caller was at fault, and it sends the
 * next person debugging into the server logs looking for a crash that is not
 * there. Path traversal attempts must all be refused.
 *
 * It creates its own project and agent and deletes them at the end.
 *
 * Usage:
 *   npm run start:all        # in one shell
 *   npm run check:abuse
 *
 * Env: CONDUIT_URL (default http://localhost:3200)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.CONDUIT_URL || 'http://localhost:3200';

async function hit(method, route, body, contentType = 'application/json') {
  const started = Date.now();
  try {
    const res = await fetch(BASE + route, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': contentType },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(15000),
    });
    let text = '';
    try { text = (await res.text()).slice(0, 160); } catch { /* ignore */ }
    return { status: res.status, ms: Date.now() - started, text };
  } catch (err) {
    return { status: 'THREW', ms: Date.now() - started, text: String(err).slice(0, 160) };
  }
}

const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`Conduit is not running on ${BASE} — start it with \`npm run start:all\`.`);
  process.exit(2);
}

// A throwaway directory, never the repository: starting an agent writes a
// Conduit section into the CLAUDE.md of its working directory, and a test must
// not edit the checkout it is testing.
const fixtureName = 'abuse-' + Date.now().toString(36);
const fixtureCwd = path.join(os.tmpdir(), fixtureName);
fs.mkdirSync(fixtureCwd, { recursive: true });

const created = await (await fetch(BASE + '/api/projects', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: fixtureName, cwd: fixtureCwd }),
})).json();
const pid = created.id;
const agent = await (await fetch(`${BASE}/api/projects/${pid}/agents`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'A', cli: 'claude' }),
})).json();
const aid = agent.id;
console.log(`fixture: project ${pid}, agent ${aid}\n`);

const long = 'x'.repeat(200000);
const cases = [
  ['GET', '/api/projects/does-not-exist'],
  ['GET', `/api/projects/${pid}/content/..%2F..%2F..%2Fsecrets.txt`],
  ['GET', `/api/projects/${pid}/content/....//....//package.json`],
  ['GET', `/api/projects/${pid}/wiki/..\\..\\..\\.env`],
  ['POST', `/api/projects/${pid}/content`, { filename: '../../escape.md', content: 'x' }],
  ['POST', `/api/projects/${pid}/content`, { filename: 'C:/Windows/pwn.txt', content: 'x' }],
  ['POST', `/api/projects/${pid}/content`, { filename: '', content: 'x' }],
  ['POST', `/api/projects/${pid}/content`, { filename: long, content: 'x' }],
  ['POST', '/api/projects', { name: '../../../evil', cwd: fixtureCwd }],
  ['POST', '/api/projects', { name: '', cwd: '' }],
  ['POST', '/api/projects', { name: 'ok', cwd: 'Z:/definitely/not/here' }],
  ['POST', '/api/projects', null],
  ['POST', '/api/projects', '{not json', 'application/json'],
  ['POST', `/api/projects/${pid}/agents`, { name: 'B', cli: 'rm -rf /' }],
  ['POST', `/api/projects/${pid}/agents`, { name: long, cli: 'claude' }],
  ['POST', `/api/projects/${pid}/agents/${aid}/start`, { flags: ['--dangerously', long] }],
  ['POST', `/api/projects/${pid}/agents/nope/start`],
  ['POST', `/api/projects/${pid}/agents/${aid}/gate/resolve`, { decision: 'approve' }],
  ['POST', `/api/projects/${pid}/agents/${aid}/gate/resolve`, { decision: 'DROP TABLE' }],
  ['POST', `/api/projects/${pid}/groupchat`, { message: long }],
  ['POST', `/api/projects/${pid}/groupchat`, { message: '@nobody hello' }],
  ['POST', `/api/projects/${pid}/groupchat`, {}],
  ['PUT', `/api/projects/${pid}/wiki/../../../outside.md`, { content: 'x' }],
  ['PUT', `/api/projects/${pid}/wiki/overview.md`, { content: long }],
  ['GET', '/api/projects/' + 'a'.repeat(5000)],
  ['POST', '/api/voice/transcribe', 'not-audio', 'audio/webm'],
  ['GET', '/api/health'],
  ['DELETE', `/api/projects/${pid}/agents/${aid}`],
  ['DELETE', `/api/projects/${pid}?removeData=true`],
];

// Everything that existed before we started throwing rubbish at the server.
//
// Some of these payloads are *supposed* to succeed: `name: '../../../evil'`
// tests that a traversal in a project name is sanitised, and Conduit correctly
// sanitises it to "evil" and creates the project. The check only ever deleted
// the fixture it created on purpose, so that one survived every run and piled
// up in the user's project list — there was an "evil" sitting in it all day.
//
// Comparing against a snapshot cleans up whatever the payloads managed to
// create, including the ones nobody thought to track.
const projectsBefore = new Set(
  ((await (await fetch(`${BASE}/api/projects`)).json().catch(() => [])) || [])
    .map((x) => x.id),
);

let bad = 0;
for (const [method, route, body, ct] of cases) {
  const r = await hit(method, route, body, ct);
  const label = `${method} ${route.slice(0, 72)}`;
  const suspicious = r.status === 'THREW' || (typeof r.status === 'number' && r.status >= 500);
  if (suspicious) bad++;
  console.log(`${suspicious ? '✗' : '✓'} ${String(r.status).padEnd(5)} ${String(r.ms).padStart(5)}ms  ${label}`);
  if (suspicious) console.log(`      ${r.text}`);
}

// The point of the whole exercise: none of the above took the server with it.
const after = await hit('GET', '/api/health');
// Take back anything the payloads created. A check that leaves projects behind
// is a check that makes the thing it is testing worse.
{
  const after = (await (await fetch(`${BASE}/api/projects`)).json().catch(() => [])) || [];
  const strays = after.filter((x) => !projectsBefore.has(x.id));
  for (const x of strays) {
    await fetch(`${BASE}/api/projects/${x.id}?removeData=true`, { method: 'DELETE' })
      .catch(() => { /* best effort */ });
  }
  if (strays.length) {
    console.log(`\ncleaned up ${strays.length} project(s) the payloads created: `
      + strays.map((x) => JSON.stringify(x.name)).join(', '));
  }
}

console.log(`\nserver alive afterwards: ${after.status === 200}`);
// The delete above must have taken Conduit's section back out of the fixture's
// own CLAUDE.md. Starting an agent edits the user's repository; deleting the
// project has to undo it.
const leftovers = fs.existsSync(fixtureCwd)
  ? fs.readdirSync(fixtureCwd).filter((f) => f === 'CLAUDE.md' || f === 'AGENTS.md')
  : [];
if (leftovers.length) {
  bad++;
  console.log(`✗ deleting the project left ${leftovers.join(', ')} behind in the agent's cwd`);
} else {
  console.log('✓ deleting the project removed the instruction files it wrote');
}
try { fs.rmSync(fixtureCwd, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(bad === 0 ? '\nno 5xx and no dropped connections' : `\n${bad} problem(s)`);
process.exit(bad === 0 && after.status === 200 ? 0 : 1);
