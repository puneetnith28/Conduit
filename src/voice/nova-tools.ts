/**
 * What the voice Keeper can do.
 *
 * Eight tools, not the twelve the text Keeper has. Two reasons, and both are
 * deliberate:
 *
 *   - Latency. These all answer immediately. `ask_agent` can legitimately take
 *     three minutes, and a live audio session cannot sit silent that long, so
 *     it and `consult_keeper` return "dispatched" and announce the real answer
 *     when it lands (see `deferred`).
 *   - Risk. There are open AWS reports of Nova looping with many tools
 *     declared. `npm run check:nova` shows eight is fine here; twelve is
 *     untested and buys little, because `create_project`, `create_agent`,
 *     `read_wiki`, `read_shared` and `get_project_overview` all involve paths
 *     and prose far easier typed than spoken. They stay in the Ctrl+J Keeper.
 *
 * `describe_gate` and `resolve_gate` are the two that can do damage, and they
 * are the two that are not trusted to the model's judgement: `approve` is
 * refused by `src/voice/approval-guard.ts` unless the command was read out
 * loud, recently, the gate is unchanged, and the user's own recorded speech
 * says to approve it. The model cannot talk its way past any of that.
 *
 * Descriptions are lifted from `src/conduit-mcp-server.ts`. They are doing
 * prompt-engineering work rather than documenting — `ask_agent`'s status
 * branches tell the model not to resend, for instance — so they transfer
 * verbatim rather than being paraphrased.
 *
 * Execution goes through the daemon's `/org/*` HTTP API, the same surface the
 * MCP server drives. The daemon does not change to support voice.
 */
import { DAEMON_HTTP_URL } from '../daemon/protocol.js';
import type { NovaTool } from './nova.js';

/** Fast tools time out quickly; a slow one here would stall the conversation. */
const FAST_TIMEOUT_MS = 8000;

async function daemon(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? FAST_TIMEOUT_MS);
  try {
    const res = await fetch(DAEMON_HTTP_URL + path, {
      ...init,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
  } finally {
    clearTimeout(timer);
  }
}

const str = (v: unknown) => String(v ?? '').trim();

export const VOICE_TOOLS: NovaTool[] = [
  {
    name: 'list_projects',
    description:
      'List every project and the agents in it, with each agent\'s live status. '
      + 'Use this first when the user asks anything about what exists.',
    schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_agents',
    description: 'List the agents in one project with their live status.',
    schema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Project name or id.' } },
      required: ['project'],
    },
  },
  {
    name: 'get_agent_status',
    description: 'The live status of one agent: running, stopped, idle or awaiting input.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
      },
      required: ['project', 'agent'],
    },
  },
  {
    name: 'start_agent',
    description:
      'Start a stopped agent. Returns as soon as the process is up — the agent '
      + 'takes a few more seconds to finish booting, which is handled for you. '
      + 'Never ask permission to start an agent the user has asked you to use.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
      },
      required: ['project', 'agent'],
    },
  },
  {
    name: 'stop_agent',
    description: 'Stop a running agent.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
      },
      required: ['project', 'agent'],
    },
  },
  {
    name: 'ask_agent',
    description:
      'Send a message to one running agent and get its answer. The agent may '
      + 'take minutes to reply, so this returns immediately and the answer is '
      + 'read out when it arrives. Say one short line like "Asking Claude now" '
      + 'and move on — do NOT wait, and do NOT send the same message twice.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
        message: { type: 'string', description: 'What to say to the agent.' },
      },
      required: ['project', 'agent', 'message'],
    },
  },
  {
    name: 'describe_gate',
    description:
      'Read out what an agent is waiting for permission to do. Always call this '
      + 'before resolve_gate — approving is refused otherwise. Say the command '
      + 'back to the user plainly and then ask whether to approve it.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
      },
      required: ['project', 'agent'],
    },
  },
  {
    name: 'resolve_gate',
    description:
      'Approve or reject what an agent is waiting to do. Rejecting always works. '
      + 'Approving works only after describe_gate has read the command out and '
      + 'the user has said the word "approve" — if it is refused, say the reason '
      + 'out loud and do not try again with different wording.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
        decision: {
          type: 'string',
          description: 'Either "approve" or "reject".',
        },
      },
      required: ['project', 'agent', 'decision'],
    },
  },
];

/**
 * Tools whose real answer arrives long after the call returns.
 *
 * The model is told so in the description, gets `dispatched` at once, and the
 * caller announces the answer when it lands. Without this the model sits mute
 * on an open microphone for up to three minutes.
 */
export const DEFERRED_TOOLS = new Set(['ask_agent']);

/**
 * Everything the gate tools need, supplied by the server.
 *
 * Gates live in the web server's own storage, not behind the daemon's `/org/*`
 * API, and resolving one has to go through the same code path the UI button
 * uses. So the server hands this down rather than the tools reaching for it.
 */
export interface GateBridge {
  /** The gate this agent is waiting on right now, or null. */
  find: (project: string, agent: string) => GateLookup;
  /** Approve it — may be refused by the guard, with a reason to say out loud. */
  approve: (found: GateFound) => { ok: boolean; message: string };
  /** Reject it. Always allowed. */
  reject: (found: GateFound) => { ok: boolean; message: string };
  /** Called after the command has been handed over to be read aloud. */
  noteDescribed: (found: GateFound) => void;
}

export interface GateFound {
  projectId: string;
  agentId: string;
  agentName: string;
  prompt: string;
  source: 'regex' | 'supervisor';
}

export type GateLookup =
  | { found: true; gate: GateFound }
  | { found: false; reason: string };

export interface ToolContext {
  /** Called when a deferred tool finally produces something worth saying. */
  onDeferredResult: (summary: string) => void;
  /** Absent only in tests that do not exercise the gate tools. */
  gates?: GateBridge;
}

/** Resolve a project by name or id, the way `findAgent` does server-side. */
function pickProject(projects: any[], ref: string): any | null {
  const want = ref.toLowerCase();
  return projects.find((p) => p.id === ref)
    || projects.find((p) => String(p.name).toLowerCase() === want)
    || projects.find((p) => String(p.name).toLowerCase().includes(want))
    || null;
}

function pickAgent(agents: any[], ref: string): any | null {
  const want = ref.toLowerCase();
  return agents.find((a) => a.id === ref)
    || agents.find((a) => String(a.name).toLowerCase() === want)
    || agents.find((a) => String(a.role || '').toLowerCase() === want)
    || agents.find((a) => String(a.name).toLowerCase().includes(want))
    || null;
}

export async function runVoiceTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const snapshot = async () => (await daemon('/org/snapshot')).projects || [];

  if (name === 'list_projects') {
    const projects = await snapshot();
    if (!projects.length) return 'There are no projects yet.';
    return projects.map((p: any) => {
      const agents = (p.agents || []).map((a: any) => `- ${a.name} (${a.cli}, ${a.status})`);
      return `## ${p.name}\n${agents.join('\n') || '- (no agents)'}`;
    }).join('\n');
  }

  if (name === 'list_agents' || name === 'get_agent_status') {
    const projects = await snapshot();
    const project = pickProject(projects, str(input.project));
    if (!project) return `No project matching "${str(input.project)}".`;
    const agents = project.agents || [];
    if (name === 'list_agents') {
      return agents.map((a: any) => `- ${a.name} (${a.cli}, ${a.status})`).join('\n')
        || `${project.name} has no agents.`;
    }
    const agent = pickAgent(agents, str(input.agent));
    return agent
      ? `${agent.name} is ${agent.status}.`
      : `No agent matching "${str(input.agent)}" in ${project.name}.`;
  }

  if (name === 'start_agent') {
    const r = await daemon('/org/start-agent', {
      method: 'POST',
      body: JSON.stringify({ project: str(input.project), agent: str(input.agent) }),
      timeoutMs: 20_000,
    });
    if (r.status === 'already-running') return `${r.agentName} was already running.`;
    if (r.status === 'started') return `${r.agentName} is starting.`;
    if (r.status === 'not-found') return r.error || 'No agent by that name.';
    return r.error || 'Could not start it.';
  }

  if (name === 'stop_agent') {
    const r = await daemon('/org/stop-agent', {
      method: 'POST',
      body: JSON.stringify({ project: str(input.project), agent: str(input.agent) }),
      timeoutMs: 15_000,
    });
    if (r.status === 'already-stopped') return `${r.agentName} was already stopped.`;
    if (r.status === 'stopped') return `${r.agentName} is stopped.`;
    return r.error || 'Could not stop it.';
  }

  if (name === 'ask_agent') {
    const project = str(input.project);
    const agent = str(input.agent);
    const message = str(input.message);
    if (!message) return 'Nothing to send — no message was given.';

    // Fire and report later. The model has been told this returns at once.
    void (async () => {
      try {
        const r = await daemon('/org/ask-agent', {
          method: 'POST',
          body: JSON.stringify({ project, agent, message }),
          timeoutMs: 300_000,
        });
        const who = r.agentName || agent;
        if (r.status === 'replied' && r.reply) {
          ctx.onDeferredResult(`${who} replied: ${r.reply}`);
        } else if (r.status === 'busy') {
          ctx.onDeferredResult(`${who} is still working on it.`);
        } else if (r.status === 'delivered') {
          ctx.onDeferredResult(`${who} got the message.`);
        } else if (r.status === 'not-running') {
          ctx.onDeferredResult(`${who} is not running, so it never heard that.`);
        } else if (r.status === 'crashed') {
          ctx.onDeferredResult(`${who} died before answering.`);
        } else if (r.error) {
          ctx.onDeferredResult(`Asking ${who} failed: ${r.error}`);
        }
      } catch (err) {
        ctx.onDeferredResult(
          `Asking ${agent} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    return JSON.stringify({
      status: 'dispatched',
      note: 'Sent. The answer will be read out when it arrives — say one short line and carry on.',
    });
  }

  if (name === 'describe_gate' || name === 'resolve_gate') {
    if (!ctx.gates) return 'I cannot reach the approval gates from here.';
    const lookup = ctx.gates.find(str(input.project), str(input.agent));
    if (!lookup.found) return lookup.reason;
    const gate = lookup.gate;

    if (name === 'describe_gate') {
      // Mark it described only now, as the text is handed over to be spoken.
      ctx.gates.noteDescribed(gate);
      return [
        `${gate.agentName} is waiting for permission.`,
        `It wants to: ${gate.prompt.trim()}`,
        'Read that back to the user and ask whether to approve it.',
      ].join('\n');
    }

    const decision = str(input.decision).toLowerCase();
    if (decision === 'reject' || decision === 'no' || decision === 'deny') {
      const r = ctx.gates.reject(gate);
      return r.message;
    }
    if (decision === 'approve' || decision === 'yes' || decision === 'allow') {
      const r = ctx.gates.approve(gate);
      return r.message;
    }
    return 'Say either approve or reject.';
  }

  return `There is no tool called ${name}.`;
}

/**
 * What the voice Keeper is told about itself.
 *
 * Deliberately shorter and blunter than the text Keeper's persona in
 * `orchestrator.ts`. There is no 🔊 convention here: that exists only because
 * a text model needed a separate line picked out for a separate text-to-speech
 * stage, and a speech-to-speech model has one channel. Asking for it would just
 * make it say "speaker emoji" out loud.
 */
export const VOICE_SYSTEM_PROMPT = [
  'You are The Keeper, the orchestrator of Conduit — a control centre where several',
  'coding agents work in parallel on the user\'s projects.',
  '',
  'You are in a spoken conversation — not reading out a status report. Talk the way',
  'a colleague sitting next to them would: contractions, plain words, a normal',
  'rhythm. Short still: most answers are one or two sentences.',
  '',
  'Answer the question with the answer. Asked what projects they have, name them —',
  '"Two: Trellis and the docs one, and everything in both is stopped." Saying "here',
  'are your projects and their statuses" announces an answer instead of giving one,',
  'and in speech that is just a wasted breath. Naming three or four things out loud',
  'is normal conversation; only reel off a genuinely long list if they ask for it.',
  '',
  'What to leave out: file paths, code, ids, and anything already on their screen.',
  'Those are worth reading aloud only when asked for them specifically.',
  '',
  'Sounding human is mostly about what you leave out. Skip the throat-clearing —',
  'no "Sure, let me", no "I\'ll take a look", no repeating the question back. Start',
  'with the thing they wanted to know. But do not strip it to a telegram either:',
  '"Both of them are stopped" is a person talking; "2 agents, stopped" is a dashboard.',
  '',
  'Carry the conversation. If they just said something, react to it before moving on.',
  'If a choice is genuinely theirs to make, ask for it in a short question rather than',
  'listing the options. If something surprised you — an agent that died, a file that',
  'was not there — say so plainly, the way you would out loud.',
  '',
  'Never invent warmth you do not have. No "great question", no enthusiasm you would',
  'not actually feel, no apologising twice. Being easy to talk to is not the same as',
  'being chirpy.',
  '',
  'Use the tools rather than guessing. You can see every project and agent, and start',
  'and stop them. A stopped agent is never a dead end: if the user wants an agent to do',
  'something, start it and then ask it, in that order, without asking permission first.',
  '',
  'When you ask an agent something, that returns immediately and the answer comes back',
  'later. Say one short line — "Asking Claude now" — and carry on. Never send the same',
  'message twice, and never claim you reached an agent you did not.',
  '',
  'When an agent is waiting for permission, read the command out with',
  'describe_gate before anything else, and say what it will actually do. You may',
  'reject on the user\'s word alone. You may not approve on your own judgement:',
  'the server checks that the command was read out and that the user said the',
  'word "approve" themselves. If it refuses, say why and leave it — do not',
  'rephrase and retry.',
  '',
  'If you are interrupted, stop and listen. Do not finish the sentence you were on.',
].join('\n');
