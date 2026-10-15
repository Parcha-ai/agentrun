// npm run demo:disk [-- --kill] [-- --record <dir>] [-- --live]: the disk demo on the reference entry. The job is data (job.ts), the fakes are fakes.ts, the spec is demo.json,
// and the standard flags are the entry's. `place` is where the run lives and how its process starts, stops and comes back: the entry's local place on fakes.
import { readFileSync } from 'node:fs';
import { demo } from '../reference/index.ts';
import { fakes } from './fakes.ts';
import { job } from './job.ts';

const raw = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url), 'utf8'));
// The spec's kill is the box going away, which a disk place can do (the sandbox is deleted). The local place has no box of its own: on fakes the same crossing ends the process.
const spec = process.argv.includes('--live') ? raw : { ...raw, kills: raw.kills.map(({ kind, ...kill }: { kind?: string }) => kill) };

await demo({ self: import.meta.url, spec, job, fakes });
