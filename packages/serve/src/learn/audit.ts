// The audit ledger: audits.jsonl at the top of an agent's git learning folder, one JSON row per line, written by the host
// alone (runner/audit.ts, and the server for an owner's grade). A row is one finished audit of a run a promoted learned
// workflow served first: its shadow run's answer (the same agent on the same input, learning off) against the served one
// (source `shadow`), or an owner's grade of the served run (source `grade`, agreed = the grade). The hold rule reads the
// newest rows of the serving revision (holdOf). The engine never reads a row's domain: only whether two answers say the
// same (learn/promote.ts sameAnswer) and what each run cost.
import { createHash } from "node:crypto";
import type { Workspace } from "../workspace/index.js";
import type { AuditLoop } from "../learning-setting.js";
import { AUDITS_FILE, type FolderChange, type FolderRead, readLearning } from "./folder.js";
import { type PromotionRecord, servingOf } from "./promote.js";

export { AUDITS_FILE };

/** The newest rows the ledger keeps: twice the widest window a definition may set (AUDIT_MAX), and a file well under the
 *  folder's file cap (a row is a few hundred bytes). */
export const AUDITS_KEPT = 2_000;
/** What every shadow run's id starts with: its served run's id follows (shadowRunId). No server-minted id starts so. */
export const SHADOW_PREFIX = "audit.";

/** One finished audit. `run`: the served run; `shadow_run`: its shadow (null for a grade's row); `workflow` at `digest`
 *  served it; `agreed`: whether the two answers say the same (a grade's: the grade), null when either answer is missing
 *  (a shadow that failed: no evidence either way, never counted by the hold rule); the two runs' costs (null unknown). */
export interface AuditRow {
  readonly run: string;
  readonly shadow_run: string | null;
  readonly workflow: string;
  readonly digest: string;
  readonly source: "shadow" | "grade";
  readonly agreed: boolean | null;
  readonly served_cost: number | null;
  readonly shadow_cost: number | null;
  readonly at: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Whether served run `runId` is audited at 1 in `k`: the first 8 hex digits of sha256("audit:" + its id), read as a
 *  number, are a multiple of k. A function of the id and k alone, so a claim taken again draws the same. */
export const auditDrawn = (runId: string, k: number): boolean => Number.parseInt(sha256(`audit:${runId}`).slice(0, 8), 16) % Math.max(1, k) === 0;

/** The k a served run is drawn at: `audit_every`, or `audit_every_later` once its revision served `audit_later_after`. */
export const auditEveryOf = (loop: AuditLoop, served: number): number => (served >= loop.audit_later_after ? loop.audit_every_later : loop.audit_every);

/** The shadow run's id for served run `runId`: one per served run, ever (a second create is the store's constraint). */
export const shadowRunId = (runId: string): string => {
  const id = `${SHADOW_PREFIX}${runId}`;
  return id.length <= 128 ? id : `${SHADOW_PREFIX}${sha256(runId).slice(0, 40)}`;
};

/** Whether `runId` is a shadow run's. */
export const isShadowRun = (runId: string): boolean => runId.startsWith(SHADOW_PREFIX);

const isRow = (value: unknown): value is AuditRow => {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const cost = (one: unknown) => one === null || (typeof one === "number" && Number.isFinite(one));
  return typeof row.run === "string" && (row.shadow_run === null || typeof row.shadow_run === "string") && typeof row.workflow === "string" && typeof row.digest === "string"
    && (row.source === "shadow" || row.source === "grade") && (row.agreed === null || typeof row.agreed === "boolean") && cost(row.served_cost) && cost(row.shadow_cost) && typeof row.at === "string";
};

/** The rows of a ledger's text, oldest first; a line that is no row is skipped. */
export function parseAudits(text: string): AuditRow[] {
  const out: AuditRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRow(value)) out.push({ run: value.run, shadow_run: value.shadow_run, workflow: value.workflow, digest: value.digest, source: value.source, agreed: value.agreed, served_cost: value.served_cost, shadow_cost: value.shadow_cost, at: value.at });
    } catch {
      // A torn line is no row.
    }
  }
  return out;
}

/** The ledger's text for `rows`: the newest AUDITS_KEPT, one per line. */
export const auditsText = (rows: readonly AuditRow[]): string => rows.slice(-AUDITS_KEPT).map((row) => JSON.stringify(row)).join("\n") + "\n";

/** The ledger's rows on the folder's main as `folder` reads it (none before the first row). */
export async function auditsOf(folder: FolderRead): Promise<AuditRow[]> {
  const at = folder.snapshot?.audits;
  return at ? parseAudits(await folder.body(AUDITS_FILE, at.oid)) : [];
}

/** The ledger's rows on the folder's main. */
export const readAudits = (ws: Workspace): Promise<AuditRow[]> => readLearning(ws, auditsOf);

/** The change that adds `rows` to the ledger `before` (none when each is there already: a row is one per served run and
 *  source, and per shadow run), with the rows it adds. */
export function auditChange(before: readonly AuditRow[], rows: readonly AuditRow[]): { added: AuditRow[]; change?: FolderChange } {
  const key = (row: AuditRow) => `${row.source}:${row.run}`;
  const known = new Set(before.map(key));
  const added: AuditRow[] = [];
  for (const row of rows) {
    if (known.has(key(row))) continue;
    known.add(key(row));
    added.push(row);
  }
  return added.length ? { added, change: { by: { host: `${added.length} audit row${added.length === 1 ? "" : "s"}` }, writes: [{ path: AUDITS_FILE, text: auditsText([...before, ...added]) }] } } : { added };
}

/** The rows the hold rule counts for `workflow` at `digest`: those with a verdict, the newest `hold_window` of them. */
export const windowOf = (rows: readonly AuditRow[], workflow: string, digest: string, loop: Pick<AuditLoop, "hold_window">): AuditRow[] =>
  rows.filter((row) => row.workflow === workflow && row.digest === digest && row.agreed !== null).slice(-loop.hold_window);

/** The hold rule: the counted rows (windowOf) when at least `hold_disagree` of them disagree, else undefined. */
export function holdOf(rows: readonly AuditRow[], workflow: string, digest: string, loop: Pick<AuditLoop, "hold_window" | "hold_disagree">): { rows: AuditRow[]; disagreed: AuditRow[] } | undefined {
  const counted = windowOf(rows, workflow, digest, loop);
  const disagreed = counted.filter((row) => row.agreed === false);
  return disagreed.length >= loop.hold_disagree ? { rows: counted, disagreed } : undefined;
}

/** A workflow's audit line, as the promotions read shows it: the bar, and the counted rows and disagreements now. */
export type AuditLine = { readonly window: number; readonly disagree: number; readonly rows: number; readonly disagreed: number };
export function auditLineOf(rows: readonly AuditRow[], workflow: string, digest: string, loop: Pick<AuditLoop, "hold_window" | "hold_disagree">): AuditLine {
  const counted = windowOf(rows, workflow, digest, loop);
  return { window: loop.hold_window, disagree: loop.hold_disagree, rows: counted.length, disagreed: counted.filter((row) => row.agreed === false).length };
}

/** What the promotions read says of each learned workflow beside what serves (learn/promote.ts servingOf, in its order):
 *  `state` (`checking`, its newest record is a check at work; `serving`, a revision serves; `stopped`, its newest record
 *  is a hold that stops it; `held`, else), its newest decided check's numbers, and its audit line over the serving (else
 *  the newest) revision's rows. */
export type ServingLine = {
  readonly state: "serving" | "checking" | "held" | "stopped";
  readonly check: { readonly n: number; readonly agreed: number; readonly alone: number; readonly attempt: 1 | 2 } | null;
  readonly audit: AuditLine | null;
};
export function servingLinesOf(records: readonly PromotionRecord[], rows: readonly AuditRow[], loop: Pick<AuditLoop, "hold_window" | "hold_disagree">): ServingLine[] {
  return servingOf(records).map(({ workflow, digest }) => {
    const own = records.filter((one) => one.workflow === workflow);
    const newest = own.at(-1);
    const state = newest?.decided === "replaying" && newest.source === "check" ? "checking"
      : digest !== null ? "serving"
      : newest?.decided === "hold" && (newest.check?.stopped || newest.audit?.stopped) ? "stopped"
      : "held";
    const checked = own.findLast((one) => one.check?.n !== undefined)?.check;
    const at = digest ?? newest?.digest;
    return {
      state,
      check: checked ? { n: checked.n!, agreed: checked.agreed ?? 0, alone: checked.alone ?? 0, attempt: checked.attempt } : null,
      audit: at === undefined ? null : auditLineOf(rows, workflow, at, loop),
    };
  });
}
