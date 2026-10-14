// node examples/apollo11/run.ts [--quick] [--live [--weak-eyes]] [--kill-in-sink N[:hold]] [--kill-after-look N] [--kill-at <ms>]
//   [--storm <ms> --kills N] [--film-landing] [--record <dir>] [--name <run>] [--weak-from <run dir>] [--dir <run dir>] [--cache <dir>] [--limit N]
//   [--max-usd X] [--json]
// Apollo 11, read whole: a lead that is never shown an image reads NASA's archive through pi-vision's eyes (the film in windows, the
// scanned air-to-ground transcript page by page, the photos one by one) and writes the landing minute by minute, every sentence
// citing the looks it rests on. With no flag it needs no key: a scripted lead and scripted eyes over the real files, $0. `--quick`
// reads the landing (the film's two cuts that hold it, 40 pages, every photo); without it, the whole film and all 626 pages. `--live`
// asks real models (your keys, or a gateway: see the README). `--weak-eyes` reads the pages and photos with the eyes the eyes bench
// measured dropping digits. The kills: `--kill-in-sink N` ends the process inside the evidence sink at its Nth filing (and the ones
// that reach the sink while it waits), after the eyes' answers are kept and before the looks are; `--kill-after-look N` right after
// the Nth look is committed; `--kill-at`
// after that many ms, `--storm` about every <ms>; a fresh process takes the run back from its store each time.
//
// Two processes of this file: the supervisor fetches and checks the files, starts, kills and restarts the run, builds the account
// and writes the recording's host lines; `--child` is the run itself.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { codeOf, finishRecording, localHost, openRecorder, openSupervisor, packageCommitRecorder, placeAt, run, type Fakes, type RunOptions } from '../reference/index.ts';
import { cost as foldCost } from '../reference/fold.ts';
import { buildAccount, outputOf, weakEyesOf, type Account } from './account.ts';
import { fetchItems, fileOf, itemOf, itemsOf, loadDataset, placeFiles, select, type Mode, type Selection } from './dataset.ts';
import { requestKill, shownImages, visionOptions } from './looks.ts';
import { EYES, LEAD, liveModels, publicName, WEAK_EYES } from './models.ts';
import { scriptedEyes, scriptedLead, typedLines, type PageStarts } from './scripted.ts';
import { workflowOf } from './workflow.ts';

const SELF = fileURLToPath(import.meta.url);
const REPO = join(import.meta.dirname, '..', '..');
/** The mission times the account covers, as the transcript types them: 102:20:00 to 102:50:00, powered descent to after the landing. */
export const ACCOUNT_SPAN = { from: '04 06 20 00', to: '04 06 50 00' };
const TYPED = 'transcript-tec-typed';

export type Options = {
  mode?: Mode; live?: boolean; weakEyes?: boolean; dataset?: string; dir?: string; cache?: string; record?: string; title?: string;
  killAfterLook?: number; killAtMs?: number; stormMs?: number; kills?: number; seed?: number; maxUsd?: number;
  /** The kill inside the evidence sink: at the run's Nth filing, holding up to `hold` filings (default 4) for at most 3 s. */
  sinkKill?: { n: number; hold?: number };
  /** The run's name in its recording (`source.run`) and its account. */
  name?: string;
  /** A finished weak-eyes run's directory: its comparison goes in this run's account as `weak_eyes`. */
  weakFrom?: string;
  /** Scripted only: the photos the eyes answer with another class, the sources (`<file>` or `<file>#page=N`) whose requests throw, and
   *  the landing pages' first times (default `scripted-pages.json`). */
  wrong?: string[]; fail?: string[]; scriptedPages?: string;
  /** Where the supervisor's progress lines go (a download); default nowhere. */
  log?: (line: string) => void;
  /** The full archive's pages with only the film's landing cuts. */
  filmLanding?: boolean;
  /** At most this many of each lane's items: a trial before a whole run. */
  limit?: number;
};

/** The job's input: what this run reads, and how it asks. */
export function inputOf(options: Options): { input: Record<string, unknown>; selection: Selection } {
  const { dataset, sha256 } = loadDataset(options.dataset);
  const all = select(dataset, options.mode ?? 'full', options.weakEyes ? ['transcript', 'photos'] : undefined, options.filmLanding);
  const selection = options.limit ? { ...all, windows: all.windows.slice(0, options.limit), pages: all.pages.slice(0, options.limit), photos: all.photos.slice(0, options.limit) } : all;
  return { selection, input: { dataset_sha256: sha256, ...selection, span: ACCOUNT_SPAN } };
}

// ---- the run ----------------------------------------------------------------------------------------------------------

async function child() {
  const dir = process.env.DIR!;
  const place = await placeAt(dir);
  const { dataset } = loadDataset(process.env.DATASET || undefined);
  const job = { workflow: workflowOf(dataset.classes), input: JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')) };
  const recorder = process.env.RECORD ? openRecorder({ dir: process.env.RECORD, commits: await packageCommitRecorder() }) : undefined;
  const live = process.env.LIVE === '1';
  const lead = scriptedLead(dataset.classes);
  const fakes: Fakes = {
    model: live ? () => { throw new Error('the live run asks a real model'); } : (messages) => {
      try { return lead(messages); } catch (error) {
        if (process.env.APOLLO_DEBUG) appendFileSync(process.env.APOLLO_DEBUG, `${JSON.stringify({ error: String((error as Error).stack).slice(0, 800), first: JSON.stringify(messages[0]).slice(0, 1500) })}\n`);
        throw error;
      }
    },
    tools: {}, pages: {}, start: 'about:blank', responses: 20_000, tokensPerSecond: live ? 0 : 400,
    judge: async () => { throw new Error('this workflow asks no judge'); },
  };
  const local = localHost(place, fakes, recorder ? { recorder } : {});
  // The images each read showed the eyes, kept with each look and, in a recording, as blobs the viewer's lanes draw.
  const shown = shownImages(recorder ? { keep: (bytes, extension) => recorder.blob(bytes, extension), onShown: (seen) => recorder.live('vision', 'shown', seen, { conv: Number(seen.conversationId) }) } : {});
  local.host.tools = { ...local.host.tools, extensions: [shown.extension] };
  const committed = join(dir, 'looks-committed.jsonl');
  const ids = new Map(dataset.items.map((item) => [fileOf(item), item.id]));
  const [n, hold] = (process.env.SINK_KILL ?? '').split(':').map(Number);
  const common = {
    harness: () => undefined, committed, shown, itemOf: (path: string) => ids.get(path.split('/').at(-1)!) ?? null,
    ...(n ? { sinkKill: { n, hold: hold || 4, waitMs: 3000, done: join(dir, 'sink-kill.done'), request: requestKill(join(dir, 'sink-kill.request')) } } : {}),
  };
  let vision: Parameters<typeof visionOptions>[1];
  if (live) {
    const eyes = process.env.WEAK_EYES === '1' ? WEAK_EYES : EYES;
    local.host.models = liveModels(process.env, [LEAD, eyes]);
    vision = { ...common, eyesModel: eyes };
  } else {
    const typed = typedLines(readFileSync(process.env.TYPED_FILE!, 'utf8'));
    const pages = JSON.parse(readFileSync(process.env.SCRIPTED_PAGES || join(import.meta.dirname, 'scripted-pages.json'), 'utf8')) as PageStarts;
    const set = (name: string) => new Set((process.env[name] ?? '').split(',').filter(Boolean));
    vision = { ...common, eyes: scriptedEyes(dataset, typed, pages, { wrong: set('WRONG'), fail: set('FAIL') }) };
  }
  const runOptions: RunOptions = { vision: (running) => visionOptions(local.host, { ...vision, harness: () => running.harness }) };
  try {
    const result = await run(place, local.host, job, runOptions);
    const leadUsd = Object.values(result.usage.models).reduce((sum, used) => sum + used.cost.total, 0);
    console.log(JSON.stringify({ outcome: { status: result.status, generation: result.generation, lead_usd: leadUsd, ...(result.status === 'refused' ? { code: result.code, message: result.message.slice(0, 300) } : {}), ...(result.status === 'stopped' ? { message: JSON.stringify(result.stop).slice(0, 300) } : {}) } }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: { status: 'error', message: String((error as Error).stack ?? error).slice(0, 600) } }));
  } finally { await recorder?.detach(); }
}

// ---- the supervisor ---------------------------------------------------------------------------------------------------

type Outcome = { status: string; generation?: number; lead_usd?: number; code?: string; message?: string };

/** The keys and settings a live run needs reach the run process; nothing else of this process's environment does. */
const PASSED = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'APOLLO_MODEL_BASE_URL', 'APOLLO_MODEL_API_KEY', 'APOLLO_DEBUG'];
const passed = () => Object.fromEntries(PASSED.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));

function startChild(env: Record<string, string>) {
  const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', SELF, '--child'], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR ?? '/tmp', ...passed(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk; });
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise<{ outcome?: Outcome; signal: string | null; stderr: string }>((resolveDone) => proc.on('close', (_code, signal) => {
    const row = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((parsed) => parsed.outcome);
    resolveDone({ ...(row ? { outcome: row.outcome as Outcome } : {}), signal, stderr: stderr.trim().slice(-1200) });
  }));
  return { proc, done };
}

/** mulberry32, so a storm's gaps are the same for the same seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const linesOf = (file: string) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } };

/** What the run has spent so far: the eyes' committed looks (paid, not kept) and, with a recording, the lead's ended messages. */
function spentUsd(dir: string, record?: string): number {
  let total = linesOf(join(dir, 'looks-committed.jsonl')).reduce((sum, look) => sum + (look.kept || typeof look.cost_usd !== 'number' ? 0 : look.cost_usd), 0);
  if (record && existsSync(join(record, '.spool'))) {
    for (const name of readdirSync(join(record, '.spool'))) {
      if (!name.startsWith('live-')) continue;
      for (const line of linesOf(join(record, '.spool', name))) {
        const message = line.source === 'pi' && line.kind === 'message_end' ? line.data?.message ?? line.data?.entry?.model?.[0] : undefined;
        if (message?.role === 'assistant' && typeof message.usage?.cost?.total === 'number') total += message.usage.cost.total;
      }
    }
  }
  return total;
}

/** The text files of a recording that hold this machine's name, the run's own paths or a key the run was given: kinds only. */
function leaksIn(record: string, own: string[]): string[] {
  const values = [hostname(), ...own, ...PASSED.flatMap((name) => (process.env[name] && process.env[name]!.length >= 8 ? [process.env[name]!] : []))].filter((value) => value.length >= 4);
  const walk = (at: string): string[] => (statSync(at).isDirectory() ? readdirSync(at).flatMap((name) => walk(join(at, name))) : [at]);
  return walk(record).filter((file) => /\.(?:jsonl?|txt|md)$/.test(file)).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return values.some((value) => text.includes(value)) ? [`${file.slice(record.length + 1)}: a machine name, a run path or a key`] : [];
  });
}

export async function apollo(options: Options) {
  const dir = resolve(options.dir ?? join(process.env.TMPDIR ?? '/tmp', `apollo11-${process.pid}`));
  const cache = resolve(options.cache ?? join(process.env.TMPDIR ?? '/tmp', 'apollo11-cache'));
  const record = options.record ? resolve(options.record) : undefined;
  mkdirSync(join(dir, 'work'), { recursive: true });
  const { dataset, sha256 } = loadDataset(options.dataset);
  // The input and the files are fixed once, here, so every process of the run reads the same ones.
  const inputFile = join(dir, 'input.json');
  if (!existsSync(inputFile)) writeFileSync(inputFile, JSON.stringify(inputOf(options).input));
  const selection = JSON.parse(readFileSync(inputFile, 'utf8')) as Selection;
  const reads = itemsOf(dataset, selection);
  const paths = await fetchItems([...reads, itemOf(dataset, TYPED)], cache, options.log);
  await placeFiles(paths, reads, join(dir, 'work'));

  const supervisor = record ? openSupervisor({ dir: record }) : undefined;
  const env = {
    DIR: dir, TYPED_FILE: paths.get(TYPED)!, ...(options.dataset ? { DATASET: resolve(options.dataset) } : {}), ...(record ? { RECORD: record } : {}),
    ...(options.live ? { LIVE: '1' } : {}), ...(options.weakEyes ? { WEAK_EYES: '1' } : {}), ...(options.wrong?.length ? { WRONG: options.wrong.join(',') } : {}),
    ...(options.fail?.length ? { FAIL: options.fail.join(',') } : {}), ...(options.scriptedPages ? { SCRIPTED_PAGES: resolve(options.scriptedPages) } : {}),
    ...(options.sinkKill ? { SINK_KILL: `${options.sinkKill.n}:${options.sinkKill.hold ?? 4}` } : {}),
  };
  const next = random(options.seed ?? 1);
  const maxKills = options.stormMs ? options.kills ?? 3 : 0;
  let kills = 0; let processes = 0; let lookKilled = false; let timedKilled = false; let overBudget = false;
  let last: { outcome?: Outcome; signal: string | null; stderr: string } | undefined;
  for (;;) {
    const { proc, done } = startChild(env);
    processes += 1;
    supervisor?.host('process.started', { gen: processes, pid: proc.pid });
    const kill = (label: string, crossing: { point: string; n: number } | null) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      kills += 1;
      supervisor?.host('kill', { gen: processes, label, crossing });
      proc.kill('SIGKILL');
    };
    const timers: NodeJS.Timeout[] = [];
    // Right after a look is committed: the Nth line of the committed looks, counted across processes, ends the process at once.
    if (options.killAfterLook && !lookKilled) timers.push(setInterval(() => {
      if (lookKilled || linesOf(join(dir, 'looks-committed.jsonl')).length < options.killAfterLook!) return;
      lookKilled = true;
      kill(`after look ${options.killAfterLook}`, { point: 'look.committed', n: options.killAfterLook! });
    }, 5));
    // With both kills the timed one lands in the process after the look kill.
    // Inside the sink: the child parks its filings and asks; the kill and its line are the supervisor's.
    if (options.sinkKill && !existsSync(join(dir, 'sink-kill.done'))) timers.push(setInterval(() => {
      const request = join(dir, 'sink-kill.request');
      if (!existsSync(request)) return;
      const filing = JSON.parse(readFileSync(request, 'utf8')) as { n: number; parked: number };
      kill(`in the sink at filing ${filing.n} (${filing.parked} held)`, { point: 'look.filing', n: filing.n });
      renameSync(request, join(dir, 'sink-kill.done'));
    }, 5));
    if (options.killAtMs && !timedKilled && (!options.killAfterLook || lookKilled)) timers.push(setTimeout(() => { timedKilled = true; kill(`at ${options.killAtMs} ms`, null); }, options.killAtMs));
    if (options.stormMs && kills < maxKills) timers.push(setTimeout(() => kill(`storm ${kills + 1}`, null), Math.round(options.stormMs * (0.67 + next() * 0.66))));
    if (options.maxUsd !== undefined) timers.push(setInterval(() => {
      if (overBudget || spentUsd(dir, record) <= options.maxUsd!) return;
      overBudget = true;
      kill(`budget ${options.maxUsd} reached`, null);
    }, 1000));
    last = await done;
    for (const timer of timers) clearTimeout(timer);
    if (overBudget) { last = { ...last, outcome: { status: 'budget', message: `stopped: the run had spent over $${options.maxUsd}` } }; break; }
    if (last.outcome || last.signal !== 'SIGKILL') break;
  }
  const outcome = last?.outcome;
  const output = outcome?.status === 'complete' ? outputOf(dir) : null;
  const models = { lead: options.live ? publicName(LEAD) : 'scripted lead (pi-ai faux)', eyes: options.live ? publicName(options.weakEyes ? WEAK_EYES : EYES) : 'scripted-eyes', scripted: !options.live };
  const typed = typedLines(readFileSync(paths.get(TYPED)!, 'utf8'));
  const store = join(dir, 'store', 'run.sqlite');
  const name = options.name ?? `apollo11-${options.live ? 'live' : 'scripted'}-${options.mode ?? 'full'}${options.weakEyes ? '-weak-eyes' : ''}`;
  const weak = options.weakFrom ? weakEyesOf(JSON.parse(readFileSync(join(resolve(options.weakFrom), 'account.json'), 'utf8')) as Account) : undefined;
  const account: Account | null = output ? buildAccount(dir, dataset, sha256, output, typed, models, store, name, weak) : null;
  if (account) writeFileSync(join(dir, 'account.json'), `${JSON.stringify(account, null, 1)}\n`);
  let problems: string[] = [];
  let leaks: string[] = [];
  if (record) {
    const recorder = openRecorder({ dir: record });
    let result: { blob: string; title: string } | undefined;
    if (account) {
      result = { blob: recorder.blob(JSON.stringify(account, null, 1), 'json'), title: 'The landing, minute by minute' };
      supervisor!.host('result', { gen: processes, ...result });
    }
    const title = options.title ?? `Apollo 11, read whole (${options.live ? 'live' : 'scripted'}${options.mode === 'quick' ? ', the landing' : ''}${options.weakEyes ? ', weak eyes' : ''}${kills ? `, killed ${kills} time${kills === 1 ? '' : 's'}` : ''})`;
    finishRecording(record, {
      title, task: 'apollo11-read-whole', model: options.live ? publicName(LEAD) : 'scripted', generations: processes, kills, code: codeOf(REPO),
      cost: (lines) => {
        const folded = foldCost(lines as never);
        // A look read back after a kill is not a second payment: the look part is the store's own fold, not one charge per filing.
        const parts = { ...folded.parts, ...(account ? { look: account.counters.cost_usd } : {}) };
        const all = Object.values(parts);
        return { usd: all.length === 0 || all.some((part) => part === null) ? null : all.reduce<number>((sum, part) => sum + (part as number), 0), parts };
      },
      source: { run: name, store }, ...(result ? { result } : {}), providers: options.live ? 'real' : 'scripted',
    });
    const manifestFile = join(record, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, dataset: { file: 'examples/apollo11/dataset.json', sha256 }, models }, null, 2)}\n`);
    const { validateRecording } = await import(new URL('../../scripts/recording/validate.mjs', import.meta.url).href) as { validateRecording(dir: string): { where: string; line?: number; message: string }[] };
    problems = validateRecording(record).map((problem) => `${problem.where}${problem.line === undefined ? '' : `:${problem.line}`} ${problem.message}`);
    leaks = leaksIn(record, [dir, cache, REPO]);
  }
  return { dir, processes, kills, outcome, stderr: last?.stderr ?? '', account, problems, leaks };
}

if (import.meta.main) {
  if (process.argv[2] === '--child') await child().catch((error) => console.log(JSON.stringify({ outcome: { status: 'error', message: String((error as Error).stack ?? error).slice(0, 600) } })));
  else {
    const { values } = parseArgs({ options: {
      quick: { type: 'boolean' }, live: { type: 'boolean' }, 'weak-eyes': { type: 'boolean' }, dataset: { type: 'string' }, dir: { type: 'string' }, cache: { type: 'string' }, record: { type: 'string' }, title: { type: 'string' },
      'film-landing': { type: 'boolean' }, 'kill-in-sink': { type: 'string' }, name: { type: 'string' }, 'weak-from': { type: 'string' }, 'kill-after-look': { type: 'string' }, 'kill-at': { type: 'string' }, storm: { type: 'string' }, kills: { type: 'string' }, seed: { type: 'string' }, 'max-usd': { type: 'string' }, wrong: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' },
    } });
    const number = (value: string | undefined) => (value === undefined ? undefined : Number(value));
    const result = await apollo({
      log: (line) => console.error(line), mode: values.quick ? 'quick' : 'full', ...(values.live ? { live: true } : {}), ...(values['weak-eyes'] ? { weakEyes: true } : {}),
      ...(values.dataset ? { dataset: values.dataset } : {}), ...(values.dir ? { dir: values.dir } : {}), ...(values.cache ? { cache: values.cache } : {}), ...(values.record ? { record: values.record } : {}), ...(values.title ? { title: values.title } : {}),
      ...(values['kill-in-sink'] ? { sinkKill: { n: Number(values['kill-in-sink'].split(':')[0]), ...(values['kill-in-sink'].includes(':') ? { hold: Number(values['kill-in-sink'].split(':')[1]) } : {}) } } : {}),
      ...(values.name ? { name: values.name } : {}), ...(values['film-landing'] ? { filmLanding: true } : {}), ...(values['weak-from'] ? { weakFrom: values['weak-from'] } : {}),
      ...(values['kill-after-look'] ? { killAfterLook: number(values['kill-after-look'])! } : {}), ...(values['kill-at'] ? { killAtMs: number(values['kill-at'])! } : {}),
      ...(values.storm ? { stormMs: number(values.storm)! } : {}), ...(values.kills ? { kills: number(values.kills)! } : {}), ...(values.seed ? { seed: number(values.seed)! } : {}),
      ...(values['max-usd'] ? { maxUsd: number(values['max-usd'])! } : {}), ...(values.wrong ? { wrong: values.wrong.split(',') } : {}), ...(values.limit ? { limit: number(values.limit)! } : {}),
    });
    if (values.json) console.log(JSON.stringify(result));
    else {
      const a = result.account;
      console.log(`Apollo 11, read whole: ${result.outcome?.status ?? 'no outcome'}${result.outcome?.message ? ` (${result.outcome.message})` : ''} after ${result.processes} process${result.processes === 1 ? '' : 'es'} and ${result.kills} kill${result.kills === 1 ? '' : 's'}; run in ${result.dir}`);
      if (a) {
        console.log(`  lead ${a.models.lead}, never shown an image; eyes ${a.models.eyes}`);
        console.log(`  the landing: ${a.entries.length} entries, ${a.entries.reduce((n, e) => n + e.cites.length, 0)} cites resolved, ${a.dropped.length} dropped`);
        console.log(`  photo sort against NASA's captions: ${a.accuracy.overall.right}/${a.accuracy.overall.total} (${Object.entries(a.accuracy.by_class).map(([name, score]) => `${name} ${score.right}/${score.total}`).join(', ')})`);
        console.log(`  times read off the scans: ${a.transcript.times.times} on ${a.transcript.times.pages} pages, ${a.transcript.times.in_typed} in NASA's typed transcript, ${a.transcript.times.not_in_typed.length} not, ${a.transcript.times.unreadable} marked unreadable`);
        console.log(`  looks: paid ${a.counters.paid}, kept ${a.counters.kept}, repeated ${a.counters.repeated}, asked twice ${a.counters.asked_twice}, failed ${a.counters.failed}, eyes cost ${a.counters.cost_usd === null ? `unknown (${a.counters.cost_unknown} look${a.counters.cost_unknown === 1 ? '' : 's'} with no known price)` : `$${a.counters.cost_usd.toFixed(4)}`}`);
      }
      if (result.stderr && result.outcome?.status !== 'complete') console.error(result.stderr);
      if (result.problems.length) console.error(`the recording does not validate:\n${result.problems.slice(0, 10).map((line) => `  ${line}`).join('\n')}`);
      if (result.leaks.length) console.error(`the recording holds what it should not:\n${result.leaks.slice(0, 10).map((line) => `  ${line}`).join('\n')}`);
    }
    if (result.outcome?.status !== 'complete' || result.problems.length || result.leaks.length) process.exitCode = 1;
  }
}
