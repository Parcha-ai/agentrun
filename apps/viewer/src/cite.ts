// `?cite=<citation>`: the stop just after the commit that first wrote a citation, so a reader of a published brief
// jumps from a claim to the moment its evidence entered the run.
import type { Line } from './format.ts';
import { stopsOf, snap } from './replay.ts';

/** The stop after the first durable line whose data or blobs hold `citation`, or undefined when none does. */
export function citeStop(lines: Line[], citation: string): number | undefined {
  const at = lines.findIndex((line) => line.channel === 'durable' && (JSON.stringify(line.data).includes(citation) || (line.blobs ?? []).includes(citation)));
  if (at < 0) return undefined;
  const commit = lines[at]!.commit;
  let end = at + 1;
  while (end < lines.length && lines[end]!.channel === 'durable' && lines[end]!.commit === commit) end += 1;
  return snap(stopsOf(lines), end);
}
