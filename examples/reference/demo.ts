// `demo()`: the reference entry as a demo's platform. A demo's `run.ts` is about twenty lines: its spec, its job, its fakes, and this call. It reads the
// standard flags, runs the job on the no-key host, and (with `--kill`) runs the spec's kills through a supervisor that starts the job as a child process,
// kills it at each named crossing or in a storm, and resumes it in a fresh one on the same directory.
//
//   (none)              fakes, $0, no key: the default, and what CI runs
//   --live              real models and services; refused unless the demo supplies them (`live`) and the keys they need are set
//   --kill              the spec's `kills`, in order, each ending one process; a fresh process resumes
//   --record <dir>      an agentrun.recording/1 directory, through the reference recorder
//   --input <path|json> the job's input (the job's own is the default)
//   --max-usd <n>       stops the run past n dollars, metered on the recording's lines; default twice the spec's `expectedCost`
//   --local-chrome      with --live and no Browserbase key: a Chrome on your own machine (CHROME_PATH). Never against real pages from a shared host
//   --dir <path>        keeps the run's directory
//   --json              prints the result as one JSON object
//
// The supervisor serves the fake browser's backend on loopback so its sessions outlive a killed child, and writes the host lines (`process.started`, `kill`
// with its `kind`, `result`) from outside every process.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { FakeBackend, remoteDriver, remoteProvider } from '@parcha/pi-browser/testing';
import type { BoxProvider } from '@parcha/pi-transport';
import { placeAt, run, type Job, type RunOptions } from './assemble.ts';
import { RUN_LABEL, tapBox } from './boxes.ts';
import { capJudge } from './judge.ts';
import { crossings, tapFakes, tapHost, type Cross, type Crossing, type EffectWindow } from './crossings.ts';
import { checkInputCapture, childPlansOf, chooseBrowser, effectiveBoxes, killsOf, maxUsdOf, parseInput, plansOf, type ChildPlan, type DemoSpec } from './demo-spec.ts';
import { cost } from './fold.ts';
import { localHost, type BrowserPlane, type Fakes, type Host } from './host.ts';
import { codeOf, finishRecording, openRecorder, openSupervisor } from './record.ts';
import { packageCommitRecorder } from './record-store.ts';

/** What `--live` swaps for the scripted parts: host members (models, tools, decisions, the browser plane) and vision options. The demo supplies them from its
 *  own keys; a demo that supplies none refuses `--live`. */
export type LiveParts = { host?: Partial<Host>; vision?: RunOptions['vision'] };
export type DemoOptions = {
  /** `import.meta.url` of the demo's `run.ts`: the file the supervisor starts, with `--child`, as each process of the run. */
  self: string;
  spec: DemoSpec;
  job: Job;
  fakes: Fakes;
  live?: (context: { env: NodeJS.ProcessEnv; browser: 'fake' | 'browserbase' | 'chrome' }) => LiveParts | Promise<LiveParts>;
  /** The run's result, as the recording shows it: the entry writes the result line and its blob from `json` (`agentrun.cited/1` for a payoff that cites what it read) instead of the raw delivered record. `keep` stores a file in the recording's blobs and returns its SHA-256; `dir` is the run's directory, where the run's own files are. It runs in the process that delivered. */
  result?: (record: unknown, context: { dir: string; keep(bytes: Uint8Array | string, extension: string): string }) => { json: unknown; title: string } | Promise<{ json: unknown; title: string }>;
  /** The arguments to read (default `process.argv.slice(2)`). */
  argv?: string[];
  /** The root of the repository, for the recording's `code` (default: two directories above the entry). */
  root?: string;
};

export type DemoResult = {
  /** How each process ended: its exit or signal, and the outcome it printed. */
  processes: Array<{ exit: number | string | null; signal: string | null; outcome?: { status: string; generation: number | null; code?: string | null; message?: string; result?: { json: unknown; title: string } }; stderr: string }>;
  kills: Array<{ gen: number; point: string | null; kind: 'process' | 'box'; why: string }>;
  /** The record the job delivered, or null. */
  record: unknown;
  dir: string;
  recording?: string;
  /** The recording's cost: dollars, or null while any part is unknown (never 0). */
  usd: number | null;
  maxUsd: number | null;
  /** The run was stopped past `--max-usd`, or finished past it. */
  overBudget: boolean;
};

const FLAGS = { child: { type: 'boolean' }, live: { type: 'boolean' }, kill: { type: 'boolean' }, record: { type: 'string' }, input: { type: 'string' }, 'max-usd': { type: 'string' }, 'local-chrome': { type: 'boolean' }, dir: { type: 'string' }, json: { type: 'boolean' } } as const;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export async function demo(options: DemoOptions): Promise<DemoResult | undefined> {
  const { values } = parseArgs({ args: options.argv ?? process.argv.slice(2), options: FLAGS });
  if (values.child) { await child(options); return undefined; }
  const result = await supervise(options, values);
  if (values.json) console.log(JSON.stringify(result));
  else summarize(options, result);
  // A command line ends with a failing code when the run did not complete or went past its cap; a caller that passed its own arguments reads the result.
  if (options.argv === undefined && (result.overBudget || result.processes.at(-1)?.outcome?.status !== 'complete')) process.exitCode = 1;
  return result;
}

// ---- the child: one process of the run ------------------------------------------------------------------------------------------------------

/** The fake browser's plane, on the backend the supervisor serves: a session opens on the backend's start page and `run` hands back the code it was given, so a
 *  lead's `page.goto("<url>")` is turned into the fake's `goto` action and each session stands on its own page. */
function fakeBrowser(url: string): BrowserPlane {
  const remote = remoteDriver(url);
  return {
    provider: () => remoteProvider(url), createDeadlineMs: 3_000,
    driver: async (target) => {
      const page = await remote(target);
      return { ...page, run: async (input) => {
        const goto = /page\.goto\(\s*(["'`])(.+?)\1\s*\)/.exec(input.code ?? '');
        return page.run(goto ? { actions: [{ op: 'goto', url: goto[2]! }] } : (input as Parameters<typeof page.run>[0]));
      } };
    },
  };
}

/** The host a run uses, in the order that keeps every platform check on the final host: the live parts merged in, then the crossings put at its seams, then the judge seam's caps. */
export function composeHost(host: Host, parts: Partial<Host> | undefined, cross: Cross, window: EffectWindow, spentFile: string): void {
  mergeParts(host, parts);
  tapHost(host, cross, window);
  host.decisions = { ...host.decisions, runJudge: capJudge(host.decisions.runJudge, spentFile) };
}

/** The live parts merged into the host member by member: a part's `tools` or `decisions` adds to the host's, never replaces it wholesale (its extensions, `answered`, `rerun` and browser
 *  decisions stay). */
export function mergeParts(host: Host, parts: Partial<Host> | undefined): void {
  if (!parts) return;
  const { tools, decisions, credentials, ...rest } = parts;
  Object.assign(host, rest);
  if (tools) host.tools = { ...host.tools, ...tools, extensions: [...host.tools.extensions, ...(tools.extensions ?? [])] } as Host['tools'];
  if (decisions) host.decisions = { ...host.decisions, ...decisions } as Host['decisions'];
  if (credentials) host.credentials = { ...host.credentials, ...credentials };
}

/** The demo's box provider: its `boxes` declaration, a directory of this machine (`local`) or Docker. */
async function boxProvider(boxes: ReturnType<typeof effectiveBoxes>, place: { root: string }) {
  if (!boxes) return undefined;
  return boxes.kind === 'local' ? (await import('@parcha/pi-transport/box/local')).localBoxes({ root: join(place.root, 'boxes') }) : (await import('@parcha/pi-transport/box/docker')).dockerBoxes(boxes.image ? { image: boxes.image } : undefined);
}

/** One box the job's own tools (the disk package's shell and files) run in: a directory of this machine whose workspace is the run's `work/`, or a container the
 *  job's files are uploaded to. It comes from the tapped provider, so its commands are crossings and its life is on the recording. */
async function inBox(provider: BoxProvider, kind: 'local' | 'docker', place: { id: string; work: string }, files: Record<string, Uint8Array>) {
  const { boxEnv } = await import('@parcha/pi-transport/hands');
  const created = await provider.create({ maxLifetimeMs: 15 * 60_000, labels: {}, ...(kind === 'local' ? { workspace: place.work } : {}) }, ctx);
  if (!created.ok) throw created.error;
  const box = created.value;
  if (kind === 'docker') {
    const uploaded = await box.upload(Object.entries(files).map(([path, bytes]) => ({ path, bytes })), ctx);
    if (!uploaded.ok) { await box.destroy(ctx); throw uploaded.error; }
  }
  const env = Object.assign(() => boxEnv(box), { cleanup: async () => undefined });
  return { env: () => env, destroy: async () => { await box.destroy(ctx); } };
}

async function child(options: DemoOptions) {
  const env = process.env;
  const place = await placeAt(env.DIR);
  const plan = env.PLAN ? (JSON.parse(env.PLAN) as ChildPlan) : undefined;
  const window: EffectWindow = { open: 0 };
  const cross = crossings(plan, env.CROSS_LOG, Date.now(), window);
  const recorder = env.RECORD_DIR ? openRecorder({ dir: env.RECORD_DIR, commits: await packageCommitRecorder() }) : undefined;
  const live = env.LIVE === '1';
  const browserKind = (env.BROWSER ?? 'fake') as 'fake' | 'browserbase' | 'chrome';
  let box: Awaited<ReturnType<typeof inBox>> | undefined;
  try {
    const parts = live ? await options.live!({ env, browser: browserKind }) : {};
    // Docker only with --live: a no-key run uses a local box, so it starts no container.
    const boxSpec = effectiveBoxes(options.spec, live);
    const provider = await boxProvider(boxSpec, place);
    const boxes = provider ? tapBox(provider, { cross, window, ...(env.RUN_LABEL ? { runLabel: env.RUN_LABEL } : {}), ...(recorder ? { recorder } : {}) }) : undefined;
    const local = localHost(place, live ? options.fakes : tapFakes(options.fakes, cross), { browser: fakeBrowser(env.BACKEND!), live, ...(recorder ? { recorder } : {}), ...(boxes ? { boxes } : {}) });
    // The live parts are merged into the host member by member FIRST, then the platform wraps the final host: the crossings (so a live `status` or `tools` still has them) and the judge seam's
    // caps (Jev's), which a live judge is held to too.
    composeHost(local.host, parts.host, cross, window, join(place.root, 'judge-spent.jsonl'));
    if (boxes && boxSpec?.runIn) box = await inBox(boxes, boxSpec.kind, place, options.job.files ?? {});
    const input = env.INPUT ? (JSON.parse(env.INPUT) as Record<string, unknown>) : options.job.input;
    // The vision lane: the demo's own on fakes (`fakes.vision`), and the live parts' on --live.
    const vision: RunOptions['vision'] = (running) => ({ ...(live ? {} : options.fakes.vision?.(local.host, running) ?? {}), ...(parts.vision?.(running) ?? {}) });
    const result = await run(place, local.host, { ...options.job, input }, { ...(box ? { env: box.env } : {}), vision });
    // The demo's result hook: what the recording shows as the run's result, made where the run's own files are.
    const made = result.status === 'complete' && options.result ? await options.result(result.output, { dir: place.root, keep: (bytes, extension) => (recorder ? recorder.blob(bytes, extension) : createHash('sha256').update(bytes).digest('hex')) }) : undefined;
    await recorder?.detach();
    console.log(JSON.stringify({ outcome: { status: result.status, generation: result.generation, ...(result.status === 'refused' ? { code: result.code, message: result.message.slice(0, 240) } : {}), ...(made ? { result: made } : {}) } }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: { status: 'error', generation: null, code: (error as { code?: string }).code ?? null, message: String((error as Error).message).slice(0, 400) } }));
  } finally {
    await box?.destroy();
  }
}

// ---- the supervisor ---------------------------------------------------------------------------------------------------------------------------

type Spawned = DemoResult['processes'][number];

export function spawnChild(self: string, env: Record<string, string>, onSpawn: (pid: number) => void, stop?: { signal?: AbortSignal }): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', fileURLToPath(self), '--child'], { env: { PATH: process.env.PATH!, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn(proc.pid!);
    // A signal already aborted (the cap was passed while the previous process's boxes were being destroyed) ends this child at once: it would otherwise run on and make more paid calls.
    const end = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
    if (stop?.signal?.aborted) end(); else stop?.signal?.addEventListener('abort', end, { once: true });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      const row = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((parsed) => parsed.outcome);
      resolve({ exit: signal ?? code, signal, ...(row ? { outcome: row.outcome } : {}), stderr: stderr.trim().slice(0, 600) });
    });
  });
}

const rows = <T,>(file: string): T[] => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as T]; } catch { return []; } }); } catch { return []; } };

const spoolLines = (recordDir: string) => {
  const spool = join(recordDir, '.spool');
  if (!existsSync(spool)) return [];
  return readdirSync(spool).filter((name) => name.endsWith('.jsonl')).flatMap((name) => rows<Record<string, unknown>>(join(spool, name)));
};

/** The cost of a recording still being written: its spools folded as they stand. Null while any part is unknown. */
export function meter(recordDir: string): number | null {
  return cost(spoolLines(recordDir)).usd;
}

/** What is known to have been spent so far: the priced parts summed, whether or not another part is unknown. The spend cap compares this, so an unknown price never switches it off. */
export function meterKnown(recordDir: string): number {
  return Object.values(cost(spoolLines(recordDir)).parts).reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

/** A run's boxes taken away with its machine: every box that carries the run's label, tool-made ones too, destroyed through the provider. A box that will not be destroyed is an error. */
export async function destroyBoxes(spec: DemoSpec, runLabel: string, root: string, live = false): Promise<void> {
  const provider = await boxProvider(effectiveBoxes(spec, live), { root });
  if (!provider) return;
  const listed = await provider.list({ [RUN_LABEL]: runLabel }, ctx);
  if (!listed.ok) throw listed.error;
  const failed: string[] = [];
  for (const ref of listed.value) {
    const found = await provider.attach(ref.id, ctx);
    const gone = found.ok && found.value ? await found.value.destroy(ctx) : found;
    if (!gone.ok) failed.push(ref.id);
  }
  if (failed.length) throw new Error(`the run's boxes could not be destroyed: ${failed.join(', ')}`);
}

async function supervise(options: DemoOptions, values: ReturnType<typeof parseArgs<{ options: typeof FLAGS }>>['values']): Promise<DemoResult> {
  const { spec, job } = options;
  const live = values.live === true;
  if (live && !options.live) throw new Error(`--live: ${spec.name} supplies no live parts (no real models or services), so it runs on fakes only.`);
  const browser = chooseBrowser({ live, env: process.env, localChrome: values['local-chrome'] === true });
  const plans = values.kill ? plansOf(killsOf(spec)) : [];
  const maxUsd = maxUsdOf(values['max-usd'], spec);
  const input = values.input === undefined ? undefined : parseInput(values.input, (path) => readFileSync(path, 'utf8'));
  if (!live) checkInputCapture(spec, input, job.input, dirname(fileURLToPath(options.self)), existsSync);
  if (values.record && (existsSync(join(values.record, '.spool')) || existsSync(join(values.record, 'manifest.json')))) throw new Error(`${values.record} already holds a recording or an unfinished one: record into a directory of its own`);

  const scratch = await mkdtemp(join(tmpdir(), `agentrun-${spec.name}-`));
  const dir = values.dir ?? join(scratch, 'run');
  const recordDir = values.record ?? join(scratch, 'recording');
  mkdirSync(recordDir, { recursive: true });
  // The fake browser's backend outlives a killed process: it is served here, and each child reaches it by URL.
  const backend = new FakeBackend({ start: options.fakes.start, pages: options.fakes.pages });
  const served = await backend.serve();
  const supervisor = openSupervisor({ dir: recordDir });
  // A label no other run shares, on every box this run makes: cleanup finds these and no others.
  const runLabel = randomUUID();
  const base: Record<string, string> = { RUN_LABEL: runLabel, HOME: scratch, TMPDIR: scratch, DIR: dir, RECORD_DIR: recordDir, BACKEND: served.url, BROWSER: browser, ...(live ? { LIVE: '1' } : {}), ...(input ? { INPUT: JSON.stringify(input) } : {}) };
  // A live child needs what the demo's live parts read from the environment, and nothing else of ours.
  // And any `DEMO_*` variable, the demo's own settings.
  for (const name of Object.keys(process.env)) if ((live && /^(BROWSERBASE_|BB_|CHROME_PATH|PI_BROWSER_|HERO_|OPENROUTER_|OPENAI_|ANTHROPIC_)/.test(name)) || name.startsWith('DEMO_')) base[name] = process.env[name]!;
  const processes: DemoResult['processes'] = [];
  const kills: DemoResult['kills'] = [];
  let overBudget = false;
  const stopper = new AbortController();
  // Metering: the recording's lines as they stand, folded; past the cap the run is stopped.
  const meterTimer = maxUsd === null ? undefined : setInterval(() => { if (meterKnown(recordDir) > maxUsd) { overBudget = true; stopper.abort(); } }, 250);
  try {
    const remaining = childPlansOf(plans);
    for (;;) {
      // Past the cap, no further process is started: the budget is checked before every restart.
      if (overBudget && processes.length > 0) break;
      const plan = remaining.shift() ?? { tools: [] };
      const gen = processes.length + 1;
      const log = join(scratch, `crossings-${gen}.jsonl`);
      const result = await spawnChild(options.self, { ...base, CROSS_LOG: log, PLAN: JSON.stringify(plan) }, (pid) => { supervisor.host('process.started', { gen, pid }); }, stopper);
      processes.push(result);
      if (overBudget) { supervisor.host('kill', { gen, label: 'max-usd', crossing: null, kind: 'process' }); kills.push({ gen, point: null, kind: 'process', why: `past --max-usd ${maxUsd}` }); break; }
      if (result.signal === 'SIGKILL') {
        const at = rows<Crossing>(log).filter((crossing) => crossing.n > 0).at(-1);
        const kind = plan.run?.kind ?? 'process';
        supervisor.host('kill', { gen, label: plan.run && !('storm' in plan.run) ? plan.run.point : at?.point ?? null, crossing: at ? { point: at.point, n: at.n } : null, side: 'child', kind });
        kills.push({ gen, point: at?.point ?? null, kind, why: plan.run?.why ?? 'a kill' });
        if (kind === 'box') await destroyBoxes(spec, runLabel, dir, live);
        continue;
      }
      break;
    }
    const delivered = (() => { try { return JSON.parse(readFileSync(join(dir, 'out', 'record.json'), 'utf8')) as { record: unknown }; } catch { return null; } })();
    if (maxUsd !== null && meterKnown(recordDir) > maxUsd) overBudget = true;
    const processesStarted = processes.length;
    // The demo's result hook, reported by the process that delivered, shapes the result line and its blob; without one, the delivered record is the result.
    const made = processes.at(-1)?.outcome?.result as { json: unknown; title: string } | undefined;
    const blob = made ? openRecorder({ dir: recordDir }).blob(JSON.stringify(made.json, null, 2), 'json') : delivered ? openRecorder({ dir: recordDir }).blob(readFileSync(join(dir, 'out', 'record.json')), 'json') : undefined;
    const resultTitle = made?.title ?? 'The record';
    if (blob) supervisor.host('result', { gen: processesStarted, blob, title: resultTitle }, { blobs: [blob] });
    const resultBlob = blob ? { blob, title: resultTitle } : undefined;
    finishRecording(recordDir, {
      title: spec.title ?? spec.name, task: job.workflow.name ?? spec.name, model: live ? 'live' : 'faux/faux-1', generations: processesStarted, kills: kills.length,
      code: codeOf(options.root ?? ROOT), cost, source: { run: 'reference', store: join(dir, 'store', 'run.sqlite') }, ...(resultBlob ? { result: resultBlob } : {}), ...(live ? { providers: 'real' as const } : {}),
    });
    const usd = cost(readEventsOf(recordDir)).usd;
    return { processes, kills, record: delivered?.record ?? null, dir, ...(values.record ? { recording: values.record } : {}), usd, maxUsd, overBudget };
  } finally {
    if (meterTimer) clearInterval(meterTimer);
    await served.close();
    if (!values.record && !values.dir) await rm(scratch, { recursive: true, force: true });
  }
}

const readEventsOf = (dir: string) => rows<Record<string, unknown>>(join(dir, 'events.jsonl'));

function summarize(options: DemoOptions, result: DemoResult) {
  console.log(`${options.spec.title ?? options.spec.name}: ${result.processes.at(-1)?.outcome?.status ?? 'no outcome'} in ${result.processes.length} process${result.processes.length === 1 ? '' : 'es'}, ${result.kills.length} kill${result.kills.length === 1 ? '' : 's'}`);
  for (const kill of result.kills) console.log(`  killed process ${kill.gen} (${kill.kind}) at ${kill.point ?? 'no named crossing'}: ${kill.why}`);
  console.log(`cost: ${result.usd === null ? 'unknown' : `$${result.usd}`}${result.maxUsd === null ? '' : ` (cap $${result.maxUsd})`}${result.overBudget ? ' — over the cap' : ''}`);
  if (result.recording) console.log(`recording: ${result.recording}`);
}
