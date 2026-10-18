// npm run demo:placed [-- --live] [-- --record <dir>] [-- --input '{"frames":6}']: a zoom a pi agent draws frame by frame, each frame a tool call that Jev places in a Daytona or a Modal
// sandbox. On fakes (no key, no network) both sandboxes are directories of this machine, a scripted lead asks for the frames and a script places them. See README.md.
import { pathToFileURL } from 'node:url';
import { demo, type DemoOptions } from '@parcha/agentrun-reference';
import spec from './demo.json' with { type: 'json' };
import { fakes } from './fakes.ts';
import { job } from './job.ts';
import { liveParts } from './live.ts';
import { result } from './result.ts';

export const options: DemoOptions = {
  self: import.meta.url, spec, job, fakes, live: liveParts, result, keepRun: true,
  manifest: ({ input, live, models }) => ({ frames: input?.frames ?? job.input.frames, lead: live ? models?.lead ?? null : 'a scripted lead (pi-ai faux)', placer: live ? 'Jev (typesafe/jev-latest)' : 'a script (no Jev call)', boxes: live ? models ?? null : 'local boxes for both environments' }),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await demo(options);
