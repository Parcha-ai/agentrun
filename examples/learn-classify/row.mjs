// The per-run row (CLASSIFY-CONTRACT.md, its field rules in the DSL's words): one JSON line per run in out/runs.jsonl,
// every field a fact the host read from the run's store, its tool calls, the proposal or curate's ports, never the
// model's claim.

const NEW_TYPES = new Set(['lesson', 'fact', 'workflow']);

/** What curate did for this run: workflow births and promotions by name, held and refused items with their reasons. A
 *  workflow the propose step withheld (it copied a page the run read) is refused before curate saw it, and says so. */
export function curateOf(curated, runId, withheld = []) {
  const kept = withheld.map((w) => ({ workflow: w.name, reason: `withheld when proposed: ${w.reason}` }));
  if (!curated) return { admitted: [], promoted: [], demoted: [], held: [], refused: kept };
  const report = curated.report.runs.find((r) => r.run === runId);
  const decisions = curated.settled.filter((s) => s.run === runId).flatMap((s) => s.decisions);
  const item = (i) => ({ ...(i.workflow ? { workflow: i.workflow } : {}), ...(i.id ? { id: i.id } : {}), ...(i.candidate ? { candidate: i.candidate } : {}), reason: i.reason });
  return {
    admitted: curated.gates.filter((g) => g.run === runId && g.status === 'admitted').map((g) => g.name),
    promoted: decisions.filter((d) => d.action === 'promote').map((d) => d.name),
    demoted: decisions.filter((d) => d.action === 'demote').map((d) => d.name),
    held: (report?.held ?? []).map(item),
    refused: [...kept, ...(report?.refused ?? []).map(item)],
  };
}

/** byWorkflow: the label is the `sic2` output of a workflow run whose outcome is complete, whatever node inside gave it. */
export function byWorkflowOf(measure) {
  const answer = measure.answer?.sic2;
  return Boolean(answer) && measure.workflowRuns.some((r) => r.outcome === 'complete' && r.output?.sic2 === answer);
}

/**
 * The run's spend: `judgeCostUsd` is its Jev part (the run's own decisions and curate's), `costUsd` the whole (every model
 * call of the run, the workflow's nodes included, plus that Jev part). Either is null when any of its parts is unknown: a
 * Jev request that threw or came back without a price, a model answer that ended in an error or an abort.
 */
export function spendOf(measure, curateJudge = { costUsd: 0, unknown: 0 }) {
  const judgeKnown = measure.judge.costUsd + curateJudge.costUsd;
  const judgeCostUsd = measure.judge.unknown || curateJudge.unknown ? null : judgeKnown;
  const costUsd = judgeCostUsd === null || measure.unpricedAnswers ? null : measure.usage.costUsd + judgeKnown;
  return { costUsd, judgeCostUsd, knownUsd: measure.usage.costUsd + judgeKnown };
}

/** `run` is the job's place in the order (1 to 100; for a sealed pass, its place in that pass); `runId` the attempt's id.
 *  `curateJudge` is the curate call's Jev meter (none for a sealed run). `convention` is the filing convention the truth
 *  set's build report puts the company under, or null; the agent never sees it. */
export function rowOf({ run, runId, job, seedSha, afterSha, offered, measure, finished, curated, curateJudge, recording, convention }) {
  const answer = measure.answer?.sic2 ?? null;
  const candidates = finished?.candidates ?? [];
  const { costUsd, judgeCostUsd } = spendOf(measure, curateJudge);
  return {
    run,
    cik: job.cik,
    split: job.split,
    seedSha,
    afterSha,
    answer,
    truth: job.sic2,
    correct: answer !== null && answer === job.sic2,
    costUsd,
    tokensIn: measure.usage.tokensIn,
    tokensOut: measure.usage.tokensOut,
    durationMs: measure.durationMs,
    workflowsOffered: offered,
    workflowsUsed: measure.workflowRuns.map(({ name, revision, outcome, classifiedBy }) => ({ name, revision, outcome, ...(classifiedBy ? { classifiedBy } : {}) })),
    byWorkflow: byWorkflowOf(measure),
    workflowsSaved: [...new Set((finished?.saved ?? []).map((w) => w.name))],
    notes: {
      new: candidates.filter((c) => NEW_TYPES.has(c.type)).length,
      used: candidates.filter((c) => c.type === 'used').length,
      corrected: candidates.filter((c) => c.type === 'correction').length,
    },
    curate: curateOf(curated, runId, finished?.proposal?.withheld),
    judgeCostUsd,
    recording: recording ?? null,
    convention: convention ?? null,
  };
}
