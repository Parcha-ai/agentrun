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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { FakeBackend, remoteDriver, remoteProvider } from '@parcha/pi-browser/testing';
import type { BoxProvider } from '@parcha/pi-transport';
import { pathsAt, placeAt, run, type Job, type RunOptions } from './assemble.ts';
import { RUN_LABEL, tapBox } from './boxes.ts';
import { capJudge } from './judge.ts';
import { askToBeKilled, crossings, tapFakes, tapHost, type Cross, type Crossing, type EffectWindow } from './crossings.ts';
import { localPlace, type Exit, type Place, type Runner } from './place.ts';
import { childPlansOf, chooseBrowser, killsOf, maxUsdOf, parseInput, plansOf, type ChildPlan, type DemoSpec } from './demo-spec.ts';
import { cost } from './fold.ts';
import { localHost, type BrowserPlane, type Fakes, type Host, type RunPlace } from './host.ts';
import { codeOf, finishRecording, openRecorder, openSupervisor } from './record.ts';
import { packageCommitRecorder } from './record-store.ts';

/** What `--live` swaps for the scripted parts: host members (models, tools, decisions, the browser plane) and vision options. The demo supplies them from its
 *  own keys; a demo that supplies none refuses `--live`. */
export type LiveParts = { host?: Partial<Host>; vision?: RunOptions['vision'] };
export type DemoOptions = {
  /** `import.meta.url` of the demo's `run.ts`: the file the supervisor starts, with `--child`, as each process of the run. */
  self: string;
  /** Where the session lives and how its process starts, stops and restarts (the place seam). Default: the local place, a child process of this machine. A package supplies another (a box that moves the session). */
  place?: (context: { paths: RunPlace; self: string; destroyBoxes: () => void | Promise<void>; requestFile: (attempt: number) => string }) => Place | Promise<Place>;
  spec: DemoSpec;
  job: Job;
  fakes: Fakes;
  live?: (context: { env: NodeJS.ProcessEnv; browser: 'fake' | 'browserbase' | 'chrome' }) => LiveParts | Promise<LiveParts>;
  /** The arguments to read (default `process.argv.slice(2)`). */
  argv?: string[];
  /** The root of the repository, for the recording's `code` (default: two directories above the entry). */
  root?: string;
};

export type DemoResult = {
  /** How each process ended: its exit or signal, and the outcome it printed. */
  processes: Exit[];
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
  /** Kills the place could not make: the attempt ended, and the run did not go on. Each has the place's error code. */
  failedKills: Array<{ gen: number; code: string }>;
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
  if (options.argv === undefined && (result.overBudget || result.failedKills.length || result.processes.at(-1)?.outcome?.status !== 'complete')) process.exitCode = 1;
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
async function boxProvider(spec: DemoSpec, place: { root: string }) {
  if (!spec.boxes) return undefined;
  return spec.boxes.kind === 'local' ? (await import('@parcha/pi-transport/box/local')).localBoxes({ root: join(place.root, 'boxes') }) : (await import('@parcha/pi-transport/box/docker')).dockerBoxes(spec.boxes.image ? { image: spec.boxes.image } : undefined);
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
  const cross = crossings(plan, env.CROSS_LOG, Date.now(), env.KILL_REQUEST ? askToBeKilled(env.KILL_REQUEST) : undefined, window);
  const recorder = env.RECORD_DIR ? openRecorder({ dir: env.RECORD_DIR, commits: await packageCommitRecorder() }) : undefined;
  const live = env.LIVE === '1';
  const browserKind = (env.BROWSER ?? 'fake') as 'fake' | 'browserbase' | 'chrome';
  let box: Awaited<ReturnType<typeof inBox>> | undefined;
  try {
    const parts = live ? await options.live!({ env, browser: browserKind }) : {};
    const provider = await boxProvider(options.spec, place);
    const boxes = provider ? tapBox(provider, { cross, window, ...(env.RUN_LABEL ? { runLabel: env.RUN_LABEL } : {}), ...(recorder ? { recorder } : {}) }) : undefined;
    const local = localHost(place, live ? options.fakes : tapFakes(options.fakes, cross), { browser: fakeBrowser(env.BACKEND!), ...(recorder ? { recorder } : {}), ...(boxes ? { boxes } : {}) });
    // The live parts are merged into the host member by member FIRST, then the platform wraps the final host: the crossings (so a live `status` or `tools` still has them) and the judge seam's
    // caps (Jev's), which a live judge is held to too.
    composeHost(local.host, parts.host, cross, window, join(place.root, 'judge-spent.jsonl'));
    if (boxes && options.spec.boxes?.runIn) box = await inBox(boxes, options.spec.boxes.kind, place, options.job.files ?? {});
    const input = env.INPUT ? (JSON.parse(env.INPUT) as Record<string, unknown>) : options.job.input;
    const result = await run(place, local.host, { ...options.job, input }, { ...(box ? { env: box.env } : {}), ...(options.spec.sites ? { sites: options.spec.sites } : {}), ...(parts.vision ? { vision: parts.vision } : {}) });
    await recorder?.detach();
    const storeFile = join(place.store, 'run.sqlite');
    const storeSha256 = existsSync(storeFile) ? createHash('sha256').update(readFileSync(storeFile)).digest('hex') : undefined;
    console.log(JSON.stringify({ outcome: { status: result.status, generation: result.generation, ...(result.status === 'refused' ? { code: result.code, message: result.message.slice(0, 240) } : {}), ...(result.status === 'complete' ? { record: result.output } : {}), ...(storeSha256 ? { storeSha256 } : {}) } }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: { status: 'error', generation: null, code: (error as { code?: string }).code ?? null, message: String((error as Error).message).slice(0, 400) } }));
  } finally {
    await box?.destroy();
  }
}

// ---- the supervisor ---------------------------------------------------------------------------------------------------------------------------

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
export async function destroyBoxes(spec: DemoSpec, runLabel: string, root: string): Promise<void> {
  const provider = await boxProvider(spec, { root });
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
  const failedKills: DemoResult['failedKills'] = [];
  let overBudget = false;
  // Where the session lives, as paths in the place: computed, not made. The supervisor touches nothing under them; the place makes them.
  const paths = pathsAt(dir);
  const requestFile = (attempt: number) => join(scratch, `kill-${attempt}.json`);
  const place = options.place ? await options.place({ paths, self: options.self, destroyBoxes: () => destroyBoxes(spec, runLabel, paths.root), requestFile }) : localPlace({ self: options.self, paths, requestFile, ...(spec.boxes ? { destroyBoxes: () => destroyBoxes(spec, runLabel, paths.root) } : {}) });
  // Metering: the recording's lines as they stand, folded; past the cap the supervisor stops the run.
  const meterTimer = maxUsd === null ? undefined : setInterval(() => { if (meterKnown(recordDir) > maxUsd) overBudget = true; }, 250);
  try {
    const remaining = childPlansOf(plans);
    let runner: Runner | undefined;
    let previous: { runner: Runner; kind: 'process' | 'box' } | undefined;
    for (;;) {
      // Past the cap, no further process is started: the budget is checked before every restart.
      if (overBudget && processes.length > 0) break;
      const plan = remaining.shift() ?? { tools: [] };
      const gen = processes.length + 1;
      const log = join(scratch, `crossings-${gen}.jsonl`);
      const request = join(scratch, `kill-${gen}.json`);
      // A place that mints a token for each attempt (a claim's mount token) has it passed on the runner's standard input, never in argv or env.
      const token = place.token ? await place.token(gen) : undefined;
      const order = { gen, env: { ...base, CROSS_LOG: log, KILL_REQUEST: request, PLAN: JSON.stringify(plan) }, ...(token !== undefined ? { stdin: token } : {}) };
      if (previous && !place.kills.includes(previous.kind)) throw new Error(`the ${place.name} place cannot lose its ${previous.kind}: this kill is not one it can make`);
      runner = previous ? (await place.recover(previous.runner, previous.kind, order)).runner : await place.start(order);
      supervisor.host('process.started', { gen, pid: runner.pid });
      // The supervisor decides when: a crossing asks to be killed (read through the place's signals), or the spend cap is passed. It writes the kill line, and only then does the place kill.
      // A kill the place cannot make is recorded and ends the attempt: it is never an unhandled rejection.
      let killed: { point: string | null; n: number | null; label: string | null; why: string; kind: 'process' | 'box' } | undefined;
      let killFailed = false;
      const decide = async (asked: { point: string; n: number } | undefined) => {
        if (killed) return;
        const kind = plan.run?.kind ?? 'process';
        killed = asked
          ? { point: asked.point, n: asked.n, label: plan.run && !('storm' in plan.run) ? plan.run.point : asked.point, why: plan.run?.why ?? 'a kill', kind }
          : { point: null, n: null, label: 'max-usd', why: `past --max-usd ${maxUsd}`, kind: 'process' };
        supervisor.host('kill', { gen, label: killed.label, crossing: killed.point === null ? null : { point: killed.point, n: killed.n }, side: 'child', kind: killed.kind });
        kills.push({ gen, point: killed.point, kind: killed.kind, why: killed.why });
        try { await place.kill(runner!, killed.kind); } catch (error) {
          const code = String((error as { code?: unknown } | null)?.code ?? 'KILL_FAILED');
          killFailed = true;
          failedKills.push({ gen, code });
          supervisor.host('kill.failed', { gen, code, message: String((error as Error | null)?.message ?? error).slice(0, 240), kind: killed.kind });
        }
      };
      const iterator = place.signals?.(gen)[Symbol.asyncIterator]();
      const pump = (async () => {
        if (!iterator) return;
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) if (next.value.kind === 'kill-request') await decide(next.value.crossing);
      })();
      const watch = setInterval(() => { if (!killed && overBudget) void decide(undefined); }, 20);
      const result = await runner.exited;
      clearInterval(watch);
      await iterator?.return?.();
      await pump;
      processes.push(result);
      if (killFailed || (killed && killed.label === 'max-usd')) break;
      if (killed) { previous = { runner, kind: killed.kind }; continue; }
      // A process that died by SIGKILL on its own (a crash, or a kill with no supervisor) is a kill at the last crossing it logged.
      if (result.signal === 'SIGKILL') {
        const at = rows<Crossing>(log).filter((crossing) => crossing.n > 0).at(-1);
        const kind = plan.run?.kind ?? 'process';
        supervisor.host('kill', { gen, label: plan.run && !('storm' in plan.run) ? plan.run.point : at?.point ?? null, crossing: at ? { point: at.point, n: at.n } : null, side: 'child', kind });
        kills.push({ gen, point: at?.point ?? null, kind, why: plan.run?.why ?? 'a kill' });
        previous = { runner, kind };
        continue;
      }
      break;
    }
    // What the run delivered and its store's hash come from the last runner's own report: nothing is read under the run's directory.
    const last = processes.at(-1)?.outcome;
    const delivered = last && last.status === 'complete' && 'record' in last ? { record: last.record } : null;
    if (maxUsd !== null && meterKnown(recordDir) > maxUsd) overBudget = true;
    const processesStarted = processes.length;
    const blob = delivered ? openRecorder({ dir: recordDir }).blob(JSON.stringify({ record: delivered.record }, null, 2), 'json') : undefined;
    if (blob) supervisor.host('result', { gen: processesStarted, blob, title: 'The record' }, { blobs: [blob] });
    const resultBlob = blob ? { blob, title: 'The record' } : undefined;
    finishRecording(recordDir, {
      title: spec.title ?? spec.name, task: job.workflow.name ?? spec.name, model: live ? 'live' : 'faux/faux-1', generations: processesStarted, kills: kills.length,
      code: codeOf(options.root ?? ROOT), cost, source: { run: 'reference', ...(last?.storeSha256 ? { store_sha256: last.storeSha256 } : {}) }, ...(resultBlob ? { result: resultBlob } : {}), ...(live ? { providers: 'real' as const } : {}),
    });
    const usd = cost(readEventsOf(recordDir)).usd;
    return { processes, kills, record: delivered?.record ?? null, dir, ...(values.record ? { recording: values.record } : {}), usd, maxUsd, overBudget, failedKills };
  } finally {
    if (meterTimer) clearInterval(meterTimer);
    await place.release();
    await served.close();
    if (!values.record && !values.dir) await rm(scratch, { recursive: true, force: true });
  }
}

const readEventsOf = (dir: string) => rows<Record<string, unknown>>(join(dir, 'events.jsonl'));

function summarize(options: DemoOptions, result: DemoResult) {
  console.log(`${options.spec.title ?? options.spec.name}: ${result.processes.at(-1)?.outcome?.status ?? 'no outcome'} in ${result.processes.length} process${result.processes.length === 1 ? '' : 'es'}, ${result.kills.length} kill${result.kills.length === 1 ? '' : 's'}`);
  for (const kill of result.kills) console.log(`  killed process ${kill.gen} (${kill.kind}) at ${kill.point ?? 'no named crossing'}: ${kill.why}`);
  if (result.failedKills.length) console.log(`kills the place could not make: ${result.failedKills.map((kill) => `process ${kill.gen} (${kill.code})`).join(', ')}`);
  console.log(`cost: ${result.usd === null ? 'unknown' : `$${result.usd}`}${result.maxUsd === null ? '' : ` (cap $${result.maxUsd})`}${result.overBudget ? ' — over the cap' : ''}`);
  if (result.recording) console.log(`recording: ${result.recording}`);
}
