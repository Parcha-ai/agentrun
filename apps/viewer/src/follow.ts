// Following a live run: a recording directory that grows while the run goes (events.jsonl gains whole lines, a blob is
// written before any line names it, manifest.json is written last, once the run finished). The viewer reads
// events.jsonl from the last byte it read, keeps a partial last line for the next read, places new lines in the format's
// file order, and stops when manifest.json appears.
import { parseLines, type Line, type Manifest } from './format.ts';

type Fetch = (url: string, init?: { headers?: Record<string, string>; cache?: 'no-store'; method?: string }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;

/** Reads a growing events.jsonl: each `read` returns the whole lines written since the last one. A server that answers a
 *  range (206) sends only what is new; one that sends the whole file (200) is read from where the last read stopped. */
export function tailOf(url: string, fetcher: Fetch = fetch as unknown as Fetch) {
  let offset = 0;
  let carry = '';
  const decoder = new TextDecoder();
  return {
    get offset() { return offset; },
    async read(): Promise<Line[]> {
      const response = await fetcher(url, { headers: { Range: `bytes=${offset}-` }, cache: 'no-store' });
      if (response.status === 416) return [];
      if (!response.ok) throw new Error(`events.jsonl answered ${response.status}`);
      const whole = new Uint8Array(await response.arrayBuffer());
      const fresh = response.status === 206 ? whole : whole.subarray(Math.min(offset, whole.byteLength));
      offset += fresh.byteLength;
      // A UTF-8 character may be cut between two reads, and a line between two writes: both wait for the next read.
      const text = carry + decoder.decode(fresh, { stream: true });
      const end = text.lastIndexOf('\n');
      carry = text.slice(end + 1);
      return end < 0 ? [] : parseLines(text.slice(0, end + 1));
    },
  };
}

/** The manifest once the run finished (it is written last), or undefined while it goes. */
export async function finishedManifest(url: string, fetcher: Fetch = fetch as unknown as Fetch): Promise<Manifest | undefined> {
  const response = await fetcher(url, { cache: 'no-store' });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`manifest.json answered ${response.status}`);
  return await response.json() as Manifest;
}

/** New lines placed in the format's file order (RECORDING.md section 3): by `t`, and in the order they arrived when
 *  their `t` is the same, which is each writer's own order. `from` is the first place that changed: the old length when
 *  every new line comes after the last one, earlier when a line arrived after lines it precedes. */
export function placeLines(lines: readonly Line[], fresh: readonly Line[]): { lines: Line[]; from: number } {
  if (fresh.length === 0) return { lines: [...lines], from: lines.length };
  const earliest = fresh.reduce((least, line) => Math.min(least, line.t), Infinity);
  let from = lines.length;
  while (from > 0 && lines[from - 1]!.t > earliest) from -= 1;
  const tail = [...lines.slice(from), ...fresh].map((line, at) => ({ line, at })).sort((a, b) => a.line.t - b.line.t || a.at - b.at).map(({ line }) => line);
  return { lines: [...lines.slice(0, from), ...tail], from };
}
