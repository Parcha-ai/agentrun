// Following a live run: a recording directory that grows while the run goes (events.jsonl gains whole lines, a blob is
// written before any line names it, manifest.json is written last, once the run finished). The viewer reads
// events.jsonl from the last byte it read, keeps a partial last line for the next read, places new lines in the format's
// file order, and stops when manifest.json appears.
import { fileOrder, parseLines, type Line, type Manifest } from './format.ts';

type Fetch = (url: string, init?: { headers?: Record<string, string>; cache?: 'no-store'; method?: string }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;

/** How many of the bytes already read each read asks for again, to tell a file that grew from one written anew. */
const OVERLAP = 256;
/** Every how many reads one asks for every byte already read again, to tell a line written anew earlier in the file. */
const WHOLE_EVERY = 30;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, at) => byte === b[at]);

/** Reads a growing events.jsonl: each `read` returns the whole lines written since the last one. A server that answers a
 *  range (206) sends only what is new; one that sends the whole file (200) is read from where the last read stopped. A
 *  writer may also replace the file whole (a recorder that puts a late line in its place): each read asks again for the
 *  last bytes it read, and every `every`th read for all of them; when they differ, or the file is now shorter, it reads
 *  the new file from its start and says so (`replaced`). */
export function tailOf(url: string, fetcher: Fetch = fetch as unknown as Fetch, every = WHOLE_EVERY) {
  let offset = 0;
  let carry = '';
  let decoder = new TextDecoder();
  // Every byte read so far, in a buffer that doubles as it fills.
  let held = new Uint8Array(4096);
  let reads = 0;
  const keep = (bytes: Uint8Array) => {
    if (offset + bytes.byteLength > held.byteLength) {
      const more = new Uint8Array(Math.max(held.byteLength * 2, offset + bytes.byteLength));
      more.set(held.subarray(0, offset));
      held = more;
    }
    held.set(bytes, offset);
    offset += bytes.byteLength;
  };
  const read = async (): Promise<{ lines: Line[]; replaced: boolean }> => {
    reads += 1;
    const back = reads % every === 0 ? offset : Math.min(OVERLAP, offset);
    const seen = held.subarray(offset - back, offset);
    const response = await fetcher(url, { headers: { Range: `bytes=${offset - back}-` }, cache: 'no-store' });
    // Nothing at all from before the offset: the file is shorter than what was read.
    if (response.status === 416) return offset > 0 ? restart() : { lines: [], replaced: false };
    // Not written yet: a run that has not started.
    if (response.status === 404 && offset === 0) return { lines: [], replaced: false };
    if (!response.ok) throw new Error(`events.jsonl answered ${response.status}`);
    const whole = new Uint8Array(await response.arrayBuffer());
    const from = response.status === 206 ? whole : whole.subarray(Math.min(offset - back, whole.byteLength));
    if (from.byteLength < back || !sameBytes(from.subarray(0, back), seen)) return restart();
    const fresh = from.subarray(back);
    keep(fresh);
    // A UTF-8 character may be cut between two reads, and a line between two writes: both wait for the next read.
    const text = carry + decoder.decode(fresh, { stream: true });
    const end = text.lastIndexOf('\n');
    carry = text.slice(end + 1);
    return { lines: end < 0 ? [] : parseLines(text.slice(0, end + 1)), replaced: false };
  };
  const restart = async (): Promise<{ lines: Line[]; replaced: boolean }> => {
    offset = 0;
    carry = '';
    decoder = new TextDecoder();
    return { lines: (await read()).lines, replaced: true };
  };
  return { get offset() { return offset; }, read };
}

/** The manifest once the run finished (it is written last), or undefined while it goes. */
export async function finishedManifest(url: string, fetcher: Fetch = fetch as unknown as Fetch): Promise<Manifest | undefined> {
  const response = await fetcher(url, { cache: 'no-store' });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`manifest.json answered ${response.status}`);
  return await response.json() as Manifest;
}

/** New lines placed in the format's file order (`fileOrder`, RECORDING.md section 3). `from` is the first place that
 *  changed: the old length when every new line comes after the last one, earlier when a line arrived after lines it
 *  precedes. Lines equal in that order keep the order they arrived in. */
export function placeLines(lines: readonly Line[], fresh: readonly Line[]): { lines: Line[]; from: number } {
  if (fresh.length === 0) return { lines: [...lines], from: lines.length };
  const arrived = [...fresh].map((line, at) => ({ line, at })).sort((a, b) => fileOrder(a.line, b.line) || a.at - b.at).map(({ line }) => line);
  const first = arrived[0]!;
  let from = lines.length;
  while (from > 0 && fileOrder(lines[from - 1]!, first) > 0) from -= 1;
  const tail = [...lines.slice(from), ...arrived].map((line, at) => ({ line, at })).sort((a, b) => fileOrder(a.line, b.line) || a.at - b.at).map(({ line }) => line);
  return { lines: [...lines.slice(0, from), ...tail], from };
}
