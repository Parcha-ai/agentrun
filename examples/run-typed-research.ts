import { writeFile } from 'node:fs/promises';
import { inspectWorkflow, formatWorkflowTree, runTypedWorkflow } from '@parcha/agentrun-dsl';
import { deepResearch } from './typed-research.ts';
import { question, researchFixtures } from './typed-research-fixtures.ts';

if (process.argv[2] === '--export' && process.argv[3]) {
  await writeFile(process.argv[3], JSON.stringify(deepResearch, null, 2) + '\n', { flag: 'wx' });
} else if (process.argv.length > 2 && !(process.argv.length === 3 && process.argv[2] === '--no-evidence')) {
  throw new Error('Usage: node examples/run-typed-research.ts [--no-evidence | --export new-workflow.json]');
} else {
  console.log(`Question: ${question}\n`);
  console.log(formatWorkflowTree(inspectWorkflow(deepResearch)));
  const { deps, calls } = researchFixtures({ noEvidence: process.argv[2] === '--no-evidence' });
  const result = await runTypedWorkflow(deepResearch, { question }, deps);
  console.log('\nScripted demonstration — fictional evidence, no model or network calls.');
  if (result.status === 'complete') {
    console.log(`Report: ${result.output.answer}`); // Inferred string, no cast.
    console.log(`${result.output.findings.length} subquestions researched; ${result.output.findings.reduce((count, finding) => count + finding.sources.length, 0)} sources retained.`);
  } else {
    console.log(`Needs research: ${result.escalation.summary}`);
    console.log('Stopped before writing findings or a report.');
    process.exitCode = 2;
  }
  const modelSteps = calls.filter(call => call.startsWith('model:')).length;
  console.log(`Calls: ${calls.filter(call => call.startsWith('tool:')).length} tools, ${calls.filter(call => call.startsWith('jev:')).length} system one decisions, ${modelSteps} model step${modelSteps === 1 ? '' : 's'}.`);
}
