// npm run demo:hero [-- --json] [-- --dir <path>] [-- --record <dir>] [-- --kill1]: the hero job on the no-key host, from the
// reference entry: nine grids read by vision from their charts, then `snapshot.html`. `--kill1` runs it in a child process that
// is killed with SIGKILL inside a paid call (the operator's published figure, after the host kept the answer and before the
// driver committed it), and a fresh process resumes the run on the same directory: the paid call is settled from the kept
// answer and is not sent again. `--record <dir>` keeps the run as an agentrun.recording/1 directory. `--chrome` runs it in a local Chrome on the job's own
// pages (no network, eyes and lead scripted); `--live` takes the real dashboards on Browserbase (PI_BROWSER_PROVIDER=browserbase, BROWSERBASE_API_KEY) and the
// broker's models, and is run only on the TL's ask.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FakeBackend, remoteDriver, remoteProvider } from '@parcha/pi-browser/testing';
import { codeOf, cost, finishRecording, localHost, openRecorder, openSupervisor, packageCommitRecorder, placeAt, run } from '../reference/index.ts';
import type { BrowserPlane, Delivery, LedgerRow, RunResult } from '../reference/index.ts';
import { heroFakes, heroJob, readGrids, watchScreenshots } from './job.ts';
import { addFrameTracks, liveBrowser, liveConfig, liveEyes, liveFrames, liveModels } from './live.ts';
import { keepLooks, shownShots } from './looks.ts';
import { fakeEyes } from '@parcha/pi-vision/testing';

const SELF = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** The moment the snapshot is taken at, when the caller gives none: fixed, so the no-key output is a constant. */
export const AT = '2026-10-15T12:00:00Z';

type Out = { status: string; generation: number | null; code?: string | null; message?: string };
type Record_ = { at: string; grids: number; read: number; failed: number; closeWithinOnePoint?: number; meanGap?: number; rows: Array<Record<string, unknown>>; html: string };

/** The result a recording carries (`agentrun.cited/1`): rows of a label, a value and the cites behind it. Each cite names the screenshot the number was read
 *  from (`blob`, the image's SHA-256) and the look that read it (`look`, the LookRecord's `facts.key`). A grid that was not read has a row and no cite. */
export type Cited = { format: 'agentrun.cited/1'; title?: string; rows: Array<{ label: string; value: string | number; note?: string; cites: Array<{ blob?: string; look?: string; fragment?: string; note?: string }> }> };
export function citedOf(record: Record_, cites: ReadonlyArray<{ receipt: string; look: string; blob: string | null }>): Cited {
  const rows: Cited['rows'] = [];
  for (const row of record.rows) {
    const at = typeof row.screenshot === 'string' ? cites.find((cite) => cite.receipt === row.screenshot) : undefined;
    const cite = (note: string) => (at ? [{ ...(at.blob ? { blob: at.blob } : {}), look: at.look, note }] : []);
    if (row.status !== 'read') { rows.push({ label: String(row.operator), value: `not read: ${String(row.note)}`, cites: [] }); continue; }
    rows.push({ label: `${String(row.operator)}: renewable share now`, value: `${String(row.share)}%`, note: `the operator publishes ${String(row.published)}% (gap ${String(row.gap)} points)`, cites: cite('read from the chart') });
    rows.push({ label: `${String(row.operator)}: peak`, value: `${String(row.peak)} ${String(row.peakUnit)}`, note: String(row.peakOf), cites: cite('read from the chart') });
  }
  return { format: 'agentrun.cited/1', title: 'Nine grids, read from the chart', rows };
}

/** What a delivered snapshot is made of: `snapshot.html`, and each cited screenshot copied beside it as an image the page links to. */
export async function deliverSnapshot(root: string, result: Delivery): Promise<void> {
  const record = result.record as Record_;
  const out = join(root, 'out');
  mkdirSync(join(out, 'screenshots'), { recursive: true });
  let html = record.html;
  for (const row of record.rows) {
    const path = typeof row.screenshot === 'string' ? row.screenshot : '';
    if (row.status !== 'read' || !path) continue;
    const receipt = JSON.parse(readFileSync(join(root, path), 'utf8')) as { body: string; ext?: string };
    const name = `screenshots/${String(row.id)}.${receipt.ext ?? 'jpg'}`;
    writeFileSync(join(out, name), Buffer.from(receipt.body, 'base64'));
    html = html.split(path).join(name);
    row.screenshotFile = name;
  }
  writeFileSync(join(out, 'snapshot.html'), html);
}

/** One process of the run: on `DIR`, killed when `KILL1` asks. */
async function child() {
  const place = await placeAt(process.env.DIR);
  const grids = readGrids();
  const mode = (process.env.MODE ?? 'fake') as 'fake' | 'chrome' | 'live';
  if (process.env.SEE) throw new Error('--see is not available yet: vision.see from code mode is agentrun #506, which has not landed.');
  const config = mode === 'fake' ? undefined : liveConfig(process.env, mode);
  const { fakes, eyes: scripted } = heroFakes(grids, { eyesLedger: join(place.root, 'eyes.jsonl'), ...(process.env.EYES_PRICE ? { eyesPrice: Number(process.env.EYES_PRICE) } : {}), ...(process.env.BROKEN ? { broken: process.env.BROKEN } : {}) });
  const recorder = process.env.RECORD_DIR ? openRecorder({ dir: process.env.RECORD_DIR, commits: await packageCommitRecorder() }) : undefined;
  // `--chrome`: no network, a local Chrome that reaches the job's own pages, the lead and eyes scripted (its eyes answer one fixed reading for any chart: this checks the
  // wiring, not the numbers). `--live`: local Chrome on the real dashboards, the eyes and the lead on the broker.
  const eyes = mode === 'live' ? liveEyes(config!) : mode === 'chrome' ? fakeEyes({ model: 'scripted-eyes', price: { input: 0, output: 0 }, ...(process.env.DIR ? { ledgerPath: join(place.root, 'eyes.jsonl') } : {}), answers: ['A fuel-mix chart. Renewable share now: 50.0%. Peak: 1000 MW.'] }) : scripted;
  const frames = config && recorder ? liveFrames(recorder, Date.now(), process.env.RECORD_DIR!) : undefined;
  const chrome = config ? await liveBrowser(place, config, { ...(mode === 'chrome' ? { pages: fakes.pages } : {}), ...(frames ? { frames } : {}), env: process.env }) : undefined;
  // The fake browser has no navigation of its own (a session opens on the backend's start page, and `run` hands back the code it was given),
  // so this plane turns the lead's `page.goto("<url>")` into the fake's `goto` action: each session then stands on its own grid's page.
  const remote = remoteDriver(process.env.BACKEND!);
  const browser: BrowserPlane = chrome?.browser ?? {
    provider: () => remoteProvider(process.env.BACKEND!), createDeadlineMs: 3_000,
    driver: async (target) => {
      const page = await remote(target);
      return { ...page, run: async (input) => {
        const goto = /page\.goto\(\s*(["'`])(.+?)\1\s*\)/.exec(input.code ?? '');
        return page.run(goto ? { actions: [{ op: 'goto', url: goto[2]! }] } : (input as Parameters<typeof page.run>[0]));
      } };
    },
  };
  const local = localHost(place, fakes, { browser, ...(recorder ? { recorder } : {}) });
  if (mode === 'live') local.host.models = liveModels(config!);
  const { runEffect } = local.host.tools;
  // The kill: after the host has kept a paid call's answer and before the driver commits it. It waits for the paid call to be the only
  // one in the tool (a call between its dispatch and the kept answer cannot be settled, and a kill there is the operator's to resolve).
  // The screenshot each branch takes, kept as a blob (the image bytes) and tied to its evidence path, so each look is filed with what it saw.
  const shown = shownShots(recorder ? { keep: (bytes, extension) => recorder.blob(bytes, extension) } : {});
  let inFlight = 0;
  let finished = 0;
  const killAt = process.env.KILL1 ? Number(process.env.KILL1) : undefined;
  local.host.tools = { ...local.host.tools, extensions: [shown.extension], runEffect: async (request) => {
    inFlight += 1;
    let value: unknown;
    try { value = await runEffect(request); } finally { inFlight -= 1; }
    finished += 1;
    if (killAt !== undefined && finished >= killAt && inFlight === 0) {
      if (process.env.CROSS_LOG) appendFileSync(process.env.CROSS_LOG, `${JSON.stringify({ point: `effect.kept ${request.node.tool}`, n: finished, pid: process.pid })}\n`);
      process.kill(process.pid, 'SIGKILL');
    }
    return value;
  } };
  const record_ = local.host.deliver;
  local.host.deliver = async (result) => { await deliverSnapshot(place.root, result); await record_(result); };
  try {
    const result: RunResult = await run(place, local.host, heroJob(grids, process.env.AT ?? AT), { vision: (running) => ({ eyes, ...(mode === 'live' ? { limits: () => ({ image: { native: false } }) } : {}), ...keepLooks(() => running.harness, { shown, cites: join(place.root, 'cites.jsonl') }) }) });
    await recorder?.detach();
    await frames?.close();
    chrome?.close();
    console.log(JSON.stringify({ outcome: { status: result.status, generation: result.generation, ...(result.status === 'refused' ? { code: result.code, message: result.message.slice(0, 240) } : {}) } satisfies Out }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: { status: 'error', generation: null, code: (error as { code?: string }).code ?? null, message: String((error as Error).message).slice(0, 400) } satisfies Out }));
  }
}

type Process = { exit: number | string | null; signal: string | null; outcome?: Out; stderr: string };

function spawnChild(env: Record<string, string>, onSpawn: (pid: number) => void): Promise<Process> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', SELF, '--child'], { env: { PATH: process.env.PATH!, HOME: env.HOME!, TMPDIR: env.TMPDIR!, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn(proc.pid!);
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      const row = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((parsed) => parsed.outcome);
      resolve({ exit: signal ?? code, signal, ...(row ? { outcome: row.outcome as Out } : {}), stderr: stderr.trim().slice(0, 600) });
    });
  });
}

const rows = <T,>(file: string): T[] => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T); } catch { return []; } };

/** What a child needs of this process's environment for a Chrome or live run, and nothing else. */
const passed = (mode?: string): Record<string, string> => {
  const names = [...(mode ? ['HERO_LIVE_SPEND_OK', 'HERO_LEAD_PRICE', 'HERO_BROKER_URL', 'HERO_EYES', 'HERO_LEAD'] : []), ...(mode === 'chrome' ? ['CHROME_PATH', 'PI_BROWSER_NO_SANDBOX'] : []), ...(mode === 'live' ? ['PI_BROWSER_PROVIDER', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'] : [])];
  return Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));
};

export type HeroRun = {
  dir: string;
  processes: Process[];
  record: Record_ | null;
  /** The result a recording carries: rows with the screenshot and look behind each number. */
  cited: Cited | null;
  /** The host's own row for every fake call, from every process. */
  ledger: LedgerRow[];
  /** The scripted eyes' requests, from every process: the paid vision calls. */
  eyesRequests: number;
  recording?: string;
  /** Removes the scratch directory the run lived in (the run's directory too, unless the caller gave one). */
  cleanup(): Promise<void>;
};

/** Runs the job in a directory of its own. With `kill1`, the first process is killed inside the paid call that is the `kill1`th to finish
 *  (alone in the tool), and a fresh process resumes. With `record`, the run is kept as a recording there. */
export async function heroRun(options: { kill1?: number; record?: string; dir?: string; broken?: string; at?: string; /** The scripted eyes' price, in dollars per million tokens in and out; default 0, so the run costs nothing. */ eyesPrice?: number; /** `chrome`: a local Chrome on the job's own pages, no network; `live`: local Chrome on the real dashboards and the broker's models. Default: the fake browser. */ mode?: 'chrome' | 'live'; /** `vision.see` from code mode, once agentrun #506 has landed: not yet. */ see?: boolean } = {}): Promise<HeroRun> {
  if (options.record && (existsSync(join(options.record, '.spool')) || existsSync(join(options.record, 'manifest.json')))) throw new Error(`${options.record} already holds a recording or an unfinished one: record into a directory of its own`);
  const scratch = await mkdtemp(join(tmpdir(), 'agentrun-hero-'));
  const cleanup = () => rm(scratch, { recursive: true, force: true });
  try {
    const dir = options.dir ?? join(scratch, 'run');
    // The fake browser's backend outlives a killed process: it is served here on loopback, and the child reaches it by URL.
    const grids = readGrids();
    const { fakes } = heroFakes(grids, options.broken ? { broken: options.broken } : {});
    const backend = new FakeBackend({ start: fakes.start, pages: fakes.pages });
    watchScreenshots(backend, grids);
    const served = await backend.serve();
    // Closed on every way out: a listening server keeps the caller's process alive.
    try {
      const base = { BACKEND: served.url, HOME: scratch, TMPDIR: scratch, DIR: dir, ...(options.record ? { RECORD_DIR: options.record } : {}), ...(options.broken ? { BROKEN: options.broken } : {}), ...(options.at ? { AT: options.at } : {}), ...(options.eyesPrice ? { EYES_PRICE: String(options.eyesPrice) } : {}), ...(options.mode ? { MODE: options.mode } : {}), ...(options.see ? { SEE: '1' } : {}), ...passed(options.mode) };
      const supervisor = options.record ? openSupervisor({ dir: options.record }) : undefined;
      const processes: Process[] = [];
      let kills = 0;
      const next = async (env: Record<string, string>) => {
        const gen = processes.length + 1;
        const result = await spawnChild({ ...base, ...env }, (pid) => { supervisor?.host('process.started', { gen, pid }); });
        processes.push(result);
        if (result.signal === 'SIGKILL') { kills += 1; supervisor?.host('kill', { gen, label: 'effect.kept published', crossing: null, side: 'child' }); }
        return result;
      };
      let last = await next(options.kill1 ? { KILL1: String(options.kill1) } : {});
      if (last.signal === 'SIGKILL') last = await next({});
      const record = (() => { try { return JSON.parse(readFileSync(join(dir, 'out', 'record.json'), 'utf8')).record as Record_; } catch { return null; } })();
    const cited = record ? citedOf(record, rows<{ receipt: string; look: string; blob: string | null }>(join(dir, 'cites.jsonl'))) : null;
      if (options.record) {
        const blob = openRecorder({ dir: options.record }).blob(JSON.stringify(cited), 'json');
        supervisor?.host('result', { gen: processes.length, blob, title: 'Nine grids, read from the chart' }, { blobs: [blob] });
        finishRecording(options.record, {
          title: 'Nine grids, read from the chart', task: 'hero-grid-snapshot', model: 'faux/faux-1', generations: processes.length, kills,
          code: codeOf(ROOT), cost, source: { run: 'hero', store: join(dir, 'store', 'run.sqlite') }, result: { blob, title: 'Nine grids, read from the chart' },
          ...(options.mode === 'live' ? { providers: 'real' as const } : {}),
        });
        // A browser session's frames become one video each, written at export, after the last frame.
        if (options.mode) await addFrameTracks(options.record);
      }
      return { dir, processes, record, cited, ledger: rows<LedgerRow>(join(dir, 'ledger.jsonl')), eyesRequests: rows(join(dir, 'eyes.jsonl')).length, ...(options.record ? { recording: options.record } : {}), cleanup };
    } finally { await served.close(); }
  } catch (error) { await cleanup(); throw error; }
}

async function main() {
  const { values } = parseArgs({ options: { child: { type: 'boolean' }, json: { type: 'boolean' }, dir: { type: 'string' }, record: { type: 'string' }, kill1: { type: 'boolean' }, chrome: { type: 'boolean' }, live: { type: 'boolean' }, see: { type: 'boolean' } } });
  if (values.child) return child();
  const result = await heroRun({ ...(values.dir ? { dir: values.dir } : {}), ...(values.record ? { record: values.record } : {}), ...(values.kill1 ? { kill1: 3 } : {}), ...(values.live ? { mode: 'live' as const } : values.chrome ? { mode: 'chrome' as const } : {}), ...(values.see ? { see: true } : {}) });
  const tally = (names: string[]) => names.reduce<Record<string, number>>((counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }), {});
  const view = {
    processes: result.processes.map((process) => ({ exit: process.exit, outcome: process.outcome?.status ?? null })),
    grids: result.record?.grids ?? null, read: result.record?.read ?? null, failed: result.record?.failed ?? null, meanGap: result.record?.meanGap ?? null,
    snapshot: join(result.dir, 'out', 'snapshot.html'),
    calls: tally(result.ledger.map((row) => `${row.kind}:${row.name}`)),
    eyesRequests: result.eyesRequests,
    ...(result.recording ? { recording: result.recording } : {}),
  };
  console.log(values.json ? JSON.stringify(view) : JSON.stringify(view, null, 2));
  if (!values.dir) console.log(`(the run's directory is ${result.dir}; remove it when done)`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
