// One run kept as an agentrun.recording/1 directory (apps/viewer/RECORDING.md): the run's store exported after the run
// with recordingLines, so the gallery's chat view and the graph per workflow execution can open it. An export after the
// run has no commit times, so every line's `t` is 0 and the lines keep the store's commit order.
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const PACKAGES = ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@parcha/agentrun-dsl', '@parcha/agentrun-pi', '@parcha/agentrun-jev', '@parcha/pi-agent-learn'];

function versionOf(name) {
  try { return require(`${name}/package.json`).version; } catch { return 'unknown'; }
}

function codeCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

/** Writes `<into>/<run id>/` and returns its name. */
export async function writeRecording({ into, run, job, model, providers, started, ended, costUsd, judgeCostUsd }) {
  const dir = join(into, run.runId);
  await mkdir(dir, { recursive: true });
  const { lines } = recordingLines(run.storePath);
  // The runner is the run's one process and its supervisor: it opened the run once and never killed it.
  const opened = { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 0, data: { gen: 1 } };
  await writeFile(join(dir, 'events.jsonl'), [opened, ...lines.map((line) => ({ ...line, t: 0 }))].map((line) => `${JSON.stringify(line)}\n`).join(''));
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
    cost: { usd: costUsd + judgeCostUsd, parts: { model_and_jev_in_run: costUsd, curate_jev: judgeCostUsd } },
    source: { run: run.runId, store_sha256: storeSha },
    providers,
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return run.runId;
}
