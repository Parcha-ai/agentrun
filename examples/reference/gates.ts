// Structural gates over the directory a reference run leaves: files exist, JSON parses, counts and cross-references
// hold. None of them reads meaning into prose. What ran is read from the run's store, through the packages' own
// readers; `events.jsonl` is best effort (a killed process may never write a row) and is for people, not for gates.
// `node examples/reference/gates.ts <run>` checks a run of the reference job and exits 1 when a gate fails.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { resolveSchemaForWorkflow } from '@parcha/agentrun-dsl';
import { nodeAt } from '@parcha/agentrun-dsl/recovery';
import { durableDoc, readJournal } from '@parcha/agentrun-pi/durable';
import type { InventoryRow } from '@parcha/pi-browser';
import { Ajv } from 'ajv';
import { RUN_KEY, type Job, type RunResult } from '@parcha/agentrun-reference';
import type { Fakes, LedgerRow } from '@parcha/agentrun-reference';
import { job as reference } from './job.ts';

/** A job, the fakes it runs on, and what its run must show: its status, the gates that fail, the tools whose receipts
 *  are filed `failed`, and for a refused run its code and a phrase its message keeps. */
export type Case = { name: string; job: Job; fakes: Fakes; expect: { status: RunResult['status']; failing: string[]; filedFailed: string[]; refused?: { code: string; says: string } } };
export type Gate = { id: string; ok: boolean; detail: string };
type Read = { ok: true; value: any } | { ok: false; error: string };

const parse = (path: string): Read => {
  try { return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
};
/** A log of the run, one JSON row per line. Missing or with a line that does not parse, it is no evidence. */
const log = <T,>(runDir: string, name: string): { ok: true; rows: T[] } | { ok: false; error: string } => {
  const path = join(runDir, name);
  if (!existsSync(path)) return { ok: false, error: `no ${name}` };
  const rows: T[] = [];
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (!line) continue;
    try { rows.push(JSON.parse(line) as T); } catch { return { ok: false, error: `${name} line ${index + 1} does not parse` }; }
  }
  return { ok: true, rows };
};
const gate = (id: string, problems: string[], fine: string): Gate => ({ id, ok: problems.length === 0, detail: problems.length ? problems.slice(0, 4).join('; ') : fine });
const countBy = <T,>(items: T[], key: (item: T) => string) => items.reduce((groups, item) => groups.set(key(item), [...(groups.get(key(item)) ?? []), item]), new Map<string, T[]>());

/** Every receipt the run filed: its path under the run, and what it says of itself. */
export function filed(runDir: string): { path: string; read: Read }[] {
  const root = join(runDir, 'evidence');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => relative(runDir, join(entry.parentPath, entry.name))).sort().map((path) => ({ path, read: parse(join(runDir, path)) }));
}

/** A citation is any string in the record that names a path under `evidence/`. */
const citationsOf = (value: unknown): string[] => (typeof value === 'string' ? (value.startsWith('evidence/') ? [value] : [])
  : Array.isArray(value) ? value.flatMap(citationsOf) : value && typeof value === 'object' ? Object.values(value).flatMap(citationsOf) : []);

export function gates(runDir: string, job: Job): Gate[] {
  const out = join(runDir, 'out', 'record.json');
  const delivered: Read = existsSync(out) ? parse(out) : { ok: false, error: 'no out/record.json' };
  const schema = resolveSchemaForWorkflow(job.workflow as never, (job.workflow.schemas as Record<string, Record<string, unknown>>)[job.workflow.output.schemaId]!);
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
  const schemaProblems = !delivered.ok ? [delivered.error]
    : validate(delivered.value.record) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`);

  const cited = delivered.ok ? [...new Set(citationsOf(delivered.value.record))] : [];
  const receipts = cited.map((path): { path: string; problem?: string; status?: unknown; tool?: unknown } => {
    const at = resolve(runDir, path);
    if (relative(runDir, at).startsWith('..')) return { path, problem: 'leaves the run directory' };
    if (!existsSync(at)) return { path, problem: 'does not exist' };
    const read = parse(at);
    if (!read.ok) return { path, problem: `does not parse: ${read.error}` };
    const missing = (['tool', 'args', 'status'] as const).filter((field) => read.value[field] === undefined);
    return { path, ...(missing.length ? { problem: `has no ${missing.join(', ')}` } : {}), status: read.value.status as unknown, tool: read.value.tool as unknown };
  });

  // Two agent steps each start at turn 0, so a model call is its turn in its conversation. A turn a kill cut is asked
  // again by the next process, and again after a second kill: once per process is the rule. What the browser does is
  // the lead's to repeat, so its rows are checked against the record below, not counted here.
  const ledger = log<LedgerRow>(runDir, 'ledger.jsonl');
  const calls = countBy(ledger.ok ? ledger.rows.filter((row) => row.kind !== 'browser') : [], (row) => (row.kind === 'model' ? `model:${row.name} of ${row.conversation ?? 'an unnamed conversation'}` : `${row.kind}:${row.name}`));
  const browserOps = countBy(ledger.ok ? ledger.rows.filter((row) => row.kind === 'browser') : [], (row) => row.name);
  const opsOf = (name: string) => browserOps.get(name)?.length ?? 0;
  const opProblems = !ledger.ok ? [ledger.error] : [
    ...(receipts.some(({ tool }) => tool === 'browser_read') ? ['page.run', 'page.read'].filter((op) => opsOf(op) === 0).map((op) => `the record cites a browser read, and ${op} never ran`) : []),
    ...(opsOf('page.judge') > opsOf('page.read') ? [`${opsOf('page.judge')} page judgments for ${opsOf('page.read')} page reads`] : []),
  ];
  const incarnationOf = (row: LedgerRow) => row.incarnation ?? `pid ${row.pid}`;
  // A judge's answer is recorded before it acts, and a resumed run replays it: a judge is asked again only by the
  // process after one that died between its ask and the record, so every ask but the last ends its process's rows.
  const rows = ledger.ok ? ledger.rows : [];
  const lastOf = new Map(rows.map((row, index) => [incarnationOf(row), index]));
  const at = new Map(rows.map((row, index) => [row, index]));
  const endedAt = (row: LedgerRow) => lastOf.get(incarnationOf(row)) === at.get(row);
  const callProblems = !ledger.ok ? [ledger.error] : [...calls].flatMap(([call, asked]) => {
    if (asked[0]!.kind !== 'model' && asked[0]!.kind !== 'judge') return asked.length === 1 ? [] : [`${call} ran ${asked.length} times`];
    if (new Set(asked.map(incarnationOf)).size < asked.length) return [`${call} was asked twice in one process`];
    return asked[0]!.kind === 'judge' && !asked.slice(0, -1).every(endedAt) ? [`${call} was asked again after a process that went on past it`] : [];
  });

  // The store: the run's journal (each step started and committed) and the browser's inventory (each session not yet
  // released). A run directory with no store holds no evidence of either.
  const store = ((): { ok: true; journal: ReturnType<typeof readJournal>; inventory: InventoryRow[] } | { ok: false; error: string } => {
    const file = join(runDir, 'store', 'run.sqlite');
    if (!existsSync(file)) return { ok: false, error: 'no store/run.sqlite' };
    try {
      return { ok: true, journal: readJournal(file, RUN_KEY), inventory: Object.values(durableDoc<{ rows: Record<string, InventoryRow> }>(file, 'browser.inventory')?.rows ?? {}) };
    } catch (error) { return { ok: false, error: `store/run.sqlite could not be read: ${error instanceof Error ? error.message : String(error)}` }; }
  })();
  const pin = (store.ok ? store.journal?.state as { pin?: { done?: string[]; inputs?: Record<string, string> } } | null | undefined : undefined)?.pin;
  const named = (path: string) => { const node = nodeAt(job.workflow, path) as { label?: string } | undefined; return node?.label ? `${node.label} (${path})` : path; };
  const stepProblems = !store.ok ? [store.error] : !pin ? ['the store holds no journal for the run'] : Object.keys(pin.inputs ?? {}).map((path) => `${named(path)} started and never committed`);
  const sessionProblems = !store.ok ? [store.error] : store.inventory.map((row) => `${row.tag} is ${row.state}`);

  return [
    gate('record-matches-output-schema', schemaProblems, `the record validates against ${job.workflow.output.schemaId}`),
    gate('citations-name-filed-evidence', receipts.flatMap(({ path, problem }) => (problem ? [`${path} ${problem}`] : [])),
      delivered.ok ? `${cited.length} citations, each a parsed receipt with its tool, args and status` : 'no record, nothing cited'),
    gate('no-failed-evidence-cited', receipts.flatMap(({ path, status }) => (status === 'failed' ? [`${path} was filed failed`] : [])),
      `${filed(runDir).filter(({ read }) => read.ok && read.value.status === 'failed').length} receipts filed failed, none cited`),
    gate('fakes-called-once', callProblems, `${calls.size} calls: every tool once, every judge and model turn at most once in each process`),
    gate('browser-ops-ran', opProblems, `${opsOf('page.run')} page runs, ${opsOf('page.read')} reads, ${opsOf('page.judge')} judgments: each cited read rests on a run and a read`),
    gate('nodes-end', stepProblems, `${pin?.done?.length ?? 0} steps committed in the journal, none left started`),
    gate('browser-sessions-released', sessionProblems, 'the browser inventory holds no session'),
  ];
}

if (import.meta.main) {
  const [runDir] = process.argv.slice(2);
  if (!runDir) throw new Error('Usage: node examples/reference/gates.ts <run directory>');
  const report = gates(runDir, reference);
  for (const { id, ok, detail } of report) console.log(`${ok ? 'pass' : 'FAIL'}  ${id}: ${detail}`);
  if (report.some(({ ok }) => !ok)) process.exitCode = 1;
}
