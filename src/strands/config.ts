// Ensure .env is loaded — from the cwd and from ~/.conduit/.env, so the
// packaged desktop app (whose cwd is its install directory) sees it too.
import '../env.js';

export const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

/**
 * Bedrock model the Supervisor runs on. Keep this in sync with the IAM policy
 * in the README — the role must allow InvokeModel on exactly this id.
 */
/**
 * Bedrock model the Supervisor runs on.
 *
 * An inference profile (`us.` prefix), not a bare model id. Bedrock has
 * retired every bare `anthropic.*` id — the old default here answered
 * "This model version has reached the end of its life" on every single call,
 * which is a default that can never work again.
 *
 * An inference profile needs its own line in the IAM policy. Yours must allow
 * `bedrock:InvokeModel` on
 *
 *   arn:aws:bedrock:<region>:<account>:inference-profile/us.anthropic.*
 *
 * and on the underlying foundation models. Without it Bedrock answers
 * AccessDenied and Conduit falls back to the Anthropic API — see
 * src/strands/failure.ts, and `supervisorHealth` on /api/health for which
 * one is actually serving you.
 */
export const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/** True when the Supervisor is switched off (no AWS access, or by choice). */
export function supervisorDisabled(): boolean {
  const v = (process.env.CONDUIT_SUPERVISOR || '').trim().toLowerCase();
  return v === '0' || v === 'off' || v === 'false';
}

/**
 * Which backend classifies agent output.
 *   'bedrock'   — Strands + Amazon Bedrock only
 *   'anthropic' — the Anthropic Messages API only (ANTHROPIC_API_KEY, or the
 *                 Claude Code OAuth token on this machine)
 *   'auto'      — Bedrock first, Anthropic when Bedrock has no usable
 *                 credentials (the default)
 */
export function supervisorProvider(): 'auto' | 'anthropic' | 'bedrock' {
  const v = (process.env.SUPERVISOR_PROVIDER || '').trim().toLowerCase();
  if (v === 'anthropic' || v === 'claude') return 'anthropic';
  if (v === 'bedrock' || v === 'aws') return 'bedrock';
  return 'auto';
}

// Credentials: the Strands BedrockModel builds its own BedrockRuntimeClient,
// which uses the standard AWS SDK provider chain — AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY from the environment or .env, ~/.aws/credentials, or
// an EC2 / ECS instance role when running on AWS.
