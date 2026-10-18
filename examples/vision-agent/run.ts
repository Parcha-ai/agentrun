// npm run demo:vision -- <example folder> [--live] [--record <dir>] [--max-usd <n>] [--fetch-sources]
// The one vision agent on an example's question and files (question.md, inputs.json): on fakes ($0, no key, no network)
// a scripted lead and scripted models over the example's committed files; with --live the real models over every file,
// those fetched by URL checked by size and SHA-256.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { demo, type DemoOptions } from '@parcha/agentrun-reference';
import { exampleAt, inputOf, job } from './agent.ts';
import spec from './demo.json' with { type: 'json' };
import { fakes } from './fakes.ts';
import { liveParts, preflight } from './live.ts';
import { result } from './result.ts';

export const options: DemoOptions = {
  self: import.meta.url, spec, job, fakes, live: liveParts, result, keepRun: true,
  // The files an input names that its example fetches by URL; a committed one is the job's own file.
  sourcesFor: (input) => {
    const named = typeof input.example === 'string' ? input.example : undefined;
    if (!named) return [];
    return exampleAt(named).items.filter((item) => item.url).map((item) => ({ id: item.id, url: item.url!, bytes: item.bytes, sha256: item.sha256 }));
  },
  itemOf: (path) => path.split('#')[0] || null,
  manifest: ({ input, models }) => ({ example: input?.example ?? null, models: models ?? { lead: 'scripted lead (pi-ai faux)', eyes: 'scripted-eyes', jev: 'scripted-jev', transcriber: 'scripted-words' } }),
};

/** The demo's arguments: an example folder becomes --input (its question and files); the rest pass through. */
export function argvFor(argv: string[]): string[] {
  const at = argv.findIndex((arg, i) => !arg.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'));
  if (at < 0) return argv;
  const example = exampleAt(argv[at]!);
  return [...argv.slice(0, at), ...argv.slice(at + 1), '--input', JSON.stringify(inputOf(example))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = argvFor(process.argv.slice(2));
  // A live run that lacks a key is refused here, before the recorder starts: nothing is written, and no cost is printed.
  const refused = preflight(argv);
  if (refused) {
    console.error(refused);
    process.exitCode = 1;
  } else {
    const run = await demo({ ...options, argv });
    const cited = run?.record as { answer?: string; report?: string } | null | undefined;
    if (cited?.answer && !process.argv.includes('--json')) console.log(`  ${cited.answer}${cited.report ? `\n  report: ${join(run!.dir, 'work', cited.report)}` : ''}`);
    // demo() sets the exit code only when it reads process.argv itself.
    if (run && (run.overBudget || run.failedKills.length || run.failedSignals.length || run.unlanded.length || run.processes.at(-1)?.outcome?.status !== 'complete')) process.exitCode = 1;
  }
}
