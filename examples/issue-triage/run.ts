// npm run demo:issue-triage [-- --record <dir>] [-- --kill] [-- --dir <path>] [-- --json]: the issue-triage job on the reference entry, on fakes ($0, no key).
// The flags are the entry's own (`demo()`); see examples/reference/README.md.
import { demo } from '../reference/index.ts';
import spec from './demo.json' with { type: 'json' };
import { fakes, job } from './job.ts';

await demo({ self: import.meta.url, spec, job, fakes });
