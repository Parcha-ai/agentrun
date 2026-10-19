// The per-run row (CLASSIFY-CONTRACT.md): one JSON line per run in out/runs.jsonl, every field a fact the host read from
// the run's store, its tool calls, the proposal or curate's ports, never the model's claim.

const NEW_TYPES = new Set(['lesson', 'fact', 'workflow']);

/** What curate did for this run: workflow births and promotions by name, held and refused items with their reasons. */
export function curateOf(curated, runId) {
  if (!curated) return { admitted: [], promoted: [], demoted: [], held: [], refused: [] };
  const report = curated.report.runs.find((r) => r.run === runId);
  const decisions = curated.settled.filter((s) => s.run === runId).flatMap((s) => s.decisions);
  const item = (i) => ({ ...(i.workflow ? { workflow: i.workflow } : {}), ...(i.id ? { id: i.id } : {}), ...(i.candidate ? { candidate: i.candidate } : {}), reason: i.reason });
  return {
    admitted: curated.gates.filter((g) => g.run === runId && g.status === 'admitted').map((g) => g.name),
    promoted: decisions.filter((d) => d.action === 'promote').map((d) => d.name),
    demoted: decisions.filter((d) => d.action === 'demote').map((d) => d.name),
    held: (report?.held ?? []).map(item),
    refused: (report?.refused ?? []).map(item),
  };
}

/**
 * byWorkflow: the answer is the `sic2` of a workflow run that completed (the use ended frozen) and whose revision the run's
 * store holds under a name, so the agent did not classify the company itself.
 */
export function byWorkflowOf(measure, uses) {
  const answer = measure.answer?.sic2;
  if (!answer) return false;
  const frozen = new Set(uses.filter((u) => u.outcome === 'frozen').map((u) => u.sha256));
  return measure.workflowRuns.some((r) => r.status === 'complete' && r.output?.sic2 === answer && frozen.has(r.digest));
}

/** `run` is the job's place in the order (1 to 100; for a sealed pass, its place in that pass); `runId` the attempt's id. */
export function rowOf({ run, runId, job, seedSha, afterSha, offered, measure, finished, curated, judgeCostUsd, recording }) {
  const answer = measure.answer?.sic2 ?? null;
  const candidates = finished?.candidates ?? [];
  const uses = finished?.uses ?? [];
  return {
    run,
    cik: job.cik,
    split: job.split,
    seedSha,
    afterSha,
    answer,
    truth: job.sic2,
    correct: answer !== null && answer === job.sic2,
    costUsd: measure.usage.costUsd + measure.judge.costUsd,
    tokensIn: measure.usage.tokensIn,
    tokensOut: measure.usage.tokensOut,
    durationMs: measure.durationMs,
    workflowsOffered: offered,
    workflowsUsed: uses.map((u) => ({ name: u.name, revision: u.sha256, outcome: u.outcome })),
    byWorkflow: byWorkflowOf(measure, uses),
    workflowsSaved: [...new Set((finished?.saved ?? []).map((w) => w.name))],
    notes: {
      new: candidates.filter((c) => NEW_TYPES.has(c.type)).length,
      used: candidates.filter((c) => c.type === 'used').length,
      corrected: candidates.filter((c) => c.type === 'correction').length,
    },
    curate: curateOf(curated, runId),
    judgeCostUsd,
    recording: recording ?? null,
  };
}
