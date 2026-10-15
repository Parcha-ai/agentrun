// A demo's `run.ts` as the reference entry's own test uses it: the reference job and its fakes, the spec from `DEMO_SPEC` (a JSON file), the standard flags.
import { readFileSync } from 'node:fs';
import { demo } from './demo.ts';
import { fakes, job } from './job.ts';

const spec = JSON.parse(readFileSync(process.env.DEMO_SPEC!, 'utf8'));
// A test knob: what the judge costs, so a run can pass a spend cap.
const judgeCost = Number(process.env.DEMO_JUDGE_COST ?? 0);
await demo({ self: import.meta.url, spec, job, fakes: judgeCost ? { ...fakes, judge: async (request) => ({ ...(await fakes.judge(request)), cost_usd: judgeCost }) } : fakes });
