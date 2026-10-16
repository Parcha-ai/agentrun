// npm run demo:video-chapters [-- --live] [-- --kill] [-- --record <dir>] [-- --input <path|json>] [-- --max-usd <n>] [-- --fetch-sources]
// npm run demo:video-chapters -- --serve [--host <address>] [--port <n>] [--live] [--max-usd <n>]: the drop page and the live view.
// A film, in chapters, on the reference entry: on fakes ($0, no key, no network) the committed clip; with --live NASA's film whole.
import { demo, type DemoOptions } from '../reference/index.ts';
import { codeMode } from './code.ts';
import spec from './demo.json' with { type: 'json' };
import { fakes } from './fakes.ts';
import job, { clipInput } from './job.ts';
import { liveParts } from './models.ts';
import { result } from './result.ts';
import sources from './sources.json' with { type: 'json' };

const film = sources.items[0]!;

export const options: DemoOptions = {
  self: import.meta.url, spec, job, fakes: { ...fakes, input: clipInput }, live: liveParts, result,
  extensions: ({ vision }) => [codeMode(vision)],
  // NASA's film is fetched and checked when an input reads it; the clip is the job's own file, and a dropped file is put in the workspace.
  sourcesFor: (input) => (input.film === `${film.id}.mp4` ? [{ id: film.id, url: film.url, bytes: film.bytes, sha256: film.sha256 }] : []),
  itemOf: (path) => path.split('#')[0] || null,
  manifest: ({ models }) => ({ sources: { file: 'examples/video-chapters/sources.json', items: [{ id: film.id, sha256: film.sha256 }] }, models: models ?? { lead: 'scripted lead (pi-ai faux)', eyes: 'scripted-eyes' } }),
};

if (import.meta.main) {
  if (process.argv.includes('--serve')) {
    const served = await (await import('./serve.ts')).serve(options, process.argv.slice(2));
    console.log(`A film, in chapters: ${served.url}/ (${process.argv.includes('--live') ? 'live' : 'fakes, $0'}; Ctrl-C stops the server, and a run it started goes on to its end)`);
  }
  else {
    const run = await demo(options);
    const cited = run?.record as { rows?: { label: string; value: string; note?: string }[] } | null | undefined;
    if (cited?.rows && !process.argv.includes('--json')) for (const row of cited.rows) console.log(`  ${row.label}: ${row.value}${row.note ? ` (${row.note})` : ''}`);
  }
}
