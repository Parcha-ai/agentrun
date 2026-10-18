// npm run demo:hear-and-find [-- --live] [-- --record <dir>] [-- --input <path|json>] [-- --max-usd <n>] [-- --fetch-sources]
// Hear and find, on the reference entry: on fakes ($0, no key, no network) the committed clip; with --live NASA's film whole,
// and its original for the frame that gets the box.
import { demo, type DemoOptions } from '../reference/index.ts';
import spec from './demo.json' with { type: 'json' };
import { fakes } from './fakes.ts';
import job, { clipInput } from './job.ts';
import { liveParts } from './models.ts';
import { result } from './result.ts';
import sources from './sources.json' with { type: 'json' };

const films = new Map(sources.items.map((item) => [`${item.id}.mp4`, item]));

export const options: DemoOptions = {
  self: import.meta.url, spec, job, fakes: { ...fakes, input: clipInput }, live: liveParts, result,
  // A NASA film an input names is fetched and checked when it is read; the clip is the job's own file.
  sourcesFor: (input) => [input.film, input.best].flatMap((name) => { const item = films.get(String(name)); return item ? [{ id: item.id, url: item.url, bytes: item.bytes, sha256: item.sha256 }] : []; })
    .filter((item, i, all) => all.findIndex((each) => each.id === item.id) === i),
  itemOf: (path) => path.split('#')[0] || null,
  manifest: ({ models }) => ({ sources: { file: 'examples/hear-and-find/sources.json', items: sources.items.map((item) => ({ id: item.id, sha256: item.sha256 })) }, models: models ?? { lead: 'scripted lead (pi-ai faux)', eyes: 'scripted-eyes', jev: 'scripted-jev', transcriber: 'scripted-words' } }),
};

if (import.meta.main) {
  const run = await demo(options);
  const cited = run?.record as { rows?: { label: string; value: string; note?: string }[] } | null | undefined;
  if (cited?.rows && !process.argv.includes('--json')) for (const row of cited.rows) console.log(`  ${row.label}: ${row.value}${row.note ? ` (${row.note})` : ''}`);
}
