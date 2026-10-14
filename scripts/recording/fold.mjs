// The counters of agentrun.recording/1 section 6 that fold from a recording's lines. The fold itself lives with the reference example
// (examples/reference/fold.ts), which uses it for the manifest's cost and which must stand alone; this is its command line.
//
// `node scripts/recording/fold.mjs <recording-dir>` prints the counters as JSON.
import { pathToFileURL } from 'node:url';
import { fold, readEvents } from '../../examples/reference/fold.ts';

export { PI_LIVE_VERSION, fold, readEvents, reAsked, repeats } from '../../examples/reference/fold.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: node scripts/recording/fold.mjs <recording-dir>'); process.exit(2); }
  console.log(JSON.stringify(fold(readEvents(process.argv[2])), null, 2));
}
