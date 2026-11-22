// A .zip built byte by byte, for the zip reader's tests (harness-zip.test.mjs) and the recipe install's (harness-recipe).
import { crc32, deflateRawSync } from "node:zlib";

/** A .zip of `entries`, each deflated, with its Unix mode in the central directory as Info-ZIP writes it: how the
 *  registry's .zip releases (Google Antigravity's) are packed. Per entry:
 *  - `name`, `bytes`, `mode` (default 0644);
 *  - `link`: a symbolic link, `bytes` its target; `type`: any other Unix file type bits (0o020000, a character device);
 *  - `method`: a method other than deflate, its bytes then stored as they are (0: stored);
 *  - `size`, `crc`, `flags`: what the directory says in place of the truth (a lie the reader must catch). */
export function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes, mode = 0o644, link = false, type, method = 8, size = bytes.length, crc = crc32(bytes), flags = 0 } of entries) {
    const data = method === 8 ? deflateRawSync(bytes) : bytes;
    const path = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE((((type ?? (link ? 0o120000 : 0o100000)) | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, path, data);
    centrals.push(central, path);
    offset += local.length + path.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A .zip whose zip64 end record claims `count` entries, and holds none: what the entry cap reads before anything else. */
export function zipClaiming(count) {
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(0n, 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([record, locator, end]);
}
