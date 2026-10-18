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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { FakeBackend, remoteDriver, remoteProvider } from '@parcha/pi-browser/testing';
import type { Harness } from '@earendil-works/pi-durable';
import type { BoxProvider } from '@parcha/pi-transport';
import type { VisionAdapterOptions } from '@parcha/pi-vision/durable';
import { pathsAt, placeAt, run, type Job, type RunOptions } from './assemble.ts';
import { RUN_LABEL, tapBox } from './boxes.ts';
import { capJudge } from './judge.ts';
import { askToBeKilled, aroundOwnFiling, crossings, tapFakes, tapHost, type Cross, type Crossing, type EffectWindow } from './crossings.ts';
import { keepLooks, shownShots } from './looks.ts';
import type { LookRecord } from '@parcha/pi-vision';
import { localPlace, type Exit, type Place, type Runner } from './place.ts';
import { inputOf, declaredEnv, childPlansOf, chooseBrowser, effectiveBoxes, killsOf, maxUsdOf, plansOf, type ChildPlan, type DemoSpec } from './demo-spec.ts';
import { cost } from './fold.ts';
import { checkItems, fetchSources, missingCommitted, readSources, withSources } from './sources.ts';
import { localHost, type BrowserPlane, type Fakes, type Host, type RunPlace } from './host.ts';
import { codeOf, finishRecording, openRecorder, openSupervisor } from './record.ts';
import { packageCommitRecorder } from './record-store.ts';

/** What `--live` swaps for the scripted parts: host members (models, tools, decisions, the browser plane) and vision options. The demo supplies them from its
 *  own keys; a demo that supplies none refuses `--live`. */
export type LiveParts = { host?: Partial<Host>; /** The live vision options, built from the host and the running run exactly as `fakes.vision` is: one seam for both. */ vision?: (host: Host, running: { readonly harness: Harness | undefined }) => Partial<VisionAdapterOptions> };
/** The model choices on the command line, handed to the demo's `live` part. */
export type LiveModels = { provider?: string; model?: string; eyesModel?: string };
const RESERVED = new Set(['format', 'title', 'task', 'model', 'generations', 'kills', 'code', 'cost', 'recorded', 'source', 'result', 'providers', 'see_also', 'job', 'store', 'baseline']);
export type DemoOptions = {
  /** `import.meta.url` of the demo's `run.ts`: the file the supervisor starts, with `--child`, as each process of the run. */
  self: string;
  /** Where the session lives and how its process starts, stops and restarts (the place seam). Default: the local place, a child process of this machine. A package supplies another (a box that moves the session). */
  place?: (context: { paths: RunPlace; self: string; destroyBoxes: () => void | Promise<void>; requestFile: (attempt: number) => string }) => Place | Promise<Place>;
  spec: DemoSpec;
  job: Job;
  fakes: Fakes;
  live?: (context: { env: NodeJS.ProcessEnv; browser: 'fake' | 'browserbase' | 'chrome'; /** What `--provider`, `--model` and `--eyes-model` named (each absent when not given): the demo's sign-in plan decides what they mean. */ models: LiveModels }) => LiveParts | Promise<LiveParts>;
  /** Fields the demo adds to the manifest, from the run it just finished (never a field the entry writes: `format`, `source`, `result`, `providers`, ...). It runs in the supervisor, once, after the last process. */
  manifest?: (context: { dir: string; record: unknown; input: Record<string, unknown> | undefined; live: boolean }) => Record<string, unknown>;
  /** The run's result, as the recording shows it: the entry writes the result line and its blob from `json` (`agentrun.cited/1` for a payoff that cites what it read) instead of the raw delivered record. `keep` stores a file in the recording's blobs and returns its SHA-256; `dir` is the run's directory, where the run's own files are. It runs in the process that delivered. */
  result?: (record: unknown, context: { dir: string; keep(bytes: Uint8Array | string, extension: string): string }) => { json: unknown; title: string } | Promise<{ json: unknown; title: string }>;
  /** The source items an input needs (`{ id, url, bytes, sha256 }`): only these are fetched, on --live or --fetch-sources; without either, a run that lacks one of their files (not in `job.files`) is refused in one line. */
  sourcesFor?: (input: Record<string, unknown>) => Array<{ id: string; url: string; bytes: number; sha256: string }>;
  /** The data set's item a look belongs to, from the record's path (Apollo 11: the page, photo or film window). Kept with the look. */
  itemOf?: (path: string) => string | null;
  /** The arguments to read (default `process.argv.slice(2)`). */
  argv?: string[];
  /** The root of the repository, for the recording's `code` (default: two directories above the entry). */
  root?: string;
  /** The recovery driver's layout for the run (`v4`: the keyed one); the driver's default when absent. A host's choice, so it is not the job's. */
  layout?: 'v3' | 'v4';
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
  /** The points of planned kills that never landed: the process finished without taking the crossing. A demo whose kill does not land is broken. */
  unlanded: string[];
};

const FLAGS = { child: { type: 'boolean' }, live: { type: 'boolean' }, kill: { type: 'boolean' }, record: { type: 'string' }, input: { type: 'string' }, 'max-usd': { type: 'string' }, 'local-chrome': { type: 'boolean' }, 'fetch-sources': { type: 'boolean' }, cache: { type: 'string' }, dir: { type: 'string' }, json: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' }, 'eyes-model': { type: 'string' }, 'see-also': { type: 'string', multiple: true } } as const;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export async function demo(options: DemoOptions): Promise<DemoResult | undefined> {
  const { values } = parseArgs({ args: options.argv ?? process.argv.slice(2), options: FLAGS });
  if (values.child) { await child(options); return undefined; }
  const result = await supervise(options, values);
  if (values.json) console.log(JSON.stringify(result));
  else summarize(options, result);
  // A command line ends with a failing code when the run did not complete or went past its cap; a caller that passed its own arguments reads the result.
  if (options.argv === undefined && (result.overBudget || result.failedKills.length || result.unlanded.length || result.processes.at(-1)?.outcome?.status !== 'complete')) process.exitCode = 1;
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
  const cross = crossings(plan, env.CROSS_LOG, Date.now(), env.KILL_REQUEST ? askToBeKilled(env.KILL_REQUEST) : undefined, window);
  const recorder = env.RECORD_DIR ? openRecorder({ dir: env.RECORD_DIR, commits: await packageCommitRecorder() }) : undefined;
  const live = env.LIVE === '1';
  const browserKind = (env.BROWSER ?? 'fake') as 'fake' | 'browserbase' | 'chrome';
  let box: Awaited<ReturnType<typeof inBox>> | undefined;
  try {
    const parts = live ? await options.live!({ env, browser: browserKind, models: env.MODELS ? (JSON.parse(env.MODELS) as LiveModels) : {} }) : {};
    // Docker only with --live: a no-key run uses a local box, so it starts no container.
    const boxSpec = effectiveBoxes(options.spec, live);
    const provider = await boxProvider(boxSpec, place);
    const boxes = provider ? tapBox(provider, { cross, window, ...(env.RUN_LABEL ? { runLabel: env.RUN_LABEL } : {}), ...(recorder ? { recorder } : {}) }) : undefined;
    const local = localHost(place, live ? options.fakes : tapFakes(options.fakes, cross), { browser: fakeBrowser(env.BACKEND!), live, ...(recorder ? { recorder } : {}), ...(boxes ? { boxes } : {}) });
    // The live parts are merged into the host member by member FIRST, then the platform wraps the final host: the crossings (so a live `status` or `tools` still has them) and the judge seam's
    // caps (Jev's), which a live judge is held to too.
    composeHost(local.host, parts.host, cross, window, join(place.root, 'judge-spent.jsonl'));
    // The checked files the job reads, fetched into work/ and verified: on --live and with --fetch-sources (a no-key run uses the files the demo commits). `sourcesFor(input)` names only the items this input needs;
    // else the demo's sources.json lists them all. A fetched file is cached by its hash (`--cache`), so a re-run does not fetch it again.
    const input = env.INPUT ? (JSON.parse(env.INPUT) as Record<string, unknown>) : options.job.input;
    let boxFiles = options.job.files;
    if (options.sourcesFor || options.spec.sources) {
      const items = options.sourcesFor ? checkItems(options.sourcesFor(input), 'sourcesFor') : readSources(sourcesPath(options)).items;
      if (live || env.FETCH_SOURCES === '1') {
        await mkdir(place.work, { recursive: true });
        const got = await fetchSources({ items }, place.work, fetch, 60_000, env.CACHE_DIR);
        // A Docker box shares nothing with work/: the verified files go in with the job's own.
        if (boxes && boxSpec?.kind === 'docker' && boxSpec.runIn) boxFiles = withSources(options.job.files, place.work, [...got.fetched, ...got.kept, ...got.cached]);
      } else if (options.sourcesFor) {
        const missing = missingCommitted(items, options.job.files, place.work);
        if (missing.length) throw new Error(`this input needs ${missing.length} source file(s) a no-key run does not have (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', ...' : ''}): run with --fetch-sources, or --live`);
      }
    }
    if (boxes && boxSpec?.runIn) box = await inBox(boxes, boxSpec.kind, place, boxFiles ?? {});
    // The vision option: every look is kept in a `vision.looks` document with the screenshot it was of, and the demo passes only its eyes.
    const shown = shownShots({ ...(recorder ? { keep: (bytes: Buffer, extension: string) => recorder.blob(bytes, extension) } : {}), ...(recorder ? { onShown: (read) => recorder.live('vision', 'shown', read) } : {}) });
    // Each record filed, by its receipt path: a look that failed is told only the receipt.
    const filedRecords = new Map<string, LookRecord>();
    const filing = local.host.evidence.file;
    local.host.evidence = { file: async (label, record) => { const at = await filing(label, record); if (at && 'facts' in record) filedRecords.set(at.path, record as LookRecord); return at; } };
    local.host.tools = { ...local.host.tools, extensions: [...local.host.tools.extensions, shown.extension] };
    // The vision lane, one seam: the entry keeps every look it is told of (`keepLooks`: each with the screenshot it was of, its item and the filing crossing); the demo's own lane (`fakes.vision` on fakes, the live parts' on --live)
    // adds to it, and may bring its own eyes and limits. A demo's `onLook` and `onMiss` run after the entry's and are never replaced by them.
    const vision: RunOptions['vision'] = (running) => {
      const own: Partial<VisionAdapterOptions> = (live ? parts.vision?.(local.host, running) : options.fakes.vision?.(local.host, running)) ?? {};
      const kept = keepLooks(() => running.harness, { shown, cites: join(place.root, 'cites.jsonl'), filed: filedRecords, ...(options.itemOf ? { itemOf: options.itemOf } : {}) });
      return {
        ...own,
        onLook: (look) => aroundOwnFiling(cross, look, async () => { await kept.onLook?.(look); await own.onLook?.(look); }),
        onMiss: async (miss) => { await kept.onMiss?.(miss); await own.onMiss?.(miss); },
      };
    };
    const result = await run(place, local.host, { ...options.job, input }, { ...(box ? { env: box.env } : {}), vision, ...(options.layout ? { layout: options.layout } : {}) });
    // The demo's result hook: what the recording shows as the run's result, made where the run's own files are.
    const made = result.status === 'complete' && options.result ? await options.result(result.output, { dir: place.root, keep: (bytes, extension) => (recorder ? recorder.blob(bytes, extension) : createHash('sha256').update(bytes).digest('hex')) }) : undefined;
    await recorder?.detach();
    const storeFile = join(place.store, 'run.sqlite');
    const storeSha256 = existsSync(storeFile) ? createHash('sha256').update(readFileSync(storeFile)).digest('hex') : undefined;
    console.log(JSON.stringify({ outcome: { status: result.status, generation: result.generation, ...(result.status === 'refused' ? { code: result.code, message: result.message.slice(0, 240) } : {}), ...(result.status === 'complete' ? { record: result.output } : {}), ...(made ? { result: made } : {}), ...(storeSha256 ? { storeSha256 } : {}) } }));
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
  const models: LiveModels = { ...(values.provider ? { provider: values.provider } : {}), ...(values.model ? { model: values.model } : {}), ...(values['eyes-model'] ? { eyesModel: values['eyes-model'] } : {}) };
  if (!live && Object.keys(models).length) throw new Error('--provider, --model and --eyes-model choose real models: they need --live');
  if (models.provider && !models.model) throw new Error('--provider needs --model (the model to use on that provider)');
  const seeAlso = (values['see-also'] ?? []).map((path) => seeAlsoOf(path));
  const kindOf = (path: string) => { try { const stat = statSync(path); return stat.isFile() ? 'file' as const : stat.isDirectory() ? 'directory' as const : undefined; } catch { return undefined; } };
  const demoDir = dirname(fileURLToPath(options.self));
  const input = values.input === undefined ? undefined : inputOf(values.input, spec, { demo: basename(demoDir), root: options.root ?? ROOT, live, read: (path) => readFileSync(path, 'utf8'), kind: kindOf });
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
  const base: Record<string, string> = { RUN_LABEL: runLabel, HOME: scratch, TMPDIR: scratch, DIR: dir, RECORD_DIR: recordDir, BACKEND: served.url, BROWSER: browser, ...(live ? { LIVE: '1' } : {}), ...(Object.keys(models).length ? { MODELS: JSON.stringify(models) } : {}), ...(values['fetch-sources'] ? { FETCH_SOURCES: '1' } : {}), CACHE_DIR: values.cache ?? join(tmpdir(), 'agentrun-sources'), ...(input ? { INPUT: JSON.stringify(input) } : {}) };
  // A live child gets exactly the environment names the demo declares in demo.json (every key, the members of a `oneOf` group included, and the programs' env), plus the process basics above; nothing undeclared reaches it.
  // A no-key run passes the demo's own `DEMO_*` settings (no secret) so a test can steer it.
  const declared = declaredEnv(spec);
  for (const name of Object.keys(process.env)) if ((live && declared.has(name)) || (!live && name.startsWith('DEMO_'))) base[name] = process.env[name]!;
  const processes: DemoResult['processes'] = [];
  const kills: DemoResult['kills'] = [];
  const failedKills: DemoResult['failedKills'] = [];
  const unlanded: string[] = [];
  let overBudget = false;
  // Where the session lives, as paths in the place: computed, not made. The supervisor touches nothing under them; the place makes them.
  const paths = pathsAt(dir);
  const requestFile = (attempt: number) => join(scratch, `kill-${attempt}.json`);
  let place!: Place;
  // Metering: the recording's lines as they stand, folded; past the cap the supervisor stops the run.
  const meterTimer = maxUsd === null ? undefined : setInterval(() => { if (meterKnown(recordDir) > maxUsd) overBudget = true; }, 250);
  try {
    place = options.place ? await options.place({ paths, self: options.self, destroyBoxes: () => destroyBoxes(spec, runLabel, paths.root, live), requestFile }) : localPlace({ self: options.self, paths, requestFile, ...(spec.boxes ? { destroyBoxes: () => destroyBoxes(spec, runLabel, paths.root, live) } : {}) });
    const remaining = childPlansOf(plans);
    let runner: Runner | undefined;
    let previous: { runner: Runner; kind: 'process' | 'box' } | undefined;
    for (;;) {
      // Past the cap, no further process is started: the budget is checked before every restart.
      if (overBudget && processes.length > 0) break;
      const plan = remaining.shift() ?? { tools: [] };
      // A kill this attempt plans that the place cannot make is refused before the attempt starts: the run is not stopped first, and no machine loss is recorded.
      const planned = plan.run?.kind;
      if (planned && !place.kills.includes(planned)) throw new Error(`the ${place.name} place cannot lose its ${planned}: this kill is not one it can make`);
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
      let decided = false;
      // A kill that fails ends the attempt at once: the supervisor does not wait for a process the place could not stop.
      let giveUp!: () => void;
      const gaveUp = new Promise<void>((resolve) => { giveUp = resolve; });
      const failed = (code: string, message: string, kind: 'process' | 'box') => {
        killFailed = true;
        failedKills.push({ gen, code });
        supervisor.host('kill.failed', { gen, code, message: message.slice(0, 240), kind });
        giveUp();
      };
      const decide = async (asked: { point: string; n: number } | undefined) => {
        if (decided) return;
        decided = true;
        const kind = asked ? (plan.run?.kind ?? 'process') : 'process';
        killed = asked
          ? { point: asked.point, n: asked.n, label: plan.run && !('storm' in plan.run) ? plan.run.point : asked.point, why: plan.run?.why ?? 'a kill', kind }
          : { point: null, n: null, label: 'max-usd', why: `past --max-usd ${maxUsd}`, kind: 'process' };
        supervisor.host('kill', { gen, label: killed.label, crossing: killed.point === null ? null : { point: killed.point, n: killed.n }, side: 'child', kind: killed.kind });
        kills.push({ gen, point: killed.point, kind: killed.kind, why: killed.why });
        try { await place.kill(runner!, killed.kind); } catch (error) { failed(String((error as { code?: unknown } | null)?.code ?? 'KILL_FAILED'), String((error as Error | null)?.message ?? error), killed.kind); }
      };
      const iterator = place.signals?.(gen)[Symbol.asyncIterator]();
      const pump = (async () => {
        if (!iterator) return;
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) if (next.value.kind === 'kill-request') await decide(next.value.crossing);
      })();
      // The budget's stop is kept: the attempt does not finish (nor the place release) until the kill, with its provider cleanup, is done.
      let deciding: Promise<void> = Promise.resolve();
      const watch = setInterval(() => { if (!decided && overBudget) deciding = decide(undefined); }, 20);
      const exit = await Promise.race([runner.exited, gaveUp.then(() => undefined)]);
      const result: Exit = exit ?? { exit: null, signal: null, stderr: 'the place could not stop this process' };
      clearInterval(watch);
      await iterator?.return?.();
      await pump;
      await deciding;
      processes.push(result);
      if (killFailed || (killed && killed.label === 'max-usd')) break;
      // A tool kill of an attempt that ended in a process kill and did not fire never will (the plan is consumed): it is reported, not carried off with the attempt.
      const missed = () => { for (const entry of notLanded(plan.tools, log)) unlanded.push('point' in entry ? entry.point : `storm (gap ${entry.gapMs} ms)`); };
      if (killed) { missed(); previous = { runner, kind: killed.kind }; continue; }
      // A process that died by SIGKILL on its own (a crash, or a kill with no supervisor) is a kill at the last crossing it logged.
      if (result.signal === 'SIGKILL') {
        const at = rows<Crossing>(log).filter((crossing) => crossing.n > 0).at(-1);
        const kind = plan.run?.kind ?? 'process';
        supervisor.host('kill', { gen, label: plan.run && !('storm' in plan.run) ? plan.run.point : at?.point ?? null, crossing: at ? { point: at.point, n: at.n } : null, side: 'child', kind });
        kills.push({ gen, point: at?.point ?? null, kind, why: plan.run?.why ?? 'a kill' });
        missed();
        previous = { runner, kind };
        continue;
      }
      // The process ended on its own with a kill still planned for it (and any that follow): none of them landed.
      for (const left of [plan, ...remaining]) {
        const tools = left === plan ? notLanded(left.tools, log) : left.tools;
        for (const entry of [...(left.run ? [left.run] : []), ...tools]) if ('point' in entry) unlanded.push(entry.point); else unlanded.push(`storm (gap ${entry.gapMs} ms)`);
      }
      break;
    }
    // What the run delivered and its store's hash come from the last runner's own report: nothing is read under the run's directory.
    const last = processes.at(-1)?.outcome;
    const delivered = last && last.status === 'complete' && 'record' in last ? { record: last.record } : null;
    if (maxUsd !== null && meterKnown(recordDir) > maxUsd) overBudget = true;
    const processesStarted = processes.length;
    // The demo's result hook, reported by the process that delivered, shapes the result line and its blob; without one, the delivered record is the result.
    const made = processes.at(-1)?.outcome?.result;
    const blob = made ? openRecorder({ dir: recordDir }).blob(JSON.stringify(made.json, null, 2), 'json') : delivered ? openRecorder({ dir: recordDir }).blob(JSON.stringify({ record: delivered.record }, null, 2), 'json') : undefined;
    const resultTitle = made?.title ?? 'The record';
    if (blob) supervisor.host('result', { gen: processesStarted, blob, title: resultTitle }, { blobs: [blob] });
    const resultBlob = blob ? { blob, title: resultTitle } : undefined;
    // `source.run` names the run: the demo, and the input file it ran on when one was given.
    const runName = values.input !== undefined && !values.input.trimStart().startsWith('{') ? `${spec.name}-${basename(values.input).replace(/\.[^.]*$/, '')}` : spec.name;
    const extra = options.manifest ? options.manifest({ dir, record: delivered?.record ?? null, input, live }) : undefined;
    for (const name of Object.keys(extra ?? {})) if (RESERVED.has(name)) throw new Error(`manifest(): "${name}" is written by the entry; use another name`);
    finishRecording(recordDir, {
      title: spec.title ?? spec.name, task: job.workflow.name ?? spec.name, model: live ? 'live' : 'faux/faux-1', generations: processesStarted, kills: kills.length,
      code: codeOf(options.root ?? ROOT), cost, source: { run: runName, ...(last?.storeSha256 ? { store_sha256: last.storeSha256 } : {}) }, ...(seeAlso.length ? { see_also: seeAlso } : {}), ...(extra ? { extra } : {}), ...(resultBlob ? { result: resultBlob } : {}), ...(live ? { providers: 'real' as const } : {}),
    });
    const usd = cost(readEventsOf(recordDir)).usd;
    return { processes, kills, record: delivered?.record ?? null, dir, ...(values.record ? { recording: values.record } : {}), usd, maxUsd, overBudget, failedKills, unlanded };
  } finally {
    if (meterTimer) clearInterval(meterTimer);
    // The backend and the scratch are closed whatever the place did: a place that failed to be made, or to be released, leaves neither open.
    try { await place?.release(); } finally {
      await served.close();
      if (!values.record && !values.dir) await rm(scratch, { recursive: true, force: true });
    }
  }
}

/** The tool kills of an attempt that did not fire: those the child's log (`landed` rows) does not show. */
export function notLanded<T extends object>(tools: readonly T[], log: string): T[] {
  const landed = rows<Crossing>(log).filter((crossing) => crossing.landed).map((crossing) => crossing.point);
  return tools.filter((entry) => { const at = 'point' in entry ? landed.indexOf(String(entry.point)) : -1; if (at >= 0) landed.splice(at, 1); return at < 0; });
}

const readEventsOf = (dir: string) => rows<Record<string, unknown>>(join(dir, 'events.jsonl'));

function summarize(options: DemoOptions, result: DemoResult) {
  console.log(`${options.spec.title ?? options.spec.name}: ${result.processes.at(-1)?.outcome?.status ?? 'no outcome'} in ${result.processes.length} process${result.processes.length === 1 ? '' : 'es'}, ${result.kills.length} kill${result.kills.length === 1 ? '' : 's'}`);
  for (const kill of result.kills) console.log(`  killed process ${kill.gen} (${kill.kind}) at ${kill.point ?? 'no named crossing'}: ${kill.why}`);
  if (result.failedKills.length) console.log(`kills the place could not make: ${result.failedKills.map((kill) => `process ${kill.gen} (${kill.code})`).join(', ')}`);
  if (result.unlanded.length) console.log(`kills that never landed: ${result.unlanded.join(', ')}`);
  console.log(`cost: ${result.usd === null ? 'unknown' : `$${result.usd}`}${result.maxUsd === null ? '' : ` (cap $${result.maxUsd})`}${result.overBudget ? ' — over the cap' : ''}`);
  if (result.recording) console.log(`recording: ${result.recording}`);
}

/** The demo's `sources.json`: `true` is the one beside `run.ts`; a path is relative to the demo's directory, or to the repository when it starts with `examples/` (as demo.json's schema writes it). */
function sourcesPath(options: DemoOptions): string {
  const named = typeof options.spec.sources === 'string' ? options.spec.sources : 'sources.json';
  return named.startsWith('examples/') ? resolve(options.root ?? ROOT, named) : resolve(dirname(fileURLToPath(options.self)), named);
}

/** A `--see-also` recording, linked by its directory's name and labeled by its manifest's title: the recording must be a finished one. */
function seeAlsoOf(path: string): { recording: string; label: string } {
  const unfinished = () => new Error(`--see-also ${basename(path)}: not a finished recording (it needs a manifest.json with its format and end time, and an events.jsonl)`);
  let manifest: { title?: unknown; format?: unknown; recorded?: { ended?: unknown } } | undefined;
  try { manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')); } catch { throw new Error(`--see-also ${basename(path)}: not a finished recording (no manifest.json)`); }
  // The example stands alone (no validator): a finished recording names its format and its end, and holds its lines.
  if (!manifest || typeof manifest.format !== 'string' || typeof manifest.recorded?.ended !== 'string' || !existsSync(join(path, 'events.jsonl'))) throw unfinished();
  return { recording: basename(path), label: typeof manifest.title === 'string' ? manifest.title : basename(path) };
}
