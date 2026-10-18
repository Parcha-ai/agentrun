// `?cite=<citation>`: the stop just after the commit that first wrote a citation, so a reader of a published brief
// jumps from a claim to the moment its evidence entered the run.
import type { Line } from './format.ts';
import { stopsOf } from './replay.ts';

/** The stop after the first durable line whose data or blobs hold `citation`, or undefined when none does. A
 *  `vision.kept` document (draft 36) is skipped: it keeps a look's answer under its key before the look is filed, a memo
 *  of the call, not the moment the look entered the run. */
export function citeStop(lines: Line[], citation: string): number | undefined {
  const memo = (line: Line) => line.kind === 'vision.kept' || (line.data as { doc?: unknown } | null)?.doc === 'vision.kept';
  const at = lines.findIndex((line) => line.channel === 'durable' && !memo(line) && (JSON.stringify(line.data).includes(citation) || (line.blobs ?? []).includes(citation)));
  if (at < 0) return undefined;
  // No stop falls inside a commit, live lines between its lines included, so the first stop after the line is the end of
  // its commit.
  const stops = stopsOf(lines);
  let end = at + 1;
  while (end < lines.length && !stops[end]) end += 1;
  return end;
}
