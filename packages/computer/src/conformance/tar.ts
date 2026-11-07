// Just enough tar for the suite to build archives and read them back without the host's tar: ustar out; ustar, pax
// and GNU long names in.
import { createHash } from "node:crypto";

export interface TarEntry {
	name: string;
	type: "file" | "dir" | "symlink" | "other";
	mode: number;
	body?: Uint8Array;
	link?: string;
}

const TYPE_FLAG = { file: "0", dir: "5", symlink: "2", other: "0" } as const;

function header(name: string, type: string, mode: number, size: number, link: string): Buffer {
	const block = Buffer.alloc(512);
	const field = (at: number, length: number, value: string) => block.write(value, at, length, "utf8");
	const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
	field(0, 100, name);
	field(100, 8, octal(mode, 8));
	field(108, 8, octal(0, 8));
	field(116, 8, octal(0, 8));
	field(124, 12, octal(size, 12));
	field(136, 12, octal(Math.floor(Date.now() / 1000), 12));
	field(148, 8, "        ");
	field(156, 1, type);
	field(157, 100, link);
	field(257, 6, "ustar\0");
	field(263, 2, "00");
	let sum = 0;
	for (const byte of block) sum += byte;
	field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
	return block;
}

const pad = (length: number) => Buffer.alloc((512 - (length % 512)) % 512);

/** A ustar archive of these entries, names as given (each under 100 bytes). */
export function tarOf(entries: TarEntry[]): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		const body = entry.type === "file" ? Buffer.from(entry.body ?? new Uint8Array()) : Buffer.alloc(0);
		parts.push(header(entry.name, TYPE_FLAG[entry.type], entry.mode, body.length, entry.link ?? ""), body, pad(body.length));
	}
	parts.push(Buffer.alloc(1024));
	return Buffer.concat(parts);
}

const text = (block: Buffer, at: number, length: number) => {
	const raw = block.subarray(at, at + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
};
const number = (block: Buffer, at: number, length: number) => Number.parseInt(text(block, at, length).trim() || "0", 8);

/** Reads pax records: "<len> key=value\n" each. */
function pax(body: Buffer): Record<string, string> {
	const records: Record<string, string> = {};
	let at = 0;
	while (at < body.length) {
		const space = body.indexOf(0x20, at);
		if (space < 0) break;
		const length = Number.parseInt(body.subarray(at, space).toString("utf8"), 10);
		if (!(length > 0)) break;
		const record = body.subarray(space + 1, at + length - 1).toString("utf8");
		const equals = record.indexOf("=");
		if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
		at += length;
	}
	return records;
}

/** Every entry of an archive, in order. Throws in words on an archive it cannot read. */
export function untar(bytes: Uint8Array): TarEntry[] {
	const archive = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const entries: TarEntry[] = [];
	let next: { path?: string; linkpath?: string } = {};
	let at = 0;
	while (at + 512 <= archive.length) {
		const block = archive.subarray(at, at + 512);
		if (block.every((byte) => byte === 0)) break;
		const size = number(block, 124, 12);
		const flag = text(block, 156, 1) || "0";
		const body = archive.subarray(at + 512, at + 512 + size);
		if (body.length < size) throw new Error(`the archive ends inside ${text(block, 0, 100)}`);
		at += 512 + size + ((512 - (size % 512)) % 512);
		if (flag === "x") {
			const records = pax(body);
			next = { path: records.path ?? next.path, linkpath: records.linkpath ?? next.linkpath };
			continue;
		}
		if (flag === "g") continue;
		if (flag === "L" || flag === "K") {
			const value = body.toString("utf8").replace(/\0+$/, "");
			next = flag === "L" ? { ...next, path: value } : { ...next, linkpath: value };
			continue;
		}
		const prefix = text(block, 345, 155);
		const name = next.path ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
		const link = next.linkpath ?? text(block, 157, 100);
		next = {};
		const type = flag === "0" || flag === "7" ? "file" : flag === "5" ? "dir" : flag === "2" ? "symlink" : "other";
		const mode = number(block, 100, 8) & 0o7777;
		entries.push({ name, type, mode, ...(type === "file" ? { body } : {}), ...(type === "symlink" ? { link } : {}) });
	}
	return entries;
}

/** An entry as one comparable line: its name without "./" or a trailing "/", type, mode, and content hash or target. */
export function describeEntry(entry: TarEntry): string {
	const name = entry.name.replace(/^\.\//, "").replace(/\/$/, "");
	const what =
		entry.type === "file" ? createHash("sha256").update(entry.body ?? new Uint8Array()).digest("hex") : entry.type === "symlink" ? `-> ${entry.link}` : "";
	return `${name} ${entry.type} ${entry.mode.toString(8)} ${what}`.trimEnd();
}
