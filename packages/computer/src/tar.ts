// Just enough tar to move a folder through computerd's tar.push and tar.pull without the host's tar, streaming both
// ways: ustar out, with a pax header for a name or a link target past ustar's 100 bytes; ustar, pax and GNU long names
// in, one entry at a time, each with its whole body, so what is held is one entry, never the archive.

export interface TarEntry {
	name: string;
	type: "file" | "dir" | "symlink" | "other";
	mode: number;
	body?: Uint8Array;
	link?: string;
}

const BLOCK = 512;
const END = Buffer.alloc(2 * BLOCK);
const TYPE_FLAG = { file: "0", dir: "5", symlink: "2", other: "0" } as const;
const pad = (length: number) => Buffer.alloc((BLOCK - (length % BLOCK)) % BLOCK);

function header(name: string, type: string, mode: number, size: number, link: string): Buffer {
	const block = Buffer.alloc(BLOCK);
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

/** One pax record, "<length> key=value\n", its length counting its own digits. */
function record(key: string, value: string): string {
	const rest = Buffer.byteLength(` ${key}=${value}\n`);
	let length = rest + String(rest).length;
	if (String(length).length !== String(rest).length) length = rest + String(length).length;
	return `${length} ${key}=${value}\n`;
}

/** One entry's blocks: a pax header first where its name or link does not fit ustar's 100 bytes, then its own, its body and the padding. */
export function tarEntry(entry: TarEntry): Buffer[] {
	const body = entry.type === "file" ? Buffer.from(entry.body ?? new Uint8Array()) : Buffer.alloc(0);
	const link = entry.link ?? "";
	const records = [...(Buffer.byteLength(entry.name) > 100 ? [record("path", entry.name)] : []), ...(Buffer.byteLength(link) > 100 ? [record("linkpath", link)] : [])].join("");
	const blocks: Buffer[] = [];
	if (records !== "") {
		const pax = Buffer.from(records);
		blocks.push(header("././@PaxHeader", "x", 0o644, pax.length, ""), pax, pad(pax.length));
	}
	blocks.push(header(entry.name, TYPE_FLAG[entry.type], entry.mode, body.length, link), body, pad(body.length));
	return blocks;
}

/** A whole archive of these entries. */
export function tarOf(entries: readonly TarEntry[]): Buffer {
	return Buffer.concat([...entries.flatMap(tarEntry), END]);
}

/** An archive of these entries as it is made: each entry's blocks as it comes, then the end. */
export async function* tarStream(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>): AsyncGenerator<Uint8Array> {
	for await (const entry of entries) yield* tarEntry(entry);
	yield END;
}

const text = (block: Buffer, at: number, length: number) => {
	const raw = block.subarray(at, at + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
};
const number = (block: Buffer, at: number, length: number) => Number.parseInt(text(block, at, length).trim() || "0", 8);
/** A size an entry can have: a whole number of bytes, 0 or more (a negative or unreadable one would never be consumed). */
const sized = (size: number) => Number.isSafeInteger(size) && size >= 0;

/** Reads pax records: "<len> key=value\n" each. */
function pax(body: Buffer): Record<string, string> {
	const records: Record<string, string> = {};
	let at = 0;
	while (at < body.length) {
		const space = body.indexOf(0x20, at);
		if (space < 0) break;
		const length = Number.parseInt(body.subarray(at, space).toString("utf8"), 10);
		if (!(length > 0)) break;
		const line = body.subarray(space + 1, at + length - 1).toString("utf8");
		const equals = line.indexOf("=");
		if (equals > 0) records[line.slice(0, equals)] = line.slice(equals + 1);
		at += length;
	}
	return records;
}

/**
 * An archive read as its bytes come: push() takes a chunk and answers the entries it finished, each whole. Bytes are
 * joined only once an entry's are all here, so a large body is copied once. Throws in words on a header whose checksum
 * is wrong; finish() throws where the bytes end inside an entry.
 */
export class TarReader {
	#parts: Buffer[] = [];
	#length = 0;
	#next: { path?: string; linkpath?: string; size?: number } = {};
	#ended = false;

	/** The first n bytes held, joined, or undefined while fewer are here. */
	#peek(n: number): Buffer | undefined {
		if (this.#length < n) return undefined;
		if ((this.#parts[0]?.length ?? 0) < n) this.#parts = [Buffer.concat(this.#parts, this.#length)];
		return (this.#parts[0] as Buffer).subarray(0, n);
	}

	#drop(n: number): void {
		const first = this.#parts[0] as Buffer;
		this.#parts[0] = first.subarray(n);
		if (this.#parts[0].length === 0) this.#parts.shift();
		this.#length -= n;
	}

	push(chunk: Uint8Array): TarEntry[] {
		if (this.#ended || chunk.length === 0) return [];
		this.#parts.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		this.#length += chunk.length;
		const entries: TarEntry[] = [];
		for (;;) {
			const head = this.#peek(BLOCK);
			if (head === undefined) return entries;
			if (head.every((byte) => byte === 0)) {
				this.#ended = true;
				this.#parts = [];
				this.#length = 0;
				return entries;
			}
			let sum = 0;
			for (let at = 0; at < BLOCK; at++) sum += at >= 148 && at < 156 ? 0x20 : (head[at] as number);
			if (sum !== number(head, 148, 8)) throw new Error(`the archive has a header whose checksum is not its bytes' (${JSON.stringify(text(head, 0, 100))})`);
			const flag = text(head, 156, 1) || "0";
			const size = flag === "x" || flag === "g" || flag === "L" || flag === "K" ? number(head, 124, 12) : (this.#next.size ?? number(head, 124, 12));
			if (!sized(size)) throw new Error(`the archive has a header whose size is no count of bytes (${JSON.stringify(text(head, 0, 100))})`);
			const whole = this.#peek(BLOCK + size + ((BLOCK - (size % BLOCK)) % BLOCK));
			if (whole === undefined) return entries;
			const body = Buffer.from(whole.subarray(BLOCK, BLOCK + size));
			const block = Buffer.from(head);
			this.#drop(whole.length);
			const entry = this.#entry(block, flag, body);
			if (entry !== undefined) entries.push(entry);
		}
	}

	#entry(block: Buffer, flag: string, body: Buffer): TarEntry | undefined {
		if (flag === "x") {
			const records = pax(body);
			const size = records.size === undefined ? this.#next.size : /^\d+$/.test(records.size) ? Number(records.size) : Number.NaN;
			if (size !== undefined && !sized(size)) throw new Error(`the archive has a pax size that is no count of bytes (${JSON.stringify(records.size)})`);
			this.#next = { path: records.path ?? this.#next.path, linkpath: records.linkpath ?? this.#next.linkpath, ...(size === undefined ? {} : { size }) };
			return undefined;
		}
		if (flag === "g") return undefined;
		if (flag === "L" || flag === "K") {
			const value = body.toString("utf8").replace(/\0+$/, "");
			this.#next = flag === "L" ? { ...this.#next, path: value } : { ...this.#next, linkpath: value };
			return undefined;
		}
		const prefix = text(block, 345, 155);
		const name = this.#next.path ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
		const link = this.#next.linkpath ?? text(block, 157, 100);
		this.#next = {};
		const type = flag === "0" || flag === "7" ? "file" : flag === "5" ? "dir" : flag === "2" ? "symlink" : "other";
		const mode = number(block, 100, 8) & 0o7777;
		return { name, type, mode, ...(type === "file" ? { body } : {}), ...(type === "symlink" ? { link } : {}) };
	}

	/** Throws in words where the bytes ended inside an entry; a short tail of no whole header, or none, is the end. */
	finish(): void {
		const head = this.#ended ? undefined : this.#peek(BLOCK);
		if (head !== undefined) throw new Error(`the archive ends inside ${this.#next.path ?? text(head, 0, 100)}`);
	}
}

/** Every entry of an archive, in order. Throws in words on an archive it cannot read. */
export function untar(bytes: Uint8Array): TarEntry[] {
	const reader = new TarReader();
	const entries = reader.push(bytes);
	reader.finish();
	return entries;
}

/** The entries of an archive as its chunks come, each whole. Throws in words on an archive it cannot read. */
export async function* untarStream(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
	const reader = new TarReader();
	for await (const chunk of chunks) yield* reader.push(chunk);
	reader.finish();
}
