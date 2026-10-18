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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import type { CodeModeOptions } from './code-mode.ts';
import { pathsAt, placeAt, run, type Job, type RunOptions } from './assemble.ts';
import { RUN_LABEL, tapBox } from './boxes.ts';
import type { Recorder, Redact } from './record.ts';
import { capJudge, JEV_CAPS } from './judge.ts';
import { askToBeKilled, aroundOwnFiling, crossings, tapFakes, tapHost, tapLive, type Cross, type Crossing, type EffectWindow } from './crossings.ts';
import { keepLooks, shownShots } from './looks.ts';
import { transcriberFromEnv } from './transcriber.ts';
import type { LookRecord } from '@parcha/pi-vision';
import { localPlace, type Exit, type Place, type Runner } from './place.ts';
import { checkModelKeys, judgeCapsOf, inputOf, declaredEnv, childPlansOf, chooseBrowser, effectiveBoxes, killsOf, maxUsdOf, plansOf, type ChildPlan, type DemoSpec } from './demo-spec.ts';
import { cost } from './fold.ts';
import { checkItems, fetchSources, missingCommitted, readSources, withSources } from './sources.ts';
import { localHost, type BrowserPlane, type Fakes, type Host, type RunPlace } from './host.ts';
import { codeOf, finishRecording, followRecording, keepBlob, lazyRecorder, openRecorder, openSupervisor } from './record.ts';
import { packageCommitRecorder } from './record-store.ts';
import { scanPlaced, scanRecording, signInFile, trackSecrets } from './secrets.ts';

/** What `--live` swaps for the scripted parts: host members (models, tools, decisions, the browser plane) and vision options. The demo supplies them from its
 *  own keys; a demo that supplies none refuses `--live`. */
export type LiveParts = { host?: Partial<Host>; /** The live tools, the same name -> function map as `Fakes.tools`: on `--live` the effect door (evidence, receipts, kill crossings) dispatches to these. A tool missing here runs from `fakes.tools` only when demo.json's `tools` entry for it says `local: "fakes"`, else the call fails `no live source for <tool>`. Without `tools`, every tool runs from `fakes.tools` as before. */ tools?: Fakes['tools']; /** Which models the live parts chose (flags, defaults, the sign-in's plan): reported with the run's outcome, and handed to `manifest` as `models`. */ models?: Record<string, string>; /** The live vision options, built from the host and the running run exactly as `fakes.vision` is: one seam for both. */ vision?: (host: Host, running: { readonly harness: Harness | undefined }, context: { input: Record<string, unknown>; place: { root: string; work: string } }) => Partial<VisionAdapterOptions> };
/** The model choices on the command line, handed to the demo's `live` part. */
export type LiveModels = { provider?: string; model?: string; eyesModel?: string };
const RESERVED = new Set(['format', 'title', 'task', 'model', 'generations', 'kills', 'code', 'cost', 'recorded', 'source', 'result', 'providers', 'see_also', 'job', 'store', 'baseline']);
export type DemoOptions = {
  /** How long the live recorder holds a line before placing it in `events.jsonl` (default 1000 ms, the time every writer has to get it to a spool). A test knob; a place whose clock is far from the host's wants it longer. */
  followHoldMs?: number;
  /** Code mode, opt-in (off by default; `codeMode` in demo.json is the same switch): the agent gets a `code` tool whose sandbox has `tools.bash` (in `work/`) and the vision handle's `vision.see`. See code-mode.ts for what it can and cannot reach. */
  codeMode?: boolean | CodeModeOptions;
  /** `import.meta.url` of the demo's `run.ts`: the file the supervisor starts, with `--child`, as each process of the run. */
  self: string;
  /** Where the session lives and how its process starts, stops and restarts (the place seam). Default: the local place, a child process of this machine. A package supplies another (a box that moves the session). */
  place?: (context: { paths: RunPlace; self: string; destroyBoxes: () => void | Promise<void>; requestFile: (attempt: number) => string }) => Place | Promise<Place>;
  spec: DemoSpec;
  job: Job;
  fakes: Fakes;
  live?: (context: { env: NodeJS.ProcessEnv; browser: 'fake' | 'browserbase' | 'chrome' | 'none'; /** What `--provider`, `--model` and `--eyes-model` named (each absent when not given): the demo's sign-in plan decides what they mean. */ models: LiveModels }) => LiveParts | Promise<LiveParts>;
  /** Fields the demo adds to the manifest, from the run it just finished (never a field the entry writes: `format`, `source`, `result`, `providers`, ...). It runs in the supervisor, once, after the last process. */
  manifest?: (context: { dir: string; record: unknown; input: Record<string, unknown> | undefined; live: boolean; /** What the live parts reported choosing (`LiveParts.models`); absent on fakes. */ models?: Record<string, string> }) => Record<string, unknown>;
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
  /** Keep the run's directory when neither `--dir` nor `--record` is given, and say where it is (`run directory: <path>`): a demo whose result is files there (the hero's `out/snapshot.html`) needs them to outlive the command. */
  keepRun?: boolean;
};

export type DemoResult = {
  /** How each process ended: its exit or signal, and the outcome it printed. */
  processes: Exit[];
  /** The run id this invocation used, minted once: `<demo name>-<8 hex>`. */
  runId: string;
  kills: Array<{ gen: number; point: string | null; kind: 'process' | 'box'; why: string; /** For a kill at a crossing: the ordinal of that crossing it landed on, and the `n` the demo planned. The kill lands at the first eligible crossing at or after the nth, so they can differ. */ n?: number; planned?: number }>;
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
  /** Attempts whose place ended its signals with `signals-failed` (or whose reader threw): the attempt ended as after a failed kill. */
  failedSignals: Array<{ gen: number; code: string }>;
  /** The points of planned kills that never landed: the process finished without taking the crossing. A demo whose kill does not land is broken. */
  unlanded: string[];
};

const FLAGS = { child: { type: 'boolean' }, live: { type: 'boolean' }, kill: { type: 'boolean' }, record: { type: 'string' }, input: { type: 'string' }, 'max-usd': { type: 'string' }, 'local-chrome': { type: 'boolean' }, 'fetch-sources': { type: 'boolean' }, cache: { type: 'string' }, dir: { type: 'string' }, json: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' }, 'eyes-model': { type: 'string' }, 'see-also': { type: 'string', multiple: true }, 'operator-kill': { type: 'string' } } as const;
/** The repository a demo lives in: `options.root`, else the nearest folder above the demo's own file that holds a
 *  `package.json` or a `.git`. Never this package's own location, which is inside `node_modules` once installed. */
function rootOf(options: { root?: string; self: string }): string {
  if (options.root) return options.root;
  const start = dirname(fileURLToPath(options.self));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

/** Set while `pi-durable-disk run --app` imports a demo's module for its `options`: the module's own top-level `demo(options)` then does nothing, so it is safe to import. */
export const IMPORTING_DEMO = Symbol.for('agentrun.reference.importing-demo');

export async function demo(options: DemoOptions): Promise<DemoResult | undefined> {
  if ((globalThis as Record<symbol, unknown>)[IMPORTING_DEMO]) return undefined;
  const { values } = parseArgs({ args: options.argv ?? process.argv.slice(2), options: FLAGS });
  if (values.child) { await child(options); return undefined; }
  const result = await supervise(options, values);
  if (values.json) console.log(JSON.stringify(result));
  else summarize(options, result);
  // A command line ends with a failing code when the run did not complete or went past its cap; a caller that passed its own arguments reads the result.
  if (options.argv === undefined && (result.overBudget || result.failedKills.length || result.failedSignals.length || result.unlanded.length || result.processes.at(-1)?.outcome?.status !== 'complete')) process.exitCode = 1;
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

/** The browser of a demo that has none (`browser: false`): any page call fails, saying so. */
function noBrowser(): BrowserPlane {
  const refuse = (): never => { throw new Error('this demo has no browser'); };
  return { provider: refuse, driver: async () => refuse() };
}

/** The host a run uses, in the order that keeps every platform check on the final host: the live parts merged in, then the crossings put at its seams, then the judge seam's caps. */
export function composeHost(host: Host, parts: Partial<Host> | undefined, cross: Cross, window: EffectWindow, spentFile: string, live = false, caps: { requests: number; tokens: number } = JEV_CAPS, fakesTapped = false): void {
  mergeParts(host, parts);
  // The fakes' judge and model have their crossings from `tapFakes`; a live host's get them here, so a kill at `judge.asked <label>` lands before a paid question. When the host's fallback judge and model are the fakes' and
  // are already tapped (`fakesTapped`), only the ones the live parts replaced are tapped here, so no crossing is counted twice.
  if (live) tapLive(host, cross, { judge: !fakesTapped || Boolean(parts?.decisions?.runJudge), model: !fakesTapped || Boolean(parts?.models) });
  tapHost(host, cross, window);
  host.decisions = { ...host.decisions, runJudge: capJudge(host.decisions.runJudge, spentFile, caps) };
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

/** pi-transport is an optional peer: a demo that declares `boxes` needs it installed, and says so in one line when it is not. */
async function transport<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && String((error as Error).message).includes("'@parcha/pi-transport")) {
      throw new Error('this demo declares boxes, which need @parcha/pi-transport; it is not on npm yet, so run this demo from a checkout of https://github.com/Parcha-ai/agentrun');
    }
    throw error;
  }
}

/** The demo's box provider: its `boxes` declaration, a directory of this machine (`local`) or Docker. */
async function boxProvider(boxes: ReturnType<typeof effectiveBoxes>, place: { root: string }) {
  if (!boxes) return undefined;
  return boxes.kind === 'local' ? (await transport(() => import('@parcha/pi-transport/box/local'))).localBoxes({ root: join(place.root, 'boxes') }) : (await transport(() => import('@parcha/pi-transport/box/docker'))).dockerBoxes(boxes.image ? { image: boxes.image } : undefined);
}

/** One box the job's own tools (the disk package's shell and files) run in: a directory of this machine whose workspace is the run's `work/`, or a container the
 *  job's files are uploaded to. It comes from the tapped provider, so its commands are crossings and its life is on the recording. */
async function inBox(provider: BoxProvider, kind: 'local' | 'docker', place: { id: string; work: string }, files: Record<string, Uint8Array>) {
  const { boxEnv } = await transport(() => import('@parcha/pi-transport/hands'));
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

/** What one process of the run is made of, before it opens the store: the place, the host (the demo's, the live parts merged, the crossings and the judge caps on it), the job with its input, and the run's options. `made` is the demo's result hook, run on the delivered result. */
export type Prepared = { models: Record<string, string> | undefined; place: RunPlace; host: Host; job: Job; runOptions: RunOptions; recorder: Recorder | undefined; /** Takes every secret the process has seen out of a text (the sign-in's earlier tokens too): what the process prints for the supervisor passes through it. Absent when the recording redacts nothing. */ redact: Redact | undefined; /** Starts what writes under the run's directory: the recorder, the fetched sources, the box. Awaited once the claim is open (before `beforeResume`); `child()` has no claim to wait for and calls it at once. */ open(): Promise<void>; made(result: Awaited<ReturnType<typeof run>>): Promise<{ json: unknown; title: string } | undefined>; done(): Promise<void> };

/** The outcome line a process reports on its way out: how the run ended, the record it delivered, what the demo's result hook made of it, and the hash of its store. */
export function outcomeOf(result: Awaited<ReturnType<typeof run>>, storeSha256: string | undefined, made?: { json: unknown; title: string }, models?: Record<string, string>) {
  return { status: result.status, generation: result.generation, ...(result.status === 'refused' ? { code: result.code, message: result.message.slice(0, 240) } : {}), ...(result.status === 'complete' ? { record: result.output } : {}), ...(made ? { result: made } : {}), ...(models ? { models } : {}), ...(storeSha256 ? { storeSha256 } : {}) };
}

export async function prepareChild(options: DemoOptions, env: NodeJS.ProcessEnv, at?: RunPlace, killNonce?: string): Promise<Prepared> {
  if (!at && !env.RUN_ID) throw new Error('a supervised process needs RUN_ID: the supervisor mints the run id once per invocation');
  const place = at ?? await placeAt(env.DIR, env.RUN_ID!);
  const plan = env.PLAN ? (JSON.parse(env.PLAN) as ChildPlan) : undefined;
  const window: EffectWindow = { open: 0 };
  const cross = crossings(plan, env.CROSS_LOG, Date.now(), env.KILL_REQUEST ? askToBeKilled(env.KILL_REQUEST, killNonce) : undefined, window);
  // A recording holds none of the secret values (the declared environment's, the sign-in's tokens, a refreshed token too): the supervisor hands this process the sign-in's home (`AGENTRUN_HOME`, the one name added beside
  // the declared ones, so a child that signs in uses the file the recorder reads), and this process reads the values itself.
  const redact = env.RECORD_DIR ? trackSecrets(env, options.spec).redact : undefined;
  const commits = env.RECORD_DIR ? await packageCommitRecorder() : undefined;
  const lazy = env.RECORD_DIR ? lazyRecorder(() => openRecorder({ dir: env.RECORD_DIR!, commits: commits!, ...(env.RECORD_GEN ? { gen: Number(env.RECORD_GEN) } : {}), ...(env.RECORD_STARTED ? { started: env.RECORD_STARTED } : {}), ...(redact ? { redact } : {}) })) : undefined;
  const recorder: Recorder | undefined = lazy;
  const live = env.LIVE === '1';
  const browserKind = (env.BROWSER ?? 'fake') as 'fake' | 'browserbase' | 'chrome' | 'none';
  let box: Awaited<ReturnType<typeof inBox>> | undefined;
  const parts = live ? await options.live!({ env, browser: browserKind, models: env.MODELS ? (JSON.parse(env.MODELS) as LiveModels) : {} }) : {};
  // Docker only with --live: a no-key run uses a local box, so it starts no container.
  const boxSpec = effectiveBoxes(options.spec, live);
  // `pi-durable-disk run --app` opens the run's tools on the claim's own environment and cannot take another: a job that must run in a box is refused there, not run outside it.
  if (at && boxSpec?.runIn) throw new Error('boxes.runIn is not supported under pi-durable-disk run --app: the app opens its tools on the claim\'s own environment, not in a box. Run the demo through its own command, or drop runIn.');
  const provider = await boxProvider(boxSpec, place);
  const boxes = provider ? (tapBox(provider, { cross, window, ...(env.RUN_LABEL ? { runLabel: env.RUN_LABEL } : {}), ...(recorder ? { recorder } : {}) }) as BoxProvider) : undefined;
  // Live tools get the same crossings the fakes' do (a kill before or after a dispatch); the ones a demo declares `local: "fakes"` fall back to the fakes' own, tapped the same way.
  const tapped = live && parts.tools ? tapFakes({ ...options.fakes, tools: parts.tools }, cross) : undefined;
  const fakesTapped = live && parts.tools ? tapFakes(options.fakes, cross) : undefined;
  const declaredFakes = new Set((options.spec.tools ?? []).filter((entry) => entry.local === 'fakes').map((entry) => entry.name));
  const local = localHost(place, live ? (fakesTapped ?? options.fakes) : tapFakes(options.fakes, cross), {
    ...(tapped ? { liveTools: tapped.tools, fakesDeclared: declaredFakes } : {}), browser: browserKind === 'none' ? noBrowser() : fakeBrowser(env.BACKEND!), live, deferLogs: true, ...(recorder ? { recorder } : {}), ...(boxes ? { boxes } : {}) });
  // The live parts are merged into the host member by member FIRST, then the platform wraps the final host: the crossings (so a live `status` or `tools` still has them) and the judge seam's
  // caps (Jev's), which a live judge is held to too.
  composeHost(local.host, parts.host, cross, window, join(place.root, 'judge-spent.jsonl'), live, judgeCapsOf(options.spec), fakesTapped !== undefined);
  // A demo with `browser: false` has none, whatever the live parts supplied.
  if (browserKind === 'none') local.host.tools = { ...local.host.tools, browser: noBrowser() };
  // The checked files the job reads, fetched into work/ and verified: on --live and with --fetch-sources (a no-key run uses the files the demo commits). `sourcesFor(input)` names only the items this input needs;
  // else the demo's sources.json lists them all. A fetched file is cached by its hash (`--cache`), so a re-run does not fetch it again.
  // The input: `--input`'s, else the demo's for this mode (`fakes.input` on fakes, which may be a smaller slice), else the job's own.
  const input = env.INPUT ? (JSON.parse(env.INPUT) as Record<string, unknown>) : (live ? undefined : options.fakes.input) ?? options.job.input;
  let boxFiles = options.job.files;
  const wanted = options.sourcesFor || options.spec.sources ? (options.sourcesFor ? checkItems(options.sourcesFor(input), 'sourcesFor') : readSources(sourcesPath(options)).items) : undefined;
  if (wanted && !(live || env.FETCH_SOURCES === '1') && options.sourcesFor) {
    const missing = missingCommitted(wanted, options.job.files, place.work);
    if (missing.length) throw new Error(`this input needs ${missing.length} source file(s) a no-key run does not have (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', ...' : ''}): run with --fetch-sources, or --live`);
  }
  // What writes under the run's directory waits for `open()`: the recorder, the fetched files, the box. Nothing before it touches the disk (on a disk the run has not mounted yet, a write would land on the bare mountpoint).
  const open = async () => {
    lazy?.start();
    local.touchLogs();
    // The checked files the job reads, fetched into work/ and verified: on --live and with --fetch-sources (a no-key run uses the files the demo commits). A fetched file is cached by its hash (`--cache`), so a re-run does not fetch it again.
    if (wanted && (live || env.FETCH_SOURCES === '1')) {
      await mkdir(place.work, { recursive: true });
      const got = await fetchSources({ items: wanted }, place.work, fetch, 60_000, env.CACHE_DIR);
      // A Docker box shares nothing with work/: the verified files go in with the job's own.
      if (boxes && boxSpec?.kind === 'docker' && boxSpec.runIn) boxFiles = withSources(options.job.files, place.work, [...got.fetched, ...got.kept, ...got.cached]);
    }
    if (boxes && boxSpec?.runIn) box = await inBox(boxes, boxSpec.kind, place, boxFiles ?? {});
  };
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
    const own: Partial<VisionAdapterOptions> = (live ? parts.vision?.(local.host, running, { input, place: { root: place.root, work: place.work } }) : options.fakes.vision?.(local.host, running, { input, place: { root: place.root, work: place.work } })) ?? {};
    const kept = keepLooks(() => running.harness, { shown, cites: join(place.root, 'cites.jsonl'), filed: filedRecords, ...(options.itemOf ? { itemOf: options.itemOf } : {}) });
    return {
      // The host's speech-to-text model for `vision.transcribe`: the demo's own (a scripted one on fakes), else the one its declared keys name; the key stays in the adapter.
      ...(own.transcriber || !live ? {} : (() => { const transcriber = transcriberFromEnv(env); return transcriber ? { transcriber } : {}; })()),
      ...own,
      onLook: (look) => aroundOwnFiling(cross, look, async () => { await kept.onLook?.(look); await own.onLook?.(look); }),
      onMiss: async (miss) => { await kept.onMiss?.(miss); await own.onMiss?.(miss); },
    };
  };
  const runOptions: RunOptions = { codeImages: shown.note, ...(boxes && boxSpec?.runIn ? { env: () => box!.env() } : {}), ...(options.spec.sites ? { sites: options.spec.sites } : {}), ...(options.codeMode ?? options.spec.codeMode ? { codeMode: options.codeMode ?? (options.spec.codeMode as CodeModeOptions | boolean) } : {}), vision, ...(options.layout ? { layout: options.layout } : {}) };
  const made = async (result: Awaited<ReturnType<typeof run>>) => (result.status === 'complete' && options.result ? options.result(result.output, { dir: place.root, keep: (bytes, extension) => (recorder ? recorder.blob(bytes, extension) : createHash('sha256').update(bytes).digest('hex')) }) : undefined);
  return { models: parts.models, place, host: local.host, job: { ...options.job, input }, runOptions, recorder, redact, open, made, done: async () => { await box?.destroy(); } };
}

const storeShaOf = (place: RunPlace) => {
  const storeFile = join(place.store, 'run.sqlite');
  return existsSync(storeFile) ? createHash('sha256').update(readFileSync(storeFile)).digest('hex') : undefined;
};

async function child(options: DemoOptions) {
  let prepared: Prepared | undefined;
  try {
    // The attempt's nonce, which the supervisor minted, is read once and removed from the environment before anything starts: pi's commands inherit this process's environment and never get it.
    const killNonce = process.env.KILL_NONCE;
    delete process.env.KILL_NONCE;
    prepared = await prepareChild(options, process.env, undefined, killNonce);
    await prepared.open();
    const result = await run(prepared.place, prepared.host, prepared.job, prepared.runOptions);
    const made = await prepared.made(result);
    await prepared.recorder?.detach();
    // What the process tells the supervisor passes through the process's own redaction: it has seen every token the sign-in held over the run, which the supervisor's own list may not.
    const line = JSON.stringify({ outcome: outcomeOf(result, storeShaOf(prepared.place), made, prepared.models) });
    console.log(prepared.redact ? prepared.redact(line) : line);
  } catch (error) {
    console.log(JSON.stringify({ outcome: { status: 'error', generation: null, code: (error as { code?: string }).code ?? null, message: String((error as Error).message).slice(0, 400) } }));
  } finally {
    await prepared?.done();
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
  const folded = cost(spoolLines(recordDir));
  // A box part with an unpriced box is null, but the boxes that are priced were spent all the same.
  return Object.values(folded.parts).reduce<number>((sum, part) => sum + (part ?? 0), 0) + (folded.parts.box === null ? folded.boxKnown : 0);
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
  // `browser: false` in demo.json: no browser is created, so no key or Chrome is asked for.
  const browser = spec.browser === false ? 'none' as const : chooseBrowser({ live, env: process.env, localChrome: values['local-chrome'] === true });
  // Refused at load, before any child starts: a model whose provider needs a key the demo does not declare, and a cap beyond its ceiling.
  checkModelKeys(spec);
  judgeCapsOf(spec);
  const plans = values.kill ? plansOf(killsOf(spec)) : [];
  const maxUsd = maxUsdOf(values['max-usd'], spec);
  // The operator's control file: a path the caller names (`--operator-kill`), which must not exist yet (a stale one would kill the first process).
  const operatorKill = values['operator-kill'] ? resolve(values['operator-kill']) : undefined;
  if (operatorKill && existsSync(operatorKill)) throw new Error(`--operator-kill ${operatorKill} already exists: it is the operator's control, made only to ask for a kill`);
  // What a recording must not hold, read before anything starts: a sign-in file that cannot be read fails the record here, not after a paid run.
  const tracked = values.record ? trackSecrets(process.env, spec) : undefined;
  const redact = tracked?.redact;
  const models: LiveModels = { ...(values.provider ? { provider: values.provider } : {}), ...(values.model ? { model: values.model } : {}), ...(values['eyes-model'] ? { eyesModel: values['eyes-model'] } : {}) };
  if (!live && Object.keys(models).length) throw new Error('--provider, --model and --eyes-model choose real models: they need --live');
  if (models.provider && !models.model) throw new Error('--provider needs --model (the model to use on that provider)');
  const seeAlso = (values['see-also'] ?? []).map((path) => seeAlsoOf(path));
  const kindOf = (path: string) => { try { const stat = statSync(path); return stat.isFile() ? 'file' as const : stat.isDirectory() ? 'directory' as const : undefined; } catch { return undefined; } };
  const demoDir = dirname(fileURLToPath(options.self));
  const input = values.input === undefined ? undefined : inputOf(values.input, spec, { demo: basename(demoDir), root: rootOf(options), live, read: (path) => readFileSync(path, 'utf8'), kind: kindOf });
  if (values.record && (existsSync(join(values.record, '.spool')) || existsSync(join(values.record, 'manifest.json')))) throw new Error(`${values.record} already holds a recording or an unfinished one: record into a directory of its own`);

  const scratch = await mkdtemp(join(tmpdir(), `agentrun-${spec.name}-`));
  const dir = values.dir ?? join(scratch, 'run');
  const recordDir = values.record ?? join(scratch, 'recording');
  mkdirSync(recordDir, { recursive: true });
  // The fake browser's backend outlives a killed process: it is served here, and each child reaches it by URL.
  const backend = new FakeBackend({ start: options.fakes.start, pages: options.fakes.pages });
  options.fakes.backend?.(backend);
  const served = await backend.serve();
  // Setting the recording up writes to the disk: if it fails (the disk full, say) the backend, the timer and the scratch are closed before the error goes on.
  let supervisor!: ReturnType<typeof openSupervisor>;
  let follower!: ReturnType<typeof followRecording>;
  let following: ReturnType<typeof setInterval> | undefined;
  let placeRef: Place | undefined;
  // The recording's clock as a value, in every order's env: a box's child writes it into its own spool directory when it has none, so a place never writes into the run's disk.
  let startedText!: string;
  let followError: unknown;
  let jobBlob!: string;
  try {
    supervisor = openSupervisor({ dir: recordDir, ...(redact ? { redact } : {}) });
    // A live run and its replay are one file: events.jsonl is appended to as the run goes (whole lines, section 3's order), and finishRecording completes it. The job is a blob from the start, so a viewer can open it at once.
    startedText = readFileSync(join(recordDir, '.spool', 'started'), 'utf8');
    follower = followRecording(recordDir, { ...(redact ? { redact } : {}), holdMs: () => Math.max(options.followHoldMs ?? 1000, 2 * (placeRef?.clockSkewMs ?? 0)) });
    // A failure of the follower (the disk full, say) is not thrown from the timer: it is kept, the running child is stopped, and the run ends through the normal path, which releases the place.
    following = setInterval(() => { try { follower.poll(); } catch (error) { followError ??= error; clearInterval(following); } }, 100);
    const jobText = JSON.stringify({ workflow: job.workflow, input: input ?? (live ? undefined : options.fakes.input) ?? job.input, files: Object.keys(job.files ?? {}) });
    jobBlob = keepBlob(recordDir, Buffer.from(redact ? redact(jobText) : jobText), 'json');
  } catch (error) {
    clearInterval(following);
    await served.close();
    if (!values.record && !values.dir) await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  // A label no other run shares, on every box this run makes: cleanup finds these and no others.
  const runLabel = randomUUID();
  const base: Record<string, string> = { ...(values.record ? { AGENTRUN_HOME: dirname(signInFile(process.env)) } : {}), DEMO_ENTRY: options.self, DEMO_NAME: spec.name, RUN_LABEL: runLabel, HOME: scratch, TMPDIR: scratch, DIR: dir, RECORD_DIR: recordDir, BACKEND: served.url, BROWSER: browser, ...(live ? { LIVE: '1' } : {}), ...(Object.keys(models).length ? { MODELS: JSON.stringify(models) } : {}), ...(values['fetch-sources'] ? { FETCH_SOURCES: '1' } : {}), CACHE_DIR: values.cache ?? join(tmpdir(), 'agentrun-sources'), ...(input ? { INPUT: JSON.stringify(input) } : {}) };
  // A live child gets exactly the environment names the demo declares in demo.json (every key, the members of a `oneOf` group included, and the programs' env), plus the process basics above; nothing undeclared reaches it.
  // A no-key run passes the demo's own `DEMO_*` settings (no secret) so a test can steer it.
  const declared = declaredEnv(spec);
  for (const name of Object.keys(process.env)) if ((live && declared.has(name)) || (!live && name.startsWith('DEMO_'))) base[name] = process.env[name]!;
  const processes: DemoResult['processes'] = [];
  const kills: DemoResult['kills'] = [];
  const failedKills: DemoResult['failedKills'] = [];
  const failedSignals: DemoResult['failedSignals'] = [];
  const unlanded: string[] = [];
  let overBudget = false;
  // Where the session lives, as paths in the place: computed, not made. The supervisor touches nothing under them; the place makes them.
  // A directory a run already used keeps its identity (run.json's `run`, whatever name this version would give it): a saved run resumes under the name it was started with.
  const savedId = (() => { try { const saved = (JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { run?: unknown }).run; return typeof saved === 'string' && saved ? saved : undefined; } catch { return undefined; } })();
  // Otherwise one fresh run id per invocation, the same across its processes (every kill and resume): a second run of one demo on a shared disk never finds the first's run.json `done` or its old signals files.
  const runId = savedId ?? `${spec.name}-${randomBytes(4).toString('hex')}`;
  const paths = pathsAt(dir, runId);
  base.RUN_ID = paths.id;
  const requestFile = (attempt: number) => join(scratch, `kill-${attempt}.json`);
  let place!: Place;
  // The place's own reading of the run (`place.status()`), written as a `run.json` host line: `gen` is the record's generation and the rest is the record verbatim, only when its status, generation, holder or sealedSeq changes
  // (RECORDING.md's host row). Read at the boundaries (a runner's start and exit, a kill, a result) and on a slow tick while a runner runs; a place without `status()` writes none, and a reading never fails the run.
  let lastRunRecord = '';
  let lastGeneration: number | undefined;
  let currentGen = 0;
  const delegationSeen = new Map<string, string>();
  const hostLabels = new Map<string, string>();
  const bootLabels = new Map<string, string>();
  const clientLabels = new Map<string, string>();
  const inodeLabels = new Map<string, string>();
  // A delegation's client and inode ids name a machine's mount and a file in the place's own store: the recording shows `client-N` and `inode-N` by first appearance, the same value the same label (in a revoke line too).
  const safeDelegation = <T extends { clientId: string; inodeId: string | number }>(delegation: T): T => ({ ...delegation, clientId: labelOf(clientLabels, 'client', delegation.clientId), inodeId: labelOf(inodeLabels, 'inode', String(delegation.inodeId)) });
  const labelOf = (labels: Map<string, string>, prefix: string, value: string) => { let label = labels.get(value); if (!label) { label = `${prefix}-${labels.size + 1}`; labels.set(value, label); } return label; };
  let reading: Promise<void> = Promise.resolve();
  const boxLabels = new Map<string, string>();
  const boxReceipted = new Set<string>();
  // The slow tick does not queue a read behind one still running (a place's reads can take seconds): the boundary reads, which a result waits for, then wait behind at most one.
  let inflight = false;
  // A read the supervisor waits for (after a kill, at a process's exit, at the end) is waited for a bounded time: an optional reading never holds supervision up for a place's whole timeout.
  const settled = (read: Promise<void>, ms = 15_000): Promise<void> => Promise.race([read, new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); })]);
  const readStatus = (final = false): Promise<void> => {
    if (!place.status) return Promise.resolve();
    reading = reading.then(async () => {
      inflight = true;
      try {
        const status = (await place.status!()) as { record?: Record<string, unknown> | null; delegations?: unknown; boxes?: unknown } | undefined;
        const record = status?.record;
        if (record && typeof record.run === 'string' && Number.isInteger(record.generation)) {
          lastGeneration = record.generation as number;
          const key = JSON.stringify([record.status, record.generation, record.holder, record.sealedSeq]);
          if (key !== lastRunRecord) {
            lastRunRecord = key;
            // The line is an allowlist (RECORDING.md's host row): run, status, generation, sealedSeq, wakeAt, holder { driver, host, bootId, pid, since }, heartbeatAt, updatedAt, and a detail as text of at most 240 with every absolute path as `<path>`; every other field is dropped (a sandbox id, a name, a
            // mountpoint: what a place knows of its machine is not the recording's). A holder's host and boot id are labels (`host-1`, `boot-1`, ... in order of first appearance, the same label for the same value), so a takeover by a new box still shows a new holder.
            const holder = record.holder && typeof record.holder === 'object' ? (record.holder as Record<string, unknown>) : undefined;
            const kept = (source: Record<string, unknown>, names: readonly string[]) => Object.fromEntries(names.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]));
            const safeHolder = holder ? { ...kept(holder, ['driver', 'pid', 'since']), ...(typeof holder.host === 'string' ? { host: labelOf(hostLabels, 'host', holder.host) } : {}), ...(typeof holder.bootId === 'string' ? { bootId: labelOf(bootLabels, 'boot', holder.bootId) } : {}) } : undefined;
            const detail = record.detail === undefined || record.detail === null ? undefined : plainText(record.detail);
            supervisor.host('run.json', { gen: record.generation, ...kept(record, ['run', 'status', 'generation', 'sealedSeq', 'wakeAt', 'heartbeatAt', 'updatedAt']), ...(safeHolder ? { holder: safeHolder } : {}), ...(detail ? { detail } : {}) });
          }
        }
        // The place's delegations of the run's own path (an Archil place), one `delegation` line each time one appears or its orphaned or pending state changes: the first line with `isOrphaned` marks the first reading that SAW the orphan.
        for (const entry of Array.isArray(status?.delegations) ? status!.delegations as unknown[] : []) {
          const delegation = delegationOf(entry);
          if (!delegation) continue;
          const id = `${delegation.clientId}:${delegation.inodeId}`;
          const state = JSON.stringify([delegation.isOrphaned, delegation.isPending, delegation.path]);
          if (delegationSeen.get(id) === state) continue;
          delegationSeen.set(id, state);
          supervisor.host('delegation', { gen: lastGeneration ?? currentGen, ...safeDelegation(delegation) });
        }
        // The boxes the place made (a `HostBox` each, ended ones too): one `box.receipt` line per box when its `to` appears, or at the final read for one still open (`to`, `seconds` and `cost_usd` null). A box is its place in the
        // place's list (the place lists the boxes it started, in the order it started them, so equal provider, kind and start never make two boxes one), and it is `box-N` by first appearance, labelled when it first shows, before its
        // receipt; never the provider's id. `cost_usd` is seconds times the published per-second price, null when the box has none (the run's cost then reads unknown).
        (Array.isArray(status?.boxes) ? status!.boxes as unknown[] : []).forEach((entry, index) => {
          const label = labelOf(boxLabels, 'box', String(index));
          const box = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
          if (!box || typeof box.provider !== 'string' || typeof box.kind !== 'string') return;
          const at = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN);
          const from = at(box.from);
          const to = at(box.to);
          const ended = Number.isFinite(to);
          if (!Number.isFinite(from) || (!ended && !final) || boxReceipted.has(label)) return;
          boxReceipted.add(label);
          const seconds = ended ? Math.max(0, (to - from) / 1000) : null;
          const price = typeof box.usdPerSecond === 'number' && Number.isFinite(box.usdPerSecond) ? box.usdPerSecond : null;
          supervisor.host('box.receipt', { box: label, provider: box.provider, kind: box.kind, from: box.from, to: ended ? box.to : null, seconds, usd_per_second: price, cost_usd: price !== null && seconds !== null ? seconds * price : null, source: typeof box.source === 'string' ? box.source.slice(0, 240) : null, priced: box.priced ?? null });
        });
      } catch { /* a reading never fails the run */ } finally { inflight = false; }
    });
    return reading;
  };
  // A place whose child writes its recording inside the place brings it home through `recordHome.bringHome`: every status tick while a runner runs, and once more, final, after the runner has exited (before the follower closes, the manifest and the release). A tick that fails is
  // retried at the next one; a final failure refuses the recording unless the attempt's box was lost (then the attempt's lines after its last carried tick are a gap, like a kill losing its in-flight commit).
  let carrying: Promise<void> = Promise.resolve();
  // The slow tick does not queue a carry behind one still running (a transfer can take seconds): the final carry, which the result waits for, then waits behind at most one.
  let carryBusy = false;
  let carryRefusal: { gen: number; code: string } | undefined;
  const carry = (gen: number, final: boolean, lost: () => boolean): Promise<void> => {
    if (!place.recordHome) return Promise.resolve();
    carrying = carrying.then(async () => {
      carryBusy = true;
      try { await place.recordHome!.bringHome(recordDir, { final }); } catch (error) {
        const code = String((error as { code?: unknown } | null)?.code ?? 'CARRY_FAILED');
        const gone = lost() || code === 'BOX_GONE';
        supervisor.host('recording.carry.failed', { gen, code, message: plainText((error as Error | null)?.message ?? error), ...(final && gone ? { lost: true } : {}) });
        if (final && !gone) carryRefusal ??= { gen, code };
      } finally { carryBusy = false; }
    });
    return carrying;
  };
  // Metering: the recording's lines as they stand, folded; past the cap the supervisor stops the run.
  const meterTimer = maxUsd === null ? undefined : setInterval(() => { if (meterKnown(recordDir) > maxUsd) overBudget = true; }, 250);
  try {
    place = options.place ? await options.place({ paths, self: options.self, destroyBoxes: () => destroyBoxes(spec, runLabel, paths.root, live), requestFile }) : localPlace({ self: options.self, paths, requestFile, ...(spec.boxes ? { destroyBoxes: () => destroyBoxes(spec, runLabel, paths.root, live) } : {}) });
    // The follower's hold reads the place's clock allowance from here on (it was assigned before the place existed, so it was never seen).
    placeRef = place;
    const remaining = childPlansOf(plans);
    let runner: Runner | undefined;
    let previous: { runner: Runner; kind: 'process' | 'box' } | undefined;
    for (;;) {
      // Past the cap, no further process is started: the budget is checked before every restart.
      if (overBudget && processes.length > 0) break;
      const queued = remaining.shift();
      const plan = queued ?? { tools: [] };
      // A kill this attempt plans that the place cannot make is refused before the attempt starts: the run is not stopped first, and no machine loss is recorded.
      const planned = plan.run?.kind;
      if (planned && !place.kills.includes(planned)) throw new Error(`the ${place.name} place cannot lose its ${planned}: this kill is not one it can make`);
      // The operator's kill is a process kill: a place that cannot make one (a box-only place) refuses `--operator-kill` before anything starts, as it refuses a planned kill it cannot make.
      if (operatorKill && !place.kills.includes('process')) throw new Error(`the ${place.name} place cannot lose its process: --operator-kill is not a kill it can make`);
      const gen = processes.length + 1;
      const log = join(scratch, `crossings-${gen}.jsonl`);
      // Where this attempt's runner writes its kill request: the place answers it (the child never derives it); the scratch default is for a place that does not.
      const request = place.requestFile?.(gen) ?? join(scratch, `kill-${gen}.json`);
      // A place that mints a token for each attempt (a claim's mount token) has it passed on the runner's standard input, never in argv or env.
      const token = place.token ? await place.token(gen) : undefined;
      // The supervisor's own nonce for this attempt: the process puts it in its kill request, and the supervisor honors only a request that carries it. The place knows nothing about it.
      const nonce = randomBytes(16).toString('hex');
      const order = { gen, env: { ...base, CROSS_LOG: log, KILL_REQUEST: request, KILL_NONCE: nonce, RECORD_GEN: String(gen), RECORD_STARTED: startedText, PLAN: JSON.stringify(plan) }, ...(token !== undefined ? { stdin: token } : {}) };
      if (previous && !place.kills.includes(previous.kind)) throw new Error(`the ${place.name} place cannot lose its ${previous.kind}: this kill is not one it can make`);
      currentGen = gen;
      const recovered = previous ? await place.recover(previous.runner, previous.kind, order) : undefined;
      runner = recovered ? recovered.runner : await place.start(order);
      supervisor.host('process.started', { gen, pid: runner.pid });
      // The reading runs beside the supervision: the kill requests and the spend cap are watched from the start, however slow the place's read is.
      void readStatus();
      // A takeover that revoked the old holder's delegations (an Archil place): what was revoked, and how long the whole takeover took.
      const revoked = (Array.isArray(recovered?.revoked) ? recovered!.revoked : []).map(delegationOf).filter((entry) => entry !== undefined).map(({ clientId, inodeId, path, isOrphaned }) => safeDelegation({ clientId, inodeId, ...(path !== undefined ? { path } : {}), isOrphaned }));
      if (revoked.length) supervisor.host('revoke', { gen, revoked, ...(Number.isFinite(recovered?.ms) ? { ms: recovered!.ms } : {}) });
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
      const decide = async (asked: { point: string; n: number } | 'operator' | undefined) => {
        if (decided) return;
        decided = true;
        const kind = asked && asked !== 'operator' ? (plan.run?.kind ?? 'process') : 'process';
        killed = asked === 'operator'
          ? { point: null, n: null, label: 'operator', why: 'the operator asked', kind: 'process' }
          : asked
          ? { point: asked.point, n: asked.n, label: plan.run && !('storm' in plan.run) ? plan.run.point : asked.point, why: plan.run?.why ?? 'a kill', kind }
          : { point: null, n: null, label: 'max-usd', why: `past --max-usd ${maxUsd}`, kind: 'process' };
        supervisor.host('kill', { gen, label: killed.label, crossing: killed.point === null ? null : { point: killed.point, n: killed.n }, side: 'child', kind: killed.kind });
        kills.push({ gen, point: killed.point, kind: killed.kind, why: killed.why, ...(typeof asked === 'object' && plan.run && !('storm' in plan.run) ? { n: asked.n, planned: plan.run.n } : {}) });
        try { await place.kill(runner!, killed.kind); } catch (error) { failed(String((error as { code?: unknown } | null)?.code ?? 'KILL_FAILED'), messageOf(error, paths.root), killed.kind); }
        await settled(readStatus());
      };
      const iterator = place.signals?.(gen)[Symbol.asyncIterator]();
      let signalsFailed = false;
      const signalsFailure = (code: string, message: string) => { if (signalsFailed) return; signalsFailed = true; failedSignals.push({ gen, code }); supervisor.host('signals.failed', { gen, code, message }); };
      // Nothing in the pump can end the supervisor: a failure of the place's signals (its iterator ends with `signals-failed`, or throws) is a line and the end of the attempt, never an unhandled rejection.
      const pump = (async () => {
        if (!iterator) return;
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
          if (next.value.kind === 'signals-failed') { signalsFailure(String(next.value.code), messageOf(next.value.message, paths.root)); return; }
          if (next.value.kind !== 'kill-request') continue;
          // A request is honored only with this attempt's nonce: a stale or other attempt's process, or a stray file on a shared mount, never puts a kill line in a recording.
          if (next.value.nonce !== nonce) { supervisor.host('kill.request.ignored', { gen, point: next.value.crossing.point, reason: next.value.nonce === undefined ? 'no nonce' : 'wrong nonce' }); continue; }
          await decide(next.value.crossing);
        }
      })().catch((error) => signalsFailure(String((error as { code?: unknown } | null)?.code ?? 'SIGNALS_FAILED'), messageOf(error, paths.root)));
      // The operator's control, a file the supervisor watches (never the child's request file): the caller makes it, the supervisor removes it, kills through the place and resumes as usual. The budget's stop is kept:
      // the attempt does not finish (nor the place release) until the kill, with its provider cleanup, is done.
      let deciding: Promise<void> = Promise.resolve();
      const watch = setInterval(() => {
        if (followError && !decided) { decided = true; deciding = place.kill(runner!, 'process').catch((error) => { failed(String((error as { code?: unknown } | null)?.code ?? 'KILL_FAILED'), messageOf(error, paths.root), 'process'); }); return; }
        if (decided) return;
        if (operatorKill && existsSync(operatorKill)) {
          // A control that cannot be removed (a directory made by mistake, a parent that forbids it) is a failed kill, reported through the normal path: the supervisor does not crash with the child still running.
          try { rmSync(operatorKill, { force: true }); deciding = decide('operator'); } catch (error) { decided = true; failed(String((error as { code?: unknown } | null)?.code ?? 'OPERATOR_KILL_UNUSABLE'), 'the operator\'s kill control could not be removed', 'process'); }
        } else if (overBudget) deciding = decide(undefined);
      }, 20);
      const tick = setInterval(() => { if (!inflight) void readStatus(); if (!carryBusy) void carry(gen, false, () => false); }, 2000);
      let exit: Exit | undefined;
      try { exit = await Promise.race([runner.exited, gaveUp.then(() => undefined)]); } catch (error) {
        clearInterval(watch);
        clearInterval(tick);
        await iterator?.return?.().catch(() => undefined);
        await pump.catch(() => undefined);
        throw error;
      }
      const result: Exit = exit ?? { exit: null, signal: null, stderr: 'the place could not stop this process' };
      clearInterval(watch);
      clearInterval(tick);
      await settled(readStatus());
      await carry(gen, true, () => killed?.kind === 'box');
      await iterator?.return?.();
      await pump;
      await deciding;
      if (followError) break;
      processes.push(result);
      if (killFailed || signalsFailed || (killed && killed.label === 'max-usd')) break;
      // A tool kill of an attempt that ended in a process kill and did not fire never will (the plan is consumed): it is reported, not carried off with the attempt.
      const missed = () => { for (const entry of notLanded(plan.tools, log)) unlanded.push('point' in entry ? entry.point : `storm (gap ${entry.gapMs} ms)`); };
      if (killed) {
        // An operator's kill is not the plan's: a kill still planned for the attempt the operator ended is planned for the next, minus the tool kills that landed. Any other kill consumes its attempt's plan: the tool kills it did not fire are reported.
        if (killed.label === 'operator' && queued) remaining.unshift({ ...queued, tools: notLanded(queued.tools, log) });
        else missed();
        previous = { runner, kind: killed.kind };
        continue;
      }
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
    // The last read can add a box's priced receipt: the cap is checked after it.
    await settled(readStatus(true));
    if (maxUsd !== null && meterKnown(recordDir) > maxUsd) overBudget = true;
    const processesStarted = processes.length;
    // The demo's result hook, reported by the process that delivered, shapes the result line and its blob; without one, the delivered record is the result.
    const made = processes.at(-1)?.outcome?.result;
    const blob = made ? openRecorder({ dir: recordDir, ...(redact ? { redact } : {}) }).blob(JSON.stringify(made.json, null, 2), 'json') : delivered ? openRecorder({ dir: recordDir, ...(redact ? { redact } : {}) }).blob(JSON.stringify({ record: delivered.record }, null, 2), 'json') : undefined;
    const resultTitle = made?.title ?? 'The record';
    if (blob) supervisor.host('result', { gen: processesStarted, blob, title: resultTitle }, { blobs: [blob] });
    const resultBlob = blob ? { blob, title: resultTitle } : undefined;
    // `source.run` names the run: the demo, and the input file it ran on when one was given.
    const runName = values.input !== undefined && !values.input.trimStart().startsWith('{') ? `${spec.name}-${basename(values.input).replace(/\.[^.]*$/, '')}` : spec.name;
    const chosen = [...processes].reverse().find((entry) => entry.outcome?.models)?.outcome?.models;
    const extra = options.manifest ? options.manifest({ dir, record: delivered?.record ?? null, input, live, ...(chosen ? { models: chosen } : {}) }) : undefined;
    for (const name of Object.keys(extra ?? {})) if (RESERVED.has(name)) throw new Error(`manifest(): "${name}" is written by the entry; use another name`);
    if (followError) throw followError;
    follower.close();
    if (carryRefusal) throw new Error(`the recording is refused: the place could not bring home process ${carryRefusal.gen}'s recording (${carryRefusal.code}), and that process ended on its own`);
    // What a viewer following the run could already have fetched is not taken back: a secret in the file as it was placed refuses the recording, though the finished file is redacted.
    scanPlaced(recordDir, tracked?.final() ?? []);
    finishRecording(recordDir, {
      ...(redact ? { redact } : {}), job: { blob: jobBlob, sha256: jobBlob },
      title: spec.title ?? spec.name, task: job.workflow.name ?? spec.name, model: live ? 'live' : 'faux/faux-1', generations: processesStarted, kills: kills.length,
      code: codeOf(rootOf(options)), cost, source: { run: runName, ...(last?.storeSha256 ? { store_sha256: last.storeSha256 } : {}) }, ...(seeAlso.length ? { see_also: seeAlso } : {}), ...(extra ? { extra } : {}), ...(resultBlob ? { result: resultBlob } : {}), ...(live ? { providers: 'real' as const } : {}),
    });
    // The record-time scan: a recording that still holds a secret is refused (its manifest removed, so it is not a finished recording), naming the key and the file, never the value.
    try { scanRecording(recordDir, tracked?.final() ?? []); } catch (error) { rmSync(join(recordDir, 'manifest.json'), { force: true }); throw error; }
    const usd = cost(readEventsOf(recordDir)).usd;
    return { processes, kills, record: delivered?.record ?? null, dir, runId, ...(values.record ? { recording: values.record } : {}), usd, maxUsd, overBudget, failedKills, failedSignals, unlanded };
  } finally {
    clearInterval(following);
    if (meterTimer) clearInterval(meterTimer);
    // The backend and the scratch are closed whatever the place did: a place that failed to be made, or to be released, leaves neither open.
    try { await place?.release(); } finally {
      await served.close();
      if (!values.record && !values.dir && !options.keepRun) await rm(scratch, { recursive: true, force: true });
    }
  }
}

/** A message the supervisor writes about a failure of the place: an absolute path outside the run's directory is replaced by `<path>` (the run's own paths stay), then it is capped at 240 characters. The recorder's exact-value redaction runs on the line after. */
export function messageOf(error: unknown, root: string): string {
  const own = resolve(root);
  const text = String((error as { message?: unknown } | null)?.message ?? error);
  // A directory in a path may have spaces in its name (`Private Documents`): a path's folders are words joined by single spaces, and only its last part ends at a space, so `/srv/x and /run/y` is two paths, not one. A Windows drive path is replaced too.
  return text.replace(/(?<![\w/:.-])\/(?:[\w.@%+~-]+(?: [\w.@%+~-]+)*\/)*[\w.@%+~-]+\/?|\b[A-Za-z]:\\(?:[^\\\n;,"'`]+\\)*[^\s\\;,"'`]+/g, (path) => (path === own || path.startsWith(`${own}/`) ? path : '<path>')).slice(0, 240);
}

/** One delegation as the recording holds it: the allowlisted fields, with the path clipped; anything that is not a delegation is not one. */
function delegationOf(value: unknown): { clientId: string; inodeId: string | number; isOrphaned: boolean; isPending: boolean; path?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.clientId !== 'string' || (typeof entry.inodeId !== 'string' && typeof entry.inodeId !== 'number')) return undefined;
  // A delegation the package found by matching its inode to the run's has no path: it is kept, without one.
  return { clientId: entry.clientId, inodeId: entry.inodeId, isOrphaned: entry.isOrphaned === true, isPending: entry.isPending === true, ...(typeof entry.path === 'string' ? { path: entry.path.slice(0, 240) } : {}) };
}

/** A place's detail as the recording holds it: text of at most 240 characters, every absolute path replaced by `<path>`. */
export function plainText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  // A path runs from its `/` to the next `:`, `;`, `,`, quote or end of line, spaces and all: a directory named `Client Files` is not left half in the recording.
  return text.replace(/(?<![\w/:.-])\/[^\n:;,"'`]*/g, '<path>').slice(0, 240);
}

/** The tool kills of an attempt that did not fire: those whose place in the plan the child's log (`landed` rows, each naming the entry that fired) does not show. Two kills at one point (or with different `where`) are told apart by that place. */
export function notLanded<T extends object>(tools: readonly T[], log: string): T[] {
  const fired = new Set(rows<Crossing>(log).filter((crossing) => crossing.landed && typeof crossing.tool === 'number').map((crossing) => crossing.tool));
  return tools.filter((_entry, index) => !fired.has(index));
}

const readEventsOf = (dir: string) => rows<Record<string, unknown>>(join(dir, 'events.jsonl'));

export function summarize(options: DemoOptions, result: DemoResult) {
  console.log(`${options.spec.title ?? options.spec.name}: ${result.processes.at(-1)?.outcome?.status ?? 'no outcome'} in ${result.processes.length} process${result.processes.length === 1 ? '' : 'es'}, ${result.kills.length} kill${result.kills.length === 1 ? '' : 's'}`);
  for (const kill of result.kills) console.log(`  killed process ${kill.gen} (${kill.kind}) at ${kill.point ?? 'no named crossing'}${kill.planned !== undefined && kill.n !== kill.planned ? ` (planned n=${kill.planned}, landed at n=${kill.n})` : ''}: ${kill.why}`);
  if (result.failedSignals.length) console.log(`the place's signals failed: ${result.failedSignals.map((entry) => `process ${entry.gen} (${entry.code})`).join(', ')}`);
  if (result.failedKills.length) console.log(`kills the place could not make: ${result.failedKills.map((kill) => `process ${kill.gen} (${kill.code})`).join(', ')}`);
  const last = result.processes.at(-1)?.outcome;
  if (last && last.status !== 'complete' && last.message) console.log(`  stopped: ${last.message}`);
  if (result.unlanded.length) console.log(`kills that never landed: ${result.unlanded.join(', ')}`);
  console.log(`cost: ${result.usd === null ? 'unknown' : `$${result.usd}`}${result.maxUsd === null ? '' : ` (cap $${result.maxUsd})`}${result.overBudget ? ' — over the cap' : ''}`);
  if (result.recording) console.log(`recording: ${result.recording}`);
  if (options.keepRun) console.log(`run directory: ${result.dir}`);
}

/** The demo's `sources.json`: `true` is the one beside `run.ts`; a path is relative to the demo's directory, or to the repository when it starts with `examples/` (as demo.json's schema writes it). */
function sourcesPath(options: DemoOptions): string {
  const named = typeof options.spec.sources === 'string' ? options.spec.sources : 'sources.json';
  return named.startsWith('examples/') ? resolve(rootOf(options), named) : resolve(dirname(fileURLToPath(options.self)), named);
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
