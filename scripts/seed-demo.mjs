#!/usr/bin/env node
/**
 * Seed a demo project so a first-time tester lands on something, not an empty
 * console (npm run seed:demo).
 *
 * A fresh install has no projects. `ensureDemoWorkspace()` in the client only
 * *selects* the first project — it does not create one — so someone evaluating
 * Conduit for the first time opens the console, sees nothing at all, and has to
 * guess what to do. This gives them a project, a workspace directory with a
 * file in it, and one agent per CLI that is actually installed on the machine.
 *
 * It does not start the agents. Starting costs the tester's own API budget, and
 * which ones they can afford to run is their decision, not this script's.
 *
 * Safe to run twice: it reuses a project of the same name rather than making a
 * second one.
 *
 * Usage:
 *   npm run seed:demo
 *   CONDUIT_URL=http://host:3200 CONDUIT_AUTH=user:pass npm run seed:demo
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = (process.env.CONDUIT_URL || 'http://localhost:3200').replace(/\/$/, '');
const NAME = process.env.SEED_PROJECT_NAME || 'Demo';
const WORKSPACE = process.env.SEED_WORKSPACE
  || path.join(os.homedir(), '.conduit', 'demo-workspace');

const auth = (process.env.CONDUIT_AUTH || '').trim();
const headers = {
  'content-type': 'application/json',
  ...(auth ? { Authorization: 'Basic ' + Buffer.from(auth).toString('base64') } : {}),
};

async function api(method, p, body) {
  const res = await fetch(BASE + '/api' + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* some routes return no body */ }
  return { status: res.status, json };
}

// ── is anything listening? ────────────────────────────────────────────
const health = await api('GET', '/health').catch(() => ({ status: 0 }));
if (health.status === 401) {
  console.error('401 — this instance needs CONDUIT_AUTH=user:pass in your environment.');
  process.exit(1);
}
if (health.status !== 200) {
  console.error(`Conduit is not answering on ${BASE}. Start it with \`npm run start:all\` first.`);
  process.exit(1);
}

// ── a workspace with something in it ──────────────────────────────────
// An empty directory makes the agents' first answers uninteresting, and aider
// asks to create a git repo in one, which raises a gate before the tester has
// any idea what a gate is.
fs.mkdirSync(WORKSPACE, { recursive: true });
const readme = path.join(WORKSPACE, 'README.md');
if (!fs.existsSync(readme)) {
  fs.writeFileSync(readme, [
    '# Demo workspace',
    '',
    'Scratch space for trying Conduit out. Nothing here matters — the agents may',
    'change or delete any of it, which is the point.',
    '',
    '## Something to ask an agent for',
    '',
    '- "read README.md and summarise it"',
    '- "add a hello world script in Python"',
    '- "list the files here and tell me what this project is"',
    '',
  ].join('\n'));
}
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: WORKSPACE, stdio: 'ignore' });
} catch {
  try {
    execFileSync('git', ['init', '-q'], { cwd: WORKSPACE, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: WORKSPACE, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=demo@conduit.local', '-c', 'user.name=Conduit',
      'commit', '-qm', 'demo workspace'], { cwd: WORKSPACE, stdio: 'ignore' });
  } catch { /* git missing is not fatal — the agents just get a plain directory */ }
}

// ── the project ───────────────────────────────────────────────────────
const existing = await api('GET', '/projects');
const list = Array.isArray(existing.json) ? existing.json : (existing.json?.projects || []);
const already = list.find((p) => (p.project?.name || p.name) === NAME);

let projectId;
if (already) {
  projectId = already.project?.id || already.id;
  console.log(`reusing project "${NAME}" (${projectId})`);
} else {
  const made = await api('POST', '/projects', {
    name: NAME,
    cwd: WORKSPACE,
    description: 'Seeded so a first run has something to look at.',
  });
  projectId = made.json?.project?.id || made.json?.id;
  if (!projectId) {
    console.error('could not create the project:', made.status, JSON.stringify(made.json));
    process.exit(1);
  }
  console.log(`created project "${NAME}" (${projectId})`);
}
console.log(`workspace: ${WORKSPACE}`);

// ── one agent per CLI ─────────────────────────────────────────────────
// All six, always. Creating an agent does not check whether its CLI exists —
// that check happens on *start*, which is the right place for it: you can
// define your fleet now and install a tool later. So a tester ends up with all
// six visible, and pressing Start on one whose CLI is missing tells them the
// command that installs it. That is a better introduction than a short list
// with no explanation of what is absent or why.
const ALL_CLIS = ['claude', 'codex', 'gemini', 'opencode', 'gpt', 'nemotron'];

const LABEL = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini',
  opencode: 'OpenCode', gpt: 'Gpt', nemotron: 'Nemotron',
};

const before = await api('GET', `/projects/${projectId}/agents`);
const have = new Set((before.json || []).map((a) => a.cli));

let added = 0;
const skipped = [];
for (const cli of ALL_CLIS) {
  if (have.has(cli)) continue;
  const r = await api('POST', `/projects/${projectId}/agents`, {
    name: LABEL[cli] || cli, cli,
  });
  if (r.status === 201 || r.status === 200) { added += 1; console.log(`  + ${LABEL[cli] || cli}`); }
  else skipped.push(`${cli} (${String(r.json?.error || r.status).slice(0, 60)})`);
}

console.log('');
console.log(`${added} agent${added === 1 ? '' : 's'} added, ${have.size} already there.`);
if (skipped.length) {
  console.log('refused by the server:');
  for (const s of skipped) console.log('  - ' + s);
}
console.log('');
console.log('Agents are created without checking their CLI is installed. Pressing Start');
console.log('on one that is missing tells you the command that installs it.');
console.log('');
console.log(`Open ${BASE}/#console and press Start on an agent.`);
console.log('Nothing was started — that would spend your API budget without asking.');
