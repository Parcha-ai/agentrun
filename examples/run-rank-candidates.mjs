import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runWorkflow } from '../packages/dsl/dist/index.js';
import { rankCandidates } from './rank-candidates.mjs';
import { createScriptedJudge, request } from './rank-candidates-fixtures.mjs';

export const help = `Rank a list with the rank-candidates AgentRun workflow.

  node examples/run-rank-candidates.mjs
  node examples/run-rank-candidates.mjs --live [--input ./request.json]

No flags: the fictional talk proposals with a scripted judge, no live calls.
--live: Jev answers the questions. Configure TYPESAFE_API_KEY on the server.
--input: JSON { "brief", "candidates": [{ "id", "title", "bucket", "summary" }], "top", "perBucket", "minScore" }.
--help: show this help.

Build the AgentRun source first. Get a key: https://console.typesafe.ai/keys
Prints the ranked candidates and why each other candidate was cut.`;

export async function main(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return 0; }
  const live = args.includes('--live');
  const inputAt = args.indexOf('--input');
  if (inputAt >= 0 && !live) throw new Error('--input requires --live: the scripted judge only knows the fictional proposals.');
  const input = inputAt >= 0 ? JSON.parse(await readFile(args[inputAt + 1], 'utf8')) : request;
  let runJudge, requests = [];
  if (live) {
    const { createJevRunner } = await import('../packages/jev/dist/index.js');
    const jev = createJevRunner();
    runJudge = params => { requests.push({ label: params.label, questions: Object.keys(params.questions).length }); return jev(params); };
  } else ({ runJudge, requests } = createScriptedJudge());
  const result = await runWorkflow(rankCandidates, input, { runJudge });
  if (result.status !== 'complete') { console.error(`Ranking did not complete: ${result.status}`); return 1; }
  console.log(`${live ? 'Live' : 'Scripted'} judge, ${requests.length} requests: ${requests.map(r => `${r.label} (${r.questions} questions)`).join(', ')}\n`);
  result.output.ranked.forEach((r, i) => console.log(`${i + 1}. ${r.title}  [${r.bucket}, ${r.score.toFixed(2)}]`));
  console.log('\nCut:');
  for (const c of result.output.cut) console.log(`- ${c.id}: ${c.reason}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
