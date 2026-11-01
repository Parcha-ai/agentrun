// The host side of a pull: a tar archive a box made, read as it arrives and written under one directory of this
// machine. The box is not trusted, so neither is a byte of the archive. Only regular files and directories are
// written; a link, a device, a pipe or any other member is skipped and counted, never created. A name is refused when
// it is absolute, holds `..`, `.`, an empty segment or a NUL, or is longer than the platform allows. Nothing is written
// outside the destination and no link already there is followed: every directory is opened one component at a time
// from a held handle of the one above, with O_NOFOLLOW (the walk of pi-durable-disk's confinement; this package does
// not depend on it), and a file is written to a temporary name in its directory and renamed into place, which
// replaces a name and never follows it. Modes are capped: a file gets at most 0755 (0644 without an execute bit), a
// directory at most 0755, never setuid, setgid, sticky, group or world write. The archive may carry at most so many
// bytes (headers and names included) and so many members; past either the extraction stops cleanly before the member,
// and what was written stays written, every file whole.
//
// Linux names a held directory `/proc/self/fd/<fd>`, so the kernel starts from the held inode and never walks the
// directory's own path again. Elsewhere each step is opened by its full path, still with O_NOFOLLOW: that holds against
// links already in place, not against a program of this machine racing the extraction.
import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { decodePath, encodePath, WorkspaceError } from "../home/workspace.ts";

/** The most bytes one pull's archive may carry (headers, names, member data), when the caller names no limit: 1 GiB. */
export const MAX_PULL_BYTES = 1024 * 1024 * 1024;
/** The most members one pull may carry, written or skipped, when the caller names no limit. */
export const MAX_PULL_ENTRIES = 100_000;
/** The longest name of one path segment, in bytes (Linux's NAME_MAX). */
export const MAX_SEGMENT_BYTES = 255;
/** The longest whole path, in bytes, the destination's own path included (Linux's PATH_MAX less its NUL). */
export const MAX_PATH_BYTES = 4095;

/**
 * Why a member of an archive, or an entry of a box's listing, was not written.
 *
 * Its kind: `symlink`, `hardlink`, `device`, `fifo`, `socket`, `unsupported` (any other kind, a global header too).
 * Its name: `absolute`, `dot_segment` (`.` or `..`), `empty_segment` (`a//b`), `nul`, `too_long`.
 * The caller: `not_asked` (the pull did not ask for this path, or not as this kind), `duplicate` (a second member of the
 * same path). The host: `link_in_destination` (a symbolic link on the host is where the entry goes or above it),
 * `occupied` (a directory, special file or file is there and is not the kind the entry is), `host_newer` (the host's file
 * is newer, and the caller keeps newer files).
 */
export type SkipReason =
	| "symlink"
	| "hardlink"
	| "device"
	| "fifo"
	| "socket"
	| "unsupported"
	| "absolute"
	| "dot_segment"
	| "empty_segment"
	| "nul"
	| "too_long"
	| "not_asked"
	| "duplicate"
	| "link_in_destination"
	| "occupied"
	| "host_newer";

const SKIP_REASONS: readonly SkipReason[] = [
	"symlink",
	"hardlink",
	"device",
	"fifo",
	"socket",
	"unsupported",
	"absolute",
	"dot_segment",
	"empty_segment",
	"nul",
	"too_long",
	"not_asked",
	"duplicate",
	"link_in_destination",
	"occupied",
	"host_newer",
];

/**
 * One entry that was not written. `path` is as the box named it, with any NUL shown as `\0`. A `symlink` or `hardlink`
 * member also carries `target`, what the link names as the archive gives it (from the header, a GNU long link or a pax
 * `linkpath`), shown the same way: the link is never created, so a caller that keeps links keeps them as this data.
 */
export type Skip = { readonly path: string; readonly reason: SkipReason; readonly target?: string };

/** A count for every reason, all zero. */
export function noSkips(): Record<SkipReason, number> {
	return Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<SkipReason, number>;
}

/** The most skips a receipt names one by one; the counts cover all of them. */
export const MAX_NAMED_SKIPS = 100;

/** Why an extraction stopped before the end of the archive. What was written before stays written. */
export type ExtractStop = {
	readonly reason: "max_bytes" | "max_entries" | "malformed";
	readonly message: string;
};

export type ExtractOptions = {
	/**
	 * The most bytes the archive may carry: header blocks, pax and long-name payloads, and member data, written or
	 * skipped (block padding aside). Default `MAX_PULL_BYTES`.
	 */
	readonly maxBytes?: number;
	/** The most members the archive may hold, written or skipped. Default `MAX_PULL_ENTRIES`. */
	readonly maxEntries?: number;
	/**
	 * Whether a member may be written, by its path relative to the destination (`/` between segments, non-UTF-8
	 * bytes as `decodePath` gives them) and its kind. Default: every file and directory.
	 */
	readonly admit?: (path: string, kind: "file" | "directory") => boolean;
	/**
	 * When a file is already at a member's path: `box` replaces it (the default); `newer` keeps it when its
	 * modification time is later than the member's, and counts the member `host_newer`.
	 */
	readonly keep?: "box" | "newer";
	/**
	 * A written file's modification time in seconds, by path, when the caller knows it more exactly than the archive (a
	 * GNU tar header holds whole seconds; a box's listing has nanoseconds). Used for the file and for `keep: "newer"`.
	 */
	readonly mtimeOf?: (path: string) => number | undefined;
	/** Called for each skipped member, as it is skipped: where a host logs the reason. */
	readonly onSkip?: (skip: Skip) => void;
};

/** What an extraction wrote and what it did not. */
export type ExtractReceipt = {
	readonly files: number;
	readonly directories: number;
	/** Bytes of the files written. */
	readonly bytes: number;
	/** The paths written, files and directories, in archive order. */
	readonly written: readonly string[];
	/** The files left as they were because the host's was newer (`keep: "newer"`). */
	readonly kept: readonly string[];
	/** Files whose mode lost a bit to the cap: setuid, setgid, sticky, group or world write. */
	readonly masked: number;
	readonly skipped: Readonly<Record<SkipReason, number>>;
	/** The first `MAX_NAMED_SKIPS` skips, in order. */
	readonly skips: readonly Skip[];
	/** Set when the extraction stopped before the end of the archive. */
	readonly stopped?: ExtractStop;
};

/** A tar read a chunk at a time. `write` resolves `false` once the extraction has stopped and wants no more bytes. */
export interface Extractor {
	write(bytes: Uint8Array): Promise<boolean>;
	/** The archive ended: settle what is half done and say what was written. Safe to call more than once. */
	finish(): Promise<ExtractReceipt>;
	readonly stopped: ExtractStop | undefined;
}

const BLOCK = 512;
/** The largest pax header, GNU long name or long link this reads; a name is at most `MAX_PATH_BYTES` anyway. */
const META_LIMIT = 64 * 1024;
const MAX_PAX_RECORDS = 256;
/** Zero bytes a writer may pad an archive with past its end (GNU tar fills a 10 KiB record). */
const TRAILER_LIMIT = 64 * 1024;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
/** Whether this system names a held directory `/proc/self/fd/<fd>`. */
const BY_FD = existsSync("/proc/self/fd");

const TYPE_SKIPS: Readonly<Record<string, SkipReason>> = {
	"1": "hardlink",
	"2": "symlink",
	"3": "device",
	"4": "device",
	"6": "fifo",
};

/** The mode a written file gets: owner read and write, the box's execute bits, group and world read. At most 0755. */
export function fileMode(mode: number): number {
	return 0o600 | (mode & 0o155);
}

/** The mode a written directory gets: owner all, group and world read and search as the box had them. At most 0755. */
export function directoryMode(mode: number): number {
	return 0o700 | (mode & 0o055);
}

function errnoOf(error: unknown): string | undefined {
	const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
	return typeof code === "string" ? code : undefined;
}

/** Why a path relative to the destination may not be written, or `undefined`: the segments are then safe names. */
export function nameProblem(path: string, rootBytes: number): { reason: SkipReason } | { segments: readonly Buffer[] } {
	if (path.includes("\0")) return { reason: "nul" };
	if (path.startsWith("/")) return { reason: "absolute" };
	const relative = path.startsWith("./") ? path.slice(2) : path;
	if (relative === "" || relative === ".") return { reason: "dot_segment" };
	const segments: Buffer[] = [];
	let total = rootBytes;
	for (const segment of relative.split("/")) {
		if (segment === "") return { reason: "empty_segment" };
		if (segment === "." || segment === "..") return { reason: "dot_segment" };
		const bytes = Buffer.from(encodePath(segment));
		if (bytes.length > MAX_SEGMENT_BYTES) return { reason: "too_long" };
		total += 1 + bytes.length;
		segments.push(bytes);
	}
	if (total > MAX_PATH_BYTES) return { reason: "too_long" };
	return { segments };
}

/** A directory of the destination, held open. `path` is its real path, used only where `/proc/self/fd` is absent. */
type Held = { readonly handle: FileHandle; readonly path: Buffer };

const SLASH = Buffer.from("/");

function entryOf(dir: Held, name: Buffer): Buffer {
	return BY_FD
		? Buffer.concat([Buffer.from(`/proc/self/fd/${dir.handle.fd}/`), name])
		: Buffer.concat([dir.path, SLASH, name]);
}

/** Why a name in a held directory cannot be walked into: a link, or something that is not a directory. */
async function blockedBy(dir: Held, name: Buffer): Promise<SkipReason> {
	const found = await lstat(entryOf(dir, name)).catch(() => undefined);
	return found?.isSymbolicLink() ? "link_in_destination" : "occupied";
}

/**
 * The directory at `segments` below `root`, opened one component at a time without following a link, created when
 * `create` and absent. A component that is a link or not a directory is the reason it cannot be reached; a component
 * that is absent and not to be created is `undefined`.
 */
async function walk(
	root: Held,
	segments: readonly Buffer[],
	create: boolean,
): Promise<{ held: Held } | { reason: SkipReason } | undefined> {
	let current = root;
	let reached = false;
	try {
		for (const name of segments) {
			const at = entryOf(current, name);
			let handle: FileHandle | undefined;
			for (let attempt = 0; handle === undefined; attempt++) {
				try {
					handle = await open(at, DIRECTORY_FLAGS);
				} catch (error) {
					const code = errnoOf(error);
					if (code === "ENOENT" && create && attempt === 0) {
						await mkdir(at, 0o755).catch((cause: unknown) => {
							if (errnoOf(cause) !== "EEXIST") throw cause;
						});
						continue;
					}
					if (code === "ENOENT") return undefined;
					if (code === "ELOOP" || code === "ENOTDIR") return { reason: await blockedBy(current, name) };
					throw error;
				}
			}
			const next: Held = { handle, path: Buffer.concat([current.path, SLASH, name]) };
			if (current !== root) await current.handle.close();
			current = next;
		}
		reached = true;
		return { held: current };
	} finally {
		if (!reached && current !== root) await current.handle.close().catch(() => {});
	}
}

/** The destination itself, created when absent and held open. The caller names it, so its own links are followed. */
async function openRoot(dest: string): Promise<Held> {
	await mkdir(dest, { recursive: true });
	const real = await realpath(dest);
	return { handle: await open(real, DIRECTORY_FLAGS), path: Buffer.from(real) };
}

function readCString(block: Buffer, at: number, width: number): Buffer {
	const field = block.subarray(at, at + width);
	const end = field.indexOf(0);
	return end === -1 ? field : field.subarray(0, end);
}

/** A numeric field: octal digits, or GNU's base-256 with the high bit set. `undefined` when it is neither. */
function readNumber(block: Buffer, at: number, width: number): number | undefined {
	const field = block.subarray(at, at + width);
	if ((field[0] as number) & 0x80) {
		if (field[0] === 0xff) return undefined;
		let value = (field[0] as number) & 0x7f;
		for (let i = 1; i < field.length; i++) value = value * 256 + (field[i] as number);
		return Number.isSafeInteger(value) ? value : undefined;
	}
	const digits = field
		.toString("latin1")
		.replace(/[\0 ]+$/, "")
		.replace(/^ +/, "");
	if (digits === "") return 0;
	if (!/^[0-7]+$/.test(digits)) return undefined;
	const value = Number.parseInt(digits, 8);
	return Number.isSafeInteger(value) ? value : undefined;
}

function checksumOk(block: Buffer): boolean {
	const stored = readNumber(block, 148, 8);
	if (stored === undefined) return false;
	let unsigned = 0;
	let signed = 0;
	for (let i = 0; i < BLOCK; i++) {
		const byte = i >= 148 && i < 156 ? 0x20 : (block[i] as number);
		unsigned += byte;
		signed += byte > 127 ? byte - 256 : byte;
	}
	return stored === unsigned || stored === signed;
}

type Pax = { path?: string; linkpath?: string; size?: number; mtime?: number };

/** The records of a pax header that matter here (`path`, `linkpath`, `size`, `mtime`), or `undefined` if malformed. */
function readPax(data: Buffer): Pax | undefined {
	const pax: Pax = {};
	let at = 0;
	let records = 0;
	while (at < data.length) {
		if (++records > MAX_PAX_RECORDS) return undefined;
		const space = data.indexOf(0x20, at);
		if (space === -1 || space - at > 20) return undefined;
		const length = Number(data.toString("latin1", at, space));
		if (!Number.isSafeInteger(length) || length <= space - at + 1 || at + length > data.length) return undefined;
		if (data[at + length - 1] !== 0x0a) return undefined;
		const record = data.subarray(space + 1, at + length - 1);
		const equals = record.indexOf(0x3d);
		if (equals < 1) return undefined;
		const key = record.toString("latin1", 0, equals);
		const value = record.subarray(equals + 1);
		if (key === "path") pax.path = decodePath(value);
		else if (key === "linkpath") pax.linkpath = decodePath(value);
		else if (key === "size") {
			const text = value.toString("latin1");
			if (!/^\d{1,16}$/.test(text) || !Number.isSafeInteger(Number(text))) return undefined;
			pax.size = Number(text);
		} else if (key === "mtime") {
			const seconds = Number(value.toString("latin1"));
			if (Number.isFinite(seconds)) pax.mtime = Math.max(0, seconds);
		}
		at += length;
	}
	return pax;
}

/** A GNU long name or long link: its payload without the NULs that end it. */
function longText(data: Buffer): string {
	let end = data.length;
	while (end > 0 && data[end - 1] === 0) end--;
	return decodePath(data.subarray(0, end));
}

const padOf = (size: number) => (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));

/** A file being written: its temporary name in its directory, and where it goes. */
type Pending = {
	readonly dir: Held;
	readonly temp: Buffer;
	readonly name: Buffer;
	readonly path: string;
	readonly out: FileHandle;
	readonly mode: number;
	readonly mtime: number;
	readonly size: number;
};

type State =
	| { readonly kind: "header" }
	| { readonly kind: "meta"; readonly type: string; readonly size: number }
	| { readonly kind: "data"; remaining: number; readonly pad: number; readonly file?: Pending }
	| { readonly kind: "padding"; remaining: number }
	| { readonly kind: "end" };

class TarExtractor implements Extractor {
	readonly #root: Held;
	readonly #maxBytes: number;
	readonly #maxEntries: number;
	readonly #admit: (path: string, kind: "file" | "directory") => boolean;
	readonly #keep: "box" | "newer";
	readonly #mtimeOf: (path: string) => number | undefined;
	readonly #onSkip: ((skip: Skip) => void) | undefined;
	#state: State = { kind: "header" };
	/** Bytes of a header or a pax or long-name payload, until it is whole. */
	#gather: Buffer = Buffer.alloc(BLOCK);
	#gathered = 0;
	#zeroBlocks = 0;
	#trailer = 0;
	#pax: Pax | undefined;
	#longName: string | undefined;
	#longLink: string | undefined;
	#entries = 0;
	/** Bytes of the archive charged to `maxBytes`: header blocks, pax and long-name payloads, member data. */
	#archiveBytes = 0;
	#stopped: ExtractStop | undefined;
	#finished: ExtractReceipt | undefined;
	/** The directory the last file went into, kept open for the next one in it. */
	#parent: { key: string; held: Held } | undefined;
	readonly #seen = new Set<string>();
	readonly #written: string[] = [];
	readonly #kept: string[] = [];
	readonly #skipped = noSkips();
	readonly #skips: Skip[] = [];
	#files = 0;
	#directories = 0;
	#bytes = 0;
	#masked = 0;

	constructor(root: Held, options: ExtractOptions | undefined) {
		this.#root = root;
		this.#maxBytes = options?.maxBytes ?? MAX_PULL_BYTES;
		this.#maxEntries = options?.maxEntries ?? MAX_PULL_ENTRIES;
		this.#admit = options?.admit ?? (() => true);
		this.#keep = options?.keep ?? "box";
		this.#mtimeOf = options?.mtimeOf ?? (() => undefined);
		this.#onSkip = options?.onSkip;
	}

	get stopped(): ExtractStop | undefined {
		return this.#stopped;
	}

	/**
	 * Writes and the finish run one at a time, in the order called. A relay that gives up on a write (a stall, an abort)
	 * may call `finish` while that write still runs; the finish waits for it, so no handle it uses is closed under it.
	 */
	#queue: Promise<unknown> = Promise.resolve();

	#serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(work);
		this.#queue = run.catch(() => {});
		return run;
	}

	write(bytes: Uint8Array): Promise<boolean> {
		return this.#serial(() => this.#write(bytes));
	}

	finish(): Promise<ExtractReceipt> {
		return this.#serial(() => this.#finish());
	}

	async #write(bytes: Uint8Array): Promise<boolean> {
		if (this.#stopped !== undefined || this.#finished !== undefined) return false;
		const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let at = 0;
		while (at < chunk.length && this.#stopped === undefined) {
			const state = this.#state;
			if (state.kind === "data") {
				const take = Math.min(state.remaining, chunk.length - at);
				if (state.file !== undefined && take > 0) await writeAll(state.file.out, chunk.subarray(at, at + take));
				state.remaining -= take;
				at += take;
				if (state.remaining === 0) {
					if (state.file !== undefined) await this.#place(state.file);
					this.#state = state.pad > 0 ? { kind: "padding", remaining: state.pad } : { kind: "header" };
				}
			} else if (state.kind === "padding") {
				const take = Math.min(state.remaining, chunk.length - at);
				state.remaining -= take;
				at += take;
				if (state.remaining === 0) this.#state = { kind: "header" };
			} else if (state.kind === "end") {
				const rest = chunk.subarray(at);
				this.#trailer += rest.length;
				at = chunk.length;
				if (this.#trailer > TRAILER_LIMIT || rest.some((byte) => byte !== 0))
					this.#stop("malformed", "the archive has bytes after its end");
			} else {
				const need = state.kind === "header" ? BLOCK : state.size + padOf(state.size);
				const take = Math.min(need - this.#gathered, chunk.length - at);
				chunk.copy(this.#gather, this.#gathered, at, at + take);
				this.#gathered += take;
				at += take;
				if (this.#gathered === need) {
					this.#gathered = 0;
					if (state.kind === "header") await this.#header(this.#gather.subarray(0, BLOCK));
					else this.#meta(state.type, Buffer.from(this.#gather.subarray(0, state.size)));
				}
			}
		}
		return this.#stopped === undefined;
	}

	async #finish(): Promise<ExtractReceipt> {
		if (this.#finished !== undefined) return this.#finished;
		const state = this.#state;
		if (state.kind === "data" && state.file !== undefined) await this.#discard(state.file);
		if (this.#stopped === undefined && state.kind !== "end") {
			this.#stop("malformed", "the archive is cut short: it ends without its two zero blocks");
		}
		if (this.#parent !== undefined) await this.#parent.held.handle.close().catch(() => {});
		await this.#root.handle.close().catch(() => {});
		this.#finished = {
			files: this.#files,
			directories: this.#directories,
			bytes: this.#bytes,
			written: this.#written,
			kept: this.#kept,
			masked: this.#masked,
			skipped: this.#skipped,
			skips: this.#skips,
			...(this.#stopped === undefined ? {} : { stopped: this.#stopped }),
		};
		return this.#finished;
	}

	#stop(reason: ExtractStop["reason"], message: string): void {
		this.#stopped ??= { reason, message };
	}

	#skip(path: string, reason: SkipReason, target?: string): void {
		this.#skipped[reason] += 1;
		const skip: Skip = {
			path: path.replaceAll("\0", "\\0"),
			reason,
			...(target === undefined ? {} : { target: target.replaceAll("\0", "\\0") }),
		};
		if (this.#skips.length < MAX_NAMED_SKIPS) this.#skips.push(skip);
		this.#onSkip?.(skip);
	}

	#meta(type: string, data: Buffer): void {
		this.#state = { kind: "header" };
		if (type === "x") {
			const pax = this.#pax === undefined ? readPax(data) : undefined;
			if (pax === undefined) {
				this.#stop("malformed", this.#pax === undefined ? "a pax header is malformed" : "two pax headers in a row");
			} else this.#pax = pax;
		} else if (type === "L") {
			if (this.#longName !== undefined) this.#stop("malformed", "two long names in a row");
			else this.#longName = longText(data);
		} else if (type === "K") {
			if (this.#longLink !== undefined) this.#stop("malformed", "two long link names in a row");
			else this.#longLink = longText(data);
		}
	}

	async #header(block: Buffer): Promise<void> {
		if (block.every((byte) => byte === 0)) {
			if (++this.#zeroBlocks === 2) {
				if (this.#pax !== undefined || this.#longName !== undefined || this.#longLink !== undefined)
					return this.#stop("malformed", "a header has no member after it");
				this.#state = { kind: "end" };
			}
			return;
		}
		if (this.#zeroBlocks > 0) return this.#stop("malformed", "a lone zero block inside the archive");
		if (!this.#charge(BLOCK)) return;
		if (!checksumOk(block)) return this.#stop("malformed", "a header has a bad checksum");
		const magic = block.toString("latin1", 257, 263);
		const posix = magic === "ustar\0";
		if (!posix && magic !== "ustar ") return this.#stop("malformed", "a header is neither POSIX nor GNU tar");
		const type = String.fromCharCode(block[156] === 0 ? 0x30 : (block[156] as number));
		const size = readNumber(block, 124, 12);
		if (size === undefined) return this.#stop("malformed", "a header has a size that is not a number");
		if (type === "x" || type === "L" || type === "K" || type === "g") {
			if (size > META_LIMIT) return this.#stop("malformed", `a ${type} header holds more than ${META_LIMIT} bytes`);
			if (type === "g") {
				// A global header would change every member after it; none of it is honoured.
				if (!this.#count(size)) return;
				this.#skip("(global pax header)", "unsupported");
				this.#state = { kind: "data", remaining: size, pad: padOf(size) };
				return;
			}
			// Charged before it is read: a box that puts the largest metadata before every empty member pays for it.
			if (!this.#charge(size)) return;
			if (this.#gather.length < size + padOf(size)) this.#gather = Buffer.alloc(META_LIMIT + BLOCK);
			this.#state = size === 0 ? { kind: "header" } : { kind: "meta", type, size };
			if (size === 0) this.#meta(type, Buffer.alloc(0));
			return;
		}
		const pax = this.#pax;
		const longLink = this.#longLink;
		const named = readCString(block, 0, 100);
		const prefix = posix ? readCString(block, 345, 155) : Buffer.alloc(0);
		const path =
			pax?.path ??
			this.#longName ??
			decodePath(prefix.length > 0 ? Buffer.concat([prefix, SLASH, named]) : Buffer.from(named));
		this.#pax = undefined;
		this.#longName = undefined;
		this.#longLink = undefined;
		const regular = type === "0";
		const directory = type === "5";
		const length = directory ? 0 : (pax?.size ?? size);
		if (!this.#count(length)) return;
		const skipData = () => {
			this.#state = length === 0 ? { kind: "header" } : { kind: "data", remaining: length, pad: padOf(length) };
		};
		const typeSkip = regular || directory ? undefined : (TYPE_SKIPS[type] ?? "unsupported");
		if (typeSkip !== undefined) {
			const linked = type === "1" || type === "2";
			const target = linked ? (pax?.linkpath ?? longLink ?? decodePath(readCString(block, 157, 100))) : undefined;
			this.#skip(path, typeSkip, target);
			return skipData();
		}
		const bare = directory ? path.replace(/\/$/, "") : path;
		if (!directory && path.endsWith("/")) {
			this.#skip(path, "empty_segment");
			return skipData();
		}
		const checked = nameProblem(bare, this.#root.path.length);
		if ("reason" in checked) {
			this.#skip(path, checked.reason);
			return skipData();
		}
		const relative = bare.startsWith("./") ? bare.slice(2) : bare;
		const kind = directory ? "directory" : "file";
		if (!this.#admit(relative, kind)) {
			this.#skip(relative, "not_asked");
			return skipData();
		}
		if (this.#seen.has(relative)) {
			this.#skip(relative, "duplicate");
			return skipData();
		}
		this.#seen.add(relative);
		const mode = readNumber(block, 100, 8) ?? 0;
		if (directory) return this.#directory(relative, checked.segments, mode);
		const known = this.#mtimeOf(relative);
		const mtime =
			known !== undefined && Number.isFinite(known) && known >= 0
				? known
				: (pax?.mtime ?? readNumber(block, 136, 12) ?? 0);
		const file = await this.#open(relative, checked.segments, mode, mtime, length);
		if (file === undefined) return skipData();
		if (length === 0) return this.#place(file);
		this.#state = { kind: "data", remaining: length, pad: padOf(length), file };
	}

	/** Count one member of `size` data bytes against both limits; `false` (and stopped) when it would pass one. */
	#count(size: number): boolean {
		if (this.#entries + 1 > this.#maxEntries) {
			this.#stop("max_entries", `the archive holds more than ${this.#maxEntries} members`);
			return false;
		}
		if (!this.#charge(size)) return false;
		this.#entries += 1;
		return true;
	}

	/** Charge `size` bytes of the archive to `maxBytes`; `false` (and stopped) when they would pass it. */
	#charge(size: number): boolean {
		if (this.#archiveBytes + size > this.#maxBytes) {
			this.#stop(
				"max_bytes",
				`the archive carries more than ${this.#maxBytes} bytes: ${this.#archiveBytes} so far, the next part ${size}`,
			);
			return false;
		}
		this.#archiveBytes += size;
		return true;
	}

	async #directory(path: string, segments: readonly Buffer[], mode: number): Promise<void> {
		const reached = await walk(this.#root, segments, true);
		if (reached === undefined || "reason" in reached) return this.#skip(path, reached?.reason ?? "occupied");
		try {
			await reached.held.handle.chmod(directoryMode(mode));
		} finally {
			if (reached.held !== this.#root) await reached.held.handle.close();
		}
		this.#directories += 1;
		this.#written.push(path);
	}

	/** The held directory a file goes into: the last one when it is the same, else a walk from the root. */
	async #parentOf(segments: readonly Buffer[]): Promise<{ held: Held } | { reason: SkipReason }> {
		const above = segments.slice(0, -1);
		const key = Buffer.concat(above.flatMap((segment) => [segment, SLASH])).toString("latin1");
		if (this.#parent?.key === key) return { held: this.#parent.held };
		const reached = above.length === 0 ? { held: this.#root } : await walk(this.#root, above, true);
		if (reached === undefined || "reason" in reached) return reached ?? { reason: "occupied" };
		if (this.#parent !== undefined && this.#parent.held !== this.#root) await this.#parent.held.handle.close();
		this.#parent = { key, held: reached.held };
		return reached;
	}

	async #open(
		path: string,
		segments: readonly Buffer[],
		mode: number,
		mtime: number,
		size: number,
	): Promise<Pending | undefined> {
		const parent = await this.#parentOf(segments);
		if ("reason" in parent) {
			this.#skip(path, parent.reason);
			return undefined;
		}
		const temp = Buffer.from(`.agentrun-pull-${randomBytes(8).toString("hex")}`);
		const out = await open(entryOf(parent.held, temp), CREATE_FLAGS, 0o600);
		const name = segments[segments.length - 1] as Buffer;
		return { dir: parent.held, temp, name, path, out, mode, mtime, size };
	}

	async #discard(file: Pending): Promise<void> {
		await file.out.close().catch(() => {});
		await unlink(entryOf(file.dir, file.temp)).catch(() => {});
	}

	/** Close a whole file, give it its capped mode and time, and rename it into place unless something is in the way. */
	async #place(file: Pending): Promise<void> {
		this.#state = { kind: "header" };
		try {
			const capped = fileMode(file.mode);
			if ((file.mode & 0o7022) !== 0) this.#masked += 1;
			await file.out.chmod(capped);
			await file.out.utimes(file.mtime, file.mtime);
			await file.out.close();
		} catch (error) {
			await this.#discard(file);
			throw error;
		}
		try {
			const there = await lstat(entryOf(file.dir, file.name)).catch((error: unknown) => {
				if (errnoOf(error) === "ENOENT") return undefined;
				throw error;
			});
			let reason: SkipReason | undefined;
			if (there?.isSymbolicLink()) reason = "link_in_destination";
			else if (there !== undefined && !there.isFile()) reason = "occupied";
			else if (there !== undefined && this.#keep === "newer" && there.mtimeMs > file.mtime * 1000)
				reason = "host_newer";
			if (reason !== undefined) {
				await unlink(entryOf(file.dir, file.temp));
				if (reason === "host_newer") this.#kept.push(file.path);
				return this.#skip(file.path, reason);
			}
			// rename replaces the name and never follows it: a link put there since the check is replaced, not written through.
			await rename(entryOf(file.dir, file.temp), entryOf(file.dir, file.name));
		} catch (error) {
			await unlink(entryOf(file.dir, file.temp)).catch(() => {});
			throw error;
		}
		this.#files += 1;
		this.#bytes += file.size;
		this.#written.push(file.path);
	}
}

async function writeAll(out: FileHandle, bytes: Buffer): Promise<void> {
	for (let at = 0; at < bytes.length; ) {
		const { bytesWritten } = await out.write(bytes, at, bytes.length - at);
		at += bytesWritten;
	}
}

function hostFailure(what: string, error: unknown): WorkspaceError {
	return new WorkspaceError(
		"transfer_failed",
		`${what} on this machine: ${error instanceof Error ? error.message : String(error)}`,
		error,
	);
}

/** An extractor into `dest`, created when absent. A failure to open it is `transfer_failed`. */
export async function openExtractor(
	dest: string,
	options?: ExtractOptions,
): Promise<Result<Extractor, WorkspaceError>> {
	const limit = (name: string, value: number | undefined) =>
		value !== undefined && (!Number.isSafeInteger(value) || value < 0)
			? `${name} must be a whole number, 0 or more, not ${value}`
			: undefined;
	const bad = limit("maxBytes", options?.maxBytes) ?? limit("maxEntries", options?.maxEntries);
	if (bad !== undefined) return err(new WorkspaceError("invalid", bad));
	try {
		return ok(new TarExtractor(await openRoot(dest), options));
	} catch (error) {
		return err(hostFailure(`could not open ${dest}`, error));
	}
}

/**
 * Read a whole tar from `source` into `dest`, by the rules of this module. A host file system failure (no space, no
 * permission) is `transfer_failed`; everything the archive does wrong is in the receipt, as skips or as `stopped`.
 */
export async function extractTar(
	source: AsyncIterable<Uint8Array>,
	dest: string,
	options?: ExtractOptions,
): Promise<Result<ExtractReceipt, WorkspaceError>> {
	const opened = await openExtractor(dest, options);
	if (!opened.ok) return opened;
	const extractor = opened.value;
	try {
		for await (const chunk of source) if (!(await extractor.write(chunk))) break;
		return ok(await extractor.finish());
	} catch (error) {
		await extractor.finish().catch(() => {});
		return err(error instanceof WorkspaceError ? error : hostFailure("could not write the archive", error));
	}
}

/** What `removeEntries` did. */
export type RemoveReceipt = {
	readonly removed: number;
	/** Directories left because they still hold something the box did not have. */
	readonly kept: number;
	readonly skipped: Readonly<Record<SkipReason, number>>;
};

/**
 * Remove `paths` (relative to `dest`) from this machine, deepest first, by the walk of the extractor: a file or a link
 * is unlinked (a link itself, never what it names), a directory removed only when empty. A path whose directory above
 * is a link, or that is absent, is left alone.
 */
export async function removeEntries(
	dest: string,
	paths: readonly string[],
	onSkip?: (skip: Skip) => void,
): Promise<Result<RemoveReceipt, WorkspaceError>> {
	const skipped = noSkips();
	let removed = 0;
	let kept = 0;
	let root: Held;
	try {
		root = await openRoot(dest);
	} catch (error) {
		return err(hostFailure(`could not open ${dest}`, error));
	}
	const skip = (path: string, reason: SkipReason) => {
		skipped[reason] += 1;
		onSkip?.({ path: path.replaceAll("\0", "\\0"), reason });
	};
	try {
		for (const path of [...paths].sort().reverse()) {
			const checked = nameProblem(path, root.path.length);
			if ("reason" in checked) {
				skip(path, checked.reason);
				continue;
			}
			const above = checked.segments.slice(0, -1);
			const reached = above.length === 0 ? { held: root } : await walk(root, above, false);
			if (reached === undefined) continue;
			if ("reason" in reached) {
				skip(path, reached.reason);
				continue;
			}
			try {
				const at = entryOf(reached.held, checked.segments[checked.segments.length - 1] as Buffer);
				const there = await lstat(at).catch(() => undefined);
				if (there === undefined) continue;
				if (there.isDirectory()) {
					const gone = await rmdir(at).then(
						() => true,
						(error: unknown) => {
							if (errnoOf(error) === "ENOTEMPTY" || errnoOf(error) === "EEXIST") return false;
							throw error;
						},
					);
					if (gone) removed += 1;
					else kept += 1;
				} else {
					await unlink(at);
					removed += 1;
				}
			} finally {
				if (reached.held !== root) await reached.held.handle.close();
			}
		}
		return ok({ removed, kept, skipped });
	} catch (error) {
		return err(hostFailure("could not remove what the box no longer has", error));
	} finally {
		await root.handle.close().catch(() => {});
	}
}
