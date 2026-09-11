/**
 * Fast-path detection of moments where an agent needs a human decision.
 *
 * Two classes of match:
 *  - a *prompt* — the CLI is literally waiting for y/n style input
 *  - a *high-risk command* — destructive shell / git / SQL that a human should
 *    see before it runs
 *
 * These run on ANSI-stripped terminal text (see `stripAnsi`). They are
 * deliberately narrow: the word "delete" in a status line is not a gate, but
 * `rm -rf` on a command line is.
 */

export const COMMON_GATE_PATTERNS = [
  /\[y\/N\]/i,
  /\[Y\/n\]/i,
  /\(yes\/no\)/i,
  /\(y\/n\)/i,
  // aider's own form, e.g. "create one to track aider's changes
  // (recommended)? (Y)es/(N)o [Yes]:" — the gpt and nemotron agent types run on
  // aider, and this blocks them on start until someone answers.
  /\(Y\)es\s*\/\s*\(N\)o/i,
  /Do you want to proceed\?/i,
  /Do you want to (?:make this edit|run this command|allow)/i,
  /Allow (?:edit|command|tool)\?/i,
  /Are you sure(?: you want to)?[^\n]{0,60}\?/i,
  // Claude Code's first-run workspace trust prompt:
  //
  //   Quick safety check: Is this a project you created or one you trust?
  //   ❯ No, exit
  //     Yes, I trust this folder
  //
  // Nothing matched this, so every freshly created Claude agent sat on it
  // forever: started, drawing a terminal, producing no output and raising no
  // gate. It reads as "the agent is taking a long time" and it is actually
  // "the agent is waiting for a keypress nobody was told about".
  //
  // `\s*` between the words because the terminal positions each one
  // separately — stripped of escapes the line arrives as
  // "Yes,Itrustthisfolder", with no spaces at all.
  /trust\s*this\s*folder/i,
  /Is\s*this\s*a\s*project\s*you\s*created\s*or\s*one\s*you\s*trust/i,
];

/**
 * Is this the workspace trust prompt?
 *
 * It is answered with arrow keys, not a letter, and the highlighted default is
 * "No, exit" — so the obvious guesses are both wrong: `y` does nothing and a
 * bare Enter quits the agent.
 */
export function isTrustPrompt(text: string): boolean {
  return /trust\s*this\s*folder/i.test(text)
    || /Is\s*this\s*a\s*project\s*you\s*created\s*or\s*one\s*you\s*trust/i.test(text);
}

export const HIGH_RISK_KEYWORDS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,   // rm -rf / rm -fr
  /\bgit\s+push\b[^\n]*(--force|-f\b)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)\b/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\b[^\n]*(?!WHERE)/i,
  /\b(Remove-Item|rmdir|del)\b[^\n]*(-Recurse|\/s\b|\/q\b)/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bkubectl\s+delete\b/i,
  /\bterraform\s+(destroy|apply\s+-auto-approve)\b/i,
];

/** Remove ANSI / VT escape sequences and control characters from PTY text. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')   // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[()][A-Z0-9]/g, '')             // charset switches
    .replace(/\x1b[>=<78]/g, '')                  // keypad / cursor save-restore
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')     // DCS / SOS / PM / APC strings
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export function checkGate(text: string): { matches: boolean; highRisk: boolean; reason: string } {
  const risky = HIGH_RISK_KEYWORDS.find((p) => p.test(text));
  if (risky) {
    const m = text.match(risky);
    return { matches: true, highRisk: true, reason: (m?.[0] || 'high-risk command').trim() };
  }
  const prompt = COMMON_GATE_PATTERNS.find((p) => p.test(text));
  if (prompt) {
    const m = text.match(prompt);
    return { matches: true, highRisk: false, reason: (m?.[0] || 'prompt').trim() };
  }
  return { matches: false, highRisk: false, reason: '' };
}

/** True when the prompt text looks like it expects a literal y / n answer. */
export function isYesNoPrompt(text: string): boolean {
  return /\[y\/N\]|\[Y\/n\]|\(yes\/no\)|\(y\/n\)|\(Y\)es\s*\/\s*\(N\)o/i.test(text);
}

/**
 * Which side of the line a gate falls on.
 *
 *   harmful — expensive or impossible to undo, or something the Supervisor
 *             itself flagged. Always the human's call.
 *   routine — the CLI is waiting on an ordinary y/n prompt and nothing in the
 *             text looks destructive.
 *
 * Conservative in one direction only: a prompt we cannot confidently call
 * routine is harmful, and goes to the human.
 */
export type GateRisk = 'routine' | 'harmful';

export function classifyGate(prompt: string, source: 'regex' | 'supervisor'): GateRisk {
  // A model already read the context and called this risky. A regex does not
  // get to overrule that.
  if (source === 'supervisor') return 'harmful';
  if (checkGate(prompt).highRisk) return 'harmful';
  return isYesNoPrompt(prompt) ? 'routine' : 'harmful';
}

/**
 * The one line worth telling the user about an auto-approval.
 *
 * The gate carries a terminal tail — rules, spinners, blank lines, and the
 * question somewhere near the end. Nobody wants six lines of that scrolling
 * past every time an agent asks to write a file; they want to know what was
 * asked and that it was allowed.
 */
export function gateQuestion(prompt: string, max = 120): string {
  const lines = prompt
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /[A-Za-z0-9]/.test(l));
  const asked = [...lines].reverse().find((l) => isYesNoPrompt(l)) || lines[lines.length - 1] || '';
  const tidy = asked.replace(/\s+/g, ' ').trim();
  return tidy.length > max ? tidy.slice(0, max - 1).trimEnd() + '…' : tidy;
}
