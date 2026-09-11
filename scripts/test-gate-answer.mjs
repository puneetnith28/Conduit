#!/usr/bin/env node
/**
 * Which prompts Conduit answers for you, and which ones still interrupt you.
 *
 * The rule used to be "a literal [y/N] is routine, everything else is the
 * human's problem", which meant a person got asked about every prompt that was
 * phrased any other way — including Claude Code's workspace trust prompt, which
 * every new agent hits before it can do anything at all. Being asked to approve
 * a door being opened, every time, is how an approval gate stops being read.
 *
 * The rule now is: routine if nothing in it is destructive *and* Conduit knows
 * which keys answer it. The second half matters — auto-approving something we
 * cannot actually type an answer to leaves the agent blocked while the audit
 * log records a decision, which is worse than asking.
 *
 * The interesting assertions here are the ones that still stop for a human.
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const asTs = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(fileURLToPath(asTs))) return { url: asTs.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { answerFor, isAnswerable, isTrustPrompt } = await import('../src/gate-answer.ts');
const { classifyGate } = await import('../src/gatePatterns.ts');

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

console.log('\nwhat Conduit answers, and what it asks about\n');

// ── the trust prompt: answered, not asked ─────────────────────────────
//
// Both spellings, because the terminal draws each word with its own cursor
// move and the text arrives with the spaces missing.
for (const text of [
  'Quick safety check: Is this a project you created or one you trust?',
  "Yes, I trust this folder",
  'Yes,Itrustthisfolder',
  'Isthisaprojectyoucreatedoroneyoutrust?',
]) {
  t(isTrustPrompt(text), `recognised as the trust prompt: ${JSON.stringify(text.slice(0, 42))}`);
  t(classifyGate(text, 'regex') === 'routine', '  and handled without asking');
}

{
  const a = answerFor('Yes, I trust this folder');
  t(!!a, 'the trust prompt has an answer');
  t(a.approve[0].data === ESC + '[B',
    'approving sends Down first — the highlighted row is "No, exit"',
    JSON.stringify(a?.approve?.[0]?.data));
  t(a.approve[1].data === CR && a.approve[1].delayMs >= 500,
    'then Enter, after a pause long enough to lose the race',
    JSON.stringify(a?.approve?.[1]));
  t(a.reject[0].data === ESC, 'rejecting sends Escape, which cancels it');
}

// ── ordinary y/n prompts: answered ────────────────────────────────────
for (const text of [
  'Create README.md? [y/N]',
  'Overwrite existing file? [Y/n]',
  'Proceed with installation (yes/no)',
  "No git repo found, create one to track aider's changes (recommended)? (Y)es/(N)o [Yes]:",
]) {
  t(classifyGate(text, 'regex') === 'routine', `answered without asking: ${JSON.stringify(text.slice(0, 44))}`);
  const a = answerFor(text);
  t(a?.approve[0].data === 'y' + CR, '  and approving types y');
  t(a?.reject[0].data === 'n' + CR, '  and rejecting types n');
}

// ── destructive things: always the human's call ───────────────────────
//
// These are the whole reason the gate exists. Every one of them contains a
// y/n prompt too, so they would sail through on the old rule if the risk
// check were ever reordered after it.
for (const text of [
  'Run `rm -rf /` ? [y/N]',
  'git push --force origin main [y/N]',
  'git reset --hard HEAD~5 [y/N]',
  'DROP TABLE users; [y/N]',
  'TRUNCATE TABLE orders (y/n)',
  'Remove-Item -Recurse -Force C:\\data [y/N]',
  'kubectl delete namespace production [y/N]',
  'terraform destroy [y/N]',
  'dd if=/dev/zero of=/dev/sda [y/N]',
  'mkfs.ext4 /dev/sdb1 [y/N]',
]) {
  t(classifyGate(text, 'regex') === 'harmful',
    `still asks a human: ${JSON.stringify(text.slice(0, 44))}`);
}

// ── anything the Supervisor flagged ───────────────────────────────────
t(classifyGate('Create README.md? [y/N]', 'supervisor') === 'harmful',
  'a Supervisor-raised gate is never routine, however harmless the text looks');

// ── prompts we cannot type an answer to ───────────────────────────────
//
// Not dangerous, necessarily — just unanswerable. Approving one automatically
// would record a decision and leave the agent exactly as blocked as before.
for (const text of [
  'Do you want to make this edit to auth.ts?',
  'Allow edit?',
  'Do you want to proceed?',
  'Are you sure you want to continue?',
  'Press any key to continue',
  '',
]) {
  t(!isAnswerable(text), `no known answer, so it asks: ${JSON.stringify(text.slice(0, 40))}`);
  t(classifyGate(text, 'regex') === 'harmful', '  and is classified harmful');
}

// ── the invariant that matters most ───────────────────────────────────
t(answerFor('Do you want to make this edit?') === null,
  'an unanswerable prompt returns null rather than a guess');
t(['rm -rf', 'git push --force', 'DROP TABLE']
  .every((c) => classifyGate(`${c} [y/N]`, 'regex') === 'harmful'),
  'destructive wins over answerable, every time');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('only the dangerous and the unanswerable interrupt you\n');
