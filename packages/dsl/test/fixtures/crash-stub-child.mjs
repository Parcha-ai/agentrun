// A minimal child of the crash sweep whose faults are chosen by STUB: it crosses one point, prints an outcome and exits.
//   fail-late  the later open prints the outcome, then exits 3
//   hang       a resume never ends
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crossing } from '@parcha/agentrun-dsl/recovery/testing';

const [, , mode, directory] = process.argv;
await crossing('admit');
if (process.env.STUB === 'hang' && mode === 'resume') await new Promise(() => { setInterval(() => {}, 1000); });
console.log(JSON.stringify({ outcome: { ok: true } }));
if (process.env.STUB === 'fail-late' && mode === 'resume' && existsSync(join(directory, 'resumed'))) process.exit(3);
if (mode === 'resume') writeFileSync(join(directory, 'resumed'), '');
