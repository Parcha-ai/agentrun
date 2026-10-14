// node examples/dependency-audit/run.ts [--fixture <name>] [--limit N] [--storm <ms>] [--kills N] [--record <dir>] [--dir <run dir>] [--seed N] [--json]
// The dependency audit on the reference assembly, with no key: the facts of a captured project, a scripted lead and a scripted
// judge. `--storm 2000` ends the process with SIGKILL about every two seconds (at most `--kills`, default 30) and a fresh
// process takes the run back from its journal each time. `--record <dir>` keeps the run as an agentrun.recording/1 directory.
//
// Two processes of this file: the supervisor starts, kills and restarts the run and writes the host lines of the recording;
// `--child` is the run itself.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { codeOf, finishRecording, localHost, openRecorder, packageCommitRecorder, placeAt, run, type Job } from '../reference/index.ts';
import { startedAt } from '../reference/record.ts';
import { appendFileSync, mkdirSync as mkdir } from 'node:fs';
import type { Fixture } from './capture.ts';
import { scriptedBrowser, scriptedFakes } from './scripted.ts';
import { workflow } from './workflow.ts';

const SELF = fileURLToPath(import.meta.url);
const FIXTURES = join(import.meta.dirname, 'fixtures');

export function loadFixture(name?: string): Fixture {
  const files = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((file) => file.endsWith('.json')) : [];
  const pick = name ? files.find((file) => file === name || file.replace(/\.json$/, '') === name || file.includes(name)) : files[0];
  if (!pick) throw new Error(`no fixture ${name ?? ''} in ${FIXTURES}: ${files.join(', ') || 'none'}`);
  return JSON.parse(readFileSync(join(FIXTURES, pick), 'utf8')) as Fixture;
}

export const jobOf = (fixture: Fixture, limit?: number): Job => ({ workflow, input: { project: fixture.project, dependencies: fixture.dependencies.slice(0, limit ?? fixture.dependencies.length) } });

/** mulberry32, so the storm's gaps are the same for the same seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- the run ----------------------------------------------------------------------------------------------------------

async function child() {
  const dir = process.env.DIR!;
  const fixture = loadFixture(process.env.FIXTURE);
  const place = await placeAt(dir);
  const recording = process.env.RECORD;
  const recorder = recording ? openRecorder({ dir: recording, commits: await packageCommitRecorder() }) : undefined;
  const fakes = scriptedFakes(fixture, place.root);
  const local = localHost(place, fakes, { browser: scriptedBrowser(fixture).plane, ...(recorder ? { recorder } : {}) });
  try {
    const result = await run(place, local.host, jobOf(fixture, process.env.LIMIT ? Number(process.env.LIMIT) : undefined));
    const usd = Object.values(result.usage.models).reduce((sum, used) => sum + used.cost.total, 0);
    console.log(JSON.stringify({ outcome: { status: result.status, generation: result.generation, usd, parts: Object.fromEntries(Object.entries({ ...result.usage.models, ...result.usage.tools }).map(([name, used]) => [name, used.cost.total])), model: `${local.host.models.lead.provider}/${local.host.models.lead.modelId}`, ...(result.status === 'refused' ? { code: result.code, message: result.message.slice(0, 300) } : {}) } }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: { status: 'error', message: String((error as Error).message).slice(0, 300) } }));
  } finally { recorder?.detach(); }
}

// ---- the supervisor ---------------------------------------------------------------------------------------------------

type Outcome = { status: string; generation?: number; usd?: number; parts?: Record<string, number>; model?: string; code?: string; message?: string };

function startChild(env: Record<string, string>) {
  const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', SELF, '--child'], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR ?? '/tmp', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk; });
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise<{ outcome?: Outcome; signal: string | null; stderr: string }>((resolveDone) => proc.on('close', (code, signal) => {
    const row = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((parsed) => parsed.outcome);
    resolveDone({ ...(row ? { outcome: row.outcome as Outcome } : {}), signal, stderr: stderr.trim().slice(0, 600) });
  }));
  return { proc, done };
}

/** The supervisor's host lines: a spool file of its own, each line tagged with the process it is about and no `seq`. */
function supervisorLines(dir: string) {
  const started = Date.parse(startedAt(dir));
  const spool = join(dir, '.spool');
  mkdir(spool, { recursive: true });
  const file = join(spool, `live-supervisor-${process.pid}.jsonl`);
  return {
    host: (kind: string, gen: number, data: unknown) => appendFileSync(file, `${JSON.stringify({ channel: 'live', source: 'host', kind, gen, t: Math.max(0, Date.now() - started), data })}\n`),
    blob: (bytes: Uint8Array | string, extension: string) => {
      const buffer = Buffer.from(bytes);
      const hash = createHash('sha256').update(buffer).digest('hex');
      mkdir(join(dir, 'blobs'), { recursive: true });
      writeFileSync(join(dir, 'blobs', `${hash}.${extension}`), buffer);
      return hash;
    },
  };
}

export type AuditOptions = { fixture?: string; limit?: number; stormMs?: number; kills?: number; seed?: number; record?: string; dir?: string };

export async function audit(options: AuditOptions) {
  const dir = resolve(options.dir ?? join(process.env.TMPDIR ?? '/tmp', `dependency-audit-${process.pid}`));
  mkdirSync(dir, { recursive: true });
  // The supervisor's own lines (a kill, the result) are about a process but are not that process's lines, so they carry no sequence
  // number; the recorder writes one on every line, so the supervisor appends its host lines to a spool of its own.
  const supervisor = options.record ? supervisorLines(options.record) : undefined;
  const next = random(options.seed ?? 1);
  const maxKills = options.stormMs ? options.kills ?? 30 : 0;
  let kills = 0; let processes = 0; let last: { outcome?: Outcome; signal: string | null; stderr: string } | undefined;
  const env = { DIR: dir, ...(process.env.AUDIT_DEBUG ? { AUDIT_DEBUG: process.env.AUDIT_DEBUG } : {}), ...(options.fixture ? { FIXTURE: options.fixture } : {}), ...(options.limit ? { LIMIT: String(options.limit) } : {}), ...(options.record ? { RECORD: resolve(options.record) } : {}) };
  for (;;) {
    const { proc, done } = startChild(env);
    processes += 1;
    // A storm gap is the interval, give or take a third; the last allowed kill is spent, then the run is left to finish.
    const timer = options.stormMs && kills < maxKills ? setTimeout(() => { if (proc.exitCode === null) { kills += 1; supervisor?.host('kill', processes, { label: `storm ${kills}`, crossing: null, pid: proc.pid }); proc.kill('SIGKILL'); } }, Math.round(options.stormMs * (0.67 + next() * 0.66))) : undefined;
    last = await done;
    clearTimeout(timer);
    if (last.outcome) break;
    if (last.signal !== 'SIGKILL') break;
  }
  const outcome = last?.outcome;
  let result: { blob: string; title: string } | undefined;
  if (options.record && outcome?.status === 'complete') {
    const out = join(dir, 'out', 'record.json');
    if (existsSync(out)) { result = { blob: supervisor!.blob(readFileSync(out), 'json'), title: 'The audit' }; supervisor!.host('result', processes, { blob: result.blob }); }
    finishRecording(options.record, {
      title: 'Dependency audit under a kill storm (scripted replay)', task: workflow.name, model: outcome.model ?? 'scripted',
      generations: outcome.generation ?? processes, kills, code: codeOf(join(import.meta.dirname, '..', '..')),
      cost: { usd: outcome.usd ?? null, parts: outcome.parts ?? {} }, source: { run: 'reference', store: join(dir, 'store', 'run.sqlite') }, ...(result ? { result } : {}),
    });
  }
  return { dir, processes, kills, outcome, stderr: last?.stderr ?? '' };
}

if (import.meta.main) {
  if (process.argv[2] === '--child') await child();
  else {
    const { values } = parseArgs({ options: { fixture: { type: 'string' }, limit: { type: 'string' }, storm: { type: 'string' }, kills: { type: 'string' }, seed: { type: 'string' }, record: { type: 'string' }, dir: { type: 'string' }, json: { type: 'boolean' } } });
    const result = await audit({
      ...(values.fixture ? { fixture: values.fixture } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}), ...(values.storm ? { stormMs: Number(values.storm) } : {}),
      ...(values.kills ? { kills: Number(values.kills) } : {}), ...(values.seed ? { seed: Number(values.seed) } : {}), ...(values.record ? { record: values.record } : {}), ...(values.dir ? { dir: values.dir } : {}),
    });
    if (values.json) console.log(JSON.stringify(result));
    else console.log(`dependency audit: ${result.outcome?.status ?? 'no outcome'} after ${result.processes} process${result.processes === 1 ? '' : 'es'} and ${result.kills} kill${result.kills === 1 ? '' : 's'}, run in ${result.dir}${result.stderr ? `\n${result.stderr}` : ''}`);
    if (result.outcome?.status !== 'complete') process.exitCode = 1;
  }
}
