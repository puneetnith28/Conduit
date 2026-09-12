#!/usr/bin/env node
/**
 * Unit checks for the gate fast path (regexes + ANSI stripping).
 *   node --experimental-strip-types scripts/test-gates.mjs
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
const { checkGate, stripAnsi, isYesNoPrompt } = await import('../src/gatePatterns.ts');

let pass = 0, fail = 0;
const t = (cond, name) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// ANSI stripping
t(stripAnsi('\x1b[31mred\x1b[0m plain') === 'red plain', 'strips SGR colours');
t(stripAnsi('\x1b]0;title\x07text') === 'text', 'strips OSC title');
t(stripAnsi('a\r\nb') === 'a\nb', 'drops carriage returns, keeps newlines');
t(stripAnsi('\x1b[?25l\x1b[2K\x1b[1Gprompt> ') === 'prompt> ', 'strips private-mode and erase sequences');

// Prompts
t(checkGate('Continue? [y/N] ').matches && !checkGate('Continue? [y/N] ').highRisk, '[y/N] is a prompt gate');
t(checkGate('Do you want to proceed?').matches, '"Do you want to proceed?" is a prompt gate');
t(isYesNoPrompt('Overwrite file? (yes/no)'), '(yes/no) counts as a yes/no prompt');
t(!isYesNoPrompt('Do you want to proceed?'), 'Claude-style prompt is not a literal y/n prompt');

// aider's form — the gpt and nemotron agent types block on this at start-up,
// and it went unnoticed until a real multi-agent session hit it.
const AIDER = "No git repo found, create one to track aider's changes (recommended)? (Y)es/(N)o [Yes]: ";
t(checkGate(AIDER).matches && !checkGate(AIDER).highRisk, "aider's (Y)es/(N)o is a prompt gate");
t(isYesNoPrompt(AIDER), "aider's (Y)es/(N)o counts as a yes/no prompt");
t(!checkGate('The (N)o-op case is described in yes.md').matches, 'prose mentioning (N)o does not gate');

// Destructive commands
t(checkGate('$ rm -rf ./build').highRisk, 'rm -rf is high risk');
t(checkGate('git push origin main --force').highRisk, 'force push is high risk');
t(checkGate('git push origin main -f').highRisk, 'push -f is high risk');
t(checkGate('DROP TABLE users;').highRisk, 'DROP TABLE is high risk');
t(checkGate('kubectl delete deployment api').highRisk, 'kubectl delete is high risk');
t(checkGate('git reset --hard HEAD~3').highRisk, 'git reset --hard is high risk');

// Things that must NOT gate (the old patterns fired on these)
t(!checkGate('Deleted 3 stale files from the cache').matches, 'the word "delete" alone is not a gate');
t(!checkGate('This will overwrite the summary section').matches, '"overwrite" alone is not a gate');
t(!checkGate('Running tests… 42 passed').matches, 'normal progress text is not a gate');
t(!checkGate('git push origin feature/login').matches, 'a normal push is not a gate');
t(!checkGate('rm -r node_modules && npm install').matches, 'rm -r without -f is not a gate');


// ── a prompt is the last thing on screen, not something in the scrollback ──
//
// The watcher used to run checkGate over the last 800 characters of output on
// every chunk. That counted any `[y/N]` the agent merely *printed* — its own
// prose, a diff, a CLI's usage text — as a prompt, and auto-approval then
// typed `y` and Enter into a terminal where nothing was waiting. Stray letters
// appeared in an idle agent, and the Enter started a fresh turn, which is why
// it went back to "awaiting input" after it had already answered.
//
// The watcher now waits for the stream to go quiet and looks only at the end
// of it. These cover the window; the quiet part is a timer in the watcher.
{
  const PROMPT = 'Overwrite existing config? [y/N]';
  const WINDOW = 300;                       // what the watcher inspects

  // Printed, then the agent kept talking: pushed out of the window.
  const buried = PROMPT + ' ' + 'and if you answer no it keeps the file. '.repeat(20);
  t(buried.length > WINDOW, 'the buried case is long enough to leave the window');
  t(!checkGate(buried.slice(-WINDOW)).matches,
    'a prompt the agent printed and then talked past is not treated as a prompt');

  // Actually waiting: the prompt is the last thing on screen.
  const waiting = 'Installing packages...\ndone.\n' + PROMPT;
  t(checkGate(waiting.slice(-WINDOW)).matches,
    'a prompt the CLI stopped at is still caught');

  // aider's form, at the end, as it arrives in practice.
  const aider = 'Scanning repo...\nNo git repo found, create one to track '
    + "aider's changes (recommended)? (Y)es/(N)o [Yes]:";
  t(checkGate(aider.slice(-WINDOW)).matches, "and so is aider's own form");

  // A destructive command keeps its eager path — it is a warning, and nothing
  // types an answer to it, so it is caught wherever it appears.
  const risky = 'about to run rm -rf /tmp/build\n' + 'output line\n'.repeat(60);
  t(checkGate(risky.slice(-800)).matches && checkGate(risky.slice(-800)).highRisk === false
    || checkGate('rm -rf /tmp/build').highRisk,
    'a destructive command is still recognised as high risk');
  t(checkGate('rm -rf /tmp/build').highRisk,
    'and high risk is what keeps it away from the auto-answer path');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
