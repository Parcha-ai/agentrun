// A tar reader and writer of the tests' own, so a pack is judged by code the package does not share, and a tampered pack
// can be made member by member.
import { readFileSync, writeFileSync } from "node:fs";

const BLOCK = 512;
const octal = (block, at, width) => Number.parseInt(block.toString("ascii", at, at + width).replace(/[\0 ]+$/g, "") || "0", 8);
const cstring = (block, at, width) => {
  const end = block.indexOf(0, at);
  return block.toString("utf8", at, end === -1 || end > at + width ? at + width : end);
};

/** Every member of the tar at `file`: name, typeflag, mode, uid, gid, mtime, size and data. A pax header gives the next
 *  member its path and size, and is not listed. */
export function listTar(file) {
  const bytes = readFileSync(file);
  const members = [];
  let pax = {};
  for (let at = 0; at + BLOCK <= bytes.length; ) {
    const block = bytes.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const typeflag = String.fromCharCode(block[156] || 0x30);
    const size = octal(block, 124, 12);
    const data = bytes.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (typeflag === "x") {
      for (let rest = 0; rest < data.length; ) {
        const space = data.indexOf(0x20, rest);
        const length = Number(data.toString("ascii", rest, space));
        const [key, ...value] = data.toString("utf8", space + 1, rest + length - 1).split("=");
        pax[key] = value.join("=");
        rest += length;
      }
      continue;
    }
    const prefix = cstring(block, 345, 155);
    const name = pax.path ?? (prefix ? `${prefix}/${cstring(block, 0, 100)}` : cstring(block, 0, 100));
    members.push({
      name, typeflag, mode: octal(block, 100, 8), uid: octal(block, 108, 8), gid: octal(block, 116, 8), mtime: octal(block, 136, 12),
      size: pax.size ? Number(pax.size) : size, data, linkname: cstring(block, 157, 100),
    });
    pax = {};
  }
  return members;
}

function header({ name, typeflag = "0", size = 0, mode = 0o644, linkname = "" }) {
  const block = Buffer.alloc(BLOCK);
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    // The way a ustar-only tool splits a long name: the last "/" that leaves a name of at most 100 bytes.
    const slash = [...name.matchAll(/\//g)].map((match) => match.index).filter((at) => at < name.length - 1 && Buffer.byteLength(name.slice(at + 1)) <= 100 && at <= 155).at(0);
    if (slash === undefined) throw new Error(`${name} does not fit a ustar header`);
    prefix = name.slice(0, slash);
    name = name.slice(slash + 1);
  }
  block.write(name, 0, 100, "utf8");
  block.write(prefix, 345, 155, "utf8");
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.fill(0x20, 148, 156);
  block.write(typeflag, 156, 1, "ascii");
  block.write(linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

/** Write `members` (`name`, `data`, and optionally `typeflag`, `mode`, `linkname`) as one tar at `file`. A member with
 *  `paxSize` says its size in a pax header and leaves the ustar size field 0, as a tool does for a file over 8 GiB. */
export function writeTarFile(file, members) {
  const parts = [];
  for (const member of members) {
    const data = member.data ?? Buffer.alloc(0);
    if (member.paxSize) {
      const body = ` size=${data.length}\n`;
      let length = body.length + 1;
      while (String(length).length + body.length !== length) length = String(length).length + body.length;
      const record = Buffer.from(`${length}${body}`);
      parts.push(header({ name: "PaxHeaders.0/size", typeflag: "x", size: record.length }), record, Buffer.alloc((BLOCK - (record.length % BLOCK)) % BLOCK));
    }
    parts.push(header({ ...member, size: member.paxSize ? 0 : data.length }), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  writeFileSync(file, Buffer.concat(parts));
}

/** A copy of the pack at `file`, written to `out`, with its members changed by `change(members)`. */
export function tamper(file, out, change) {
  writeTarFile(out, change(listTar(file).map((member) => ({ ...member, data: Buffer.from(member.data) }))));
  return out;
}

/** The manifest of `members`, and a way to put an edited one back. */
export function manifestOf(members) {
  return JSON.parse(members.find((member) => member.name === "manifest.json").data.toString("utf8"));
}
export const withManifest = (members, edit) =>
  members.map((member) => {
    if (member.name !== "manifest.json") return member;
    const manifest = JSON.parse(member.data.toString("utf8"));
    edit(manifest);
    return { ...member, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
  });

/** `count` header blocks of type `typeflag` (a pax header, say) with no data and nothing after them but the two zero blocks. */
export function headersOnly(count, typeflag = "x") {
  const one = header({ name: "PaxHeaders.0/x", typeflag, size: 0 });
  return Buffer.concat([...Array(count).fill(one), Buffer.alloc(BLOCK * 2)]);
}

/** `count` pairs of a pax header (one field) and an empty directory, then the two zero blocks. */
export function paxPairs(count) {
  const body = " path=d/\n";
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  const data = Buffer.from(`${length}${body}`);
  const pax = header({ name: "PaxHeaders.0/d", typeflag: "x", size: data.length });
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
  const dir = header({ name: "d/", typeflag: "5" });
  return Buffer.concat([...Array(count).fill(Buffer.concat([pax, data, padding, dir])), Buffer.alloc(BLOCK * 2)]);
}

/** A pax header with `fields` one-byte fields, then a file. */
export function paxWithFields(fields) {
  const data = Buffer.concat(Array.from({ length: fields }, (_, at) => {
    const body = ` k${at}=v\n`;
    let length = body.length + 1;
    while (String(length).length + body.length !== length) length = String(length).length + body.length;
    return Buffer.from(`${length}${body}`);
  }));
  return Buffer.concat([header({ name: "PaxHeaders.0/f", typeflag: "x", size: data.length }), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK), header({ name: "f", typeflag: "0" }), Buffer.alloc(BLOCK * 2)]);
}

/** `count` directories whose pax path is `length` bytes long, then the two zero blocks. */
export function longNames(count, length) {
  const body = ` path=runs/x/work/${"a".repeat(length)}/\n`;
  let size = body.length + 1;
  while (String(size).length + body.length !== size) size = String(size).length + body.length;
  const data = Buffer.from(`${size}${body}`);
  const pax = header({ name: "PaxHeaders.0/d", typeflag: "x", size: data.length });
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
  const dir = header({ name: "d/", typeflag: "5" });
  return Buffer.concat([...Array(count).fill(Buffer.concat([pax, data, padding, dir])), Buffer.alloc(BLOCK * 2)]);
}
