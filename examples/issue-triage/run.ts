// npm run demo:issue-triage [-- --record <dir>] [-- --kill] [-- --dir <path>] [-- --json]: the issue-triage job on the reference entry, on fakes ($0, no key).
// The flags are the entry's own (`demo()`); see examples/reference/README.md.
import { demo } from '../reference/index.ts';
import demoSpec from './demo.json' with { type: 'json' };
import { fakes, job } from './job.ts';
import { live } from './live.ts';

// The scripted run's title says its issues are synthetic; a live take is about a real repository's issues, and its recording says so.
const spec = process.env.LIVE === '1' || process.argv.includes('--live')
  ? { ...demoSpec, title: "Triage a public repository's newest issues, scored against its maintainers' labels" }
  : demoSpec;

await demo({ self: import.meta.url, spec, job, fakes, live });
