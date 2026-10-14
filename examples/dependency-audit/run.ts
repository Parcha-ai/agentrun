// node examples/dependency-audit/run.ts [--fixture <name> | --live --package <package.json | owner/repo[@commit]> [--model provider/id]]
//   [--limit N] [--storm <ms>] [--kills N] [--record <dir>] [--dir <run dir>] [--seed N] [--json]
// The dependency audit on the reference assembly. By default it needs no key: the facts of a captured project, a scripted lead and
// a scripted judge. `--live` reads a package.json you name from the public sources, with your own model key (ANTHROPIC_API_KEY,
// OPENAI_API_KEY or GEMINI_API_KEY) and a Chrome on this machine; the install step is skipped and says so unless a box is available. `--storm 2000` ends the process with SIGKILL about every two seconds (at most `--kills`, default 30) and a fresh
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
import type { BrowserPlane, Fakes, RunOptions } from '../reference/index.ts';
import { badgeImageTool, visionOptions } from './badges.ts';
import { liveModels, modelJudge } from './live.ts';
import { resolveDependencies } from './sources.ts';
import { makeTools, rerunner } from './tools.ts';
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

export const jobOf = (fixture: Fixture, limit?: number): Job => ({ workflow, input: { project: fixture.project, commit: fixture.source.commit, commit_date: fixture.source.commit_date, read_on: fixture.source.captured.slice(0, 10), dependencies: fixture.dependencies.slice(0, limit ?? fixture.dependencies.length) } });

/** mulberry32, so the storm's gaps are the same for the same seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- the run ----------------------------------------------------------------------------------------------------------

async function child() {
  const dir = process.env.DIR!;
  const place = await placeAt(dir);
  const job: Job = { workflow, input: JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')) };
  const live = process.env.LIVE === '1';
  const recording = process.env.RECORD;
  const recorder = recording ? openRecorder({ dir: recording, commits: await packageCommitRecorder() }) : undefined;
  let local;
  let tools: Fakes['tools'];
  let runOptions: RunOptions = {};
  if (live) {
    const { catalog, lead } = liveModels(process.env, process.env.MODEL);
    const liveTools = makeTools({ root: place.root, source: { live: true } });
    const fakes = { model: () => { throw new Error('the live run asks a real model'); }, tools: liveTools, judge: modelJudge(catalog, lead), pages: {}, start: 'about:blank' } as Fakes;
    local = localHost(place, fakes, { browser: await localChrome(place), ...(recorder ? { recorder } : {}) });
    local.host.models = { catalog, lead };
    local.host.decisions.runJudge = modelJudge(catalog, lead);
    // The repository agent reads README badges as images: a tool saves each as a PNG, and the eyes (the user's own model) read it.
    local.host.tools = { ...local.host.tools, extensions: [badgeImageTool({ onImage: (image) => recorder?.live('vision', 'badge.image', { path: image.path, sha256: image.sha256, width: image.width, height: image.height }, { blobs: [recorder.blob(image.png, 'png')] }) })] };
    runOptions = { vision: (running) => visionOptions(local!.host, { harness: () => running.harness as never, eyesModel: lead }) };
    tools = liveTools;
  } else {
    const fixture = loadFixture(process.env.FIXTURE);
    const fakes = scriptedFakes(fixture, place.root);
    local = localHost(place, fakes, { browser: scriptedBrowser(fixture).plane, ...(recorder ? { recorder } : {}) });
    tools = fakes.tools;
  }
  // A call a killed process left unknown is settled by running it again: the reads are read-only, an install runs in a fresh box.
  local.host.tools = { ...local.host.tools, rerun: rerunner((job.input as { dependencies: Array<{ name: string; version: string }> }).dependencies, tools as never) };
  try {
    const result = await run(place, local.host, job, runOptions);
    const usd = Object.values(result.usage.models).reduce((sum, used) => sum + used.cost.total, 0);
    console.log(JSON.stringify({ outcome: { status: result.status, generation: result.generation, usd, parts: Object.fromEntries(Object.entries({ ...result.usage.models, ...result.usage.tools }).map(([name, used]) => [name, used.cost.total])), model: `${local.host.models.lead.provider}/${local.host.models.lead.modelId}`, ...(result.status === 'refused' ? { code: result.code, message: result.message.slice(0, 300) } : {}) } }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: { status: 'error', message: String((error as Error).message).slice(0, 300) } }));
  } finally { recorder?.detach(); }
}

/** A Chrome on this machine, driven over CDP by the browser package. It reaches the public internet: the live run reads GitHub's pages. */
async function localChrome(place: { root: string }): Promise<BrowserPlane> {
  const [{ cdpProvider }, { stagehandDriver }, { findChrome }] = await Promise.all([import('@parcha/pi-browser/providers/cdp'), import('@parcha/pi-browser/driver/stagehand'), import('@parcha/pi-browser/coding-agent')]);
  const executablePath = process.env.CHROME_PATH || findChrome(process.env);
  if (!executablePath) throw new Error('--live needs a Chrome: none was found. Set CHROME_PATH.');
  const provider = cdpProvider({ chrome: { executablePath, profileRoot: join(place.root, 'chrome'), headless: true } });
  return { provider: () => provider, driver: stagehandDriver() };
}

/** The job's input from `--package`: a package.json on disk (its lockfile beside it), or `owner/repo[@commit]` on GitHub. */
async function inputFrom(spec: string, limit?: number): Promise<Record<string, unknown>> {
  let pkg: { name?: string; dependencies?: Record<string, string> }; let lock: { packages?: Record<string, { version?: string }> } | undefined; let project = spec; let commit: string | undefined; let commitDate: string | undefined;
  if (existsSync(spec)) {
    pkg = JSON.parse(readFileSync(spec, 'utf8'));
    const lockFile = join(resolve(spec, '..'), 'package-lock.json');
    lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : undefined;
    project = pkg.name ?? spec;
  } else {
    const [repo, ref] = spec.split('@');
    const headers: Record<string, string> = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
    const meta = await (await fetch(`https://api.github.com/repos/${repo}/commits/${ref ?? 'HEAD'}`, { headers: { 'user-agent': 'agentrun-dependency-audit', ...headers } })).json() as { sha?: string; commit?: { committer?: { date?: string } } };
    if (!meta.sha) throw new Error(`--package ${spec}: GitHub has no such commit`);
    commit = meta.sha; commitDate = (meta.commit?.committer?.date ?? '').slice(0, 10); project = repo!;
    const file = async (name: string) => { const response = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${name}`); return response.status === 200 ? await response.text() : null; };
    const text = await file('package.json');
    if (text === null) throw new Error(`${spec} has no package.json`);
    pkg = JSON.parse(text);
    const lockText = await file('package-lock.json');
    lock = lockText ? JSON.parse(lockText) : undefined;
  }
  const dependencies = (await resolveDependencies(pkg, lock, limit)).map(({ name, version }) => ({ name, version }));
  if (!dependencies.length) throw new Error(`${spec} lists no dependencies the registry can resolve`);
  return { project, ...(commit ? { commit, commit_date: commitDate ?? '' } : {}), read_on: new Date().toISOString().slice(0, 10), dependencies };
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

export type AuditOptions = { live?: boolean; package?: string; model?: string; fixture?: string; limit?: number; stormMs?: number; kills?: number; seed?: number; record?: string; dir?: string };

export async function audit(options: AuditOptions) {
  const dir = resolve(options.dir ?? join(process.env.TMPDIR ?? '/tmp', `dependency-audit-${process.pid}`));
  mkdirSync(dir, { recursive: true });
  // The input is fixed once, here, so every process of the run reads the same dependencies.
  const inputFile = join(dir, 'input.json');
  if (!existsSync(inputFile)) {
    const input = options.live ? await inputFrom(options.package ?? (() => { throw new Error('--live needs --package <package.json | owner/repo[@commit]>'); })(), options.limit) : jobOf(loadFixture(options.fixture), options.limit).input;
    writeFileSync(inputFile, JSON.stringify(input));
  }
  // The supervisor's own lines (a kill, the result) are about a process but are not that process's lines, so they carry no sequence
  // number; the recorder writes one on every line, so the supervisor appends its host lines to a spool of its own.
  const supervisor = options.record ? supervisorLines(options.record) : undefined;
  const next = random(options.seed ?? 1);
  const maxKills = options.stormMs ? options.kills ?? 30 : 0;
  let kills = 0; let processes = 0; let last: { outcome?: Outcome; signal: string | null; stderr: string } | undefined;
  const env = { DIR: dir, ...(options.live ? { LIVE: '1' } : {}), ...(options.model ? { MODEL: options.model } : {}), ...(process.env.AUDIT_DEBUG ? { AUDIT_DEBUG: process.env.AUDIT_DEBUG } : {}), ...(options.fixture ? { FIXTURE: options.fixture } : {}), ...(options.record ? { RECORD: resolve(options.record) } : {}) };
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
  if (process.argv[2] === '--child') await child().catch((error) => console.log(JSON.stringify({ outcome: { status: 'error', message: String((error as Error).message).slice(0, 300) } })));
  else {
    const { values } = parseArgs({ options: { live: { type: 'boolean' }, package: { type: 'string' }, model: { type: 'string' }, fixture: { type: 'string' }, limit: { type: 'string' }, storm: { type: 'string' }, kills: { type: 'string' }, seed: { type: 'string' }, record: { type: 'string' }, dir: { type: 'string' }, json: { type: 'boolean' } } });
    const result = await audit({
      ...(values.live ? { live: true } : {}), ...(values.package ? { package: values.package } : {}), ...(values.model ? { model: values.model } : {}), ...(values.fixture ? { fixture: values.fixture } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}), ...(values.storm ? { stormMs: Number(values.storm) } : {}),
      ...(values.kills ? { kills: Number(values.kills) } : {}), ...(values.seed ? { seed: Number(values.seed) } : {}), ...(values.record ? { record: values.record } : {}), ...(values.dir ? { dir: values.dir } : {}),
    });
    if (values.json) console.log(JSON.stringify(result));
    else console.log(`dependency audit: ${result.outcome?.status ?? 'no outcome'}${result.outcome?.message ? ` (${result.outcome.message})` : ''} after ${result.processes} process${result.processes === 1 ? '' : 'es'} and ${result.kills} kill${result.kills === 1 ? '' : 's'}, run in ${result.dir}${result.stderr ? `\n${result.stderr}` : ''}`);
    if (result.outcome?.status !== 'complete') process.exitCode = 1;
  }
}
