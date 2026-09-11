/**
 * How do you actually answer this prompt?
 *
 * Conduit had two separate ideas about that. Auto-approval typed a `y` and
 * hoped; the approve button had its own branch and did nothing at all when the
 * prompt was not a literal y/n question. So a prompt Conduit could not type an
 * answer to was either silently ignored or, worse, auto-approved by sending a
 * `y` the terminal discarded — leaving an agent blocked by a decision the
 * audit log recorded as made.
 *
 * One function owns it now, and it answers the question the risk policy needs:
 * a prompt is only safe to handle automatically if we know how to handle it.
 * `answerFor` returning null means "a human has to look at this", which is
 * exactly the set `classifyGate` refuses to call routine.
 *
 * The keystrokes are measured against the real CLIs, not guessed. Where a
 * sequence needs a pause, the pause travels with it instead of being something
 * every caller has to remember.
 */

/** One thing to type, optionally after waiting. */
export interface Keystroke {
  data: string;
  /** Wait this long after the previous keystroke before sending this one. */
  delayMs?: number;
}

/**
 * Type a sequence, honouring the pauses between its keys.
 *
 * The delays accumulate, which is the whole point: written as independent
 * timers, a 900ms Down and a 600ms Enter fire at 900ms and 600ms — the Enter
 * lands first, on whichever row was highlighted to begin with. For the trust
 * prompt that row is "No, exit".
 */
export function typeKeys(write: (data: string) => void, keys: Keystroke[]): void {
  let at = 0;
  for (const k of keys) {
    at += k.delayMs ?? 0;
    const data = k.data;
    if (at === 0) write(data);
    else setTimeout(() => { try { write(data); } catch { /* agent gone */ } }, at);
  }
}

export interface GateAnswer {
  /** What to type to allow it. */
  approve: Keystroke[];
  /** What to type to refuse it. */
  reject: Keystroke[];
  /** For the audit log, in the past tense. */
  describe: string;
}

/** ESC, spelled out: a literal control byte in source is too easy to lose. */
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

/** A literal y/n question: shells, installers, git, aider. */
const YES_NO = /\[y\/N\]|\[Y\/n\]|\(yes\/no\)|\(y\/n\)|\(Y\)es\s*\/\s*\(N\)o/i;

/**
 * Claude Code's first-run workspace trust prompt.
 *
 *   Quick safety check: Is this a project you created or one you trust?
 *   > No, exit
 *     Yes, I trust this folder
 *
 * The pattern allows missing whitespace because the terminal draws each word
 * with its own cursor move: stripped of escapes the line arrives as
 * "Yes,Itrustthisfolder", with no spaces at all.
 */
const TRUST = /trust\s*this\s*folder|Is\s*this\s*a\s*project\s*you\s*created\s*or\s*one\s*you\s*trust/i;

export function isTrustPrompt(text: string): boolean {
  return TRUST.test(text);
}

export function answerFor(prompt: string): GateAnswer | null {
  if (TRUST.test(prompt)) {
    // An arrow menu whose highlighted row is "No, exit" — so a `y` does
    // nothing and a bare Enter quits the agent. Down moves the marker to
    // "Yes, I trust this folder"; Enter accepts it. Both measured against a
    // live prompt rather than assumed.
    //
    // The 600ms is not politeness. At 120ms the Enter overtook the redraw
    // often enough to land back on "No, exit" and kill the agent outright.
    //
    // The lead-in before the first key matters as much as the gap after it.
    // Auto-approval fires the instant the text matches, while the menu is
    // still being drawn — the keys went into a prompt that was not listening
    // yet and the agent sat there anyway. A human clicking Approve supplies
    // that delay by existing; the watcher does not.
    return {
      approve: [{ data: ESC + '[B', delayMs: 900 }, { data: CR, delayMs: 600 }],
      reject: [{ data: ESC, delayMs: 900 }],
      describe: 'trusted the workspace',
    };
  }

  if (YES_NO.test(prompt)) {
    return {
      approve: [{ data: 'y' + CR }],
      reject: [{ data: 'n' + CR }],
      describe: 'answered the prompt',
    };
  }

  // Anything else — Claude's own permission UI, a command the Supervisor
  // flagged, a question phrased in prose. We do not know which key means yes,
  // and guessing at a keyboard is how you approve the wrong thing.
  return null;
}

/** Can Conduit answer this without a human? */
export function isAnswerable(prompt: string): boolean {
  return answerFor(prompt) !== null;
}
