// Office documents and spreadsheets with nothing installed: the text of word processor and slide documents (slides in
// order, with their notes), and every sheet's cells with formula, stored value and the cells whose formula has no
// stored value said, not dropped. A faithful render needs LibreOffice in the environment; without it the text above
// still comes back and the render is a `needs` miss. This module holds what needs no dependency: the limits, the typed
// miss, the zip directory with its bomb guard, and the text a result is rendered to. The reader that inflates and
// parses is the `office-js` provider.

import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import type { MissCode } from "./contract.js";
import { visionContext } from "./env.js";
import { SOURCE_BYTES_IN_PROCESS } from "./limits.js";
import type { Cell, ProviderCall, ProviderSource } from "./provider.js";

const MiB = 1024 * 1024;

/** What one archive may hold before any of it is inflated, and what the reader parses of it. */
export type OfficeLimits = {
  /** Entries: a package holds a few dozen parts, a deck three or four per slide, a bomb of small files millions (2026-10-11). */
  readonly maxEntries: number;
  /** Declared uncompressed bytes over all entries: 16 times the bytes the package reads into the process (2026-10-11). */
  readonly maxUncompressedBytes: number;
  /** Declared bytes per compressed byte over the whole archive, once it declares more than `ratioFloorBytes`: synthetic sheet XML deflates 6 to 1, a run of identical rows 342 to 1, and deflate's own ceiling is 1,032 to 1 (measured 2026-10-11). */
  readonly maxRatio: number;
  readonly ratioFloorBytes: number;
  /** One XML part parsed, and the most text built from one word or OpenDocument text: @xmldom/xmldom took 2.0 s and 279 MB of heap for 4 MiB of sheet XML, 16 s and 2 GB for 32 MiB (measured 2026-10-11). */
  readonly maxPartBytes: number;
  /** All parts parsed for one read, so a deck of thousands of slides costs seconds of parsing per call, not minutes; also the most text built from the cells of one workbook (2026-10-11). */
  readonly maxParsedBytes: number;
  /** Cells one read builds: a part at the cap holds at most about 170,000, but a repeat count in an OpenDocument sheet holds any number (2026-10-11). */
  readonly maxCells: number;
};

export const OFFICE_LIMITS: OfficeLimits = Object.freeze({
  maxEntries: 10_000,
  maxUncompressedBytes: 16 * SOURCE_BYTES_IN_PROCESS,
  maxRatio: 100,
  ratioFloorBytes: MiB,
  maxPartBytes: 4 * MiB,
  maxParsedBytes: 32 * MiB,
  maxCells: 250_000,
});

/** An office file that cannot be read, as a typed miss: the codes a provider's failure maps to. The message is one line
 *  the model reads, and names the sizes, the cap and how to narrow the read. */
export type OfficeMissCode = Extract<MissCode, "over_budget" | "unreadable" | "unsupported" | "needs">;
export class OfficeMissError extends Error {
  constructor(readonly code: OfficeMissCode, message: string) {
    super(message);
    this.name = "OfficeMissError";
  }
}

/** A source's bytes through the environment: the one file it opens, never more than the process holds of it, and the very
 *  bytes it was hashed as. A file over the cap, one that cannot be read, and one that changed after its hash are typed
 *  misses; a file that grew after it was described is read only as far as the size it had when opened. */
export async function readSource(source: ProviderSource, call: ProviderCall): Promise<Uint8Array> {
  const context = visionContext(call.signal);
  const unreadable = (why: string) => new OfficeMissError("unreadable", `it could not be read: ${why.split("\n")[0]}`);
  const tooBig = (bytes: number) => new OfficeMissError("over_budget", `${mib(bytes)} is over the ${mib(SOURCE_BYTES_IN_PROCESS)} the reader takes into memory; read it with bash`);
  if (source.bytes > SOURCE_BYTES_IN_PROCESS) throw tooBig(source.bytes);
  const opened = await call.env.openBinaryReader(source.path, undefined, context);
  if (!opened.ok) throw unreadable(opened.error.message);
  try {
    const info = await opened.value.info(context);
    if (!info.ok) throw unreadable(info.error.message);
    if (info.value.size > SOURCE_BYTES_IN_PROCESS) throw tooBig(info.value.size);
    const read = await opened.value.read(0, info.value.size, context);
    if (!read.ok) throw unreadable(read.error.message);
    if (createHash("sha256").update(read.value).digest("hex") !== source.sha256) throw new OfficeMissError("unreadable", "it changed after it was hashed; read it again");
    return read.value;
  } finally {
    await opened.value.close(visionContext());
  }
}

export type ZipEntry = { readonly name: string; readonly method: number; readonly size: number; readonly originalSize: number; readonly crc: number; readonly offset: number };

const END_RECORD = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
/** Compressed bytes pushed to the inflater at a time: deflate expands at most 1,032 to 1, so one push writes at most 8 MiB. */
const PUSH_BYTES = 8192;
const END_RECORD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64 = 0xffffffff;
const mib = (bytes: number) => `${(bytes / MiB).toFixed(1)} MiB`;

/** The entries of a zip archive from its central directory, held to the limits before anything is inflated: the count,
 *  the declared total, and the declared ratio of the whole. An encrypted or duplicated entry, a zip64 archive and a
 *  directory that runs off the file are refused. Nothing is inflated, so a bomb costs this much and no more. */
export function zipDirectory(data: Uint8Array, limits: OfficeLimits = OFFICE_LIMITS): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const unreadable = (why: string) => new OfficeMissError("unreadable", `not a readable zip archive: ${why}`);
  const over = (what: string) => new OfficeMissError("over_budget", `the archive ${what}; the reader takes it no further, read it with bash`);
  let end = data.length - END_RECORD_BYTES;
  for (const floor = Math.max(0, end - MAX_COMMENT_BYTES); end >= floor && view.getUint32(end, true) !== END_RECORD; end--);
  if (end < 0 || view.getUint32(end, true) !== END_RECORD) throw unreadable("no end record");
  const count = view.getUint16(end + 10, true);
  if (count === 0xffff) throw over("is a zip64 archive");
  if (count > limits.maxEntries) throw over(`holds ${count} entries, over the ${limits.maxEntries} the reader takes`);
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let [declared, stored] = [0, 0];
  try {
    for (let at = view.getUint32(end + 16, true), i = 0; i < count; i++) {
      if (view.getUint32(at, true) !== CENTRAL_ENTRY) throw unreadable("a directory entry is damaged");
      const [flags, method, size, originalSize, nameBytes] = [view.getUint16(at + 8, true), view.getUint16(at + 10, true), view.getUint32(at + 20, true), view.getUint32(at + 24, true), view.getUint16(at + 28, true)];
      const name = new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameBytes));
      if (flags & 1) throw unreadable(`${name} is encrypted`);
      if (size === ZIP64 || originalSize === ZIP64) throw over("is a zip64 archive");
      if (names.has(name)) throw unreadable(`${name} appears twice`);
      names.add(name);
      declared += originalSize;
      stored += size;
      entries.push({ name, method, size, originalSize, crc: view.getUint32(at + 16, true), offset: view.getUint32(at + 42, true) });
      at += 46 + nameBytes + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
  } catch (error) {
    if (error instanceof RangeError) throw unreadable("the directory runs past the end of the file");
    throw error;
  }
  if (declared > limits.maxUncompressedBytes) throw over(`declares ${mib(declared)} uncompressed, over the ${mib(limits.maxUncompressedBytes)} the reader takes`);
  if (declared > limits.ratioFloorBytes && declared > limits.maxRatio * stored) throw over(`declares ${mib(declared)} from ${mib(stored)}, over ${limits.maxRatio} to 1`);
  return entries;
}

/** One entry's bytes, held to its directory entry. It is inflated in pushes of 8 KiB and stopped the moment it passes
 *  the size the directory declares, so an entry that lies about its size costs one push and not its real size; the
 *  bytes must be as many as declared and have the declared CRC-32, so a changed byte is not read as a different value.
 *  An entry declared over `limit` is over budget before it is touched; one that is not what it declares is unreadable.
 *  `keep: false` checks and discards, in memory that does not grow. */
export async function inflateEntry(data: Uint8Array, entry: ZipEntry, limit: number, keep = true): Promise<Uint8Array> {
  const damaged = (why: string) => new OfficeMissError("unreadable", `${entry.name} ${why}`);
  if (entry.originalSize > limit) throw new OfficeMissError("over_budget", `${entry.name} is ${mib(entry.originalSize)}, over the ${mib(limit)} the reader takes of one part; read it with bash`);
  if (entry.method !== 0 && entry.method !== 8) throw new OfficeMissError("unsupported", `${entry.name} uses compression method ${entry.method}, which the reader does not take`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (entry.offset + 30 > data.length || view.getUint32(entry.offset, true) !== LOCAL_ENTRY) throw damaged("has a damaged header");
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const packed = data.subarray(start, start + entry.size);
  if (packed.length < entry.size) throw damaged("is cut short");
  const chunks: Uint8Array[] = [];
  let [total, crc] = [0, 0];
  const take = (chunk: Uint8Array) => {
    if ((total += chunk.length) > entry.originalSize) throw damaged("inflates past the size its directory declares");
    crc = crc32(chunk, crc);
    if (keep) chunks.push(chunk);
  };
  try {
    if (entry.method === 0) take(packed);
    else {
      const stream = new (await import("fflate")).Inflate(take);
      for (let from = 0; from < packed.length; from += PUSH_BYTES) stream.push(packed.subarray(from, from + PUSH_BYTES), from + PUSH_BYTES >= packed.length);
    }
  } catch (error) {
    if (error instanceof OfficeMissError) throw error;
    throw damaged(`cannot be inflated: ${String((error as Error)?.message ?? error).split("\n")[0]}`);
  }
  if (total !== entry.originalSize || crc !== entry.crc) throw damaged("is not what its directory declares: its size or its checksum differs");
  return keep ? Buffer.concat(chunks) : new Uint8Array(0);
}

/** A cell as the office reader gives it: the package's own, and the date a date-formatted number stands for. */
export type OfficeCell = Cell & { readonly date?: string };

/** One cell as a model reads it: `D3=71866.19 {=SUM(C$2:C3)}`. A formula with no stored result says so in the cell, and
 *  a number with a date format carries its date. */
export function cellText(cell: OfficeCell): string {
  const { value, date, formula } = cell;
  const shown = value === null ? "<no stored value>" : typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value).replace(/\r?\n/g, "\\n");
  return `${cell.ref}=${shown}${date ? ` [${date}]` : ""}${formula === undefined ? "" : ` {=${formula}}`}`;
}

/** A sheet as text: its name, then one line per row that holds cells, each cell with its reference so that a gap never
 *  shifts a column. */
export function sheetText(name: string, cells: readonly OfficeCell[], hidden = false): string {
  const rows: string[][] = [];
  let last = "";
  for (const cell of cells) {
    const row = cell.ref.replace(/^[A-Z]+/, "");
    if (row !== last) rows.push([]);
    last = row;
    rows.at(-1)!.push(cellText(cell));
  }
  return [`Sheet "${name}"${hidden ? " (hidden)" : ""}`, ...(rows.length ? rows.map((row) => row.join(" | ")) : ["(no cells)"])].join("\n");
}

/** What the text of an office document is not, for a result read without a render. */
export const notRenderedNote = (kind: "office" | "sheet"): string =>
  `${kind === "sheet" ? "Cells only: formatting, charts, images and pivot views are not shown here." : "Text only: page layout, images, charts, drawings and text inside pictures are not shown here."} A faithful render needs LibreOffice (soffice) in the environment.`;
