// npm run demo:kill [-- --seed <n>] [-- --kills <n>] [-- --json]: the reference job, killed with SIGKILL at a seeded random
// point ten times, each time resumed by a fresh process on the same directory, then counted. No key, no network beyond
// this machine's loopback. The same seed gives the same plan of kills.
//
// Two processes of this file. The supervisor owns what must outlive a killed process: the fake browser backend (served
// on loopback) and the plan. The child runs the job on the supervisor's backend; it is the one that dies.
//
// A kill lands at a crossing, a named point just before or after a step the job takes: the child counts its crossings
// as it takes them and ends itself with SIGKILL at the planned one; the supervisor counts the browser's calls the child
// makes and ends the child at the planned one, between the call being applied and its answer leaving. A crossing is
// never a clock: where a kill lands is a fact of the run, not of its timing.
//
// The ledger is read from structured data only: the store's committed entries, the receipt files, events.jsonl,
// ledger.jsonl (the host's own row per fake call, appended by every process) and the backend's ledger.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FakeBackend, remoteDriver, remoteProvider } from '@parcha/pi-browser/testing';
import { placeAt, run } from './assemble.ts';
import { localHost, type LedgerRow, type StatusEvent } from './host.ts';
import { fakes, job } from './job.ts';
import { summary } from './run.ts';

const SELF = fileURLToPath(import.meta.url);

// ---- crossings and the plan ---------------------------------------------------------------------------------------------

/** Where a kill is planned: the `n`th crossing one side takes in the process, counted from 1. */
export type Plan = { side: 'child' | 'supervisor'; n: number };
export type Crossing = { side: 'child' | 'supervisor'; n: number; point: string; t: string };

/** mulberry32: a seed is the whole of the supervisor's randomness. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How far the work has got, as the number of an uncut run's crossings on one side that the processes so far have taken in
 *  order: the longest prefix of `reference` that is a subsequence of every process's crossings, one after the other. */
export function progress(reference: string[], processes: string[][]): number {
  let at = 0;
  for (const name of processes.flat()) if (at < reference.length && name === reference[at]) at += 1;
  return at;
}

/** Startup crossings a resumed process takes again before it reaches new work (the browser's reconcile, a node's start). */
const REPLAYED = 3;

/** The plan for the next kill. The side is drawn by the work left on each; the crossing is drawn from a window that
 *  shrinks with the work and the kills left, so ten kills spread over the whole run and none is drawn past its end. */
export function planNext(next: () => number, left: number, remaining: { child: number; supervisor: number }): Plan {
  const total = remaining.child + remaining.supervisor;
  const side = total > 0 && next() * total >= remaining.child ? 'supervisor' : 'child';
  const window = Math.max(2, Math.floor((2 * remaining[side]) / left) + REPLAYED);
  return { side, n: 1 + Math.floor(next() * window) };
}

// ---- the child --------------------------------------------------------------------------------------------------------

/** The child's crossings: written to `CROSS_LOG` as they are taken, so a process that dies leaves them behind, and a
 *  kill planned for this one ends it here. */
function crossings() {
  const log = process.env.CROSS_LOG;
  const at = process.env.KILL_CHILD_AT ? Number(process.env.KILL_CHILD_AT) : undefined;
  let n = 0;
  /** A crossing inside an effect's window (the tool dispatched, its result not yet committed) is logged and never cut:
   *  the driver admitted the effect, so a cut there stops the next process on it as unknown, for an operator. */
  return (point: string, options: { cut?: boolean } = {}) => {
    const cut = options.cut !== false;
    if (cut) n += 1;
    if (log) appendFileSync(log, `${JSON.stringify({ side: 'child', n: cut ? n : 0, point, t: process.hrtime.bigint().toString(), pid: process.pid } satisfies Crossing & { pid: number })}\n`);
    if ((cut && n === at) || point === process.env.KILL_AT_POINT) process.kill(process.pid, 'SIGKILL');
  };
}

/** The reference job, with a crossing before and after each step its host seams show: the tool, the model's request, the
 *  judge, a receipt, the delivery, and one at each row of events the run reports. */
async function child() {
  const cross = crossings();
  const place = await placeAt(process.env.DIR);
  const taps = {
    ...fakes,
    model: (messages: Parameters<typeof fakes.model>[0]) => {
      const turn = messages.filter((message) => message.role === 'toolResult').length;
      cross(`model.request turn ${turn}`);
      const answer = fakes.model(messages);
      cross(`model.answered turn ${turn}`);
      return answer;
    },
    tools: Object.fromEntries(Object.entries(fakes.tools).map(([name, tool]) => [name, (args: Record<string, unknown>) => {
      cross(`tool.dispatch ${name}`, { cut: false });
      const result = tool(args);
      cross(`tool.returned ${name}`, { cut: false });
      return result;
    }])),
    judge: async (request: Parameters<typeof fakes.judge>[0]) => {
      cross(`judge.asked ${request.label}`);
      const answer = await fakes.judge(request);
      cross(`judge.answered ${request.label}`);
      return answer;
    },
  };
  const browser = { provider: () => remoteProvider(process.env.BACKEND!), driver: remoteDriver(process.env.BACKEND!) };
  const local = localHost(place, taps, { browser });
  const { evidence, status, deliver } = local.host;
  local.host.evidence = { file: async (label, record) => { cross(`receipt.filing ${record.tool}`); const filed = await evidence.file(label, record); cross(`receipt.filed ${record.tool}`); return filed; } };
  local.host.status = (event: StatusEvent) => {
    cross(`event ${event.source}.${event.source === 'workflow' ? event.event.type : 'change' in event ? event.change : 'look' in event ? 'look' : 'miss' in event ? 'miss' : 'reconciled'}`);
    return status(event);
  };
  local.host.deliver = async (result) => { cross('deliver.writing'); await deliver(result); cross('deliver.written'); };
  try {
    const result = await run(place, local.host, job);
    console.log(JSON.stringify({ outcome: { status: result.status, generation: result.generation }, view: summary(place, result, local) }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: { status: 'error', code: (error as { code?: string }).code ?? null, message: String((error as Error).message).slice(0, 200) } }));
  }
}

// ---- the supervisor ---------------------------------------------------------------------------------------------------

type Process = { exit: number | string | null; signal: string | null; outcome?: { status: string; generation?: number; code?: string | null; message?: string }; view?: ReturnType<typeof summary>; stderr: string };

function spawnChild(env: Record<string, string>, onSpawn: (pid: number) => void): Promise<Process> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', SELF, '--child'], { env: { PATH: process.env.PATH!, HOME: env.HOME!, TMPDIR: env.TMPDIR!, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn(child.pid!);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const row = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((parsed) => parsed.outcome);
      resolve({ exit: signal ?? code, signal, ...(row ? { outcome: row.outcome, view: row.view } : {}), stderr: stderr.trim().slice(0, 400) });
    });
  });
}

/** The backend the child reaches over loopback, whose every call is a supervisor crossing: before it is applied, and after
 *  it is applied and before its answer leaves. A kill planned for one ends the child there and never answers. */
function watchedBackend() {
  const backend = new FakeBackend({ start: fakes.start, pages: fakes.pages });
  const state: { pid?: number; n: number; plan?: Plan; seen: Crossing[]; killed?: Crossing } = { n: 0, seen: [] };
  const cross = async (point: string) => {
    state.n += 1;
    const crossing: Crossing = { side: 'supervisor', n: state.n, point, t: process.hrtime.bigint().toString() };
    state.seen.push(crossing);
    if (state.plan?.side === 'supervisor' && state.plan.n === state.n && state.pid !== undefined) {
      state.killed = crossing;
      process.kill(state.pid, 'SIGKILL');
      await new Promise<never>(() => {});
    }
  };
  // The calls the child makes over loopback: the provider's own methods, and the driver's seven operations. Not the
  // helpers the face calls on itself, which return at once.
  const calls: Array<[string, Record<string, unknown>, string[]]> = [
    ['provider', backend.provider as unknown as Record<string, unknown>, Object.keys(backend.provider).filter((key) => typeof (backend.provider as unknown as Record<string, unknown>)[key] === 'function')],
    ['driver', backend.driverFace as unknown as Record<string, unknown>, ['connect', 'snapshot', 'run', 'url', 'screenshot', 'page', 'close']],
  ];
  for (const [face, holder, keys] of calls) {
    for (const key of keys) {
      const original = holder[key] as (...a: unknown[]) => unknown;
      holder[key] = async function (this: unknown, ...args: unknown[]) {
        await cross(`browser.applying ${face}.${key}`);
        const result = await original.apply(this, args);
        await cross(`browser.applied ${face}.${key}`);
        return result;
      };
    }
  }
  return { backend, state };
}

type Counted = ReturnType<typeof count>;

/** The run directory as structured data: the store's committed entries, the receipts, the events and the host's ledger. */
export function count(dir: string, backend: FakeBackend) {
  const rows = <T,>(file: string): T[] => { try { return readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T); } catch { return []; } };
  const ledger = rows<LedgerRow>('ledger.jsonl');
  const events = rows<StatusEvent>('events.jsonl');
  const tally = (keys: string[]) => keys.reduce<Record<string, number>>((counts, key) => ({ ...counts, [key]: (counts[key] ?? 0) + 1 }), {});
  const requests = ledger.filter((row) => row.kind === 'model');
  const receipts = (() => { try { return readdirSync(join(dir, 'evidence'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name))).sort(); } catch { return []; } })();
  return {
    // The model's turns as the store committed them: one entry per assistant message.
    committedTurns: committed(dir).turns,
    toolResults: committed(dir).results,
    requests: tally(requests.map((row) => row.name)),
    requestPids: Object.fromEntries([...new Set(requests.map((row) => row.name))].map((name) => [name, requests.filter((row) => row.name === name).map((row) => row.pid)])),
    effects: tally(ledger.filter((row) => row.kind === 'tool').map((row) => row.name)),
    judge: tally(ledger.filter((row) => row.kind === 'judge').map((row) => row.name)),
    receipts,
    looks: events.filter((event) => event.source === 'vision' && 'look' in event).length,
    browser: tally([...backend.ledger.map((row) => row.op), ...backend.dispatched.map((row) => `page.${row.op}`)]),
    workflowEvents: tally(events.filter((event): event is Extract<StatusEvent, { source: 'workflow' }> => event.source === 'workflow').map((event) => event.event.type)),
  };
}

/** What the run's store committed, in order: each assistant message by the tools it called, each tool result by the tool and
 *  whether it was an error. */
function committed(dir: string): { turns: string[]; results: Array<{ tool: string; error: boolean }> } {
  const file = join(dir, 'store', 'run.sqlite');
  if (!existsSync(file)) return { turns: [], results: [] };
  const { DatabaseSync } = require_('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    const records = (db.prepare('SELECT record FROM entries ORDER BY id').all() as Array<{ record: string }>)
      .map((row) => JSON.parse(row.record) as { kind?: string; model?: Array<{ content?: Array<{ type?: string; name?: string }>; toolName?: string; isError?: boolean }> });
    return {
      turns: records.filter((record) => record.kind === 'pi.assistant').map((record) => (record.model?.[0]?.content ?? []).filter((block) => block.type === 'toolCall').map((block) => block.name).join('+') || 'text'),
      results: records.filter((record) => record.kind === 'pi.tool-result').map((record) => ({ tool: record.model?.[0]?.toolName ?? '', error: record.model?.[0]?.isError === true })),
    };
  } finally { db.close(); }
}
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

export type Kill = { process: number; plan: Plan; landed: Crossing | null; generation: number | null; ms: number; outcome?: string };
export type Ledger = {
  seed: number;
  kills: Kill[];
  processes: number;
  final: { status: string; generation: number | null; record: unknown };
  browserCalls: string[];
  /** The kills that landed while the browser's first tool (the page action) was running, by process number. */
  runInterrupted: number[];
  counted: Counted;
  reference: Counted;
  checks: Array<{ name: string; ok: boolean; detail?: unknown }>;
  ms: number;
};

/** One census run of the job, uncut, in a directory of its own: the reference every cut run is held to. */
async function whole(scratch: string, name: string, plan?: (seen: Crossing[]) => void) {
  const dir = join(scratch, name);
  const { backend, state } = watchedBackend();
  const served = await backend.serve();
  const log = join(scratch, `${name}.crossings.jsonl`);
  try {
    const result = await spawnChild({ HOME: scratch, TMPDIR: scratch, DIR: dir, BACKEND: served.url, CROSS_LOG: log }, (pid) => { state.pid = pid; });
    plan?.(state.seen);
    const child = (() => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Crossing); } catch { return [] as Crossing[]; } })();
    return { dir, result, backend, supervisor: state.seen, child, counted: count(dir, backend) };
  } finally { await served.close(); }
}

/** The one cut the draw leaves out: inside the effect's window. The first process ends at `point` (the tool dispatched, its
 *  result not committed); the second finds the effect admitted and never completed, refuses it, and the tool is not
 *  dispatched again. */
export async function cutInEffectWindow(point = 'tool.dispatch search') {
  const scratch = await mkdtemp(join(tmpdir(), 'agentrun-kill-'));
  const { backend, state } = watchedBackend();
  const served = await backend.serve();
  try {
    const env = { HOME: scratch, TMPDIR: scratch, DIR: join(scratch, 'run'), BACKEND: served.url };
    const killed = await spawnChild({ ...env, KILL_AT_POINT: point }, (pid) => { state.pid = pid; });
    const resumed = await spawnChild(env, (pid) => { state.pid = pid; });
    return { killed: killed.signal, resumed: resumed.outcome, effects: count(join(scratch, 'run'), backend).effects };
  } finally { await served.close(); await rm(scratch, { recursive: true, force: true }); }
}

export async function killAnywhere(options: { seed: number; kills: number; keep?: boolean }): Promise<Ledger> {
  const started = Date.now();
  const scratch = await mkdtemp(join(tmpdir(), 'agentrun-kill-'));
  try {
    // The reference: the job uncut. It also counts the crossings a whole run takes, which the plan draws from.
    const reference = await whole(scratch, 'reference');
    if (reference.result.outcome?.status !== 'complete') throw new Error(`the uncut job did not complete: ${JSON.stringify(reference.result.outcome ?? reference.result.stderr)}`);
    
    const dir = join(scratch, 'cut');
    const { backend, state } = watchedBackend();
    const served = await backend.serve();
    const kills: Kill[] = [];
    let last: Process | undefined;
    let processes = 0;
    try {
      const next = random(options.seed);
      const refNames = { child: reference.child.map((crossing) => crossing.point), supervisor: reference.supervisor.map((crossing) => crossing.point) };
      const taken: Record<'child' | 'supervisor', string[][]> = { child: [], supervisor: [] };
      let finished = false;
      for (let index = 0; ; index += 1) {
        // A plan the process did not reach is drawn again: ten kills means ten that landed.
        const left = options.kills - kills.filter((kill) => kill.landed).length;
        // Once a process has completed the run, a later cut is a resume of a finished run: its first crossing is always taken.
        const planned: Plan | undefined = left <= 0 ? undefined : finished ? { side: 'child', n: 1 + Math.floor(next() * 3) }
          : planNext(next, left, { child: refNames.child.length - progress(refNames.child, taken.child), supervisor: refNames.supervisor.length - progress(refNames.supervisor, taken.supervisor) });
        const log = join(scratch, `cut-${index}.crossings.jsonl`);
        state.n = 0; state.seen = []; delete state.killed; delete state.pid; delete state.plan;
        if (planned?.side === 'supervisor') state.plan = planned;
        processes += 1;
        const began = Date.now();
        last = await spawnChild({ HOME: scratch, TMPDIR: scratch, DIR: dir, BACKEND: served.url, CROSS_LOG: log, ...(planned?.side === 'child' ? { KILL_CHILD_AT: String(planned.n) } : {}) }, (pid) => { state.pid = pid; });
        const own = (() => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Crossing); } catch { return [] as Crossing[]; } })();
        taken.child.push(own.map((crossing) => crossing.point));
        taken.supervisor.push(state.seen.map((crossing) => crossing.point));
        if (!planned) break;
        const landed = last.signal === 'SIGKILL' ? (planned.side === 'supervisor' ? state.killed ?? null : own.at(-1) ?? null) : null;
        kills.push({ process: index + 1, plan: planned, landed, generation: last.outcome?.generation ?? null, ms: Date.now() - began, ...(last.outcome ? { outcome: `${last.outcome.status}${last.outcome.code ? ` ${last.outcome.code}` : ''}` } : {}) });
        // A process that ended without the planned kill ended the run: the plan named a crossing it did not reach.
        if (last.signal !== 'SIGKILL') finished = true;
      }
    } finally { await served.close(); }

    const counted = count(dir, backend);
    const record = (() => { try { return JSON.parse(readFileSync(join(dir, 'out', 'record.json'), 'utf8')); } catch { return null; } })();
    const wanted = (() => { try { return JSON.parse(readFileSync(join(reference.dir, 'out', 'record.json'), 'utf8')); } catch { return null; } })();
    const ref = reference.counted;
    const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const landed = kills.filter((kill) => kill.landed);
    /** The kills that landed at one of `points`: the ones that explain a repeat of the work inside them. */
    const cutAt = (points: RegExp) => landed.filter((kill) => points.test(`${kill.landed!.side} ${kill.landed!.point}`)).map((kill) => ({ kill: kill.process, at: kill.landed!.point }));
    const times = (table: Record<string, number>, name: string) => table[name] ?? 0;
    const interrupted = (tool: string) => counted.toolResults.some((result) => result.tool === tool && result.error);
    // Work a kill can repeat, and the crossings that sit inside it: after the work began and before its result was committed.
    const repeats = Object.keys(counted.requests).map((turn) => ({ what: `model ${turn}`, times: times(counted.requests, turn), allowed: 1, causes: cutAt(new RegExp(`^child model\\.(request|answered) ${turn}$`)), pids: counted.requestPids[turn] }))
      .concat([
        { what: 'judge verdict', times: times(counted.judge, 'verdict'), allowed: 1, causes: cutAt(/^child judge\.(asked|answered) verdict$/), pids: [] },
        { what: 'browser read', times: times(counted.browser, 'page.read'), allowed: 1, causes: cutAt(/^(child receipt\.(filing|filed) browser_read|supervisor browser\.applied driver\.page)$/), pids: [] },
        { what: 'vision look', times: counted.looks, allowed: 1, causes: cutAt(/^(child receipt\.(filing|filed) look|child event vision\.look)$/), pids: [] },
      ]);
    const eq1 = (n: number) => n === 1;
    const checks: Ledger['checks'] = [
      { name: `${options.kills} kills landed`, ok: landed.length === options.kills, detail: landed.length },
      { name: 'the last process completed the run', ok: last?.outcome?.status === 'complete', detail: last?.outcome ?? last?.stderr },
      { name: 'the delivered record equals the uninterrupted run\'s', ok: record !== null && eq(record, wanted) },
      { name: 'every effect (the search) was made exactly once', ok: eq(counted.effects, ref.effects), detail: counted.effects },
      { name: 'the browser session was created once and released once', ok: eq1(times(counted.browser, 'create')) && eq1(times(counted.browser, 'release')), detail: counted.browser },
      { name: 'the browser\'s page action ran at most once; not at all only where a kill interrupted its tool', ok: times(counted.browser, 'page.run') === 1 || (times(counted.browser, 'page.run') === 0 && interrupted('run')), detail: { 'page.run': times(counted.browser, 'page.run'), interrupted: counted.toolResults.filter((result) => result.error).map((result) => result.tool) } },
      { name: 'every committed model turn exactly once, in order', ok: eq(counted.committedTurns, ref.committedTurns), detail: counted.committedTurns },
      { name: 'the same receipts, each filed once', ok: eq(counted.receipts, ref.receipts), detail: counted.receipts },
      { name: 'a model turn, the judge, a browser read or a vision look is repeated only when a kill landed inside it, once per such kill, in a later process', ok: repeats.every(({ times: n, allowed, causes, pids }) => n >= 1 && n - allowed <= causes.length && (pids.length === 0 || new Set(pids).size === n)), detail: repeats.filter(({ times: n }) => n > 1).map(({ what, times: n, causes }) => ({ what, asked: n, cutBy: causes })) },
    ];
    // The window of the page action's tool in an uncut run: from the model asking for it to the next turn's request.
    const order = [...reference.child, ...reference.supervisor].sort((a, b) => (BigInt(a.t) < BigInt(b.t) ? -1 : 1));
    const from = order.findIndex((crossing) => crossing.point === 'model.answered turn 0');
    const to = order.findIndex((crossing) => crossing.point === 'model.request turn 1');
    const inRun = new Set(order.slice(from + 1, to).map((crossing) => `${crossing.side} ${crossing.point}`));
    const runInterrupted = landed.filter((kill) => inRun.has(`${kill.landed!.side} ${kill.landed!.point}`)).map((kill) => kill.process);
    const browserCalls = backend.ledger.map((row) => row.op);
    return { seed: options.seed, kills, processes, browserCalls, runInterrupted, final: { status: last?.outcome?.status ?? 'unknown', generation: last?.outcome?.generation ?? null, record }, counted, reference: ref, checks, ms: Date.now() - started };
  } finally {
    if (!options.keep) await rm(scratch, { recursive: true, force: true });
  }
}

/** The ledger as the lines `npm run demo:kill` prints. */
export function render(ledger: Ledger): string[] {
  const table = (counts: Record<string, number>) => Object.entries(counts).map(([name, n]) => `${name} x${n}`).join(', ');
  const runs = ledger.counted.browser['page.run'] ?? 0;
  const again = ledger.checks.find((check) => check.name.startsWith('a model turn'))?.detail as Array<{ what: string; asked: number; cutBy: Array<{ kill: number; at: string }> }> | undefined;
  return [
    `seed ${ledger.seed} (the same seed gives the same plan)`,
    ...ledger.kills.map((kill) => `  kill ${String(kill.process).padStart(2)}  ${kill.landed ? `cut at ${kill.landed.side} ${kill.landed.point}  (${(kill.ms / 1000).toFixed(1)} s)` : `did not land: ${kill.plan.side} crossing #${kill.plan.n} was not reached  (${(kill.ms / 1000).toFixed(1)} s, ${kill.outcome ?? 'no outcome'}), drawn again`}`),
    `${ledger.processes} processes, generation ${ledger.final.generation}, final status ${ledger.final.status}, ${(ledger.ms / 1000).toFixed(1)} s`,
    '',
    `committed model turns   ${ledger.counted.committedTurns.join(', ')}`,
    `model requests          ${table(ledger.counted.requests)}`,
    `effects                 ${table(ledger.counted.effects)}`,
    `browser                 ${table(ledger.counted.browser)}`,
    `page.run                x${runs}${runs === 0 ? `: errored run result committed (kill ${ledger.runInterrupted.join(', ') || 'none landed in its window'})` : ''}`,
    `judge                   ${table(ledger.counted.judge)}`,
    `receipts                ${ledger.counted.receipts.join(', ')}`,
    '',
    ...ledger.checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'}  ${check.name}`),
    ...(again ?? []).map((row) => `      ${row.what} done ${row.asked}x: kills inside it: ${row.cutBy.map((cut) => `${cut.kill} (${cut.at})`).join(', ') || 'none'}`),
    '',
    'What the claims are:',
    '  - A paid effect (the search) is made exactly once. A kill between its dispatch and its commit is not drawn: it stops the run on',
    '    FROZEN_EFFECT_UNKNOWN, by design, so the call is never made twice. A host with a reconcile resumes there instead.',
    '  - The browser\'s page action (page.run) is made at most once: its outcome, if unknown, is never repeated. The scripted model',
    '    ignores an errored run result, so the record being equal to the uninterrupted run\'s does not prove the action happened.',
    '  - page.read may repeat, each repeat tied to a kill inside it; its receipt is named by its content and filed once.',
    '  - A model turn or the judge is asked again only after a kill landed inside it, in a later process; a committed turn is never repeated.',
  ];
}

if (import.meta.main) {
  if (process.argv[2] === '--child') await child();
  else {
    const { values } = parseArgs({ options: { seed: { type: 'string' }, kills: { type: 'string' }, json: { type: 'boolean' }, keep: { type: 'boolean' } } });
    const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(values.seed);
    const ledger = await killAnywhere({ seed, kills: values.kills === undefined ? 10 : Number(values.kills), keep: values.keep === true });
    if (values.json) console.log(JSON.stringify(ledger));
    else console.log(render(ledger).join('\n'));
    if (ledger.checks.some((check) => !check.ok)) process.exitCode = 1;
  }
}
