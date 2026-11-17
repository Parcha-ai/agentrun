import { usd } from "@/lib/costPerRun";
import type { AuditRow, Bill, Serving } from "@/lib/v2";

// The Learning tab's bill, audit line and serving workflow, read as a person reads them. The bill is the server's (GET
// /v2/agents/{id}/learning/cost `bill`): booked dollars only, every run that does a job with all learning spent for it
// (its look-back and grade, its audit's shadow run, its revision's compile and check), cumulative, against the agent for
// all of it (the mean of the agent's own runs before its first served run, times the runs), with each hold at the run the
// server placed it on. The serving workflow is the promotions read's champion. Nothing here computes a dollar or a node.

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

/** The audit ledger as the tab holds it: its rows once read, `loading` while it is read, `failed` when the read failed. */
export type Audits = readonly AuditRow[] | "loading" | "failed";

/** A learned workflow's audit line: its newest audit rows against the hold bar (the serving read's, null when it has
 *  none), every row of the ledger with a verdict (null while the ledger is unread: never 0 of 0), and why its runs are
 *  not audited (null when they are). */
export type AuditLineOf = { workflow: string; recent: { rows: number; agreed: number; window: number; disagree: number } | null; all: { rows: number; agreed: number } | null; off: string | null };

/** Each learned workflow's audit line, from what serves (`serving`) and the audit ledger (`audits`). */
export function auditLinesOf(serving: readonly Serving[], audits: Audits): AuditLineOf[] {
  return serving.map((one) => {
    const rows = typeof audits === "string" ? null : audits.filter((row) => row.workflow === one.workflow && row.agreed !== null);
    return {
      workflow: one.workflow,
      recent: one.audit ? { rows: one.audit.rows, agreed: one.audit.rows - one.audit.disagreed, window: one.audit.window, disagree: one.audit.disagree } : null,
      all: rows === null ? null : { rows: rows.length, agreed: rows.filter((row) => row.agreed).length },
      off: one.audits_off,
    };
  });
}

/** The champion as the promotions read gives it (`serving[].champion`), its nodes and the check it was promoted on. */
export type Champion = NonNullable<Serving["champion"]>;
export type ChampionNode = NonNullable<Champion["nodes"]>[number];

/** A node's tier in words: `fast`, the agent's own model, or none. */
export const tierWords = (tier: ChampionNode["tier"]): string => (tier === "fast" ? "fast" : tier === "agent" ? "agent model" : "-");

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A predicate in words: `not` and its operand, a field's test as `path = value`, else its name and path. */
function predicateWords(p: unknown): string {
  if (!isObject(p)) return "?";
  if (p.predicate === "not") return `not ${predicateWords(p.of)}`;
  if ((p.predicate === "and" || p.predicate === "or") && Array.isArray(p.of)) return p.of.map(predicateWords).join(` ${p.predicate} `);
  if (p.predicate === "field_equals" && typeof p.path === "string") return `${p.path} = ${JSON.stringify(p.value)}`;
  return [p.predicate, p.path].filter((part) => typeof part === "string").join(" ") || "?";
}

/** A check a node runs in code, in words: when it runs, or what stops its loop. */
export const checkLineWords = (check: ChampionNode["checks"][number]): string => `${check.on} ${predicateWords(check.predicate)}`;

const pctOf = (share: number) => `${Math.round(share * 100)}%`;

/** The check the champion was promoted on, with the bars it was held to and where its inputs came from. */
export function checkWords(c: Champion["check"]): string {
  if (!c?.n) return "Promoted with no check behind it";
  return `Checked on ${c.n} ${c.n === 1 ? "input" : "inputs"}: ${c.alone ?? 0} answered alone (bar ${pctOf(c.alone_min)}), ${c.agreed ?? 0} of them agreed (bar ${pctOf(c.agree_min)}) · inputs from the newest ${c.compile_after} runs · ${c.attempt === 1 ? "first check" : "the recompile's check"}`;
}
