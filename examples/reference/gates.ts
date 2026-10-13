// Structural gates over the directory a reference run leaves: files exist, JSON parses, counts and cross-references
// hold. None of them reads meaning into prose. `node examples/reference/gates.ts <run>` checks a run of the reference
// job and exits 1 when a gate fails.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { resolveSchemaForWorkflow } from '@parcha/agentrun-dsl';
import { Ajv } from 'ajv';
import type { Job, RunResult } from './assemble.ts';
import type { Fakes, LedgerRow, StatusEvent } from './host.ts';
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
  const receipts = cited.map((path): { path: string; problem?: string; status?: unknown } => {
    const at = resolve(runDir, path);
    if (relative(runDir, at).startsWith('..')) return { path, problem: 'leaves the run directory' };
    if (!existsSync(at)) return { path, problem: 'does not exist' };
    const read = parse(at);
    if (!read.ok) return { path, problem: `does not parse: ${read.error}` };
    const missing = (['tool', 'args', 'status'] as const).filter((field) => read.value[field] === undefined);
    return { path, ...(missing.length ? { problem: `has no ${missing.join(', ')}` } : {}), status: read.value.status as unknown };
  });

  // Two agent steps each start at turn 0, so a model call is its turn in its conversation.
  const ledger = log<LedgerRow>(runDir, 'ledger.jsonl');
  const calls = countBy(ledger.ok ? ledger.rows : [], (row) => (row.kind === 'model' ? `model:${row.name} of ${row.conversation ?? 'an unnamed conversation'}` : `${row.kind}:${row.name}`));
  const callProblems = !ledger.ok ? [ledger.error] : [...calls].flatMap(([call, rows]) => rows[0]!.kind !== 'model' ? (rows.length === 1 ? [] : [`${call} ran ${rows.length} times`])
    : rows.length > 2 ? [`${call} was asked ${rows.length} times`] : rows.length === 2 && rows[0]!.pid === rows[1]!.pid ? [`${call} was asked twice in one process`] : []);

  const events = log<StatusEvent>(runDir, 'events.jsonl');
  const seen = events.ok ? events.rows : [];
  const steps = countBy(seen.flatMap((event) => (event.source === 'workflow' && ['node.start', 'node.end'].includes(event.event.type) ? [event.event] : [])),
    (event) => `${event.label}@${event.executionPath ?? ''}`);
  const sessions = countBy(seen.flatMap((event) => (event.source === 'browser' && 'change' in event ? [event] : [])), (event) => event.row.session.tag);
  const fromEvents = (problems: string[]) => (events.ok ? problems : [events.error]);

  return [
    gate('record-matches-output-schema', schemaProblems, `the record validates against ${job.workflow.output.schemaId}`),
    gate('citations-name-filed-evidence', receipts.flatMap(({ path, problem }) => (problem ? [`${path} ${problem}`] : [])),
      delivered.ok ? `${cited.length} citations, each a parsed receipt with its tool, args and status` : 'no record, nothing cited'),
    gate('no-failed-evidence-cited', receipts.flatMap(({ path, status }) => (status === 'failed' ? [`${path} was filed failed`] : [])),
      `${filed(runDir).filter(({ read }) => read.ok && read.value.status === 'failed').length} receipts filed failed, none cited`),
    gate('fakes-called-once', callProblems, `${calls.size} calls: every tool and judge once, every model turn once or once more in a later process`),
    gate('nodes-end', fromEvents([...steps].flatMap(([step, rows]) => (rows.at(-1)!.type === 'node.end' ? [] : [`${step} started and never ended`]))), `${steps.size} steps, each ended`),
    gate('browser-sessions-released', fromEvents([...sessions].flatMap(([tag, rows]) => (rows.some((row) => row.change === 'released') ? [] : [`${tag} was never released`]))),
      `${sessions.size} sessions, each released`),
  ];
}

if (import.meta.main) {
  const [runDir] = process.argv.slice(2);
  if (!runDir) throw new Error('Usage: node examples/reference/gates.ts <run directory>');
  const report = gates(runDir, reference);
  for (const { id, ok, detail } of report) console.log(`${ok ? 'pass' : 'FAIL'}  ${id}: ${detail}`);
  if (report.some(({ ok }) => !ok)) process.exitCode = 1;
}
