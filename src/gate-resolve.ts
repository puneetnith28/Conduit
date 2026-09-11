/**
 * Resolving an approval gate — the one implementation.
 *
 * This used to live inside the REST route. It moved out when voice gained a
 * guarded approve path (`src/voice/approval-guard.ts`), because two copies of
 * "what actually reaches the agent" would drift, and the half that drifted
 * would be the one that answers a destructive prompt.
 *
 * What reaches the agent depends on what it is waiting for:
 *
 *   - a literal y/n prompt (shell, git, installers): answer it with y or n
 *   - anything else — Claude's own permission UI, or a risky command the
 *     Supervisor spotted — approve means leave it alone, and reject means
 *     interrupt the agent and tell it why
 *   - custom means type the user's own text
 */
import { randomUUID } from 'crypto';
import * as storage from './storage.js';
import { answerFor, typeKeys } from './gate-answer.js';
import type { DaemonClient } from './daemon/client.js';

export type GateDecision = 'approve' | 'reject' | 'custom';

export interface ResolveGateOptions {
  customInput?: string;
  /** How the decision was made, for the audit log. Absent means the UI. */
  via?: string;
  /** The words that authorised it, when a voice approval did. Logged verbatim. */
  authorisingPhrase?: string;
}

export type ResolveGateResult =
  | { ok: true; action: string; agentName: string }
  | { ok: false; status: number; error: string };

export function resolveGate(
  daemon: DaemonClient,
  broadcast: (msg: any) => void,
  projectId: string,
  agentId: string,
  decision: GateDecision,
  opts: ResolveGateOptions = {},
): ResolveGateResult {
  const agent = storage.getAgent(projectId, agentId);
  if (!agent) return { ok: false, status: 404, error: 'Agent not found' };
  const gate = agent.pendingGate;
  if (!gate) return { ok: false, status: 409, error: 'No pending gate for this agent' };
  if (!['approve', 'reject', 'custom'].includes(decision)) {
    return { ok: false, status: 400, error: 'decision must be approve, reject, or custom' };
  }

  const customInput = opts.customInput || '';
  storage.updateAgent(projectId, agentId, { pendingGate: undefined });

  // One source of truth for "which keys answer this", shared with the
  // auto-approval path in the watcher. See src/gate-answer.ts.
  const answer = gate.source === 'regex' ? answerFor(gate.prompt) : null;
  let action = 'none';

  const type = (keys: { data: string; delayMs?: number }[]) =>
    typeKeys((d) => daemon.writeTerminal(agent.id, d), keys);

  try {
    if (decision === 'approve') {
      if (answer) { type(answer.approve); action = answer.describe; }
      // No answer means we do not know which key means yes. Saying nothing is
      // correct — guessing at a keyboard is how you approve the wrong thing —
      // but the caller is told, so the UI can say the agent still needs a
      // keypress in its terminal rather than closing as though it were done.
    } else if (decision === 'reject') {
      if (answer) { type(answer.reject); action = 'declined the prompt'; }
      else {
        // Nothing to type, so stop the agent and tell it why.
        daemon.command({ op: 'terminal:interrupt', agentId: agent.id });
        setTimeout(() => {
          daemon.request('agent:inject', {
            agentId: agent.id, fromName: 'User',
            message: 'STOP. The user rejected the action you were about to take. Do not proceed with it; explain what you were doing and wait for instructions.',
          }).catch(() => { /* daemon down */ });
        }, 400);
        action = 'interrupted';
      }
    } else if (decision === 'custom' && customInput) {
      daemon.writeTerminal(agent.id, customInput.replace(/\r?\n$/, '') + '\r');
      action = 'sent custom input';
    }
  } catch { /* daemon down */ }

  storage.appendAuditLog(projectId, {
    event: `gate_${decision}`,
    agentId: agent.id,
    agentName: agent.name,
    gate,
    action,
    customInput: decision === 'custom' ? customInput : undefined,
    via: opts.via,
    // A voice approval records the words that authorised it. If a
    // transcription error ever runs something destructive, this is the line
    // that explains what the machine thought it heard.
    authorisingPhrase: opts.authorisingPhrase,
  });

  const suffix = opts.via ? ` (by ${opts.via})` : '';
  const entry: storage.GroupChatEntry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    role: 'user',
    sender: 'User',
    text: decision === 'approve'
      ? `Approved ${agent.name}'s pending action.${suffix}`
      : decision === 'reject'
        ? `Rejected ${agent.name}'s pending action.${suffix}`
        : `Replied to ${agent.name}: ${customInput}`,
  };
  storage.appendGroupChat(projectId, entry);
  broadcast({ type: 'groupchat:message', payload: { ...entry, projectId } });
  broadcast({ type: 'gate:resolved', agentId });

  return { ok: true, action, agentName: agent.name };
}
