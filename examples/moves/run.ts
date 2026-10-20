// npm run demo:moves [-- --handoff] [-- --record <dir>] [-- --live]: the moves demo on the reference entry. The job is data (job.ts), the fakes are fakes.ts, the spec is demo.json.
// The place is the disk package's `localPlace` here; the live runner (live.ts) uses `archilPlace` over a host that is this machine for the first and third process and a Modal VM for the second.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localPlace } from '@parcha/pi-durable-disk';
import { demo, type DemoOptions } from '@parcha/agentrun-harness';
import { fakes } from './fakes.ts';
import { job } from './job.ts';

const spec = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url), 'utf8'));
const childApp = fileURLToPath(import.meta.resolve('@parcha/agentrun-harness/child-app'));

export const options: DemoOptions = { self: import.meta.url, spec, job, fakes, place: localPlace({ app: childApp }) };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await demo(options);
