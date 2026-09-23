import { inspectWorkflow, runWorkflowSlice } from '@parcha/agentrun-dsl';
import { createHash } from 'node:crypto';
import { researchQuestion } from './typed-research.ts';
import { evidenceCases } from './research-eval-cases.mjs';
import { isMain, loadEvidenceCases, loadResearchAdapters, runCli, saveReport, validateEvidenceCases, withCancellation } from './research-runtime.mjs';

// Scripted answers are separate from the gold labels. Changing the gold labels
// cannot change these outputs. This verifies the evaluator, not Jev quality.
const scriptedProbabilities = { direct: 0.95, contrary: 0.93, irrelevant: 0.03, topical: 0.12, promotion: 0.09, insufficient: 0.2 };
export async function scriptedEvidenceDecision({ questions, state, signal }) {
  signal?.throwIfAborted();
  return { answers: Object.fromEntries(Object.keys(questions).map(id => {
    const source = state.items[Number(id.split('.')[0])].item;
    const fixture = evidenceCases.find(example => example.question === state.subquestion && example.text === source.text);
    return [id, { type: 'noul', noul: scriptedProbabilities[fixture?.id] }];
  })) };
}

export async function evaluateEvidence({ runJudge = scriptedEvidenceDecision, cases = evidenceCases, signal, mode = 'scripted' } = {}) {
  const bundled = cases === evidenceCases;
  cases = validateEvidenceCases(cases);
  const selector = researchQuestion.root.steps.find(step => step.label === 'screen-evidence');
  if (selector?.node !== 'sift') throw new Error('The evidence evaluation requires the screen-evidence sift step.');
  const decisions = [];
  for (const example of cases) {
    signal?.throwIfAborted();
    const result = await runWorkflowSlice(researchQuestion, {
      // Neutral identity: do not leak the case category or expected label.
      question: example.question, search: { sources: [{ id: 'candidate', text: example.text }] },
    }, { from: 'screen-evidence' }, { runJudge: params => withCancellation(runJudge(params), params.signal), signal });
    signal?.throwIfAborted();
    const evidence = result.state.evidence;
    const selected = evidence.items.some(item => item.id === 'candidate');
    decisions.push({ id: example.id, expected: example.keep, selected,
      probability: evidence.answers[0].answers.answersQuestion.noul,
      passed: selected === example.keep, reason: example.reason });
  }
  const passed = decisions.filter(row => row.passed).length;
  return {
    mode, workflowSha256: inspectWorkflow(researchQuestion).sha256,
    dataset: bundled ? 'fictional-research-evidence-v1' : 'custom-research-evidence',
    ...(!bundled ? { datasetSha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex') } : {}),
    threshold: selector.keep.gte,
    rubric: structuredClone(researchQuestion.schemas[selector.out]),
    total: decisions.length, passed, failed: decisions.length - passed, decisions,
    limitations: [bundled ? 'Six fictional cases, authored independently of model answers; not a representative quality benchmark.'
      : `${cases.length} user-supplied labeled cases; the caller is responsible for label correctness and representativeness.`,
      mode === 'scripted' ? 'Scripted adapter outputs test evaluation mechanics, not model quality.'
        : bundled ? 'Observed decisions on this small case set only; no cost or quality improvement is claimed.'
          : 'Observed decisions on this case set only; no cost or quality improvement is claimed.'],
  };
}

if (isMain(import.meta.url)) await runCli(async (signal, options) => {
  const cases = options.cases ? await loadEvidenceCases(options.cases, signal) : evidenceCases;
  const { runJudge } = options.live
    ? await loadResearchAdapters({ ...options, signal, agents: false }) : { runJudge: scriptedEvidenceDecision };
  const report = await evaluateEvidence({ runJudge, cases, signal, mode: options.live ? 'live' : 'scripted' });
  if (options.out) await saveReport(options.out, report, signal);
  if (options.summary) {
    console.log(options.cases ? `Live evaluation — ${report.total} custom cases, not a benchmark.`
      : options.live ? 'Live evaluation — six fictional cases, not a benchmark.' : 'Scripted evaluation — fixture decisions, not model quality.');
    for (const row of report.decisions) {
      console.log(`${row.passed ? 'PASS' : 'FAIL'} ${row.id}: ${row.selected ? 'kept' : 'excluded'} (expected ${row.expected ? 'keep' : 'exclude'}; probability ${row.probability})`);
    }
    console.log(`${report.passed}/${report.total} cases passed. Threshold: ${report.threshold}.`);
  } else console.log(JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 2;
});
