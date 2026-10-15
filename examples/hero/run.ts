// npm run demo:hero [-- --live] [-- --kill] [-- --record <dir>] [-- --input <json|file>]: the hero job on the reference entry. See README.md.
import { pathToFileURL } from 'node:url';
import { demo } from '../reference/index.ts';
import spec from './demo.json' with { type: 'json' };
import { fakes } from './fakes.ts';
import { job } from './job.ts';
import { result } from './result.ts';

/** What the supervisor and each process of the run read: the job, its fakes and the result it keeps. */
export const options = { self: import.meta.url, spec, job, fakes, result };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await demo(options);
