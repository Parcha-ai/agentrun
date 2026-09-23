import { runTypedWorkflow, inspectWorkflow } from '@parcha/agentrun-dsl';
import { deepResearch } from './typed-research.ts';
import { question, sourceSets, subquestions, researchFixtures } from './typed-research-fixtures.ts';
import { ResearchExampleError, isMain, loadResearchAdapters, runCli, saveReport, withCancellation } from './research-runtime.mjs';

// A tiny public, fictional corpus. Return all passages to avoid hiding relevant
// evidence behind a keyword filter or requiring a second service/account.
export const corpus = sourceSets.flat();

export function offlineResearchAdapters() {
  return {
    runNode: researchFixtures().deps.runNode,
    async runJudge({ questions, state, signal }) {
      signal?.throwIfAborted();
      const relevant = sourceSets[subquestions.indexOf(state.subquestion)]?.[0]?.id;
      if (!relevant) throw new ResearchExampleError('fixture', 'The scripted decision has no answer for that subquestion.');
      return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, {
        type: 'noul', noul: state.items[Number(id.split('.')[0])].item.id === relevant ? 0.95 : 0.05,
      }])) };
    },
  };
}

export async function runResearch({ adapters = offlineResearchAdapters(), signal, mode = 'scripted' } = {}) {
  signal?.throwIfAborted();
  const calls = { tool: 0, decision: 0, agent: 0 };
  const result = await runTypedWorkflow(deepResearch, { question }, {
    signal,
    async runEffect({ node, signal: effectSignal }) {
      effectSignal?.throwIfAborted();
      if (node.tool !== 'search') throw new ResearchExampleError('tool', 'This example permits only search of the bundled corpus.');
      calls.tool++;
      return { sources: structuredClone(corpus) };
    },
    async runJudge(params) { calls.decision++; return withCancellation(adapters.runJudge(params), params.signal); },
    async runNode(params) { calls.agent++; return withCancellation(adapters.runNode(params), params.signal); },
  });
  signal?.throwIfAborted();
  if (result.status === 'complete') {
    for (const finding of result.output.findings) {
      for (const source of finding.sources) {
        if (!corpus.some(original => original.id === source.id && original.text === source.text)) {
          throw new ResearchExampleError('citation', 'A returned source was absent from or changed from the bundled corpus. The report was rejected.');
        }
      }
    }
  }
  return {
    mode, workflowSha256: inspectWorkflow(deepResearch).sha256,
    question, corpus: 'fictional-wiki-migration-v1', calls,
    status: result.status,
    ...(result.status === 'complete' ? { output: result.output } : { escalation: { kind: result.escalation.kind, summary: result.escalation.summary } }),
    limitations: ['Bundled fictional sources; no web research.', 'Citation identity is checked; that does not establish whether an answer follows from its sources.', 'A successful run is not a research-quality benchmark.'],
  };
}

if (isMain(import.meta.url)) await runCli(async (signal, options) => {
  if (options.cases) throw new ResearchExampleError('usage', '--cases is only supported by the research evaluator.');
  const adapters = options.live ? await loadResearchAdapters({ ...options, signal }) : offlineResearchAdapters();
  const report = await runResearch({ adapters, signal, mode: options.live ? 'live' : 'scripted' });
  if (options.out) await saveReport(options.out, report, signal);
  if (options.summary) {
    console.log(options.live ? 'Live research over fictional sources.' : 'Scripted research — fictional sources; no model calls.');
    if (report.status === 'complete') {
      console.log(`Report: ${report.output.answer}`);
      console.log(`${report.output.findings.length} findings; ${new Set(report.output.findings.flatMap(finding => finding.sources.map(source => source.id))).size} distinct sources cited.`);
    } else {
      console.log(`Needs research: ${report.escalation.summary}`);
      console.log('Stopped without a report.');
    }
    console.log(`Calls: ${report.calls.tool} tools, ${report.calls.decision} system one decisions, ${report.calls.agent} model ${report.calls.agent === 1 ? 'step' : 'steps'}.`);
  } else console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'complete') process.exitCode = 2;
});
