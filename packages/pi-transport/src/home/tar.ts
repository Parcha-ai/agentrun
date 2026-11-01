// The headers of a tar stream the host writes from a checkpoint's record, for a box's own `tar` to unpack. The host only
// ever writes this format; it never reads a box's archive.

const BLOCK = 512;
const NAME_BYTES = 100;

/** What a header says about one entry. `name` and `link` are the bytes of the paths, without a trailing NUL. */
export type TarHeader = {
	readonly name: Uint8Array;
	/** `0` a file, `1` a hard link, `2` a symbolic link, `5` a directory, `6` a named pipe. */
	readonly type: "0" | "1" | "2" | "5" | "6";
	readonly size: number;
	readonly mode: number;
	/** Whole seconds since 1970, negative before it. */
	readonly mtime: number;
	/** The target of a link. */
	readonly link?: Uint8Array;
};

/** Two blocks of zeros: the end of the archive. */
export const TAR_END = new Uint8Array(BLOCK * 2);

/** The zeros that fill the data of an entry of `size` bytes up to a whole block. */
export function tarPadding(size: number): Uint8Array {
	return new Uint8Array(size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));
}

/**
 * A number in a header field: octal digits and a NUL while it fits, else GNU base-256 (the high bit of the first byte
 * set, the value big-endian in two's complement), which also carries a time before 1970.
 */
function numeric(block: Uint8Array, at: number, width: number, value: number): void {
	if (value >= 0 && value < 8 ** (width - 1)) {
		const digits = value.toString(8).padStart(width - 1, "0");
		for (let index = 0; index < width - 1; index++) block[at + index] = digits.charCodeAt(index);
		block[at + width - 1] = 0;
		return;
	}
	const span = 1n << BigInt(width * 8);
	let rest = BigInt(value) < 0n ? BigInt(value) + span : BigInt(value);
	for (let index = width - 1; index >= 0; index--) {
		block[at + index] = Number(rest & 0xffn);
		rest >>= 8n;
	}
	block[at] = (block[at] as number) | 0x80;
}

function ascii(block: Uint8Array, at: number, text: string): void {
	for (let index = 0; index < text.length; index++) block[at + index] = text.charCodeAt(index);
}

/** One GNU header block. A name or link longer than its field is cut there; `tarHeaders` puts the whole one before it. */
function block(header: Omit<TarHeader, "type"> & { readonly type: TarHeader["type"] | "L" | "K" }): Uint8Array {
	const out = new Uint8Array(BLOCK);
	out.set(header.name.subarray(0, NAME_BYTES), 0);
	numeric(out, 100, 8, header.mode & 0o7777);
	numeric(out, 108, 8, 0);
	numeric(out, 116, 8, 0);
	numeric(out, 124, 12, header.size);
	numeric(out, 136, 12, header.mtime);
	out.fill(0x20, 148, 156);
	ascii(out, 156, header.type);
	if (header.link !== undefined) out.set(header.link.subarray(0, NAME_BYTES), 157);
	ascii(out, 257, "ustar  ");
	let sum = 0;
	for (const byte of out) sum += byte;
	ascii(out, 148, sum.toString(8).padStart(6, "0"));
	out[154] = 0;
	out[155] = 0x20;
	return out;
}

/** A GNU long name (`L`) or long link (`K`): the whole path and a NUL, as the data of an entry of its own. */
function long(type: "L" | "K", path: Uint8Array): Uint8Array[] {
	const data = new Uint8Array(path.length + 1);
	data.set(path);
	const name = new TextEncoder().encode("././@LongLink");
	return [block({ name, type, size: data.length, mode: 0o644, mtime: 0 }), data, tarPadding(data.length)];
}

/** The blocks before an entry's data: a long name and a long link first when a path does not fit its field. */
export function tarHeaders(header: TarHeader): Uint8Array[] {
	const blocks: Uint8Array[] = [];
	if (header.name.length > NAME_BYTES) blocks.push(...long("L", header.name));
	if (header.link !== undefined && header.link.length > NAME_BYTES) blocks.push(...long("K", header.link));
	blocks.push(block(header));
	return blocks;
}
