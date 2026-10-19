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

/** byWorkflow: the label (`sic2` in v1, `sic4` in v2) is the output of a workflow run whose outcome is complete, whatever
 *  node inside gave it. */
export function byWorkflowOf(measure, key = 'sic2') {
  const answer = measure.answer?.[key];
  return Boolean(answer) && measure.workflowRuns.some((r) => r.outcome === 'complete' && r.output?.[key] === answer);
}

/**
 * The run's spend: `judgeCostUsd` is its Jev part (the run's own decisions and curate's), `costUsd` the whole (every model
 * call of the run, the workflow's nodes included, that Jev part, and in v2 what its tools cost: `tools`, the browser's,
 * search's and the document reader's). Either is null when any of its parts is unknown: a Jev request that threw or came
 * back without a price, a model answer that ended in an error or an abort, a tool that did not know its price.
 */
export function spendOf(measure, curateJudge = { costUsd: 0, unknown: 0 }, tools = []) {
  const judgeKnown = measure.judge.costUsd + curateJudge.costUsd;
  const judgeCostUsd = measure.judge.unknown || curateJudge.unknown ? null : judgeKnown;
  const toolsKnown = tools.reduce((sum, usd) => sum + (typeof usd === 'number' ? usd : 0), 0);
  const unknownTool = tools.some((usd) => typeof usd !== 'number');
  const costUsd = judgeCostUsd === null || measure.unpricedAnswers || unknownTool ? null : measure.usage.costUsd + judgeKnown + toolsKnown;
  return { costUsd, judgeCostUsd, knownUsd: measure.usage.costUsd + judgeKnown + toolsKnown };
}

/** `run` is the job's place in the order (1 to 100; for a sealed pass, its place in that pass); `runId` the attempt's id.
 *  `curateJudge` is the curate call's Jev meter (none for a sealed run). `convention` is the filing convention the truth
 *  set's build report puts the company under, or null; the agent never sees it. */
export function rowOf({ run, runId, job, seedSha, afterSha, offered, measure, finished, curated, curateJudge, recording, convention, key = 'sic2', tools = [] }) {
  const answer = measure.answer?.[key] ?? null;
  const candidates = finished?.candidates ?? [];
  const { costUsd, judgeCostUsd } = spendOf(measure, curateJudge, tools);
  return {
    run,
    cik: job.cik,
    split: job.split,
    seedSha,
    afterSha,
    answer,
    truth: key === 'sic4' ? job.sic : job.sic2,
    correct: answer !== null && answer === job[key === 'sic4' ? 'sic' : 'sic2'],
    costUsd,
    tokensIn: measure.usage.tokensIn,
    tokensOut: measure.usage.tokensOut,
    durationMs: measure.durationMs,
    workflowsOffered: offered,
    workflowsUsed: measure.workflowRuns.map(({ name, revision, outcome, classifiedBy }) => ({ name, revision, outcome, ...(classifiedBy ? { classifiedBy } : {}) })),
    byWorkflow: byWorkflowOf(measure, key),
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

/**
 * A v2 row: v1's fields, with `answer` and `truth` the 4-digit codes and `correct` the headline (the code exact, and the
 * segment not wrong), then the v2 fields of CLASSIFY-CONTRACT.md. `score` is `scoreV2`'s, `stats` `toolStats`'s,
 * `scoringJudge` the scorer's Jev meter.
 */
export function rowOfV2({ score, stats, scoringJudge, ...v1 }) {
  const row = rowOf({ ...v1, key: 'sic4', tools: [stats.browserCostUsd, stats.searchCostUsd, stats.documentCostUsd] });
  const { job } = v1;
  return {
    ...row,
    correct: score.correct,
    convention: null,
    set: 'v2',
    categories: job.categories ?? [],
    websiteGiven: Boolean(job.website),
    sic4Answer: score.sic4Answer,
    sic4Truth: score.sic4Truth,
    sicCorrect4: score.sicCorrect4,
    sicCorrect2: score.sicCorrect2,
    segmentAnswer: score.segmentAnswer,
    segmentTruth: score.segmentTruth,
    segmentCorrect: score.segmentCorrect,
    shareError: score.shareError,
    evidenceSupported: score.evidenceSupported,
    toolCalls: stats.toolCalls,
    browserMinutes: stats.browserSeconds / 60,
    visionPages: stats.visionPages,
    browserCostUsd: stats.browserCostUsd,
    // The scorer's own Jev: not the agent's cost, so not in costUsd, but spent all the same; the spend guard counts it.
    scoreCostUsd: !scoringJudge || scoringJudge.unknown ? null : scoringJudge.costUsd,
  };
}
