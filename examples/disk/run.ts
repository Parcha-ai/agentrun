// npm run demo:disk [-- --kill | --handoff] [-- --record <dir>] [-- --live]: the disk demo on the reference entry. The job is data (job.ts), the fakes are fakes.ts, the spec is demo.json, and the
// standard flags are the entry's. The place is the disk package's `localPlace`: each process of the run is `pi-durable-disk run --app` on the reference package's child-app, which opens the run on
// the package's own claim and runs the job on it. The entry reads `options` (it hands the runner DEMO_ENTRY, this file); the supervisor starts, kills and restarts through the place.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localPlace } from '@parcha/pi-durable-disk';
import { demo, type DemoOptions } from '@parcha/agentrun-harness';
import { fakes } from './fakes.ts';
import { job } from './job.ts';
import { live } from './model.ts';

const raw = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url), 'utf8'));
// The spec's kill is the box going away, which a disk place can do (the sandbox is deleted). The local place has no box of its own: on fakes the same crossing ends the process. `--handoff` runs the spec's handoffs instead (the entry's flag).
const spec = process.argv.includes('--live') ? raw : { ...raw, kills: raw.kills.map(({ kind, ...kill }: { kind?: string }) => kill) };
const childApp = fileURLToPath(import.meta.resolve('@parcha/agentrun-harness/child-app'));

export const options: DemoOptions = { self: import.meta.url, spec, job, fakes, live, place: localPlace({ app: childApp }) };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await demo(options);
