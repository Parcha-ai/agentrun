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
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { codeOf, finishRecording, localHost, openRecorder, packageCommitRecorder, placeAt, run, type Job } from '../reference/index.ts';
import { openSupervisor } from '../reference/record.ts';
import type { Fixture } from './capture.ts';
import type { BrowserPlane, Fakes, RunOptions } from '../reference/index.ts';
import { badgeImageTool, visionOptions } from './badges.ts';
import { checkReceipts, recordOf } from './check.ts';
import { attachInstall, killBox, startInstall } from './install-box.ts';
import { liveModels, modelJudge } from './live.ts';
import { resolveDependencies } from './sources.ts';
import { makeTools, rerunner } from './tools.ts';
import { scriptedBackend, scriptedBrowser, scriptedFakes, scriptedVision } from './scripted.ts';
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
    // The install runs in a throwaway Docker box when there is one; without Docker the step is skipped and the receipt says so.
    const liveTools = makeTools({ root: place.root, source: { live: true }, ...(process.env.AUDIT_NO_BOX ? {} : { boxes: { startInstall, attachInstall } }) });
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
    // With `--real-install` the install is a real npm install in a throwaway Docker box (no model, no key): its strace lines are the real ones.
    const fakes = scriptedFakes(fixture, place.root, process.env.AUDIT_PACE ? Number(process.env.AUDIT_PACE) : 0, process.env.AUDIT_REAL_INSTALL ? { startInstall, attachInstall } : undefined);
    local = localHost(place, fakes, { browser: scriptedBrowser(fixture, process.env.BACKEND).plane, ...(recorder ? { recorder } : {}) });
    tools = (fakes as unknown as { rerunTools: Fakes['tools'] }).rerunTools;
    // The vision lane with no key: the captured badges drawn as PNGs, read by scripted eyes that say what each badge says.
    const vision = scriptedVision(fixture, place.root, (image) => recorder?.live('vision', 'badge.image', { path: image.path, sha256: image.sha256, width: image.width, height: image.height }, { blobs: [recorder.blob(image.png, 'png')] }));
    local.host.tools = { ...local.host.tools, extensions: [vision.tool] };
    runOptions = { vision: (running) => visionOptions(local!.host, { harness: () => running.harness as never, eyes: vision.eyes as never }) };
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

/** pi's packages as installed, added to the code a recording was cut from: a fold that reads pi's own documents must know pi's version. */
const PI_PACKAGES = ['pi-durable', 'chord', 'pi-ai', 'pi-agent-core', 'pi-coding-agent', 'pi-tui'];
function withPi(code: ReturnType<typeof codeOf>): ReturnType<typeof codeOf> {
  const require = createRequire(import.meta.url);
  const installed = Object.fromEntries(PI_PACKAGES.flatMap((name) => {
    // A package may not export its package.json, so it is read where the install put it, beside the others.
    const read = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
    try { return [[`@earendil-works/${name}`, read(join(import.meta.dirname, '..', '..', 'node_modules', '@earendil-works', name, 'package.json'))]]; } catch { /* not hoisted here */ }
    try { return [[`@earendil-works/${name}`, read(require.resolve(`@earendil-works/${name}/package.json`))]]; } catch { return []; }
  }));
  return { ...code, packages: { ...code.packages, ...installed } };
}

/** Keeps a file whole in the recording's `blobs/` under its SHA-256 and returns the hash. */
function keepBlob(dir: string, bytes: Buffer, extension: string): string {
  const hash = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  writeFileSync(join(dir, 'blobs', `${hash}.${extension}`), bytes);
  return hash;
}

export type AuditOptions = { realInstall?: boolean; killBox?: boolean; unbounded?: boolean; holdCapMs?: number; pace?: number; attempts?: number; title?: string; live?: boolean; package?: string; model?: string; fixture?: string; limit?: number; stormMs?: number; kills?: number; seed?: number; record?: string; dir?: string };

/** The labels of the workflow's `call` nodes: while one is in flight a kill can land between its admission and its answer, which stops the
 *  run on an unknown effect until a host settles it through reconcile. */
const CALLS = new Set(['registry', 'advisories', 'install in a box']);

/** The leaf nodes of the workflow: the ones a kill cuts, as opposed to the map and chains around them. */
const LEAVES = new Set([...CALLS, 'repository', 'finding', 'verdict']);

/** The leaf nodes this process has started and not ended, read from the workflow events it appended to `events.jsonl` after `offset`
 *  (the file's size when the process started): a node an earlier process left open is open here only if this process starts it again. */
function inFlight(dir: string, offset: number): string[] {
  const open = new Set<string>();
  try {
    for (const line of readFileSync(join(dir, 'events.jsonl'), 'utf8').slice(offset).split('\n')) {
      if (!line) continue;
      let row: { source?: string; event?: { type?: string; label?: string; executionPath?: string } };
      try { row = JSON.parse(line); } catch { continue; }
      const event = row.source === 'workflow' ? row.event : undefined;
      if (!event?.label || !LEAVES.has(event.label) || !event.executionPath) continue;
      if (event.type === 'node.start') open.add(event.executionPath); else if (event.type === 'node.end') open.delete(event.executionPath);
    }
  } catch { /* no events yet */ }
  return [...open];
}
const sizeOf = (file: string) => { try { return readFileSync(file).length; } catch { return 0; } };

/** One attempt: the run, killed on the storm's schedule, until a process ends it. */
async function attempt(options: AuditOptions, dir: string, seed: number) {
  mkdirSync(dir, { recursive: true });
  // The input is fixed once, here, so every process of the run reads the same dependencies.
  const inputFile = join(dir, 'input.json');
  if (!existsSync(inputFile)) {
    const input = options.live ? await inputFrom(options.package ?? (() => { throw new Error('--live needs --package <package.json | owner/repo[@commit]>'); })(), options.limit) : jobOf(loadFixture(options.fixture), options.limit).input;
    writeFileSync(inputFile, JSON.stringify(input));
  }
  // The supervisor writes the host lines (a process started, a kill, the result) in a spool of its own, outside every process.
  const supervisor = options.record ? openSupervisor({ dir: options.record }) : undefined;
  const next = random(seed);
  const maxKills = options.stormMs ? options.kills ?? 30 : 0;
  const cuts = new Map<string, number>();
  let boxKilled = false;
  let kills = 0; let processes = 0; let last: { outcome?: Outcome; signal: string | null; stderr: string } | undefined;
  // A scripted run's fake browser belongs to the supervisor, so a killed process leaves its sessions and pages as they were.
  const served = options.live ? undefined : await scriptedBackend(loadFixture(options.fixture)).serve();
  const env = { DIR: dir, ...(served ? { BACKEND: served.url } : {}), ...(options.live ? { LIVE: '1' } : {}), ...(options.model ? { MODEL: options.model } : {}), ...(process.env.AUDIT_DEBUG ? { AUDIT_DEBUG: process.env.AUDIT_DEBUG } : {}), ...(options.fixture ? { FIXTURE: options.fixture } : {}), ...(options.pace ? { AUDIT_PACE: String(options.pace) } : {}), ...(options.realInstall ? { AUDIT_REAL_INSTALL: '1' } : {}), ...(options.record ? { RECORD: resolve(options.record) } : {}) };
  for (;;) {
    const { proc, done } = startChild(env);
    processes += 1;
    supervisor?.host('process.started', { gen: processes, pid: proc.pid });
    // A storm gap is the interval, give or take a third. The last allowed kill is spent, then the run is left to finish.
    let stopped = false;
    const offset = sizeOf(join(dir, 'events.jsonl'));
    const strike = async () => {
      // The storm guarantees progress: a node cut twice is not cut again until it has ended, so a request slower than the storm's gap
      // is paid for at most three times instead of for ever. (`unbounded` is the counters' test: a storm that starves.)
      for (let waited = 0; !options.unbounded && waited < (options.holdCapMs ?? 300_000) && !stopped && inFlight(dir, offset).some((path) => (cuts.get(path) ?? 0) >= 2); waited += 20) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      if (stopped || proc.exitCode !== null) return;
      kills += 1;
      for (const path of inFlight(dir, offset)) cuts.set(path, (cuts.get(path) ?? 0) + 1);
      supervisor?.host('kill', { gen: processes, label: `storm ${kills}`, crossing: null });
      proc.kill('SIGKILL');
    };
    // `--kill-box`: once, a running install's box is removed from under it, as if its machine were lost; the door starts it again in a fresh box.
    const boxKiller = options.killBox && !boxKilled ? setInterval(() => {
      if (boxKilled) return;
      try {
        for (const name of readdirSync(join(dir, 'boxes'))) {
          const file = join(dir, 'boxes', name, 'box.json');
          if (!existsSync(file) || existsSync(join(dir, 'boxes', name, 'lost'))) continue;
          const { boxId } = JSON.parse(readFileSync(file, 'utf8')) as { boxId: string };
          boxKilled = true;
          writeFileSync(join(dir, 'boxes', name, 'lost'), boxId);
          void killBox(boxId).then((removed) => { if (removed) supervisor?.host('kill', { gen: processes, label: `box lost: ${name}`, crossing: 'install' }); else boxKilled = false; });
          return;
        }
      } catch { /* no box yet */ }
    }, 1500) : undefined;
    const timer = options.stormMs && kills < maxKills ? setTimeout(() => void strike(), Math.round(options.stormMs * (0.67 + next() * 0.66))) : undefined;
    last = await done;
    stopped = true;
    clearTimeout(timer);
    if (boxKiller) clearInterval(boxKiller);
    if (last.outcome) break;
    if (last.signal !== 'SIGKILL') break;
  }
  await served?.close();
  const outcome = last?.outcome;
  let result: { blob: string; title: string } | undefined;
  if (options.record && outcome?.status === 'complete') {
    const out = join(dir, 'out', 'record.json');
    if (existsSync(out)) { result = { blob: keepBlob(options.record, readFileSync(out), 'json'), title: 'The audit' }; supervisor!.host('result', { gen: processes, blob: result.blob }); }
    finishRecording(options.record, {
      title: options.title ?? `Dependency audit${options.stormMs ? ' under a kill storm' : ''} (${options.live ? 'live' : 'scripted fixture'})`, task: workflow.name, model: outcome.model ?? 'scripted',
      generations: processes, kills, code: withPi(codeOf(join(import.meta.dirname, '..', '..'))),
      cost: { usd: outcome.usd ?? null, parts: outcome.parts ?? {} }, source: { run: 'reference', store: join(dir, 'store', 'run.sqlite') }, ...(result ? { result } : {}),
    });
  }
  // Every fact in the record must rest on a receipt the run filed, of the kind the fact claims.
  const record = outcome?.status === 'complete' ? recordOf(dir) : null;
  return { dir, processes, kills, outcome, stderr: last?.stderr ?? '', receiptProblems: record ? checkReceipts(dir, record) : [] };
}

/** Runs the audit; with `attempts`, a run a kill stopped on an unknown effect is started again from nothing on the next seed. */
export async function audit(options: AuditOptions) {
  const dir = resolve(options.dir ?? join(process.env.TMPDIR ?? '/tmp', `dependency-audit-${process.pid}`));
  const record = options.record ? resolve(options.record) : undefined;
  const fresh = { dir: !existsSync(dir), record: record !== undefined && !existsSync(record) };
  const seed = options.seed ?? 1;
  let result = await attempt(options, dir, seed);
  let tries = 1;
  while (result.outcome?.code === 'FROZEN_EFFECT_UNKNOWN' && tries < (options.attempts ?? 1) && fresh.dir && (record === undefined || fresh.record)) {
    await rm(dir, { recursive: true, force: true });
    if (record) await rm(record, { recursive: true, force: true });
    result = await attempt(options, dir, seed + tries);
    tries += 1;
  }
  return { ...result, attempts: tries };
}

if (import.meta.main) {
  if (process.argv[2] === '--child') await child().catch((error) => console.log(JSON.stringify({ outcome: { status: 'error', message: String((error as Error).message).slice(0, 300) } })));
  else {
    const { values } = parseArgs({ options: { live: { type: 'boolean' }, package: { type: 'string' }, model: { type: 'string' }, fixture: { type: 'string' }, limit: { type: 'string' }, storm: { type: 'string' }, kills: { type: 'string' }, seed: { type: 'string' }, record: { type: 'string' }, dir: { type: 'string' }, unbounded: { type: 'boolean' }, 'real-install': { type: 'boolean' }, 'kill-box': { type: 'boolean' }, pace: { type: 'string' }, attempts: { type: 'string' }, title: { type: 'string' }, json: { type: 'boolean' } } });
    const result = await audit({
      ...(values.live ? { live: true } : {}), ...(values.package ? { package: values.package } : {}), ...(values.model ? { model: values.model } : {}), ...(values.fixture ? { fixture: values.fixture } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}), ...(values.storm ? { stormMs: Number(values.storm) } : {}),
      ...(values.kills ? { kills: Number(values.kills) } : {}), ...(values.seed ? { seed: Number(values.seed) } : {}), ...(values.record ? { record: values.record } : {}), ...(values.dir ? { dir: values.dir } : {}),
      ...(values.unbounded ? { unbounded: true } : {}), ...(values['real-install'] ? { realInstall: true } : {}), ...(values['kill-box'] ? { killBox: true } : {}), ...(values.pace ? { pace: Number(values.pace) } : {}), ...(values.attempts ? { attempts: Number(values.attempts) } : {}), ...(values.title ? { title: values.title } : {}),
    });
    if (values.json) console.log(JSON.stringify(result));
    else console.log(`dependency audit: ${result.outcome?.status ?? 'no outcome'}${result.outcome?.message ? ` (${result.outcome.message})` : ''} after ${result.processes} process${result.processes === 1 ? '' : 'es'} and ${result.kills} kill${result.kills === 1 ? '' : 's'}, run in ${result.dir}${result.stderr ? `\n${result.stderr}` : ''}`);
    if (result.receiptProblems.length) console.error(`${result.receiptProblems.length} fact(s) cite no filed receipt of their kind:\n${result.receiptProblems.slice(0, 10).map((problem) => `  ${problem}`).join('\n')}`);
    if (result.outcome?.status !== 'complete' || result.receiptProblems.length) process.exitCode = 1;
  }
}
