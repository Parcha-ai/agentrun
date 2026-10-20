// One run kept as an agentrun.recording/1 directory (apps/viewer/RECORDING.md): the run's store exported after the run
// with recordingLines, so the gallery's chat view and the graph per workflow execution can open it. An export after the
// run has no commit times, so every line's `t` is 0 and the lines keep the store's commit order.
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { redactorOf, scanRecording, scrubOf, secretsOf } from '../../packages/harness/src/secrets.ts';
import { SECRET_NAMES } from './tools-v2.mjs';

/** The demo spec (demo.json): the keys a live pass is given, each registered as a secret value as the reference
 *  recorder registers a demo's (#562). */
export const DEMO_SPEC = JSON.parse(readFileSync(join(import.meta.dirname, 'demo.json'), 'utf8'));

const require = createRequire(import.meta.url);
const PACKAGES = ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@parcha/agentrun-dsl', '@parcha/agentrun-pi', '@parcha/agentrun-jev', '@parcha/pi-agent-learn'];

function versionOf(name) {
  try { return require(`${name}/package.json`).version; } catch { return 'unknown'; }
}

function codeCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

/** What a recording must not hold. First, as the reference recorder takes it (packages/harness/src/secrets.ts
 *  `secretsOf`): the values of the keys `spec` declares, the sign-in's tokens, this machine's host name and boot id.
 *  Second, the names these tools read (`SECRET_NAMES`), whatever the spec says. */
export function recordingSecrets(env = process.env, spec = DEMO_SPEC) {
  const found = secretsOf(env, spec);
  const seen = new Set(found.map((secret) => secret.value));
  for (const key of SECRET_NAMES) {
    const value = typeof env[key] === 'string' ? env[key].trim() : '';
    if (value.length >= 12 && !seen.has(value)) { seen.add(value); found.push({ key, value }); }
  }
  return found;
}

/** Writes `<into>/<run id>/` and returns its name. */
/** `spend` is the row's (`spendOf`); `modelUsd` the model part, null when unknown. Every line and the manifest have the
 *  secrets of `env` (`recordingSecrets`) replaced by `[redacted]`, and the user name, the home directory and the pass's
 *  own paths scrubbed (`~`, `<run>/...`), as the reference recorder does; a recording that still holds a secret is
 *  refused: its manifest is removed and the error names the key and the file. */
export async function writeRecording({ into, run, job, model, providers, started, ended, spend, modelUsd, env = process.env }) {
  const dir = join(into, run.runId);
  await mkdir(dir, { recursive: true });
  const { lines } = recordingLines(run.storePath);
  const secrets = recordingSecrets(env);
  const redact = redactorOf(secrets);
  let user;
  try { user = userInfo().username; } catch { user = env.USER; }
  const temp = tmpdir();
  const machine = scrubOf({ user, home: homedir(), dirs: [run.dir ?? dirname(run.storePath), dirname(into), env.HOME !== homedir() ? env.HOME : undefined, temp !== '/tmp' ? temp : undefined] });
  const scrub = (text) => { const hidden = redact ? redact(text) : text; return machine ? machine(hidden) : hidden; };
  // The runner is the run's one process and its supervisor: it opened the run once and never killed it.
  const opened = { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 0, data: { gen: 1 } };
  await writeFile(join(dir, 'events.jsonl'), scrub([opened, ...lines.map((line) => ({ ...line, t: 0 }))].map((line) => `${JSON.stringify(line)}\n`).join('')));
  const storeSha = createHash('sha256').update(await readFile(run.storePath)).digest('hex');
  const manifest = {
    format: 'agentrun.recording/1',
    title: `learn-classify ${run.runId}`,
    task: `classify ${job.name}`,
    recorded: { started: new Date(started).toISOString(), ended: new Date(ended).toISOString() },
    code: { repo: 'Parcha-ai/agentrun', commit: codeCommit(), packages: Object.fromEntries(PACKAGES.map((name) => [name, versionOf(name)])) },
    model,
    generations: 1,
    kills: 0,
    cost: { usd: spend.costUsd, parts: { model: modelUsd, jev: spend.judgeCostUsd } },
    source: { run: run.runId, store_sha256: storeSha },
    providers,
  };
  await writeFile(join(dir, 'manifest.json'), scrub(`${JSON.stringify(manifest, null, 2)}\n`));
  try {
    scanRecording(dir, secrets);
  } catch (error) {
    await rm(join(dir, 'manifest.json'), { force: true });
    throw error;
  }
  return run.runId;
}
