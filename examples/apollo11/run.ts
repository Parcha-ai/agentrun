// npm run demo:apollo11 [-- --live] [-- --kill] [-- --record <dir>] [-- --input <path|json>] [-- --max-usd <n>]
// Apollo 11, read whole: the job on fakes ($0, no key) or live (your keys, SETUP-PROMPT.md), its kill and its recording, through the
// platform's flags. `seam.ts` stands in for the reference entry's `demo()` until the entry runs vision on fakes and holds its filings.
import spec from './demo.json' with { type: 'json' };
import { fakesOf } from './fakes.ts';
import job from './job.ts';
import { demo, type ApolloDemo } from './seam.ts';
import sources from './sources.json' with { type: 'json' };

export const options: ApolloDemo = { self: import.meta.url, spec, job, fakes: fakesOf(sources.classes) };

if (import.meta.main) await demo(options);
