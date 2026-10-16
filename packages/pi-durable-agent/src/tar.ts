import { type FileHandle, open } from "node:fs/promises";

// POSIX ustar headers, with a pax extended header for a name over 100 bytes or beyond ASCII, and for a size over 8 GiB.
// A pack holds regular files and directories only, so nothing else is written and nothing else is read.

export const BLOCK = 512;
const MAX_OCTAL_SIZE = 0o77777777777;
const PAX_LIMIT = 64 * 1024;
const MAX_PAX_FIELDS = 64;
/** The most the names of all the members may add up to, so what a listing holds and a reader walks stays bounded. */
export const MAX_NAME_BYTES = 32 * 1024 * 1024;

export type TarEntry = {
  /** `/` between segments; a directory ends in `/`. */
  name: string;
  kind: "file" | "dir";
  size: number;
  mode: number;
  /** Seconds since the epoch. */
  mtime: number;
  /** The file to copy from, for a file whose bytes are not in `data`. */
  source?: string;
  /** Opens the file to copy from, for a caller that checks what it opens; it is closed after the copy. */
  open?: () => Promise<FileHandle>;
  data?: Buffer;
};

const pad = (size: number) => (size % BLOCK === 0 ? size : size + BLOCK - (size % BLOCK));
const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, "utf8");
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return Buffer.concat([Buffer.from(String(length), "ascii"), body]);
}

function field(block: Buffer, at: number, width: number, value: number): void {
  block.write(`${value.toString(8).padStart(width - 1, "0")}\0`, at, width, "ascii");
}

function header(name: string, typeflag: string, size: number, mode: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  field(block, 100, 8, mode);
  field(block, 108, 8, 0);
  field(block, 116, 8, 0);
  field(block, 124, 12, Math.min(size, MAX_OCTAL_SIZE));
  field(block, 136, 12, Math.max(0, mtime));
  block.fill(0x20, 148, 156);
  block.write(typeflag, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

/** The header blocks of one entry: a pax header first when its name or size does not fit a ustar header. */
function headersOf(entry: TarEntry): Buffer[] {
  const name = entry.kind === "dir" && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
  const records: Buffer[] = [];
  if (Buffer.byteLength(name) > 100 || !isAscii(name)) records.push(paxRecord("path", name));
  if (entry.size > MAX_OCTAL_SIZE) records.push(paxRecord("size", String(entry.size)));
  const blocks: Buffer[] = [];
  if (records.length) {
    const data = Buffer.concat(records);
    const label = `PaxHeaders.0/${name.split("/").filter(Boolean).at(-1)?.replace(/[^\x20-\x7e]/g, "_").slice(0, 60) ?? "entry"}`;
    blocks.push(header(label, "x", data.length, 0o644, entry.mtime), data, Buffer.alloc(pad(data.length) - data.length));
  }
  blocks.push(header(name, entry.kind === "dir" ? "5" : "0", entry.kind === "dir" ? 0 : entry.size, entry.mode, entry.mtime));
  return blocks;
}

/** The size in bytes of the tar `writeTar` makes of `entries`. */
export function tarSize(entries: readonly TarEntry[]): number {
  let total = BLOCK * 2;
  for (const entry of entries) total += headersOf(entry).reduce((sum, block) => sum + block.length, 0) + (entry.kind === "file" ? pad(entry.size) : 0);
  return total;
}

/** Write `entries`, in the order given, as one tar at `file`. A source that is shorter or longer than its `size` is an
 *  error: the entry's header has already said how many bytes follow. */
export async function writeTar(file: string, entries: readonly TarEntry[]): Promise<void> {
  const out = await open(file, "wx", 0o600);
  try {
    for (const entry of entries) {
      for (const block of headersOf(entry)) await out.write(block);
      if (entry.kind === "dir") continue;
      let written = 0;
      if (entry.data) {
        await out.write(entry.data);
        written = entry.data.length;
      } else if (entry.open || entry.source !== undefined) {
        const input = entry.open ? await entry.open() : await open(entry.source!, "r");
        try {
          const chunk = Buffer.alloc(64 * 1024);
          while (written < entry.size) {
            const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, entry.size - written), null);
            if (bytesRead === 0) break;
            await out.write(chunk, 0, bytesRead);
            written += bytesRead;
          }
        } finally {
          await input.close();
        }
      }
      if (written !== entry.size) throw new Error(`${entry.name} changed while it was packed: ${written} of ${entry.size} bytes`);
      await out.write(Buffer.alloc(pad(entry.size) - entry.size));
    }
    await out.write(Buffer.alloc(BLOCK * 2));
    await out.sync();
  } finally {
    await out.close();
  }
}

export type TarMember = { name: string; kind: "file" | "dir"; size: number; mode: number; mtime: number; offset: number };

const text = (block: Buffer, at: number, width: number) => {
  const end = block.indexOf(0, at);
  return block.toString("utf8", at, end === -1 || end > at + width ? at + width : end);
};
const number = (block: Buffer, at: number, width: number): number | undefined => {
  const digits = block.toString("ascii", at, at + width).replace(/[\0 ]+$/g, "").replace(/^ +/, "");
  return /^[0-7]+$/.test(digits) ? Number.parseInt(digits, 8) : digits === "" ? 0 : undefined;
};

async function readAt(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return buffer.subarray(0, done);
}

function paxFields(data: Buffer): Map<string, string> | undefined {
  const fields = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = Number(data.toString("ascii", at, space));
    if (space === -1 || !Number.isInteger(length) || length < 1 || at + length > data.length || data[at + length - 1] !== 0x0a) return undefined;
    const record = data.toString("utf8", space + 1, at + length - 1);
    const equals = record.indexOf("=");
    if (equals < 1 || fields.size >= MAX_PAX_FIELDS) return undefined;
    fields.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return fields;
}

const KINDS: Record<string, string> = { "1": "a hard link", "2": "a symbolic link", "3": "a character device", "4": "a block device", "6": "a fifo", g: "a global pax header", L: "a GNU long name", K: "a GNU long link", S: "a sparse file" };

/**
 * The members of the tar in `file` (`size` bytes), without reading their data, or the problem that makes it unreadable:
 * a bad checksum, a truncated member, a link, a device or any type but a regular file and a directory, a global or a
 * doubled pax header, more than 64 pax fields in one header, bytes after the end. Parsing stops at the first problem.
 * The work is bounded by the input: at most `maxMembers` members and two header blocks for each (a member and its one
 * pax header), so a tar of nothing but headers is refused after that many, and no header is copied into the next.
 */
export async function listTar(file: FileHandle, size: number, maxMembers = Number.POSITIVE_INFINITY): Promise<{ members: TarMember[]; problems: string[] }> {
  const members: TarMember[] = [];
  const problems: string[] = [];
  const maxHeaders = 2 * maxMembers + 2;
  let headers = 0;
  let nameBytes = 0;
  let position = 0;
  let pax: Map<string, string> | undefined;
  for (;;) {
    if (members.length > maxMembers) {
      problems.push(`the pack has more than ${maxMembers} members`);
      break;
    }
    if (position + BLOCK > size) {
      problems.push("the tar ends without its two zero blocks");
      break;
    }
    const block = await readAt(file, BLOCK, position);
    if (block.every((byte) => byte === 0)) {
      const second = await readAt(file, BLOCK, position + BLOCK);
      if (second.length !== BLOCK || !second.every((byte) => byte === 0)) problems.push("the tar ends with one zero block");
      for (let at = position + BLOCK * 2; at < size && problems.length === 0; at += 64 * 1024) {
        if (!(await readAt(file, Math.min(64 * 1024, size - at), at)).every((byte) => byte === 0)) problems.push("there are bytes after the end of the tar");
      }
      if (pax) problems.push("a pax header has no member after it");
      break;
    }
    if (++headers > maxHeaders) {
      problems.push(`the tar has more than ${maxHeaders} header blocks`);
      break;
    }
    const given = number(block, 148, 8);
    let sum = 0;
    for (let at = 0; at < BLOCK; at++) sum += at >= 148 && at < 156 ? 0x20 : block[at]!;
    if (given === undefined || given !== sum) {
      problems.push(`a header at byte ${position} has a bad checksum`);
      break;
    }
    if (block.toString("ascii", 257, 262) !== "ustar") {
      problems.push(`the header at byte ${position} is not POSIX ustar`);
      break;
    }
    const typeflag = String.fromCharCode(block[156] === 0 ? 0x30 : block[156]!);
    const headerSize = number(block, 124, 12);
    const mode = number(block, 100, 8) ?? 0;
    const mtime = number(block, 136, 12) ?? 0;
    const prefix = text(block, 345, 155);
    const named = text(block, 0, 100);
    if (headerSize === undefined) {
      problems.push(`the header at byte ${position} has a size that is not octal`);
      break;
    }
    if (typeflag === "x") {
      if (headerSize > PAX_LIMIT || position + BLOCK + pad(headerSize) > size) {
        problems.push("a pax header is too large or cut short");
        break;
      }
      if (pax) {
        problems.push("two pax headers in a row");
        break;
      }
      pax = paxFields(await readAt(file, headerSize, position + BLOCK));
      if (!pax) {
        problems.push(`a pax header is malformed or holds more than ${MAX_PAX_FIELDS} fields`);
        break;
      }
      position += BLOCK + pad(headerSize);
      continue;
    }
    const declared = pax?.get("size");
    const length = declared === undefined ? headerSize : /^\d{1,15}$/.test(declared) ? Number(declared) : Number.NaN;
    const name = pax?.get("path") ?? (prefix ? `${prefix}/${named}` : named);
    pax = undefined;
    if (!Number.isSafeInteger(length)) {
      problems.push(`${name} has a size that is not a number`);
      break;
    }
    const regular = typeflag === "0";
    if (!regular && typeflag !== "5") {
      problems.push(`${name} is ${KINDS[typeflag] ?? `a member of type ${JSON.stringify(typeflag)}`}`);
      break;
    }
    const dir = typeflag === "5";
    if (dir !== name.endsWith("/")) {
      problems.push(`${name} is ${dir ? "a directory without" : "a file with"} a trailing slash`);
      break;
    }
    nameBytes += Buffer.byteLength(name);
    if (nameBytes > MAX_NAME_BYTES) {
      problems.push(`the member names add up to more than ${MAX_NAME_BYTES} bytes`);
      break;
    }
    members.push({ name: dir ? name.replace(/\/+$/, "") : name, kind: dir ? "dir" : "file", size: dir ? 0 : length, mode, mtime, offset: position + BLOCK });
    position += BLOCK + (typeflag === "5" ? 0 : pad(length));
    if (position > size) {
      problems.push(`${name} is cut short: the tar ends inside it`);
      break;
    }
  }
  return { members, problems };
}

/** Copy `length` bytes at `offset` of `source` to `target`, which is open for writing. */
export async function copyRange(source: FileHandle, offset: number, length: number, target: FileHandle): Promise<void> {
  const chunk = Buffer.alloc(64 * 1024);
  for (let done = 0; done < length; ) {
    const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, length - done), offset + done);
    if (bytesRead === 0) throw new Error("the tar ends inside a member");
    await target.write(chunk, 0, bytesRead);
    done += bytesRead;
  }
}

export { readAt };
