// The audit ledger: audits.jsonl at the top of an agent's git learning folder, one JSON line each, appended by the host
// alone (runner/audit.ts, and the server for an owner's grade). A `started` line is a shadow audit begun (written before
// its shadow run is created); a row is one finished audit of a run a promoted learned workflow served first: its shadow
// run's answer (the same agent on the same input, learning off) against the served one (source `shadow`, the started
// line's result), or an owner's grade of the served run (source `grade`, agreed = the grade). The open audits are the
// started lines with no result row: settlement reads their two runs by id, so none is ever lost to a window of runs.
// Each line keeps the promotion it counts for (`promoted_at`), and the hold rule reads the newest rows of the serving
// revision's current promotion (holdOf). The engine never reads a row's domain: only whether two answers say the same
// (learn/promote.ts sameAnswer) and what each run cost.
import { createHash } from "node:crypto";
import { COMPUTER_TOOLS } from "@parcha/agentrun-kernel/kernel";
import type { LearningStore } from "./store.js";
import type { AuditLoop } from "../learning-setting.js";
import type { McpPin } from "../mcp-gateway.js";
import type { RunLaunch } from "../run-launch.js";
import { pinAnnotations, toolClassOf, toolWord } from "./replay-calls.js";
import { AUDITS_FILE, type FolderChange, type FolderRead, readLearning } from "./folder.js";
import { type CostStop, type PromotionRecord, promotionStartOf, servingOf, type ServingState, servingStateOf } from "./promote.js";

export { AUDITS_FILE };

/** The newest rows the ledger keeps: twice the widest window a definition may set (AUDIT_MAX), and a file well under the
 *  folder's file cap (a line is a few hundred bytes); with them, the started lines of theirs, and every open one. */
export const AUDITS_KEPT = 2_000;
/** What every shadow run's id starts with: its served run's id follows (shadowRunId). No server-minted id starts so. */
export const SHADOW_PREFIX = "audit.";

/** One finished audit. `run`: the served run; `shadow_run`: its shadow (null for a grade's row, or one never started);
 *  `workflow` at `digest` served it, under the promotion begun at `promoted_at` (learn/promote.ts promotionStartOf: the
 *  one serving when its shadow started, or at the grade; null: none); `agreed`: whether the two answers say the same (a
 *  grade's: the grade), null when either answer is missing (a shadow that failed, parked or never ran: no evidence either
 *  way, never counted by the hold rule); the two runs' costs (null unknown). `turn`: the served run's answer the audit is
 *  of, the id of its answer row (its newest final answer when the audit began, or at the grade): a follow-up's later
 *  answer is never the one compared; absent when it had none. `skipped`: a drawn run whose cap left its shadow no
 *  allowance (less than a run's smallest cap): no shadow was started. `parked`: its shadow came to wait on a person (an
 *  approval, a question, a raise of its cap: what the served run's cap left) and ended there, so it has no answer. */
export interface AuditRow {
  readonly run: string;
  readonly shadow_run: string | null;
  readonly workflow: string;
  readonly digest: string;
  readonly promoted_at: string | null;
  readonly source: "shadow" | "grade";
  readonly agreed: boolean | null;
  readonly served_cost: number | null;
  readonly shadow_cost: number | null;
  readonly turn?: string;
  readonly skipped?: "no allowance";
  readonly parked?: true;
  readonly at: string;
}

/** A shadow audit begun (runner/audit.ts startAudit), written before its shadow run is created: open until a row of
 *  source `shadow` for the same `run` is written. `turn`: the served run's answer row it audits (AuditRow.turn). */
export interface AuditStarted {
  readonly source: "started";
  readonly run: string;
  readonly shadow_run: string;
  readonly workflow: string;
  readonly digest: string;
  readonly promoted_at: string | null;
  readonly turn?: string;
  readonly at: string;
}

/** One line of the ledger, in the order written. */
export type LedgerLine = AuditRow | AuditStarted;

/** The rows of `lines` (the finished audits), oldest first. */
export const rowsOf = (lines: readonly LedgerLine[]): AuditRow[] => lines.filter((line): line is AuditRow => line.source !== "started");

/** The started lines of `lines` with no result row yet: the audits settlement still owes, oldest first. */
export function openAudits(lines: readonly LedgerLine[]): AuditStarted[] {
  const done = new Set(lines.filter((line) => line.source === "shadow").map((line) => line.run));
  return lines.filter((line): line is AuditStarted => line.source === "started" && !done.has(line.run));
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

/** The tools an agent's computer brings beside its grants (a browser's one tool, a desktop's or a phone's kernel tools). */
const broughtBy = (computer: unknown): readonly string[] => {
  const kind = (computer as { kind?: unknown } | null | undefined)?.kind;
  return kind === "browser" ? ["browser"] : kind === "desktop" || kind === "phone" ? COMPUTER_TOOLS : [];
};

/** The first tool agent revision `revision` can call (its grants, and what its computer brings) that is not read-only by
 *  the rule a check's replay skips a write by (learn/replay-calls.ts toolClassOf: an MCP tool by its pinned annotations,
 *  readOnlyHint, a built-in by READ_TOOLS); undefined when every one only reads. An agent that can call one is never
 *  audited: its shadow, a second run of the agent on the same input, could do that write again. */
export function auditWriterOf(revision: { readonly body: unknown; readonly mcpPin: unknown } | undefined): string | undefined {
  const body = revision?.body as { tools?: unknown; computer?: unknown } | undefined;
  const granted = Array.isArray(body?.tools) ? body.tools.filter((tool): tool is string => typeof tool === "string") : [];
  const annotations = pinAnnotations(revision?.mcpPin as McpPin | null | undefined);
  return [...granted, ...broughtBy(body?.computer)].find((tool) => toolClassOf(tool, annotations) !== "read");
}

/** What the promotions read says of an agent never audited (auditWriterOf names `tool`). */
export const auditsOffWords = (tool: string): string => `audits off: ${toolWord(tool)} can write`;

/** Whether a served run's launch can be audited: started over the API (no trigger, no origin of its first message) with no
 *  uploaded files. A triggered run's context (a GitHub event's checkout, the thread it answers on) is never rebuilt for a
 *  shadow, which could answer there too: its served run is not auditable (its record's metrics.not_auditable). */
export const auditableLaunch = (launch: Pick<RunLaunch, "trigger" | "inputOrigin" | "files">): boolean => !launch.trigger && !launch.inputOrigin && !launch.files?.length;

const isLine = (value: unknown): value is LedgerLine => {
  if (value === null || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  const cost = (one: unknown) => one === null || (typeof one === "number" && Number.isFinite(one));
  const common = typeof line.run === "string" && typeof line.workflow === "string" && typeof line.digest === "string" && (line.promoted_at === null || typeof line.promoted_at === "string")
    && (line.turn === undefined || typeof line.turn === "string") && typeof line.at === "string";
  if (line.source === "started") return common && typeof line.shadow_run === "string";
  return common && (line.shadow_run === null || typeof line.shadow_run === "string") && (line.source === "shadow" || line.source === "grade")
    && (line.agreed === null || typeof line.agreed === "boolean") && cost(line.served_cost) && cost(line.shadow_cost);
};

/** Why a row has no verdict, as written (AuditRow.skipped, AuditRow.parked): never one of a row with one. */
const noVerdictOf = (line: AuditRow): Pick<AuditRow, "skipped" | "parked"> =>
  line.agreed !== null ? {} : line.skipped === "no allowance" ? { skipped: "no allowance" } : line.parked === true ? { parked: true } : {};

/** A line's turn (AuditRow.turn), as written: none when it has none. */
const turnOf = (line: { readonly turn?: string }): Pick<AuditRow, "turn"> => (line.turn === undefined ? {} : { turn: line.turn });

/** The lines of a ledger's text, in the order written; one out of shape is skipped. */
export function parseLedger(text: string): LedgerLine[] {
  const out: LedgerLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!isLine(value)) continue;
      const { run, workflow, digest, promoted_at, at } = value;
      out.push(value.source === "started"
        ? { source: "started", run, shadow_run: value.shadow_run, workflow, digest, promoted_at, ...turnOf(value), at }
        : { run, shadow_run: value.shadow_run, workflow, digest, promoted_at, source: value.source, agreed: value.agreed, served_cost: value.served_cost, shadow_cost: value.shadow_cost, ...turnOf(value), ...noVerdictOf(value), at });
    } catch {
      // A torn line is no line.
    }
  }
  return out;
}

/** The ledger's text for `lines`: from the AUDITS_KEPT-th newest row on, and every open started line before it. */
export function auditsText(lines: readonly LedgerLine[]): string {
  const rows = lines.flatMap((line, i) => (line.source === "started" ? [] : [i]));
  const from = rows.length > AUDITS_KEPT ? rows[rows.length - AUDITS_KEPT]! : 0;
  const open = new Set<LedgerLine>(openAudits(lines));
  return lines.filter((line, i) => i >= from || open.has(line)).map((line) => JSON.stringify(line)).join("\n") + "\n";
}

/** The ledger's lines on the folder's main as `folder` reads it (none before the first). */
export async function ledgerOf(folder: FolderRead): Promise<LedgerLine[]> {
  const at = folder.snapshot?.audits;
  return at ? parseLedger(await folder.body(AUDITS_FILE, at.oid)) : [];
}

/** The ledger's rows on the folder's main: its finished audits, oldest first. */
export const readAudits = async (store: LearningStore): Promise<AuditRow[]> => rowsOf(await readLearning(store, ledgerOf));

/** A line's place in the ledger: one per served run and source (a started line's, its shadow's row, a grade's row). */
export const lineKey = (line: LedgerLine): string => `${line.source}:${line.run}`;

/** The change that appends `lines` to the ledger `before` (none when each is there already: lineKey), with the lines it
 *  appends. */
export function auditChange(before: readonly LedgerLine[], lines: readonly LedgerLine[]): { added: LedgerLine[]; change?: FolderChange } {
  const known = new Set(before.map(lineKey));
  const added: LedgerLine[] = [];
  for (const line of lines) {
    if (known.has(lineKey(line))) continue;
    known.add(lineKey(line));
    added.push(line);
  }
  const rows = rowsOf(added).length;
  const said = rows ? `${rows} audit row${rows === 1 ? "" : "s"}` : `${added.length} audit${added.length === 1 ? "" : "s"} started`;
  return added.length ? { added, change: { by: { host: said }, writes: [{ path: AUDITS_FILE, text: auditsText([...before, ...added]) }] } } : { added };
}

/** The rows the hold rule counts for `workflow` at `digest` under the promotion begun at `promotedAt` (learn/promote.ts
 *  promotionStartOf; none counted for null): those with a verdict, the newest `hold_window` of them. */
export const windowOf = (rows: readonly AuditRow[], workflow: string, digest: string, promotedAt: string | null, loop: Pick<AuditLoop, "hold_window">): AuditRow[] =>
  promotedAt === null ? [] : rows.filter((row) => row.workflow === workflow && row.digest === digest && row.promoted_at === promotedAt && row.agreed !== null).slice(-loop.hold_window);

/** The hold rule: the counted rows (windowOf) when at least `hold_disagree` of them disagree, else undefined. */
export function holdOf(rows: readonly AuditRow[], workflow: string, digest: string, promotedAt: string | null, loop: Pick<AuditLoop, "hold_window" | "hold_disagree">): { rows: AuditRow[]; disagreed: AuditRow[] } | undefined {
  const counted = windowOf(rows, workflow, digest, promotedAt, loop);
  const disagreed = counted.filter((row) => row.agreed === false);
  return disagreed.length >= loop.hold_disagree ? { rows: counted, disagreed } : undefined;
}

/** A workflow's audit line, as the promotions read shows it: the bar, and the counted rows and disagreements now. */
export type AuditLine = { readonly window: number; readonly disagree: number; readonly rows: number; readonly disagreed: number };
export function auditLineOf(rows: readonly AuditRow[], workflow: string, digest: string, promotedAt: string | null, loop: Pick<AuditLoop, "hold_window" | "hold_disagree">): AuditLine {
  const counted = windowOf(rows, workflow, digest, promotedAt, loop);
  return { window: loop.hold_window, disagree: loop.hold_disagree, rows: counted.length, disagreed: counted.filter((row) => row.agreed === false).length };
}

/** What the promotions read says of each learned workflow beside what serves (learn/promote.ts servingOf, in its order):
 *  `state` (learn/promote.ts servingStateOf with the money rule's decision, `costStop`: the word the learning view's
 *  `status` says too), its newest decided check's numbers, and its audit line over the rows of the serving (else the
 *  newest) revision's newest promotion (the ones the hold rule counts). */
export type ServingLine = {
  readonly state: ServingState;
  readonly check: { readonly n: number; readonly agreed: number; readonly alone: number; readonly attempt: 1 | 2 } | null;
  readonly audit: AuditLine | null;
};
export function servingLinesOf(records: readonly PromotionRecord[], rows: readonly AuditRow[], loop: Pick<AuditLoop, "hold_window" | "hold_disagree">, costStop: CostStop): ServingLine[] {
  return servingOf(records).map(({ workflow, digest }) => {
    const own = records.filter((one) => one.workflow === workflow);
    const newest = own.at(-1);
    const checked = own.findLast((one) => one.check?.n !== undefined)?.check;
    const at = digest ?? newest?.digest;
    return {
      state: servingStateOf(records, workflow, costStop),
      check: checked ? { n: checked.n!, agreed: checked.agreed ?? 0, alone: checked.alone ?? 0, attempt: checked.attempt } : null,
      audit: at === undefined ? null : auditLineOf(rows, workflow, at, promotionStartOf(records, workflow, at)?.at ?? null, loop),
    };
  });
}
