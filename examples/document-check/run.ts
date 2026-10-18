// npm run demo:document-check [-- --live] [-- --record <dir>] [-- --input test-copy | <path|json>] [-- --max-usd <n>]
// A Delaware certified copy, checked mark by mark on the reference entry: on fakes ($0, no key, no network) a scripted lead
// and a scripted Jev; with --live a lead model and Jev. Both read the committed PDFs.
import { demo, type DemoOptions } from '../reference/index.ts';
import spec from './demo.json' with { type: 'json' };
import { fakes } from './fakes.ts';
import job from './job.ts';
import { liveParts } from './models.ts';
import { result } from './result.ts';
import sample from './sample/sample.json' with { type: 'json' };

export const options: DemoOptions = {
  self: import.meta.url, spec, job, fakes, live: liveParts, result,
  itemOf: (path) => path.split('#')[0] || null,
  manifest: ({ models }) => ({ sample: { file: 'examples/document-check/sample/sample.json', filing: sample.filing.accession }, models: models ?? { lead: 'scripted lead (pi-ai faux)', judge: 'scripted-jev' } }),
};

if (import.meta.main) {
  const run = await demo(options);
  const cited = run?.record as { title?: string; rows?: { label: string; value: string; cites: { fragment: string }[] }[] } | null | undefined;
  if (cited?.rows && !process.argv.includes('--json')) {
    console.log(cited.title);
    for (const row of cited.rows) console.log(`  ${row.value === 'yes' ? 'yes' : 'no '}  ${row.label}  ${row.cites.map((cite) => cite.fragment).join(' ')}`);
  }
}
