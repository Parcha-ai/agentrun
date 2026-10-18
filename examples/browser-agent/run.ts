// npm run demo:browser -- <example folder> [--live] [--local-chrome] [--record <dir>] [--max-usd <n>]
// The one browser agent on an example's task (question.md): on fakes ($0, no key, no network) a scripted lead and the
// fake browser's practice pages; with --live the real lead and a real browser (Browserbase with its key pair, or with
// --local-chrome a Chrome on this machine).
import { pathToFileURL } from 'node:url';
import { demo, type DemoOptions } from '@parcha/agentrun-reference';
import { exampleAt, inputOf, job } from './agent.ts';
import spec from './demo.json' with { type: 'json' };
import { fakes } from './fakes.ts';
import { liveParts } from './live.ts';
import { result } from './result.ts';

export const options: DemoOptions = {
  self: import.meta.url, spec, job, fakes, live: liveParts, result, keepRun: true,
  manifest: ({ input, models }) => ({ example: input?.example ?? null, models: models ?? { lead: 'scripted lead (pi-ai faux)', browser: 'fake' } }),
};

/** The demo's arguments: an example folder becomes --input (its task); the rest pass through. */
export function argvFor(argv: string[]): string[] {
  const at = argv.findIndex((arg, i) => !arg.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'));
  if (at < 0) return argv;
  return [...argv.slice(0, at), ...argv.slice(at + 1), '--input', JSON.stringify(inputOf(exampleAt(argv[at]!)))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await demo({ ...options, argv: argvFor(process.argv.slice(2)) });
  const answered = run?.record as { answer?: string } | null | undefined;
  if (answered?.answer && !process.argv.includes('--json')) console.log(`  ${answered.answer}`);
  // demo() sets the exit code only when it reads process.argv itself.
  if (run && (run.overBudget || run.failedKills.length || run.failedSignals.length || run.unlanded.length || run.processes.at(-1)?.outcome?.status !== 'complete')) process.exitCode = 1;
}
