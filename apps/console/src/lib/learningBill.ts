import { usd } from "@/lib/costPerRun";
import type { AuditRow, Bill, CostRun, Promotion, Serving } from "@/lib/v2";

// The Learning tab's bill, audit line and serving workflow, read as a person reads them. The bill is the server's (GET
// /v2/agents/{id}/learning/cost `bill`): booked dollars only, every run that does a job with all learning spent for it
// (its look-back and grade, its audit's shadow run, its revision's check), cumulative, against the agent for all of it
// (the mean of the agent's own runs before the first promotion, times the runs). Nothing here computes a dollar.

const runsWord = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;
const dollars = (value: number) => (value >= 1 ? `$${value.toFixed(2)}` : usd(value));

/** The bill's headline and the run its break-even marker stands on (null: none yet, or nothing promoted). */
export function billWords(bill: Bill): { headline: string; marker: number | null } {
  const last = bill.points.at(-1);
  const withheld = bill.withheld ? ` · ${runsWord(bill.withheld)} of unknown cost on neither line` : "";
  if (!last) return { headline: `No run with a known cost yet${withheld}`, marker: null };
  if (!bill.promoted) return { headline: `No learned workflow serves yet: the bill is the agent's own, ${dollars(last.actual_usd)} over ${runsWord(bill.points.length)}${withheld}`, marker: null };
  if (bill.break_even) {
    const all = last.agent_usd === null ? "" : `, ${dollars(last.agent_usd)} had the agent done all of it`;
    return { headline: `Break-even at run ${bill.break_even.n}: ${dollars(last.actual_usd)} booked over ${runsWord(bill.points.length)}${all}${withheld}`, marker: bill.break_even.n };
  }
  const gap = bill.gap_usd === null ? "" : `: ${dollars(bill.gap_usd)} over the agent for all of it at run ${last.n}`;
  return { headline: `Not yet${gap}${withheld}`, marker: null };
}

/** A hold, at the bill's run it bore on: the first run that does a job started at or after it (null: none has yet). */
export type Hold = { workflow: string; at: string; n: number | null; by: "audit" | "check" };

/** Each hold record, oldest first, at its run of the bill (`runs`: the cost series, for when each run started). */
export function holdsOf(records: readonly Promotion[], bill: Bill, runs: readonly CostRun[]): Hold[] {
  const started = new Map(runs.map((run) => [run.run_id, run.started_at]));
  return records.filter((record) => record.decided === "hold").map((record) => ({
    workflow: record.workflow,
    at: record.at,
    n: bill.points.find((point) => (started.get(point.run_id) ?? "") >= record.at)?.n ?? null,
    by: record.audit ? "audit" : "check",
  }));
}

/** A learned workflow's audit line: its newest audit rows against the hold bar (the serving read's, null when it has
 *  none), every row of the ledger with a verdict, and why its runs are not audited (null when they are). */
export type AuditLineOf = { workflow: string; recent: { rows: number; agreed: number; window: number; disagree: number } | null; all: { rows: number; agreed: number }; off: string | null };

/** Each learned workflow's audit line, from what serves (`serving`) and the audit ledger (`audits`). */
export function auditLinesOf(serving: readonly Serving[], audits: readonly AuditRow[]): AuditLineOf[] {
  return serving.map((one) => {
    const rows = audits.filter((row) => row.workflow === one.workflow && row.agreed !== null);
    return {
      workflow: one.workflow,
      recent: one.audit ? { rows: one.audit.rows, agreed: one.audit.rows - one.audit.disagreed, window: one.audit.window, disagree: one.audit.disagree } : null,
      all: { rows: rows.length, agreed: rows.filter((row) => row.agreed).length },
      off: one.audits_off,
    };
  });
}

/** A node of a learned workflow: where it is (its place in its parent), its kind and label, the tier its model step runs
 *  on (`fast`, or the agent's own model; null for a step that calls no model), and the checks it runs in code. */
export type NodeRow = { path: string; kind: string; label: string; tier: "fast" | "agent model" | null; checks: string[] };

/** The kinds of node that call a model and may name a tier (the server's check.ts TIERED_KINDS). */
const TIERED = new Set(["agent", "decide", "extract", "report"]);
/** The fields of a node that are a check run in code. */
const CHECK_KEYS = ["when", "until"] as const;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNode = (value: unknown): value is Record<string, unknown> => isObject(value) && typeof value.node === "string";

/** A predicate in words: `not` and its operand, a field's test as `path = value`, else its name and path. */
function predicateWords(p: unknown): string {
  if (!isObject(p)) return "?";
  if (p.predicate === "not") return `not ${predicateWords(p.of)}`;
  if ((p.predicate === "and" || p.predicate === "or") && Array.isArray(p.of)) return p.of.map(predicateWords).join(` ${p.predicate} `);
  if (p.predicate === "field_equals" && typeof p.path === "string") return `${p.path} = ${JSON.stringify(p.value)}`;
  return [p.predicate, p.path].filter((part) => typeof part === "string").join(" ") || "?";
}

/** Every node of workflow document `doc`, depth first, a chain's steps in their order and the chain itself left out
 *  (its steps are the nodes). Empty for a document with no root node. */
export function nodeRowsOf(doc: unknown): NodeRow[] {
  const rows: NodeRow[] = [];
  const visit = (node: Record<string, unknown>, path: string) => {
    const kind = node.node as string;
    if (kind === "chain" && Array.isArray(node.steps)) {
      node.steps.forEach((step, i) => { if (isNode(step)) visit(step, path ? `${path}.${i}` : String(i)); });
      return;
    }
    rows.push({
      path: path || "root",
      kind,
      label: typeof node.label === "string" ? node.label : kind,
      tier: TIERED.has(kind) ? (node.tier === "fast" ? "fast" : "agent model") : null,
      checks: CHECK_KEYS.filter((key) => node[key] !== undefined).map((key) => `${key} ${predicateWords(node[key])}`),
    });
    for (const [key, value] of Object.entries(node)) {
      const at = path ? `${path}.${key}` : key;
      if (isNode(value)) visit(value, at);
      else if (Array.isArray(value)) value.forEach((item, i) => { if (isNode(item)) visit(item, `${at}.${i}`); });
    }
  };
  if (isObject(doc) && isNode(doc.root)) visit(doc.root, "");
  return rows;
}

const pctOf = (share: number) => `${Math.round(share * 100)}%`;

/** The check a revision was promoted (or held) on, with the bars it was held to and where its inputs came from. */
export function checkWords(record: Promotion): string {
  const c = record.check;
  if (!c?.n) return record.decided === "promote" ? "Promoted with no check behind it" : record.reason;
  return `Checked on ${c.n} ${c.n === 1 ? "input" : "inputs"}: ${c.alone ?? 0} answered alone (bar ${pctOf(c.alone_min)}), ${c.agreed ?? 0} of them agreed (bar ${pctOf(c.agree_min)}) · inputs from the newest ${c.compile_after} runs · ${c.attempt === 1 ? "first check" : "the recompile's check"}`;
}
