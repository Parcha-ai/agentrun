import { formatWorkflowTree, inspectWorkflow, runTypedWorkflow } from '@parcha/agentrun-dsl';
import { evidenceWorkflow } from './workflow.js';
import { offlineAdapters, question } from './offline.js';

if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== '--no-evidence') {
  throw new Error('Usage: npm start -- [--no-evidence]');
}
console.log(formatWorkflowTree(inspectWorkflow(evidenceWorkflow)));
console.log('\nFictional sources and scripted decisions. No model or network calls.');
const result = await runTypedWorkflow(evidenceWorkflow, { question }, offlineAdapters(process.argv[2] === '--no-evidence'));
if (result.status === 'complete') {
  console.log(`\n${question}\n`);
  for (const source of result.output) console.log(`[${source.id}] ${source.text}`);
  console.log(`\n${result.output.length} passages retained. The exception stays with the rule.`);
} else {
  console.log(`Needs research: ${result.escalation.summary}`);
  process.exitCode = 2;
}
