/**
 * Voice settings persistence — provider/model/voice selections live in
 * ~/.conduit/voice.json so they survive across daemon/web restarts. API keys
 * never live here — those go in .env.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const VOICE_DIR = path.join(os.homedir(), '.conduit');
const VOICE_PATH = path.join(VOICE_DIR, 'voice.json');
/**
 * API keys live in a SEPARATE file so settings (safe to share / paste) stay
 * cleanly apart from secrets. Both files live under ~/.conduit — outside any
 * git repo — and are never echoed back to the browser in plain text.
 */
const KEYS_PATH = path.join(VOICE_DIR, 'api-keys.json');

export interface VoiceConfig {
  /**
   * How you talk to the Keeper.
   *
   *   'pipeline' — record, transcribe, ask the Keeper, speak the answer. Works
   *                with any provider, costs nothing when idle, and takes 7-9
   *                seconds an exchange because each stage waits for the last.
   *   'live'     — one open connection to Amazon Nova 2 Sonic: it hears you,
   *                answers in under a second, and stops when you talk over it.
   *                Needs AWS credentials with bedrock:InvokeModelWithBidirectionalStream.
   *
   * Defaults to 'pipeline' so an install with no AWS access behaves exactly as
   * it did before.
   */
  engine: 'pipeline' | 'live';
  stt: {
    provider: 'browser' | 'openai' | 'gemini' | 'groq';
    model: string;
    language: string;
    /** Save each captured clip to ~/.conduit/voice-debug/ — for diagnosing
     *  bad transcription / mic quality. Off by default (privacy). */
    saveRecordings: boolean;
  };
  tts: {
    enabled: boolean;
    provider: 'browser' | 'openai' | 'gemini' | 'groq';
    model: string;
    voice: string;
    /** Playback rate, 0.25–4.0. Honoured by OpenAI; Gemini ignores it. */
    speed: number;
  };
  /**
   * The live engine's own voice.
   *
   * Separate from `tts.voice` on purpose. That field holds a name from
   * whichever text-to-speech provider is selected — "Microsoft David", an
   * OpenAI voice, a browser voice — and it was being handed to Nova as its
   * `voiceId`, which knows none of those. Two different vocabularies sharing
   * one field meant picking a browser voice silently changed what the live
   * Keeper tried to sound like.
   */
  live: {
    voice: string;
  };
}

/**
 * The voices Nova Sonic accepts.
 *
 * Asked the service rather than the documentation: each of these was offered
 * to `amazon.nova-2-sonic-v1:0` in a real session and accepted at promptStart.
 * The check is meaningful because a wrong one is refused outright —
 * `giovanna` came back "Received invalid id".
 *
 * Only the first three have published descriptions. The rest are Nova's
 * multilingual set and are listed by name alone rather than guessing at
 * accents nobody here has heard.
 *
 * An unrecognised value is still passed through: this list can go stale, and
 * Nova is the authority on what it will speak with.
 */
export const NOVA_VOICES = [
  'matthew', 'tiffany', 'amy',
  'ambre', 'florian', 'beatrice', 'lorenzo',
  'greta', 'lennart', 'carlos', 'lupe',
] as const;

const DEFAULT: VoiceConfig = {
  engine: 'pipeline',
  stt: { provider: 'browser', model: '', language: 'en-US', saveRecordings: false },
  tts: { enabled: true, provider: 'browser', model: '', voice: '', speed: 1.0 },
  live: { voice: 'matthew' },
};

export function loadConfig(): VoiceConfig {
  try {
    if (fs.existsSync(VOICE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(VOICE_PATH, 'utf-8'));
      return {
        engine: raw.engine === 'live' ? 'live' : DEFAULT.engine,
        stt: { ...DEFAULT.stt, ...(raw.stt || {}) },
        tts: { ...DEFAULT.tts, ...(raw.tts || {}) },
        live: { ...DEFAULT.live, ...(raw.live || {}) },
      };
    }
  } catch { /* fall through */ }
  return DEFAULT;
}

export function saveConfig(cfg: VoiceConfig): void {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  fs.writeFileSync(VOICE_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

/** API keys — stored in api-keys.json. .env still wins as an explicit override. */
export interface ApiKeys { openai?: string; gemini?: string; groq?: string }

export function loadApiKeys(): ApiKeys {
  try {
    if (fs.existsSync(KEYS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
      return {
        openai: typeof raw.openai === 'string' ? raw.openai : undefined,
        gemini: typeof raw.gemini === 'string' ? raw.gemini : undefined,
        groq: typeof raw.groq === 'string' ? raw.groq : undefined,
      };
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * Merge-save: only fields present in `partial` change; an empty-string value
 * means "clear this key" (delete the entry).
 */
export function saveApiKeys(partial: ApiKeys): void {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const cur = loadApiKeys();
  const next: ApiKeys = { ...cur };
  for (const k of ['openai', 'gemini'] as const) {
    const v = partial[k];
    if (typeof v !== 'string') continue;
    if (v === '') delete next[k];
    else next[k] = v;
  }
  fs.writeFileSync(KEYS_PATH, JSON.stringify(next, null, 2), 'utf-8');
  // Best-effort owner-only permissions (Windows ignores this — file lives in
  // the user's profile so the OS ACL already restricts access).
  try { fs.chmodSync(KEYS_PATH, 0o600); } catch { /* ignore */ }
}

export function getApiKey(provider: 'openai' | 'gemini' | 'groq'): string | undefined {
  // .env takes precedence (explicit override for power users / CI), then file.
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY || loadApiKeys().openai || undefined;
  }
  if (provider === 'gemini') {
    return (
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      loadApiKeys().gemini ||
      undefined
    );
  }
  if (provider === 'groq') {
    // The same key the `gpt` agent type already uses, so voice works with no
    // extra setup for anyone running GPT-OSS.
    return process.env.GROQ_API_KEY || loadApiKeys().groq || undefined;
  }
  return undefined;
}

export function hasKey(provider: 'browser' | 'openai' | 'gemini' | 'groq'): boolean {
  if (provider === 'browser') return true;
  return !!getApiKey(provider);
}
