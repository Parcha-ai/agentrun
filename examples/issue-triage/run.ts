// npm run demo:issue-triage [-- --record <dir>] [-- --kill] [-- --dir <path>] [-- --json]: the issue-triage job on the reference entry, on fakes ($0, no key).
// The flags are the entry's own (`demo()`); see examples/reference/README.md.
import { demo } from '../reference/index.ts';
import demoSpec from './demo.json' with { type: 'json' };
import { fakes, job } from './job.ts';
import { live } from './live.ts';

// demo.json's title is the gallery take's, a live one. The scripted run is about synthetic issues, and its recording says so.
const isLive = process.env.LIVE === '1' || process.argv.includes('--live');
const spec = isLive ? demoSpec : { ...demoSpec, title: "Triage a repository's newest issues (a scripted run on synthetic issues, not a real repository's)" };

await demo({ self: import.meta.url, spec, job, fakes, live });
