/**
 * Anthropic Messages API path for the Supervisor.
 *
 * The Supervisor runs as a Strands Agent on either Bedrock or Anthropic — see
 * `buildModel` in agent.ts. This module is two things:
 *
 *   1. `anthropicClientOptions()` — the credential the Strands AnthropicModel
 *      authenticates with, so the SDK covers the Anthropic path too.
 *   2. `classifyWithAnthropic()` — a hand-rolled Messages API call kept as the
 *      last resort beneath both. It carries the model ladder below, which the
 *      SDK route has no equivalent for, and it still answers if the optional
 *      `@anthropic-ai/sdk` peer is missing at runtime.
 *
 * Credentials, in priority order:
 *   1. `ANTHROPIC_API_KEY` — the supported path (`x-api-key`).
 *   2. The Claude Code OAuth token in ~/.claude/.credentials.json. Convenient
 *      because it is already on the machine, but it is Claude Code's own
 *      credential: it expires (Claude Code refreshes it), and a subscription
 *      may not grant every model. Prefer an API key for anything long-lived.
 *
 * Model selection: `ANTHROPIC_MODEL_ID` pins one model. Otherwise we walk a
 * ladder from most to least capable and keep the first that answers — a
 * subscription token is commonly allowed on Haiku while the larger models
 * return 429. The choice is re-probed periodically so a temporary rate limit
 * doesn't pin the Supervisor to the smallest model forever.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type { SupervisorUpdate, SupervisorClassification } from './agent.js';

const CLAUDE_CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const API_URL = 'https://api.anthropic.com/v1/messages';
const REQUEST_TIMEOUT_MS = 60_000;
/** Re-probe the preferred model this often, so a passing rate limit isn't permanent. */
const MODEL_RECHECK_MS = 30 * 60 * 1000;

/** Most capable first. Overridden entirely by ANTHROPIC_MODEL_ID. */
const MODEL_LADDER = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

const CLASSIFICATIONS: SupervisorClassification[] = [
  'progress', 'blocker', 'question', 'risky_action', 'noise',
];

export type SupervisorErrorKind = 'auth' | 'rate-limit' | 'model' | 'network' | 'other';

export class AnthropicSupervisorError extends Error {
  readonly kind: SupervisorErrorKind;
  readonly status?: number;

  constructor(message: string, kind: SupervisorErrorKind, status?: number) {
    super(message);
    this.name = 'AnthropicSupervisorError';
    this.kind = kind;
    this.status = status;
  }
}

interface Credential {
  kind: 'api-key' | 'oauth';
  headers: Record<string, string>;
  /** OAuth only — epoch ms. */
  expiresAt?: number;
}

/** Read the Claude Code OAuth credential, including its expiry. */
function readClaudeOauth(): { accessToken: string; expiresAt?: number } | null {
  try {
    if (!fs.existsSync(CLAUDE_CREDS)) return null;
    const data = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf-8'));
    const o = data?.claudeAiOauth;
    if (!o?.accessToken) return null;
    const expiresAt = Number(o.expiresAt);
    return { accessToken: o.accessToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined };
  } catch {
    return null;
  }
}

/**
 * Resolve the credential to call the Messages API with. Re-read on every call:
 * Claude Code rotates its token on disk and we must not cache a stale one.
 */
function resolveCredential(): Credential {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (apiKey) {
    return {
      kind: 'api-key',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    };
  }

  const oauth = readClaudeOauth();
  if (!oauth) {
    throw new AnthropicSupervisorError(
      'No Anthropic credential. Set ANTHROPIC_API_KEY in .env, or sign in to Claude Code so ~/.claude/.credentials.json exists.',
      'auth',
    );
  }
  if (oauth.expiresAt && oauth.expiresAt <= Date.now()) {
    throw new AnthropicSupervisorError(
      `The Claude Code OAuth token expired at ${new Date(oauth.expiresAt).toISOString()}. Run any Claude Code command to refresh it, or set ANTHROPIC_API_KEY.`,
      'auth',
    );
  }
  return {
    kind: 'oauth',
    expiresAt: oauth.expiresAt,
    headers: {
      'Authorization': 'Bearer ' + oauth.accessToken,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
    },
  };
}

/**
 * The same credential as `resolveCredential`, shaped for the Anthropic SDK so
 * the Strands `AnthropicModel` can use it.
 *
 * One resolver, two transports. The OAuth file is read in exactly one place
 * (`readClaudeOauth`) and turned into headers here or above — do not add a
 * third reader, because the token rotates on disk and a stale copy fails in a
 * way that looks like an auth misconfiguration rather than a cache.
 */
export function anthropicClientOptions(): { apiKey?: string; client?: Anthropic } {
  const cred = resolveCredential();
  if (cred.kind === 'api-key') return { apiKey: cred.headers['x-api-key'] };

  // A Claude Code OAuth token is not an API key, and AnthropicModel throws
  // unless it gets one -- `clientConfig` alone does not satisfy that check.
  // Handing it a fully built client is the documented way past it, so the
  // bearer token authenticates the same way it does on the raw path.
  return {
    client: new Anthropic({
      apiKey: null,
      authToken: cred.headers.Authorization.replace(/^Bearer /, ''),
      defaultHeaders: { 'anthropic-beta': cred.headers['anthropic-beta'] },
    }),
  };
}

export function hasAnthropicCredential(): boolean {
  if ((process.env.ANTHROPIC_API_KEY || '').trim()) return true;
  return readClaudeOauth() !== null;
}

/**
 * Models that still accept `temperature`.
 *
 * The Claude 5 family and 4.6+ answer 400 "`temperature` is deprecated for this
 * model" rather than ignoring it, so sending it is fatal, not merely useless.
 * Sampling is left at the provider default there; the Supervisor's determinism
 * comes from its system prompt and a single required tool call, not from
 * temperature.
 */
export function supportsTemperature(model: string): boolean {
  return !/(opus|sonnet|haiku|fable)-5|opus-4-[6-9]|sonnet-4-[6-9]|fable-4-[6-9]/i.test(model);
}

/** Models that reject `output_config.effort` (Haiku 4.5 and the claude-3 family). */
function supportsEffort(model: string): boolean {
  return !/haiku|claude-3/i.test(model);
}

function candidateModels(): string[] {
  const pinned = (process.env.ANTHROPIC_MODEL_ID || '').trim();
  return pinned ? [pinned] : MODEL_LADDER;
}

const REPORT_TOOL = {
  name: 'report_update',
  description: 'Report the classification and summary of the agent\'s recent output.',
  input_schema: {
    type: 'object',
    properties: {
      classification: {
        type: 'string',
        enum: CLASSIFICATIONS,
        description: 'The category of the update.',
      },
      summary: {
        type: 'string',
        description: 'One short spoken-style sentence summarizing it.',
      },
    },
    required: ['classification', 'summary'],
    additionalProperties: false,
  },
  strict: true,
};

const SYSTEM_PROMPT = [
  'You are a technical supervisor overseeing autonomous coding agents on behalf of a human engineer.',
  'You receive a batch of output from one agent. Decide whether the human needs to hear about it and',
  'call the report_update tool exactly once with a classification and ONE short spoken-style sentence',
  '(it is read aloud). Use "noise" for routine chatter and progress you already reported. Use',
  '"risky_action" only when the agent is about to do something destructive or irreversible. Use',
  '"question" when the agent is waiting on the human.',
].join(' ');

/** The model that answered last, plus when we should re-probe the ladder. */
let resolvedModel: string | null = null;
let resolvedAt = 0;

/** Reset the cached model choice (tests, or after a config change). */
export function resetModelSelection(): void {
  resolvedModel = null;
  resolvedAt = 0;
}

/** The model currently in use, for logging / health output. */
/**
 * The ladder, for callers that walk it themselves.
 *
 * The Strands AnthropicModel path needs the same sequence the raw path uses:
 * a Claude Code subscription token is routinely refused on the larger models
 * and allowed on Haiku, so a 429 on the first rung is a reason to step down,
 * not a reason to give up on the SDK.
 */
export function anthropicCandidates(): string[] {
  return candidateModels();
}

/** Remember which rung answered, so the next call starts there. */
export function noteWorkingModel(model: string): void {
  resolvedModel = model;
  resolvedAt = Date.now();
}

export function currentModel(): string {
  return resolvedModel || candidateModels()[0];
}

function classifyStatus(status: number, body: string): SupervisorErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 404) return 'model';
  if (status === 400 && /model/i.test(body)) return 'model';
  if (status >= 500) return 'network';
  return 'other';
}

interface CallResult {
  update: SupervisorUpdate;
  model: string;
}

/** One Messages API call against a specific model. Throws AnthropicSupervisorError. */
async function callModel(
  cred: Credential,
  model: string,
  prompt: string,
  withEffort: boolean,
): Promise<CallResult> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    tools: [REPORT_TOOL],
    tool_choice: { type: 'tool', name: 'report_update' },
  };
  // A classification is a simple task — keep thinking shallow where supported.
  if (withEffort && supportsEffort(model)) body.output_config = { effort: 'low' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: cred.headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new AnthropicSupervisorError(
      aborted ? `Anthropic request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : `Anthropic request failed: ${msg}`,
      'network',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Some models reject `effort`; retry once without it before giving up.
    if (res.status === 400 && /effort/i.test(text) && withEffort) {
      return callModel(cred, model, prompt, false);
    }
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text)?.error?.message || detail; } catch { /* keep raw */ }
    throw new AnthropicSupervisorError(
      `Anthropic ${res.status} on ${model}: ${detail}`,
      classifyStatus(res.status, text),
      res.status,
    );
  }

  const data = (await res.json()) as {
    content?: Array<{ type?: string; name?: string; input?: unknown }>;
  };
  const call = data.content?.find((c) => c.type === 'tool_use' && c.name === 'report_update');
  const input = call?.input as { classification?: unknown; summary?: unknown } | undefined;
  if (!input) {
    throw new AnthropicSupervisorError(`Anthropic returned no report_update call on ${model}`, 'other');
  }
  const classification = String(input.classification || '') as SupervisorClassification;
  const summary = String(input.summary || '').trim();
  if (!CLASSIFICATIONS.includes(classification) || !summary) {
    throw new AnthropicSupervisorError(
      `Anthropic returned an invalid classification on ${model}: ${JSON.stringify(input).slice(0, 200)}`,
      'other',
    );
  }
  return { update: { classification, summary }, model };
}

/**
 * Classify one batch of agent output. Walks the model ladder on rate-limit /
 * missing-model errors and remembers what worked.
 */
export async function classifyWithAnthropic(prompt: string): Promise<SupervisorUpdate> {
  const cred = resolveCredential();

  // Prefer the model that worked last, until it is time to re-probe.
  const ladder = candidateModels();
  const fresh = resolvedModel && Date.now() - resolvedAt < MODEL_RECHECK_MS;
  const order = fresh && resolvedModel
    ? [resolvedModel, ...ladder.filter((m) => m !== resolvedModel)]
    : ladder;

  let lastError: AnthropicSupervisorError | null = null;
  for (const model of order) {
    try {
      const { update } = await callModel(cred, model, prompt, true);
      if (resolvedModel !== model) {
        console.log(`[supervisor] using Anthropic model ${model} (${cred.kind === 'oauth' ? 'Claude Code OAuth token' : 'ANTHROPIC_API_KEY'})`);
      }
      resolvedModel = model;
      resolvedAt = Date.now();
      return update;
    } catch (err) {
      const e = err instanceof AnthropicSupervisorError
        ? err
        : new AnthropicSupervisorError(String(err), 'other');
      lastError = e;
      // Only a rate limit or an unavailable model justifies trying a smaller one.
      if (e.kind !== 'rate-limit' && e.kind !== 'model') throw e;
      if (resolvedModel === model) { resolvedModel = null; resolvedAt = 0; }
    }
  }

  throw lastError || new AnthropicSupervisorError('No Anthropic model available', 'model');
}
