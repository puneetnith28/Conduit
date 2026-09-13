#!/usr/bin/env node
/**
 * Put the demo workspace back to its baseline between takes (npm run demo:reset).
 *
 * Two kinds of residue accumulate across recordings and both change how the
 * agents behave on the next take:
 *
 *   - files the agents wrote, and edits they made to files that were already
 *     there. `git reset --hard` plus `git clean` deals with those.
 *   - aider's own memory: `.aider.chat.history.md` grows every session (37 KB
 *     after a handful of takes here) and `.aider.tags.cache.v4` caches the
 *     repository map. aider reads the history back on start, so take four is
 *     answering with context from take one, and you cannot see why.
 *
 * It refuses to touch a directory that is not a git repository, and it refuses
 * to run if the baseline commit is missing, because both mean it is pointed
 * somewhere it should not be.
 *
 * Usage:
 *   npm run demo:reset
 *   DEMO_WORKSPACE=E:/OtherPlace npm run demo:reset
 *   npm run demo:reset -- --keep-agent-files   # only clear aider's memory
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WS = process.env.DEMO_WORKSPACE || 'E:/TestAgent';
const keepFiles = process.argv.includes('--keep-agent-files');

if (!fs.existsSync(WS)) {
  console.error(`No such directory: ${WS}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(WS, '.git'))) {
  console.error(`${WS} is not a git repository — refusing to clean it.`);
  console.error('Set DEMO_WORKSPACE if the demo lives somewhere else.');
  process.exit(1);
}

const git = (...args) =>
  execFileSync('git', args, { cwd: WS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ── aider's memory, always ────────────────────────────────────────────
// Removed even with --keep-agent-files: it is aider's state, not your work.
const aiderResidue = fs.readdirSync(WS).filter((f) => f.startsWith('.aider'));
let freed = 0;
for (const name of aiderResidue) {
  const p = path.join(WS, name);
  try {
    const st = fs.statSync(p);
    freed += st.isDirectory() ? 0 : st.size;
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`  cleared  ${name}`);
  } catch { /* locked by a running agent — stop it first */ }
}
if (!aiderResidue.length) console.log('  (no aider residue)');

// ── what the agents changed ───────────────────────────────────────────
if (keepFiles) {
  console.log('\n  --keep-agent-files: leaving the agents\' work in place.');
} else {
  let head = '';
  try { head = git('rev-parse', '--short', 'HEAD'); } catch {
    console.error('\nNo commits in this repository — nothing to reset to.');
    process.exit(1);
  }
  const dirty = git('status', '--porcelain');
  if (!dirty) {
    console.log(`\n  already clean at ${head}`);
  } else {
    const lines = dirty.split('\n').filter(Boolean);
    console.log(`\n  discarding ${lines.length} change${lines.length === 1 ? '' : 's'}:`);
    for (const l of lines.slice(0, 10)) console.log(`    ${l}`);
    if (lines.length > 10) console.log(`    … and ${lines.length - 10} more`);
    git('reset', '--hard');
    // -d for directories the agents created, -x so ignored build output goes
    // too. `build/` is tracked here, so it comes back from the reset.
    git('clean', '-fdx');
    console.log(`  reset to ${head}`);
  }
}

if (freed > 1024) console.log(`\n  freed ${(freed / 1024).toFixed(0)} KB of agent chat history`);
console.log(`\n${WS} is ready for the next take.`);
