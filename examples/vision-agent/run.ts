// npm run demo:vision -- <example folder> [--live] [--record <dir>] [--max-usd <n>] [--thinking low|medium|high] [--fetch-sources]
// The one vision agent on an example's question and files (question.md, inputs.json): on fakes ($0, no key, no network)
// a scripted lead and scripted models over the example's committed files; with --live the real models over every file,
// those fetched by URL checked by size and SHA-256.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { demo, type DemoOptions } from '@parcha/agentrun-harness';
import { exampleAt, inputOf, job, jobOf, positionalAt, thinkingOf, thinkingRefusal } from './agent.ts';
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

/** `--thinking <level>` or `--thinking=<level>` taken out of the arguments, with the value it had (empty when it had none). */
function takeThinking(argv: string[]): { rest: string[]; thinking?: string } {
  const at = argv.findIndex((arg) => arg === '--thinking' || arg.startsWith('--thinking='));
  if (at < 0) return { rest: argv };
  if (argv[at]!.startsWith('--thinking=')) return { rest: [...argv.slice(0, at), ...argv.slice(at + 1)], thinking: argv[at]!.slice('--thinking='.length) };
  const value = argv[at + 1];
  const has = value !== undefined && !value.startsWith('--');
  return { rest: [...argv.slice(0, at), ...argv.slice(at + (has ? 2 : 1))], thinking: has ? value : '' };
}

/** The demo's arguments: an example folder (the one argument that is neither a flag nor a flag's value) becomes --input (its question
 *  and files), `--thinking` becomes the input's `thinking` (the host reads no such flag, and the run's child process is given nothing but
 *  the input); the rest pass through. A second folder, or one that is not an example, throws: it is refused, never ignored. */
export function argvFor(argv: string[]): string[] {
  const { rest, thinking } = takeThinking(argv);
  const folders = positionalAt(rest);
  if (folders.length > 1) throw new Error(`one example folder at a time: ${folders.map((i) => rest[i]).join(', ')}`);
  const at = folders[0] ?? -1;
  const out = at < 0 ? rest : [...rest.slice(0, at), ...rest.slice(at + 1), '--input', JSON.stringify(inputOf(exampleAt(rest[at]!)))];
  if (thinking === undefined) return out;
  const given = out.indexOf('--input');
  const base = given >= 0 ? inlineObject(out[given + 1]) : undefined;
  // An input it cannot read inline (a file, a capture name, none, or JSON that is not an object) has nowhere to put the level: the flag
  // stays in the arguments, and the command line refuses it rather than run at the wrong level.
  if (!base) return [...out, `--thinking=${thinking}`];
  const input = JSON.stringify({ ...base, thinking });
  return out.map((arg, i) => (i === given + 1 ? input : arg));
}

const inlineObject = (text: string | undefined): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text ?? '');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch { return undefined; }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let argv: string[] = [];
  let refused: string | undefined;
  // A folder that cannot be placed, a thinking level that is not low, medium or high, or a live run that lacks a key, is refused here,
  // before the recorder starts: nothing is written, and no cost is printed. The child process reads its level from the input, which the
  // supervisor gave it.
  try {
    argv = argvFor(process.argv.slice(2));
    refused = thinkingRefusal(argv) ?? preflight(argv);
  } catch (error) {
    refused = (error as Error).message;
  }
  if (refused) {
    console.error(refused);
    process.exitCode = 1;
  } else {
    const run = await demo({ ...options, job: jobOf(thinkingOf(argv)), argv });
    const cited = run?.record as { answer?: string; report?: string } | null | undefined;
    if (cited?.answer && !process.argv.includes('--json')) console.log(`  ${cited.answer}${cited.report ? `\n  report: ${join(run!.dir, 'work', cited.report)}` : ''}`);
    // demo() sets the exit code only when it reads process.argv itself.
    if (run && (run.overBudget || run.failedKills.length || run.failedSignals.length || run.unlanded.length || run.processes.at(-1)?.outcome?.status !== 'complete')) process.exitCode = 1;
  }
}
