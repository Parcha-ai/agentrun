// The search step: a search's results sifted under a policy.
import { clip } from "../page.js";
import { kindOf } from "../providers/keyed.js";
import { QUERY_MAX, type Search } from "../search.js";
import type { Verdict, WebDecider } from "./decider.js";
import { bounded, byScore, droppedOf, drops, failed, ran, relevanceOf, type Scored, type Sifted, since, skipped, type StepOptions } from "./record.js";

/** Under label or rerank+label, the score at least one result must reach for the search not to be called a miss. */
export const LOW_RELEVANCE = 0.3;

/** How a search's results reach the model. "drop": those scored below THRESHOLD are left out, the rest in the
 *  provider's order. "label": every one is kept in the provider's order, each with its `relevance`. "rerank+label":
 *  as label, the most relevant first. */
export type DecidePolicy = "drop" | "label" | "rerank+label";
const POLICIES: readonly DecidePolicy[] = ["drop", "label", "rerank+label"];
/** `policy`, "drop" when none is given; any other value throws. */
export function policyOf(policy: unknown = "drop"): DecidePolicy {
  if (!POLICIES.includes(policy as DecidePolicy)) throw new RangeError(`the classifier's policy must be "drop", "label" or "rerank+label" (it was ${kindOf(policy)})`);
  return policy as DecidePolicy;
}

/** A search's results sifted by `decider` under `options.policy` (DecidePolicy), and `sift` telling the model what was
 *  done. The need judged is the task when one is given, else the search's objective (siftRequest's query). */
export async function siftSearch(decider: WebDecider, answer: Search, options: StepOptions & { policy?: DecidePolicy | undefined }): Promise<Sifted<Search & { sift?: string }>> {
  const policy = policyOf(options.policy);
  if ("error" in answer || !answer.results.length) return { answer, classifier: skipped(decider, "search", "no results") };
  const start = performance.now();
  const { got, requests } = await bounded((ctx) => decider.sift(answer.objective, answer.results, options.task, ctx), options);
  const n = answer.results.length;
  if ("code" in got) return { answer: { ...answer, sift: `not run (${got.code}); these results are unsifted` }, classifier: failed(decider, "search", n, since(start), requests, got) };
  const scored: Scored[] = answer.results.map((hit, i) => ({ id: hit.url, score: got.verdicts[i] as Verdict }));
  if (policy !== "drop") return { answer: labelled(decider.id, answer, scored, options.task, policy === "rerank+label"), classifier: ran(decider, "search", got, since(start), requests, scored, []) };
  const results = answer.results.filter((_, i) => !drops(scored[i]!.score));
  return { answer: { ...answer, results, sift: `${decider.id} kept ${results.length} of ${n} results` }, classifier: ran(decider, "search", got, since(start), requests, scored, droppedOf(scored)) };
}

/** `answer`'s results, every one, each scored one with `relevance`, its score to two places; when `rerank`, the most
 *  relevant first (a stable sort: ties in the provider's order, a refused one last). The sift line says which, and that
 *  nothing looks relevant to the need when no result reaches LOW_RELEVANCE. */
function labelled(id: string, answer: Extract<Search, { results: unknown }>, scored: Scored[], task: string | undefined, rerank: boolean): Search & { sift: string } {
  const pairs = answer.results.map((hit, i) => ({ hit, score: scored[i]!.score }));
  if (rerank) pairs.sort((a, b) => byScore(a.score, b.score));
  const results = pairs.map(({ hit, score }) => ({ ...hit, ...relevanceOf(score) }));
  const best = Math.max(...scored.map((item) => item.score ?? 0));
  const miss = best < LOW_RELEVANCE ? `; nothing here looks relevant to ${JSON.stringify(clip(task ?? answer.objective, QUERY_MAX))}; consider rephrasing` : "";
  const done = rerank ? `ordered ${results.length} results by relevance` : `labelled ${results.length} results with their relevance`;
  return { ...answer, results, sift: `${id} ${done}, how likely each holds what the search asks for (0 to 1)${miss}` };
}

