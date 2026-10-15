// npm run demo:apollo11 [-- --live] [-- --kill] [-- --record <dir>] [-- --input <path|json>] [-- --max-usd <n>] [-- --fetch-sources] [-- --see-also <recording>]
// Apollo 11, read whole, on the reference entry: on fakes ($0, no key, no network) the committed slice; with --live the landing hour.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demo, type DemoOptions } from '../reference/index.ts';
import { lookCounters, type Cited } from './account.ts';
import { itemOfPath, loadDataset, sourcesFor } from './dataset.ts';
import spec from './demo.json' with { type: 'json' };
import { fakesOf } from './fakes.ts';
import job, { sliceInput } from './job.ts';
import { liveParts } from './models.ts';
import sources from './sources.json' with { type: 'json' };

const knob = (name: string) => process.env[name]?.split(',').filter(Boolean);
const pages = process.env.DEMO_PAGES ? { pages: JSON.parse(readFileSync(process.env.DEMO_PAGES, 'utf8')) } : {};

export const options: DemoOptions = {
  self: import.meta.url, spec, job, live: liveParts, sourcesFor, itemOf: itemOfPath(),
  fakes: { ...fakesOf(sources.classes, { wrong: knob('DEMO_WRONG'), fail: knob('DEMO_FAIL'), ...pages }), input: sliceInput },
  result: (record) => ({ json: record, title: (record as Cited).title }),
  manifest: ({ models }) => {
    const { sha256, slice } = loadDataset();
    return { sources: { file: 'examples/apollo11/sources.json', sha256 }, ...(slice ? { slice: { file: 'examples/apollo11/slice/slice.json', sha256: slice } } : {}), models: models ?? { lead: 'scripted lead (pi-ai faux)', eyes: 'scripted-eyes' } };
  },
};

if (import.meta.main) {
  const run = await demo(options);
  const account = (run?.record as Cited | null | undefined)?.apollo11;
  if (run && account && !process.argv.includes('--json')) {
    console.log(`  the landing: ${account.entries.length} entries, ${account.entries.reduce((n, entry) => n + entry.cites.length, 0)} cites resolved, ${account.dropped.length} dropped; eyes ${account.eyes.join(', ')}`);
    console.log(`  photo sort against NASA's captions: ${account.accuracy.overall.right}/${account.accuracy.overall.total}`);
    console.log(`  times read off the scans: ${account.transcript.times.times} on ${account.transcript.times.pages} pages, ${account.transcript.times.in_typed} in NASA's typed transcript`);
    const store = join(run.dir, 'store', 'run.sqlite');
    if (existsSync(store)) { const counted = lookCounters(store); console.log(`  looks: paid ${counted.paid}, kept ${counted.kept}, repeated ${counted.repeated}, failed ${counted.failed}`); }
  }
}
