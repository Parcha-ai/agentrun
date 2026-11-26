// A zip archive unpacked by node alone: no unzip on the host is needed or run. Only a verified archive reaches it (harness-archive.ts checks its sha256 first), and still it trusts
// nothing the archive says:
//  - its central directory is read from the end (zip64 too), and each entry's data is found from its own local header;
//  - a name that is absolute, holds `..`, a backslash, a drive letter or a NUL is refused, as is any name twice;
//  - a symlink, a device or any type but a file or a folder is refused, as is an encrypted entry or a method other than
//    stored and deflate;
//  - each file is written new (never over another), its size and CRC-32 checked against the directory's, its execute
//    bits kept (0755, else 0644); the sum of what it declares is held under a limit before writing, and each file to its
//    declared size while writing.
// A refusal throws before or while writing into `root`, which is the caller's fresh folder to remove.
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";

/** The most a zip may unpack to, all its files together. */
export const ZIP_MAX_UNPACKED = 4 * 1024 * 1024 * 1024;
/** The most entries a zip may hold. */
const ZIP_MAX_ENTRIES = 100_000;

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

/** One entry of the central directory, its name checked. */
type Entry = { name: string; dir: boolean; mode: number; method: number; crc: number; compressed: number; size: number; local: number };

/** `name` as a path inside the root (forward slashes, no trailing one), or why it is refused. */
function safeName(name: string): { path: string } | { why: string } {
  if (name.includes("\0")) return { why: "holds a NUL" };
  if (name.includes("\\")) return { why: "holds a backslash" };
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return { why: "is absolute" };
  const parts = name.split("/").filter((part, i, all) => !(part === "" && i === all.length - 1));
  if (!parts.length || parts.some((part) => part === "" || part === "." || part === "..")) return { why: "leaves the archive's folder or is empty" };
  return { path: parts.join("/") };
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error(`the zip ends at byte ${position + bytesRead}, before what its directory points at`);
  return buffer;
}

/** The central directory of the zip `file` (`size` bytes long): its entries, each name and type checked. */
async function directory(file: FileHandle, size: number): Promise<Entry[]> {
  // The end record: 22 bytes, then a comment of at most 65535.
  const tailLength = Math.min(size, 22 + MAX16);
  const tail = await readAt(file, size - tailLength, tailLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { at = i; break; }
  if (at < 0) throw new Error("it is not a zip: no end of central directory");
  let count = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdOffset = tail.readUInt32LE(at + 16);
  if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
    const locatorAt = size - tailLength + at - 20;
    if (locatorAt < 0) throw new Error("its zip64 end record is missing");
    const locator = await readAt(file, locatorAt, 20);
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) throw new Error("its zip64 end record is missing");
    const record = await readAt(file, Number(locator.readBigUInt64LE(8)), 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new Error("its zip64 end record is not one");
    count = Number(record.readBigUInt64LE(32));
    cdSize = Number(record.readBigUInt64LE(40));
    cdOffset = Number(record.readBigUInt64LE(48));
  }
  if (count > ZIP_MAX_ENTRIES) throw new Error(`it holds ${count} entries, past the ${ZIP_MAX_ENTRIES} one may`);
  if (cdOffset + cdSize > size) throw new Error("its central directory runs past its end");
  const cd = await readAt(file, cdOffset, cdSize);
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw new Error(`its central directory's entry ${n + 1} is not one`);
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let compressed = cd.readUInt32LE(p + 20);
    let length = cd.readUInt32LE(p + 24);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    const external = cd.readUInt32LE(p + 38);
    let local = cd.readUInt32LE(p + 42);
    const raw = cd.subarray(p + 46, p + 46 + nameLength);
    const name = raw.toString(flags & 0x800 ? "utf8" : "latin1");
    // zip64: the sizes and offset that read 0xffffffff are in the extra field 0x0001, in that order.
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const dataLength = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (length === MAX32) { length = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (compressed === MAX32) { compressed = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (local === MAX32) { local = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + dataLength;
    }
    p = extraEnd + commentLength;

    const checked = safeName(name);
    const said = JSON.stringify(name.slice(0, 200));
    if ("why" in checked) throw new Error(`its entry ${said} ${checked.why}`);
    if (seen.has(checked.path)) throw new Error(`its entry ${said} is in it twice`);
    seen.add(checked.path);
    if (flags & 0x1) throw new Error(`its entry ${said} is encrypted`);
    // A Unix-made entry's type and mode are in the high half of its external attributes; others are files or folders.
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    const type = unixMode & 0o170000;
    const dir = name.endsWith("/") || type === 0o040000 || (madeBy >> 8 !== 3 && (external & 0x10) !== 0);
    if (type === 0o120000) throw new Error(`its entry ${said} is a symlink`);
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new Error(`its entry ${said} is neither a file nor a folder`);
    if (!dir && method !== 0 && method !== 8) throw new Error(`its entry ${said} is compressed with method ${method}, and only stored and deflate are read`);
    entries.push({ name: checked.path, dir, mode: unixMode & 0o777, method, crc, compressed, size: length, local });
  }
  return entries;
}

/** Unpacks the zip at `archive` into `root` (an empty folder): see the header for what it refuses. */
export async function unzipInto(archive: string, root: string, options: { maxUnpacked?: number } = {}): Promise<void> {
  const maxUnpacked = options.maxUnpacked ?? ZIP_MAX_UNPACKED;
  const file = await open(archive, "r");
  try {
    const entries = await directory(file, (await file.stat()).size);
    const total = entries.reduce((sum, entry) => sum + (entry.dir ? 0 : entry.size), 0);
    if (total > maxUnpacked) throw new Error(`it unpacks to ${total} bytes, past the ${maxUnpacked} a zip may`);
    for (const entry of entries) {
      const target = join(root, ...entry.name.split("/"));
      if (entry.dir) {
        await mkdir(target, { recursive: true, mode: 0o755 });
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      // Its data: after its own local header, whose name and extra lengths may differ from the directory's.
      const header = await readAt(file, entry.local, 30);
      if (header.readUInt32LE(0) !== LOCAL) throw new Error(`its entry ${JSON.stringify(entry.name)} has no local header where its directory says`);
      const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      let crc = 0;
      let got = 0;
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          got += chunk.length;
          if (got > entry.size) return done(new Error(`its entry ${JSON.stringify(entry.name)} unpacks past the size its directory says`));
          crc = crc32(chunk, crc);
          done(null, chunk);
        },
      });
      const source = entry.compressed ? createReadStream(archive, { start, end: start + entry.compressed - 1 }) : undefined;
      const sink = createWriteStream(target, { flags: "wx", mode: 0o600 });
      if (!source) sink.end();
      else if (entry.method === 0) await pipeline(source, counted, sink);
      else await pipeline(source, createInflateRaw(), counted, sink);
      if (!source) await new Promise<void>((done, reject) => sink.once("close", done).once("error", reject));
      if (got !== entry.size) throw new Error(`its entry ${JSON.stringify(entry.name)} unpacks to ${got} bytes, and its directory says ${entry.size}`);
      if (crc >>> 0 !== entry.crc >>> 0) throw new Error(`its entry ${JSON.stringify(entry.name)} fails its CRC-32`);
      await chmod(target, entry.mode & 0o111 ? 0o755 : 0o644);
    }
  } finally {
    await file.close();
  }
}
