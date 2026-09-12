// Does this machine's IAM user actually have Bedrock?
//
// Three separate things have to be true before the Supervisor runs on Bedrock,
// and they fail with three different errors that are easy to confuse:
//
//   1. credentials exist and are valid          -> otherwise UnrecognizedClient
//   2. the model is enabled for the account    -> otherwise AccessDenied that
//      (Anthropic models are Marketplace           talks about aws-marketplace
//      products. There is no longer a page to      actions, not bedrock ones
//      click: the FIRST successful invoke by an
//      identity holding aws-marketplace:Subscribe
//      enables it account-wide, once, forever.)
//   3. the IAM policy allows the inference      -> otherwise AccessDenied naming
//      profile AND the models behind it            the user and the action
//
// This prints which one you are on. Nothing here is destructive; every call is
// a one-token completion or a list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

// The same two files, in the same order, as src/env.ts. This runs as plain JS
// so it cannot import that module — but a probe that cannot see the
// credentials the app uses is testing a different machine. ~/.conduit/.env is
// the only one the packaged desktop app ever reads.
for (const file of [path.resolve(process.cwd(), '.env'), path.join(os.homedir(), '.conduit', '.env')]) {
  if (fs.existsSync(file)) dotenv.config({ path: file });
}

const REGION = process.env.AWS_REGION || 'us-east-1';
const MODEL = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const ok = (s) => `\x1b[32m PASS\x1b[0m ${s}`;
const no = (s) => `\x1b[31m FAIL\x1b[0m ${s}`;
const dim = (s) => `\x1b[90m      ${s}\x1b[0m`;

console.log(`region ${REGION}`);
console.log(`model  ${MODEL}\n`);

// 1 — credentials
const haveKeys = !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;
console.log(haveKeys ? ok('credentials are present') : no('no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY'));
if (!haveKeys) {
  console.log(dim('put them in .env and ~/.conduit/.env — the packaged app only reads the latter'));
  process.exit(1);
}

// 2 — can we even see the profile? (needs bedrock:ListInferenceProfiles)
//
// @aws-sdk/client-bedrock is the control-plane package and is NOT a dependency
// of this repo — only the runtime one is. Import it dynamically so a machine
// without it still gets the invoke test below, which is the test that matters.
let profileVisible = null;
try {
  const { BedrockClient, ListInferenceProfilesCommand } =
    await import('@aws-sdk/client-bedrock');
  const c = new BedrockClient({ region: REGION });
  const r = await c.send(new ListInferenceProfilesCommand({ maxResults: 100 }));
  const ids = (r.inferenceProfileSummaries || []).map((p) => p.inferenceProfileId);
  profileVisible = ids.includes(MODEL);
  console.log(profileVisible
    ? ok('the inference profile exists in this region')
    : no(`no inference profile named ${MODEL} in ${REGION}`));
  if (!profileVisible && ids.length) {
    const anthropic = ids.filter((i) => i.includes('anthropic')).slice(0, 6);
    console.log(dim(`available: ${anthropic.join(', ') || ids.slice(0, 6).join(', ')}`));
  }
} catch (e) {
  const why = /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(String(e.message))
    ? 'optional @aws-sdk/client-bedrock not installed'
    : e.name;
  console.log(dim(`skipped the profile listing (${why}) — the invoke below is the real test`));
}

// 3 — the actual invoke, which is what the Supervisor does
const rt = new BedrockRuntimeClient({ region: REGION });
try {
  const res = await rt.send(new InvokeModelCommand({
    modelId: MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4,
      messages: [{ role: 'user', content: 'say ok' }],
    }),
  }));
  const out = JSON.parse(new TextDecoder().decode(res.body));
  const text = (out.content || []).map((c) => c.text).join('').trim();
  console.log(ok(`Bedrock answered: "${text}"`));
  console.log('\nThe Supervisor will run on Bedrock. Restart Conduit and check /api/health.');
  process.exit(0);
} catch (e) {
  const name = e.name || 'Error';
  const msg = String(e.message || e);
  console.log(no(`${name}`));
  console.log(dim(msg.slice(0, 240)));
  console.log('');
  if (/AccessDenied/i.test(name) && /marketplace/i.test(msg)) {
    // Not a Bedrock permission problem at all, despite the shared error name.
    //
    // Anthropic models are AWS Marketplace products. The first invoke of one
    // makes Bedrock try to subscribe the *account* on the caller's behalf, and
    // that subscribe is what is being refused here — bedrock:InvokeModel is
    // already granted, or this call would have failed earlier and differently.
    //
    // Subscribing is an account-level, once-ever act. Doing it in the console
    // as an admin is the right fix; granting an app's own key the right to buy
    // Marketplace products is not.
    console.log('Bedrock permissions are fine. The model is not enabled for this account yet.');
    console.log('');
    console.log('  Enabling is done BY INVOKING, not by a button — the Bedrock "Model access"');
    console.log('  page was retired. An identity that holds aws-marketplace:Subscribe has to');
    console.log('  make one successful call, which enables the model account-wide for everyone.');
    console.log('  After that this key invokes it with no Marketplace permission at all.');
    console.log('');
    console.log('  one-time, either:');
    console.log('    a) console, as an admin: Model catalog > Claude Sonnet 4.5 > open in');
    console.log('       playground > send one message. Pick the CROSS-REGION / inference-profile');
    console.log('       entry — the bare model id fails validation before it ever enables.');
    console.log('    b) add aws-marketplace:Subscribe + ViewSubscriptions to this key, re-run');
    console.log('       this script once, then REMOVE them again. The enablement persists.');
    console.log('');
    console.log('  Anthropic also wants a one-time use-case form per account:');
    console.log('    Model catalog > any Anthropic model > submit use case details.');
  } else if (/AccessDenied/i.test(name)) {
    const arn = msg.match(/User: (\S+)/)?.[1];
    const res = msg.match(/on resource: (\S+)/)?.[1];
    console.log('The IAM policy is still missing a line.');
    if (arn) console.log(`  identity : ${arn}`);
    if (res) console.log(`  resource : ${res}`);
    console.log('  fix      : attach docs/bedrock-iam-policy.json to that user');
    console.log('             (IAM > Users > Add permissions > Create inline policy > JSON)');
  } else if (/ValidationException/i.test(name) && /on-demand/i.test(msg)) {
    console.log('This model has no on-demand access — use the us.* inference profile id, not the bare id.');
  } else if (/end of its life/i.test(msg)) {
    console.log('BEDROCK_MODEL_ID points at a retired model. Use an inference profile:');
    console.log('  BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  } else if (/Throttling/i.test(name)) {
    console.log('Credentials and permissions are fine — you are rate/quota capped right now.');
    console.log('Bedrock > this model > request a quota increase, or wait for the daily cap to reset.');
  } else if (/UnrecognizedClient|InvalidSignature/i.test(name)) {
    console.log('The keys are wrong, rotated, or from a different account.');
  } else if (/ResourceNotFound/i.test(name)) {
    console.log("Model access is not enabled in this region.");
    console.log('  Bedrock > Model access > Modify > tick Anthropic Claude > Save');
  }
  process.exit(1);
}
