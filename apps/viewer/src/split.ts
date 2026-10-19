// A recording's lines in two files (RECORDING.md draft 51): `events.jsonl`, and `events.live.jsonl` with exactly its
// `pi.live` lines, each placed back by `events.live.idx`, one 0-based position in the unsplit file per live line. The
// split moves lines and never edits them, so split and merged again a recording is the same bytes. A publisher (the
// gallery's build) splits; the validator, the gate and the inspection view merge before they read. The two live files
// come together or neither, and a view knows a recording is split only because `events.live.idx` is there.

export const LIVE_LINES = 'events.live.jsonl';
export const LIVE_INDEX = 'events.live.idx';

/** Each line of `text` with its own end: the last one may have none. */
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Whether a line (its text, its end left in or out) is a `pi.live` document line. */
export function isLiveLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { kind?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.kind === 'pi.live';
  } catch { return false; }
}

/** `text` (a whole events.jsonl) split: its other lines, its `pi.live` lines, and the live lines' positions, as the three
 *  files hold them. No live line: nothing to split, `live` and `idx` empty. */
export function splitLines(text: string): { lines: string; live: string; idx: string } {
  const main: string[] = [];
  const live: string[] = [];
  const at: number[] = [];
  linesOf(text).forEach((line, index) => { if (isLiveLine(line)) { live.push(line); at.push(index); } else main.push(line); });
  return { lines: main.join(''), live: live.join(''), idx: at.map((position) => `${position}\n`).join('') };
}

/** The three files merged back into the unsplit text, or the reason they do not merge: `idx` is one base-10 integer per
 *  line, each line ending in LF; one position per live line, strictly increasing, inside the merged list; every live line
 *  is a `pi.live` line. */
export function mergeLines(lines: string, live: string, idx: string): { text: string } | { problem: string } {
  if (!/^(?:(?:0|[1-9][0-9]*)\n)*$/.test(idx)) return { problem: `${LIVE_INDEX} is not one base-10 integer per line, each ending in LF` };
  const positions = idx === '' ? [] : idx.slice(0, -1).split('\n').map(Number);
  const liveLines = linesOf(live);
  const mainLines = linesOf(lines);
  if (positions.length !== liveLines.length) return { problem: `${LIVE_INDEX} holds ${positions.length} positions for the ${liveLines.length} lines of ${LIVE_LINES}` };
  const notLive = liveLines.findIndex((line) => !isLiveLine(line));
  if (notLive >= 0) return { problem: `${LIVE_LINES} line ${notLive + 1} is not a pi.live line` };
  const total = mainLines.length + liveLines.length;
  for (let n = 0; n < positions.length; n++) {
    if (n > 0 && positions[n]! <= positions[n - 1]!) return { problem: `${LIVE_INDEX} position ${positions[n]} (line ${n + 1}) does not increase past ${positions[n - 1]}` };
    if (positions[n]! >= total) return { problem: `${LIVE_INDEX} position ${positions[n]} (line ${n + 1}) is past the ${total} lines merged` };
  }
  // Only the last line of the unsplit file may have no end: a line with none anywhere else would run into the next.
  const merged: string[] = new Array(total);
  positions.forEach((position, n) => { merged[position] = liveLines[n]!; });
  let next = 0;
  for (let index = 0; index < total; index++) if (merged[index] === undefined) merged[index] = mainLines[next++]!;
  if (merged.slice(0, -1).some((line) => !line.endsWith('\n'))) return { problem: `a line other than the last has no end of line once merged` };
  return { text: merged.join('') };
}
