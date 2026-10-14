// The counters strip of agentrun.recording/1 section 6 for a recording's lines. It is the viewer's fold (apps/viewer/src/counters.ts),
// the one fold; this is its command line and the function the repo's tests call.
//
// `node scripts/recording/fold.mjs <recording-dir>` prints the counters as JSON.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { counterFold, countersOf } from '../../apps/viewer/src/counters.ts';

/** The events of a recording directory, parsed. */
export const readEvents = (dir) => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

/** The counters at the end of a recording's lines. */
export const fold = (lines) => countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: node scripts/recording/fold.mjs <recording-dir>'); process.exit(2); }
  console.log(JSON.stringify(fold(readEvents(process.argv[2])), null, 2));
}
