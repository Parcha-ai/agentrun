// GET /agents/{id}/learning/loop from the one store: what the console's Learning tab tells of the self-learning loop
// beside the cost series. Each compile turn the agent's runs took (learn/compile.ts: the workflow it wrote, the notes it
// absorbed, each attempt and what the checks refused, the draft's digest and whether that revision serves). The checks'
// own words only: no input, no answer.
import { FINAL_STATES, type Store } from "../store/store.js";
import { promotionOf, promotionsOf } from "../learn/promote.js";
import { lastOwnRuns, promotedOf } from "../learn/compile.js";
import { defaultLearningOf, learningIdOf } from "../learn/learning-of.js";
import { loopOf } from "../learning-setting.js";
import { roundsOf } from "./learning.js";

/** How many compile turns the read gives, the newest. */
export const LOOP_COMPILES_MAX = 50;

/** One compile turn of a run, in the round of it that compiled (a follow-up opens a round past the first, and each
 *  round's end may compile): `errors` its draft's when none passed (never silent). */
export type LoopCompile = {
  run_id: string;
  round: number;
  at: string;
  workflow: string | null;
  attempts: { ok: boolean; errors: string[] }[];
  digest: string | null;
  promoted: boolean | null;
  draft_errors: string[];
};
const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((one): one is string => typeof one === "string") : []);

/** The agent's compile turns (every round of each run, roundsOf: newest first, LOOP_COMPILES_MAX), over its ended runs
 *  (not imported, not archived), and how many completed runs of its own count toward its compile. A compile's `promoted`
 *  is its revision's promotion as the records say now (null while undecided): whether it serves now is the promotions
 *  read's `serving`. The agent's learning on the default disk, the one the server reads (learn/learning-of.ts): its runs
 *  there alone. */
export async function agentLoopOverStore(store: Store, agentId: string): Promise<{ compiles: LoopCompile[]; completed_runs: number }> {
  const learning = defaultLearningOf(agentId);
  const ended = (await store.runs.list(learning)).filter((run) => run.agentId === agentId && FINAL_STATES.includes(run.state) && !run.importedFrom && run.archivedAt === null).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  // The completed runs of the agent's own toward its compile (what compileDue counts), at most compile_after: the tab
  // says "N of compile_after" from this, never from the one page of runs it reads.
  const current = (await store.agents.get(agentId))?.currentRevision;
  const body = current ? (await store.agents.revision(current))?.body as { learning?: unknown } | undefined : undefined;
  const completed_runs = (await lastOwnRuns(store, learning, loopOf(body?.learning).compile_after)).length;
  const promotions = await promotionsOf(store.settings, learningIdOf(learning)).catch(() => []);
  const compiles: (LoopCompile & { createdAt: number })[] = [];
  for (const run of ended) {
    for (const kept of await roundsOf(store, run.id).catch(() => [])) {
      const row = (kept.proposal ?? null) as { compiled?: unknown; draft_errors?: unknown } | null;
      if (!row) continue;
      const errors = texts(row.draft_errors);
      const record = row.compiled as { workflow?: unknown; attempts?: unknown; digest?: unknown } | undefined;
      const named = record && typeof record === "object" && typeof record.workflow === "string" ? record : undefined;
      if (!named && !errors.length) continue;
      const attempts = Array.isArray(named?.attempts) ? named.attempts.filter((one) => one && typeof one === "object" && typeof (one as { ok?: unknown }).ok === "boolean").map((one) => ({ ok: (one as { ok: boolean }).ok, errors: texts((one as { errors?: unknown }).errors) })) : [];
      const kept16 = typeof named?.digest === "string" && /^[0-9a-f]{16}$/.test(named.digest) ? named.digest : null;
      // A draft its check had nothing to run on stopped (runner/promotion.ts stopUnchecked): its record's reason is one
      // of the draft's errors, never silent.
      const own = named && kept16 ? promotionOf(promotions, named.workflow as string, kept16) : undefined;
      const unchecked = own?.decided === "hold" && own.check?.stopped && own.check.n === 0 ? [own.reason] : [];
      compiles.push({
        createdAt: kept.createdAt, run_id: run.id, round: kept.round, at: new Date(kept.createdAt).toISOString(), workflow: named ? (named.workflow as string) : null, attempts,
        digest: kept16, promoted: named && kept16 ? (promotedOf(promotions, named.workflow as string, kept16) ?? null) : null, draft_errors: [...errors, ...unchecked],
      });
    }
  }
  // Newest first by when each round kept it (a later round of an earlier run can be newer than a later run's), the run's
  // start and its round breaking a tie.
  const newest = compiles.map((one, i) => ({ one, i })).sort((a, b) => b.one.createdAt - a.one.createdAt || b.i - a.i).slice(0, LOOP_COMPILES_MAX);
  return { compiles: newest.map(({ one: { createdAt: _createdAt, ...one } }) => one), completed_runs };
}
