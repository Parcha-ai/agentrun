// Archives built byte by byte for the extractor's tests, so a hostile member is exactly what the test says it is, and
// a walk of a directory tree that a test compares before and after.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const BLOCK = 512;

export type Member = {
	/** The name field, raw bytes allowed (a string is UTF-8). Cut at 100 bytes as tar does. */
	readonly name: string | Buffer;
	/** The typeflag: "0" file, "5" directory, "2" symlink, "1" hardlink, "3"/"4" device, "6" fifo, "x", "L", "g". */
	readonly type?: string;
	readonly mode?: number;
	readonly mtime?: number;
	readonly linkname?: string;
	/** The data that follows the header. Its length is the size field unless `size` says otherwise. */
	readonly data?: Buffer | string;
	/** The size field when it must differ from the data's length (a bomb that claims more than it sends). */
	readonly size?: number;
	readonly magic?: "posix" | "gnu";
	/** Break the checksum. */
	readonly badChecksum?: boolean;
};

function octal(block: Buffer, at: number, width: number, value: number): void {
	block.write(`${value.toString(8).padStart(width - 1, "0")}\0`, at, width, "latin1");
}

/** One member's header block and its data, padded to whole blocks. */
export function member(spec: Member): Buffer {
	const data = typeof spec.data === "string" ? Buffer.from(spec.data) : (spec.data ?? Buffer.alloc(0));
	const block = Buffer.alloc(BLOCK);
	const name = typeof spec.name === "string" ? Buffer.from(spec.name) : spec.name;
	name.copy(block, 0, 0, Math.min(100, name.length));
	octal(block, 100, 8, spec.mode ?? 0o644);
	octal(block, 108, 8, 0);
	octal(block, 116, 8, 0);
	octal(block, 124, 12, spec.size ?? data.length);
	octal(block, 136, 12, spec.mtime ?? 1_700_000_000);
	block.fill(0x20, 148, 156);
	block.write(spec.type ?? "0", 156, 1, "latin1");
	if (spec.linkname !== undefined) block.write(spec.linkname, 157, 100, "utf8");
	if (spec.magic === "gnu") block.write("ustar  \0", 257, 8, "latin1");
	else block.write("ustar\u000000", 257, 8, "latin1");
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${(sum + (spec.badChecksum ? 1 : 0)).toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
	const pad = data.length % BLOCK === 0 ? 0 : BLOCK - (data.length % BLOCK);
	return Buffer.concat([block, data, Buffer.alloc(pad)]);
}

/** A pax header whose records come before the next member. Values may hold any byte. */
export function pax(records: Readonly<Record<string, string | Buffer>>): Buffer {
	const parts: Buffer[] = [];
	for (const [key, raw] of Object.entries(records)) {
		const value = typeof raw === "string" ? Buffer.from(raw) : raw;
		const body = Buffer.concat([Buffer.from(` ${key}=`), value, Buffer.from("\n")]);
		let length = body.length + 1;
		while (String(length).length + body.length !== length) length = String(length).length + body.length;
		parts.push(Buffer.concat([Buffer.from(String(length)), body]));
	}
	return member({ name: "PaxHeaders/x", type: "x", data: Buffer.concat(parts) });
}

/** A GNU long name for the next member, NUL-terminated as GNU tar writes it. */
export function longName(name: string | Buffer): Buffer {
	const bytes = typeof name === "string" ? Buffer.from(name) : name;
	return member({ name: "././@LongLink", type: "L", data: Buffer.concat([bytes, Buffer.alloc(1)]), magic: "gnu" });
}

/** The two zero blocks that end an archive. */
export const END = Buffer.alloc(BLOCK * 2);

/** Members and the end, as one archive. */
export function archive(...parts: Buffer[]): Buffer {
	return Buffer.concat([...parts, END]);
}

/** An archive fed as chunks of `size` bytes, as a box's stream delivers it. */
export async function* chunked(bytes: Buffer, size = 700): AsyncGenerator<Uint8Array> {
	for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

/** Every entry under `root`: kind, mode, size, content hash or link target. Keyed by path relative to `root`. */
export function tree(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const visit = (dir: string, prefix: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const rel = prefix === "" ? name : `${prefix}/${name}`;
			const info = lstatSync(path);
			const mode = (info.mode & 0o7777).toString(8);
			if (info.isSymbolicLink()) out[rel] = `link -> ${readlinkSync(path)}`;
			else if (info.isDirectory()) {
				out[rel] = `dir ${mode}`;
				visit(path, rel);
			} else if (info.isFile()) {
				const sha = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
				out[rel] = `file ${mode} ${info.size} ${sha}`;
			} else out[rel] = `special ${mode}`;
		}
	};
	visit(root, "");
	return out;
}

/** The content of every file under `root`, by relative path: what a round trip must keep. */
export function contents(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, line] of Object.entries(tree(root))) {
		out[path] = line.startsWith("file ") ? line.replace(/^file \d+ /, "file ") : line.replace(/^dir \d+$/, "dir");
	}
	return out;
}
