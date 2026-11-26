// What a promotion record copied from a run, blanked (a run's purge): a leaf module, so the store's learning rows
// (store/sqlite/learning-rows.ts) blank a purged run's copies in their own transaction without importing promote.ts.
import type { AuditDisagreement, CheckDisagreement, PromotionRecord } from "./promote.js";

/** A check's disagreement with what it copied from its run blanked: its run id and which way the draft went (an answer,
 *  a hand-back, a failed step) and the fields it had wrong (the definition's names, no run text) and where each known
 *  answer came from kept, its input, the agent's answer, the draft's, the known answers' values and the grader's words
 *  gone. */
export const blankCheck = (one: CheckDisagreement): CheckDisagreement => ({
  run: one.run, input: "", agent: null,
  ...(one.draft !== undefined ? { draft: "" } : {}),
  ...(one.escalated !== undefined ? { escalated: "" } : {}),
  ...(one.failed ? { failed: true as const } : {}),
  ...(one.fields ? { fields: one.fields } : {}),
  ...(one.expected ? { expected: one.expected.map(({ field, known, value }) => ({ field, known, ...(value !== undefined ? { value: "" } : {}) })) } : {}),
});

/** An audit's disagreement blanked the same way: its run ids and whether a grade wrote it kept, its known answer empty. */
export const blankAudit = (one: AuditDisagreement): AuditDisagreement => ({ run: one.run, served: one.served, input: "", agent: null, draft: null, ...(one.graded ? { graded: true as const } : {}), ...(one.expected !== undefined ? { expected: "" } : {}) });

/** `record` with what it copied from run `runId` blanked: each disagreement naming it (a check's agent run, a connected
 *  agent's collected turn too; an audit's served run or shadow run), and the grader's words its reason quotes from one
 *  (differentDecisionWords' example). Its decision, numbers and run ids stay. The record itself when it names no such
 *  disagreement. */
export function forgetRunIn(record: PromotionRecord, runId: string): PromotionRecord {
  if (!record || typeof record !== "object") return record;
  const check = record.check?.disagreements?.some((one) => one.run === runId);
  const turns = record.check?.turns?.disagreements?.some((one) => one.run === runId);
  const audit = record.audit?.disagreements.some((one) => one.run === runId || one.served === runId);
  if (!check && !turns && !audit) return record;
  let reason = record.reason;
  for (const one of record.check?.disagreements ?? []) if (one.run === runId && one.differs_on !== undefined) reason = reason.replace(` (for example: ${one.differs_on})`, "");
  const blanked = (list: readonly CheckDisagreement[]) => list.map((one) => (one.run === runId ? blankCheck(one) : one));
  return {
    ...record,
    reason,
    ...((check || turns) && record.check ? { check: {
      ...record.check,
      ...(check ? { disagreements: blanked(record.check.disagreements!) } : {}),
      ...(turns ? { turns: { ...record.check.turns!, disagreements: blanked(record.check.turns!.disagreements!) } } : {}),
    } } : {}),
    ...(audit && record.audit ? { audit: { ...record.audit, disagreements: record.audit.disagreements.map((one) => (one.run === runId || one.served === runId ? blankAudit(one) : one)) } } : {}),
  };
}

/** The runs whose copies `record` holds (forgetRunIn blanks them): each disagreement's run, a connected agent's collected
 *  turn's, an audit's served run and shadow run. */
export function runsNamedIn(record: PromotionRecord): string[] {
  if (!record || typeof record !== "object") return [];
  return [...new Set([
    ...(record.check?.disagreements ?? []).map((one) => one.run),
    ...(record.check?.turns?.disagreements ?? []).map((one) => one.run),
    ...(record.audit?.disagreements ?? []).flatMap((one) => [one.run, one.served]),
  ].filter((run): run is string => typeof run === "string"))];
}
