// A run's screen recordings as the API serves them: the files computer-record.ts writes into the run's recordings folder
// on this machine (workspace/paths.ts recordingsFolder), beside its work/ folder. The run view lists them (`recordings`),
// and the run files route serves them under recordings/, read-only, to the readers of the run's other files.
//
// A file's length is read from its own boxes, never by running a program: ffmpeg's fragmented MP4 says each fragment's
// start (tfdt) and each frame's duration (trun, else tfhd's or trex's default), at its track's timescale (mdhd). A
// finished file ends with ffmpeg's trailer (mfra); one still being written has none, and its last box may be cut short,
// so it is read up to its last whole box. A read goes on from where the one before it stopped, so a console that polls a
// recording being written reads only what was added.
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RECORDING_LIMITS } from "./computer-record.js";
import { localWorkspace, readOnlyWorkspace, type Workspace } from "./workspace/index.js";
import { RECORDINGS } from "./workspace/paths.js";

/** One recording as the run view lists it. `finished`: ffmpeg finished the file, or the run has ended and the file has
 *  stopped changing (an encoder cut short leaves a file that plays up to its last fragment). */
export type RecordingView = { path: string; computer: string; seconds: number; bytes: number; finished: boolean };

/** The recordings `folder` holds as a read-only Workspace, or null when it holds none (the run recorded nothing). */
export async function recordingsWorkspace(folder: string): Promise<Workspace | null> {
  const there = await lstat(folder).catch(() => undefined);
  return there?.isDirectory() ? readOnlyWorkspace(localWorkspace(folder)) : null;
}

/** How far a file was read, and what it said up to there. */
type Read = { at: number; size: number; timescale: number; dflt: number; end: number; finished: boolean };
/** The newest reads, by path: at most READS_KEPT. */
const reads = new Map<string, Read>();
const READS_KEPT = 256;

/** The boxes in `buf`, each its type and its body; a box cut short ends the walk. */
function* boxes(buf: Buffer): Generator<[string, Buffer]> {
  for (let at = 0; at + 8 <= buf.length; ) {
    let length = buf.readUInt32BE(at);
    let head = 8;
    if (length === 1 && at + 16 <= buf.length) [length, head] = [Number(buf.readBigUInt64BE(at + 8)), 16];
    if (length < head || at + length > buf.length) return;
    yield [buf.toString("latin1", at + 4, at + 8), buf.subarray(at + head, at + length)];
    at += length;
  }
}

/** What box `type` says into `read`: the timescale, the default frame duration, and a fragment's end. */
function take(read: Read, type: string, body: Buffer): void {
  if (type === "moov" || type === "trak" || type === "mdia" || type === "mvex" || type === "moof") for (const [inner, part] of boxes(body)) take(read, inner, part);
  else if (type === "mdhd") read.timescale = body.readUInt32BE(body[0] === 1 ? 20 : 12);
  else if (type === "trex") read.dflt = body.readUInt32BE(12);
  else if (type === "traf") {
    let start = 0;
    let dflt = read.dflt;
    let length = 0;
    for (const [inner, part] of boxes(body)) {
      const flags = part.readUInt32BE(0) & 0xffffff;
      if (inner === "tfhd" && flags & 0x8) dflt = part.readUInt32BE(8 + (flags & 0x1 ? 8 : 0) + (flags & 0x2 ? 4 : 0));
      else if (inner === "tfdt") start = part[0] === 1 ? Number(part.readBigUInt64BE(4)) : part.readUInt32BE(4);
      else if (inner === "trun") {
        const count = part.readUInt32BE(4);
        const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length;
        for (let i = 0, at = 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0); i < count; i += 1, at += stride) length += flags & 0x100 ? part.readUInt32BE(at) : dflt;
      }
    }
    read.end = Math.max(read.end, start + length);
  }
}

/** File `path`'s read, `size` bytes long now: on from the last read when the file only grew, else from its start. */
async function readOf(path: string, size: number): Promise<Read> {
  const kept = reads.get(path);
  const read: Read = kept && kept.size <= size ? { ...kept } : { at: 0, size: 0, timescale: 0, dflt: 0, end: 0, finished: false };
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(16);
    while (read.at + 8 <= size) {
      await file.read(head, 0, 16, read.at);
      let length = head.readUInt32BE(0);
      let skip = 8;
      if (length === 1) [length, skip] = [Number(head.readBigUInt64BE(8)), 16];
      if (length < skip || read.at + length > size) break;
      const type = head.toString("latin1", 4, 8);
      if (type === "mfra") read.finished = true;
      if (type === "moov" || type === "moof") {
        const body = Buffer.alloc(length - skip);
        await file.read(body, 0, body.length, read.at + skip);
        take(read, type, body);
      }
      read.at += length;
    }
  } finally {
    await file.close();
  }
  read.size = size;
  reads.delete(path);
  reads.set(path, read);
  if (reads.size > READS_KEPT) reads.delete(reads.keys().next().value!);
  return read;
}

/** The recordings in `folder`, each computer's files in the order it recorded them: its path on the files route, its
 *  computer (its ref id, as its file is named: computer-record.ts names a computer's later files <computer>-2.mp4 and
 *  on), its length in seconds, its size, and whether it is finished: its trailer is there, or the run has `ended` and the
 *  file is unchanged past the time the recorder gives ffmpeg to finish it (RECORDING_LIMITS.settleMs). None when the
 *  folder isn't there. A file that can't be read is listed with 0 seconds. */
export async function recordingsOf(folder: string, ended: boolean): Promise<RecordingView[]> {
  const names = await readdir(folder).catch(() => [] as string[]);
  const files = new Set(names.filter((name) => name.endsWith(".mp4")));
  const series = [...files].map((name) => {
    const base = name.slice(0, -".mp4".length);
    const later = /^(.+)-(\d+)$/.exec(base);
    return later && Number(later[2]) >= 2 && files.has(`${later[1]}.mp4`) ? { name, computer: later[1]!, n: Number(later[2]) } : { name, computer: base, n: 1 };
  });
  series.sort((a, b) => (a.computer === b.computer ? a.n - b.n : a.computer < b.computer ? -1 : 1));
  const listed: RecordingView[] = [];
  for (const { name, computer } of series) {
    const path = join(folder, name);
    const file = await lstat(path).catch(() => undefined);
    if (!file?.isFile()) continue;
    const read = await readOf(path, file.size).catch(() => undefined);
    const seconds = read?.timescale ? Math.round((read.end / read.timescale) * 10) / 10 : 0;
    const settled = ended && Date.now() - file.mtimeMs > RECORDING_LIMITS.settleMs;
    listed.push({ path: `${RECORDINGS}/${name}`, computer, seconds, bytes: file.size, finished: read?.finished === true || settled });
  }
  return listed;
}
