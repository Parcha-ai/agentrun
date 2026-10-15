// SEAM. The reference entry's `demo()` (the template's platform) runs every demo's job; Apollo 11 needs four things from it that are
// agreed and not built yet: a `vision` option that runs on fakes too and files each look (vision.looks, its images, its miss), the
// `vision.filing` kill point that holds the filings reaching the sink, the run's place in a tool's context, and sources.json's checked
// files fetched into the workspace. Until the entry has them, this file is that platform for Apollo 11 alone, with the template's
// flags and `demo()`'s shape, so moving onto the entry changes run.ts's import and deletes this file.
//
//   (none)              fakes, $0, no key: the default, and what CI runs
//   --live              real models (your keys, or a gateway: models.ts); --lead and --eyes name them as provider/id
//   --kill              the spec's kills: here `vision.filing`, the Nth filing held with those reaching the sink after it
//   --record <dir>      an agentrun.recording/1 directory, through the reference recorder
//   --input <path|json> the job's input (the job's own is the default)
//   --max-usd <n>       stops the run past n dollars (default twice the spec's expectedCost)
//   --dir <path>        keeps the run's directory; --cache <path> keeps the checked sources between runs
//   --weak-from <dir>   a finished weak-eyes run's directory: its comparison goes in this run's result as `weak_eyes`
//   --see-also <dir>    the weak-eyes recording this one links (the manifest's `see_also`)
//   --json              the result as one JSON object
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cost as foldCost } from '../reference/fold.ts';
import { codeOf, finishRecording, localHost, openRecorder, openSupervisor, packageCommitRecorder, placeAt, run, type Fakes, type Job } from '../reference/index.ts';
import { lookCounters, resultOf, typedLines, weakEyesOf, type Cited, type Counters } from './account.ts';
import { fetchItems, fileOf, itemOf, itemsFor, loadDataset, placeFiles, type Reads } from './dataset.ts';
import { scriptedEyes, type PageStarts } from './fakes.ts';
import { requestKill, shownImages, visionOptions } from './looks.ts';
import { chooseModels, liveModels, publicName } from './models.ts';
import { TYPED_FILE } from './tools/index.ts';

const REPO = join(import.meta.dirname, '..', '..');
const TYPED = 'transcript-tec-typed';

/** The parts of demo.json this platform acts on. */
export type DemoSpec = { name: string; title?: string; expectedCost?: number; kills?: Array<{ point: string; why: string; n?: number; hold?: number }>; [other: string]: unknown };
export type ApolloDemo = { self: string; spec: DemoSpec; job: Job; fakes: Fakes };

/** `--input <path|json>`: a JSON object, from a file or inline. */
function parseInput(argument: string): Record<string, unknown> {
  const value: unknown = JSON.parse(argument.trimStart().startsWith('{') ? argument : readFileSync(argument, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('--input is a JSON object, or a path to a file of one');
  return value as Record<string, unknown>;
}
/** What a run is told beyond the template's flags: test knobs for the scripted eyes (photos answered with another class, sources whose
 *  requests throw) and the landing pages' first times they answer from. */
export type Knobs = { wrong?: string[]; fail?: string[]; scriptedPages?: string; sources?: string; log?: (line: string) => void };
type Flags = { live?: boolean; kill?: boolean; record?: string; input?: string; 'max-usd'?: string; dir?: string; cache?: string; json?: boolean; lead?: string; eyes?: string; 'weak-from'?: string; 'see-also'?: string; name?: string };

const FLAGS = {
  child: { type: 'boolean' }, live: { type: 'boolean' }, kill: { type: 'boolean' }, record: { type: 'string' }, input: { type: 'string' }, 'max-usd': { type: 'string' }, dir: { type: 'string' },
  cache: { type: 'string' }, json: { type: 'boolean' }, lead: { type: 'string' }, eyes: { type: 'string' }, 'weak-from': { type: 'string' }, 'see-also': { type: 'string' }, name: { type: 'string' },
} as const;

/** The run.ts call: the child with `--child`, else the supervisor with the flags. */
export async function demo(options: ApolloDemo): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: FLAGS });
  if (values.child) return child(options);
  const result = await supervise(options, values, { log: (line) => console.error(line) });
  if (values.json) console.log(JSON.stringify(result));
  else summarize(result);
  if (result.outcome?.status !== 'complete' || result.overBudget || result.problems.length || result.leaks.length) process.exitCode = 1;
}

// ---- the child: one process of the run -------------------------------------------------------------------------------------

async function child(options: ApolloDemo) {
  const env = process.env;
  const dir = env.DIR!;
  const place = await placeAt(dir);
  const { dataset } = loadDataset();
  const input = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')) as Record<string, unknown>;
  const recorder = env.RECORD ? openRecorder({ dir: env.RECORD, commits: await packageCommitRecorder() }) : undefined;
  const live = env.LIVE === '1';
  const local = localHost(place, options.fakes, recorder ? { recorder } : {});
  // The images each read showed the eyes, kept with each look and, in a recording, as blobs the viewer's lanes draw.
  const shown = shownImages(recorder ? { keep: (bytes, extension) => recorder.blob(bytes, extension), onShown: (seen) => recorder.live('vision', 'shown', seen, { conv: Number(seen.conversationId) }) } : {});
  local.host.tools = { ...local.host.tools, extensions: [shown.extension] };
  const ids = new Map(dataset.items.map((item) => [fileOf(item), item.id]));
  const [n, hold] = (env.SINK_KILL ?? '').split(':').map(Number);
  const common = {
    harness: () => undefined, committed: join(dir, 'looks-committed.jsonl'), shown, itemOf: (path: string) => ids.get(path.split('/').at(-1)!) ?? null,
    ...(n ? { sinkKill: { n, hold: hold || 4, waitMs: 3000, done: join(dir, 'sink-kill.done'), request: requestKill(join(dir, 'sink-kill.request')) } } : {}),
  };
  let vision: Parameters<typeof visionOptions>[1];
  if (live) {
    const [lead, eyes] = [env.LEAD_MODEL!, env.EYES_MODEL!].map((name) => ({ provider: name.split('/')[0]!, modelId: name.split('/').slice(1).join('/') }));
    local.host.models = liveModels(env, [lead!, eyes!]);
    vision = { ...common, eyesModel: eyes! };
  } else {
    const typed = typedLines(readFileSync(join(dir, 'work', TYPED_FILE), 'utf8'));
    const pages = JSON.parse(readFileSync(env.SCRIPTED_PAGES || join(import.meta.dirname, 'fakes-pages.json'), 'utf8')) as PageStarts;
    const set = (name: string) => new Set((env[name] ?? '').split(',').filter(Boolean));
    vision = { ...common, eyes: scriptedEyes(dataset, typed, pages, { wrong: set('WRONG'), fail: set('FAIL') }) };
  }
  try {
    const result = await run(place, local.host, { ...options.job, input }, { vision: (running) => visionOptions(local.host, { ...vision, harness: () => running.harness }) });
    console.log(JSON.stringify({ outcome: { status: result.status, generation: result.generation, ...(result.status === 'refused' ? { code: result.code, message: result.message.slice(0, 300) } : {}), ...(result.status === 'stopped' ? { message: JSON.stringify(result.stop).slice(0, 300) } : {}) } }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: { status: 'error', message: String((error as Error).stack ?? error).slice(0, 600) } }));
  } finally { await recorder?.detach(); }
}

// ---- the supervisor ----------------------------------------------------------------------------------------------------------

type Outcome = { status: string; generation?: number; code?: string; message?: string };

/** The keys and settings a live run needs reach the run process; nothing else of this process's environment does. */
const PASSED = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'APOLLO_MODEL_BASE_URL', 'APOLLO_MODEL_API_KEY'];
const passed = () => Object.fromEntries(PASSED.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));

function startChild(self: string, env: Record<string, string>) {
  const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', fileURLToPath(self), '--child'], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR ?? '/tmp', ...passed(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk; });
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise<{ outcome?: Outcome; signal: string | null; stderr: string }>((resolveDone) => proc.on('close', (_code, signal) => {
    const row = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((parsed) => parsed.outcome);
    resolveDone({ ...(row ? { outcome: row.outcome as Outcome } : {}), signal, stderr: stderr.trim().slice(-1200) });
  }));
  return { proc, done };
}

const linesOf = (file: string) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } };

/** What the run has spent so far: the eyes' committed looks, each key's payment once as the counters fold it, and, with a recording,
 *  the lead's ended messages. */
function spentUsd(dir: string, record: string): number {
  const byKey = new Map<string, { kept: boolean; cost_usd: number | null }[]>();
  for (const look of linesOf(join(dir, 'looks-committed.jsonl'))) byKey.set(look.key, [...(byKey.get(look.key) ?? []), look]);
  let total = 0;
  for (const looks of byKey.values()) {
    looks.forEach((look, at) => { if ((!look.kept || at === 0) && typeof look.cost_usd === 'number') total += look.cost_usd; });
  }
  if (existsSync(join(record, '.spool'))) {
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

export type Run = {
  dir: string; processes: number; kills: number; outcome: Outcome | undefined; stderr: string;
  result: Cited | null; counters: Counters | null; models: { lead: string; eyes: string }; recording?: string;
  usd: number | null; maxUsd: number | null; overBudget: boolean; problems: string[]; leaks: string[];
};

/** Runs the job: the checked sources in the workspace, a child per process, the spec's kills with `--kill`, the result, the recording. */
export async function supervise(options: ApolloDemo, flags: Flags, knobs: Knobs = {}): Promise<Run> {
  const { spec } = options;
  if (knobs.sources) process.env.APOLLO_SOURCES = resolve(knobs.sources);
  const dir = resolve(flags.dir ?? join(process.env.TMPDIR ?? '/tmp', `apollo11-${process.pid}-${Date.now()}`));
  const cache = resolve(flags.cache ?? join(process.env.TMPDIR ?? '/tmp', 'apollo11-cache'));
  const record = resolve(flags.record ?? join(dir, 'recording'));
  if (existsSync(join(record, '.spool')) || existsSync(join(record, 'manifest.json'))) throw new Error(`${record} already holds a recording or an unfinished one: record into a directory of its own`);
  mkdirSync(join(dir, 'work'), { recursive: true });
  const { dataset, sha256 } = loadDataset();
  // The input is fixed once, here, so every process of the run reads the same one, and a run resumes only on the sources it began with.
  const inputFile = join(dir, 'input.json');
  const shaFile = join(dir, 'sources.sha256');
  if (!existsSync(inputFile)) {
    writeFileSync(shaFile, sha256);
    writeFileSync(inputFile, JSON.stringify(flags.input ? parseInput(flags.input) : options.job.input));
  }
  const started = existsSync(shaFile) ? readFileSync(shaFile, 'utf8') : '';
  if (started !== sha256) throw Object.assign(new Error(`${dir} started on the sources with SHA-256 ${started || 'unknown'}, and this sources.json's is ${sha256}. Resume it with that file, or start a new directory.`), { code: 'DATASET_CHANGED' });
  const input = JSON.parse(readFileSync(inputFile, 'utf8')) as Reads;
  const reads = itemsFor(dataset, input);
  const paths = await fetchItems([...reads, itemOf(dataset, TYPED)], cache, knobs.log);
  await placeFiles(paths, [...reads, itemOf(dataset, TYPED)], join(dir, 'work'));

  const live = flags.live === true;
  const chosen = live ? chooseModels(process.env, { ...(flags.lead ? { lead: flags.lead } : {}), ...(flags.eyes ? { eyes: flags.eyes } : {}) }) : undefined;
  const models = { lead: chosen ? publicName(chosen.lead) : 'scripted lead (pi-ai faux)', eyes: chosen ? publicName(chosen.eyes) : 'scripted-eyes' };
  const sink = flags.kill ? (spec.kills as Array<{ point: string; n?: number; hold?: number }> | undefined)?.find((kill) => kill.point === 'vision.filing') : undefined;
  const maxUsd = flags['max-usd'] !== undefined ? Number(flags['max-usd']) : typeof spec.expectedCost === 'number' ? spec.expectedCost * 2 : null;
  const supervisor = openSupervisor({ dir: record });
  const env = {
    DIR: dir, RECORD: record, ...(process.env.APOLLO_SOURCES ? { APOLLO_SOURCES: process.env.APOLLO_SOURCES } : {}),
    ...(chosen ? { LIVE: '1', LEAD_MODEL: models.lead, EYES_MODEL: models.eyes } : {}),
    ...(knobs.wrong?.length ? { WRONG: knobs.wrong.join(',') } : {}), ...(knobs.fail?.length ? { FAIL: knobs.fail.join(',') } : {}), ...(knobs.scriptedPages ? { SCRIPTED_PAGES: resolve(knobs.scriptedPages) } : {}),
    ...(sink ? { SINK_KILL: `${sink.n ?? 1}:${sink.hold ?? 1}` } : {}),
  };
  let kills = 0; let processes = 0; let overBudget = false;
  let last: { outcome?: Outcome; signal: string | null; stderr: string } | undefined;
  for (;;) {
    const { proc, done } = startChild(options.self, env);
    processes += 1;
    supervisor.host('process.started', { gen: processes, pid: proc.pid });
    const kill = (label: string, crossing: { point: string; n: number } | null) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      kills += 1;
      supervisor.host('kill', { gen: processes, label, crossing, kind: 'process' });
      proc.kill('SIGKILL');
    };
    const timers: NodeJS.Timeout[] = [];
    // Inside the sink: the child holds its filings and asks; the kill and its line are the supervisor's.
    if (sink && !existsSync(join(dir, 'sink-kill.done'))) timers.push(setInterval(() => {
      const request = join(dir, 'sink-kill.request');
      if (!existsSync(request)) return;
      let filing: { n: number; parked: number };
      try { filing = JSON.parse(readFileSync(request, 'utf8')); } catch { return; }
      kill(`vision.filing ${filing.n} (${filing.parked} held)`, { point: 'vision.filing', n: filing.n });
      renameSync(request, join(dir, 'sink-kill.done'));
    }, 5));
    if (maxUsd !== null) timers.push(setInterval(() => {
      if (overBudget || spentUsd(dir, record) <= maxUsd) return;
      overBudget = true;
      kill('max-usd', null);
    }, 1000));
    last = await done;
    for (const timer of timers) clearTimeout(timer);
    if (overBudget) { last = { ...last, outcome: { status: 'budget', message: `stopped: the run had spent over $${maxUsd}` } }; break; }
    if (last.outcome || last.signal !== 'SIGKILL') break;
  }
  const outcome = last?.outcome;
  const name = flags.name ?? `apollo11-${live ? 'live' : 'scripted'}${flags.input ? `-${basename(flags.input).replace(/\.json$/, '')}` : ''}`;
  const delivered = outcome?.status === 'complete' ? resultOf(dir) : null;
  const weak = flags['weak-from'] ? resultOf(resolve(flags['weak-from'])) : null;
  const weakName = flags['weak-from'] ? readFileSync(join(resolve(flags['weak-from']), 'run-name'), 'utf8').trim() : '';
  const result = delivered ? { ...delivered, apollo11: { ...delivered.apollo11, ...(weak ? { weak_eyes: weakEyesOf(weak, weakName) } : {}) } } : null;
  writeFileSync(join(dir, 'run-name'), name);
  if (result) writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 1)}\n`);
  const counters = outcome?.status === 'complete' ? lookCounters(join(dir, 'store', 'run.sqlite')) : null;
  const recorder = openRecorder({ dir: record });
  const blob = result ? recorder.blob(JSON.stringify(result, null, 1), 'json') : undefined;
  if (blob) supervisor.host('result', { gen: processes, blob, title: result!.title }, { blobs: [blob] });
  const title = `${spec.title ?? spec.name} (${live ? 'live' : 'scripted'}${kills ? `, killed ${kills} time${kills === 1 ? '' : 's'}` : ''})`;
  finishRecording(record, {
    title, task: options.job.workflow.name ?? spec.name, model: chosen ? models.lead : 'scripted', generations: processes, kills, code: codeOf(REPO),
    cost: foldCost, source: { run: name, store: join(dir, 'store', 'run.sqlite') }, ...(blob ? { result: { blob, title: result!.title } } : {}), providers: live ? 'real' : 'scripted',
  });
  const manifestFile = join(record, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { cost: { usd: number | null } } & Record<string, unknown>;
  writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, sources: { file: 'examples/apollo11/sources.json', sha256 }, models, ...(flags['see-also'] ? { see_also: { recording: flags['see-also'], label: 'the same pages and photos through weaker eyes' } } : {}) }, null, 2)}\n`);
  const { validateRecording } = await import(new URL('../../scripts/recording/validate.mjs', import.meta.url).href) as { validateRecording(dir: string): { where: string; line?: number; message: string }[] };
  const problems = validateRecording(record).map((problem) => `${problem.where}${problem.line === undefined ? '' : `:${problem.line}`} ${problem.message}`);
  const leaks = leaksIn(record, [dir, cache, REPO]);
  return { dir, processes, kills, outcome, stderr: last?.stderr ?? '', result, counters, models, ...(flags.record ? { recording: record } : {}), usd: manifest.cost.usd, maxUsd, overBudget, problems, leaks };
}

function summarize(run: Run) {
  console.log(`Apollo 11, read whole: ${run.outcome?.status ?? 'no outcome'}${run.outcome?.message ? ` (${run.outcome.message})` : ''} after ${run.processes} process${run.processes === 1 ? '' : 'es'} and ${run.kills} kill${run.kills === 1 ? '' : 's'}; run in ${run.dir}`);
  console.log(`  lead ${run.models.lead}, never shown an image; eyes ${run.models.eyes}`);
  const a = run.result?.apollo11;
  if (a) {
    console.log(`  the landing: ${a.entries.length} entries, ${a.entries.reduce((n, e) => n + e.cites.length, 0)} cites resolved, ${a.dropped.length} dropped`);
    console.log(`  photo sort against NASA's captions: ${a.accuracy.overall.right}/${a.accuracy.overall.total} (${Object.entries(a.accuracy.by_class).map(([name, score]) => `${name} ${score.right}/${score.total}`).join(', ')})`);
    console.log(`  times read off the scans: ${a.transcript.times.times} on ${a.transcript.times.pages} pages, ${a.transcript.times.in_typed} in NASA's typed transcript, ${a.transcript.times.not_in_typed.length} not, ${a.transcript.times.unreadable} marked unreadable`);
  }
  const c = run.counters;
  if (c) console.log(`  looks: paid ${c.paid}, kept ${c.kept}, repeated ${c.repeated}, asked twice ${c.asked_twice}, failed ${c.failed}, eyes cost ${c.cost_usd === null ? `unknown (${c.cost_unknown} with no known price)` : `$${c.cost_usd.toFixed(4)}`}`);
  console.log(`  cost: ${run.usd === null ? 'unknown' : `$${run.usd.toFixed(4)}`}${run.maxUsd === null ? '' : ` (cap $${run.maxUsd})`}${run.overBudget ? ', over the cap' : ''}${run.recording ? `; recording ${run.recording}` : ''}`);
  if (run.stderr && run.outcome?.status !== 'complete') console.error(run.stderr);
  if (run.problems.length) console.error(`the recording does not validate:\n${run.problems.slice(0, 10).map((line) => `  ${line}`).join('\n')}`);
  if (run.leaks.length) console.error(`the recording holds what it should not:\n${run.leaks.slice(0, 10).map((line) => `  ${line}`).join('\n')}`);
}
