#!/usr/bin/env node
/**
 * Which approvals reach the human.
 *
 * This is the one test in the suite where a false negative is dangerous rather
 * than annoying: a destructive command classified as "routine" would be
 * auto-approved and run. So the harmful cases are asserted individually and by
 * name, and the routine ones only have to be things a person would obviously
 * have clicked yes to.
 *
 * Run with:  node --experimental-strip-types scripts/test-gate-policy.mjs
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// `src/*.ts` imports its siblings with `.js` specifiers — what the TypeScript
// build wants, and what `--experimental-strip-types` refuses to resolve. Map
// the specifier back to the file that exists. Needed since gatePatterns gained
// a dependency on gate-answer.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const asTs = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(fileURLToPath(asTs))) return { url: asTs.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

// Dynamic, so the resolve hook above is already registered when this
// module graph loads. A static import is hoisted and resolved before any
// top-level code runs, which is why the hook alone was not enough once
// gatePatterns gained a sibling dependency.
const { classifyGate, gateQuestion } = await import('../src/gatePatterns.ts');

let passed = 0;
let failed = 0;
function t(ok, label, detail) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\nGate policy — what reaches the human\n');

// ── Harmful: always the human's call ──────────────────────────────────
// Each of these is a real terminal tail shape: the destructive command sits on
// a line, and the CLI is asking to run it. Both facts are present, and the
// destructive one has to win.
const HARMFUL = [
  ['rm -rf', '$ rm -rf ./build\nProceed? [y/N]'],
  ['force push', '$ git push --force origin main\nDo you want to proceed?'],
  ['reset --hard', 'About to run: git reset --hard HEAD~3\nContinue? (y/n)'],
  ['branch -D', 'git branch -D feature/auth\nAre you sure? [y/N]'],
  ['DROP TABLE', 'Executing: DROP TABLE sessions;\nConfirm (yes/no)'],
  ['TRUNCATE', 'TRUNCATE TABLE audit_log;\nProceed? [y/N]'],
  ['kubectl delete', '$ kubectl delete namespace prod\nAre you sure you want to continue?'],
  ['terraform destroy', 'terraform destroy -auto-approve\nDo you want to proceed?'],
  ['mkfs', 'mkfs.ext4 /dev/sda1\n[y/N]'],
  ['dd', 'dd if=/dev/zero of=/dev/sda\nContinue? (y/n)'],
  ['Remove-Item -Recurse', 'Remove-Item -Recurse -Force C:\\data\nAre you sure? [Y/n]'],
  ['format', 'format c:\nProceed? [y/N]'],
];
for (const [label, text] of HARMFUL) {
  t(classifyGate(text, 'regex') === 'harmful', `${label} stays with the human`,
    classifyGate(text, 'regex'));
}

// The Supervisor looked at this and called it risky. A regex does not overrule
// a model that has already read the context.
t(classifyGate('The agent is about to rewrite the deployment config.', 'supervisor') === 'harmful',
  'anything the Supervisor raised stays with the human');

// An unfamiliar prompt shape is not something to guess at.
t(classifyGate('Do you want to make this edit to auth.ts?', 'regex') === 'harmful',
  "a prompt we cannot answer with a keystroke stays with the human");
t(classifyGate('Allow command?', 'regex') === 'harmful',
  'a permission dialog with no y/n marker stays with the human');

// ── Routine: the thing the Keeper is for ──────────────────────────────
const ROUTINE = [
  ['create a file', 'Create README.md? [y/N]'],
  ['aider git repo', "No git repo found, create one to track aider's changes (recommended)? (Y)es/(N)o [Yes]:"],
  ['install a dep', 'Add pytest to requirements.txt? (yes/no)'],
  ['write a test', 'Create tests/test_auth.py with 4 cases? [Y/n]'],
  ['continue', 'Continue with the plan? (y/n)'],
];
for (const [label, text] of ROUTINE) {
  t(classifyGate(text, 'regex') === 'routine', `${label} is handled without asking`,
    classifyGate(text, 'regex'));
}

// ── The one line the user actually reads ──────────────────────────────
console.log('');
const tail = [
  '───────────────────────────────────────',
  '',
  'Applied edit to README.md',
  '',
  'Create README.md? [y/N]',
  '',
].join('\n');
const q = gateQuestion(tail);
t(q === 'Create README.md? [y/N]', 'the notice quotes the question, not the terminal', q);
t(!q.includes('\n'), 'and it is one line', JSON.stringify(q));

const long = 'Do you want to ' + 'x'.repeat(300) + '? [y/N]';
t(gateQuestion(long).length <= 120, 'a very long prompt is capped', String(gateQuestion(long).length));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
