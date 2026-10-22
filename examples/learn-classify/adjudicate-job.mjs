// The adjudication pass's job (learn-mcc's ADJUDICATION.md): one merchant of the sealed sample per run, judged blind by
// learn-mcc's adjudicator home with its two host tools (adjudicator-tools.mjs): `site` records the adjudicator's own code
// and the tiers the risk rubric allows, from the site alone; `codes` refuses until then and gives the merchant's candidate
// codes with no source; the answer judges each candidate. The run is given the merchant's name and website and nothing
// else of its sealed row.
import { adjudicatorRun } from '../learn-mcc/adjudicator-tools.mjs';
import { groundedPage } from './mcc.mjs';

/** The run's input: the merchant's name and website. */
export const jobInputAdjudicate = (job) => ({ name: job.name, website: job.website });

export const jobTextAdjudicate = (job) => [
  'Judge this merchant, blind.',
  `Merchant: ${job.name}`,
  `Website: ${job.website}`,
].join('\n');

/** The sealed sample's merchants as the runner keys them (`cik`): the id, name, website and the sample's order. Nothing
 *  else of a sealed row (its teacher block, vertical or stratum) reaches a run. */
export function sampleJobs(sample) {
  return [...sample].sort((a, b) => a.order - b.order).map((m) => {
    if (typeof m.merchantId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(m.merchantId)) throw new Error(`the sample has a merchant id that is not one: ${JSON.stringify(m.merchantId)}`);
    return { cik: m.merchantId, merchantId: m.merchantId, name: m.name, website: m.website, order: m.order };
  });
}

/** One run's host tools and answer for a merchant: a fresh adjudicatorRun over its candidates (their stage state is the
 *  run's own), and its verdict as the answer, refused until `problems` is empty. `record(verdict)` is the run's stage 1
 *  and stage 2. */
export function adjudicationRun({ candidates, groups }) {
  const run = adjudicatorRun({ candidates, groups });
  return {
    tools: run.tools,
    answer: { ...run.answer, problems: run.problems, recorded: (verdict) => `the verdict on ${(verdict?.codes ?? []).length} candidate codes` },
    record: run.record,
  };
}

/** Whether a recorded verdict grounds (SPEC.md's grounding, as the learner's receipt reads it): each judgment (the own
 *  code, the risk tiers, each candidate) has at least one evidence item that a page of the merchant's own, read in the
 *  run, holds word for word. `ungrounded` names the judgments that do not; an unjudgeable site grounds nothing (null). */
export function adjudicationGrounding(lines, recorded, merchant) {
  if (recorded.stage1.unjudgeable) return { grounded: null, ungrounded: [] };
  const judgments = [['own', recorded.stage1.own.evidence], ['risk', recorded.stage1.risk.evidence], ...Object.entries(recorded.stage2.codes).map(([code, v]) => [code, v.evidence])];
  const ungrounded = judgments.filter(([, evidence]) => !(evidence ?? []).some((cite) => groundedPage(lines, cite, merchant))).map(([what]) => what);
  return { grounded: ungrounded.length === 0, ungrounded };
}
