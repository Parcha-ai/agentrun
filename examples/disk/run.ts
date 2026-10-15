// npm run demo:disk [-- --kill] [-- --record <dir>] [-- --live]: the disk demo on the reference entry. The job is data (job.ts), the fakes are fakes.ts, the spec is demo.json, and the
// standard flags are the entry's. The place is the disk package's `localPlace`: each process of the run is `pi-durable-disk run --app` on the reference's child-app, which opens the run on
// the package's own claim and runs the job on it. The entry reads `options` (DEMO_ENTRY is this file); the supervisor starts, kills and restarts through the place.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localPlace } from '@parcha/pi-durable-disk';
import { demo, type DemoOptions } from '../reference/index.ts';
import { fakes } from './fakes.ts';
import { job } from './job.ts';

const raw = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url), 'utf8'));
// The spec's kill is the box going away, which a disk place can do (the sandbox is deleted). The local place has no box of its own: on fakes the same crossing ends the process.
const spec = process.argv.includes('--live') ? raw : { ...raw, kills: raw.kills.map(({ kind, ...kill }: { kind?: string }) => kill) };
const childApp = fileURLToPath(new URL('../reference/child-app.ts', import.meta.url));

export const options: DemoOptions = {
  self: import.meta.url, spec, job, fakes,
  // The child-app finds the demo's options through DEMO_ENTRY, which the place's runner is handed with each start.
  place: (context) => {
    const place = localPlace({ app: childApp })(context);
    const withEntry = (order: Parameters<typeof place.start>[0]) => ({ ...order, env: { ...order.env, DEMO_ENTRY: import.meta.url } });
    return { ...place, start: (order) => place.start(withEntry(order)), recover: (last, kind, order) => place.recover(last, kind, withEntry(order)) };
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await demo(options);
