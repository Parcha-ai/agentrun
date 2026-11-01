// A run's files between this machine and a box: a host directory seeded into a box path, and what changed in a box
// directory pulled back. Both move one tar through `transfer`, the relay `moveWorkspace` uses, so a box streams it or
// moves it as files by its `facts().bulk`, under the same stall limit, deadline and clean-up. In the box: `sh`, GNU
// `tar` and `find` for a pull, and `split`, `sha256sum`, `cut`, `wc` and `cat` when a side moves files. No name is
// ever put in a shell string: the box reads the list of names NUL-separated on its standard input.
//
// A pull is incremental by listing, not by time. The box lists the directory (`find -printf`: kind, size, mode,
// modification time to the nanosecond, link target, every path NUL-separated) and the host compares it with the
// listing of the last pull, which the caller keeps as the mark: a path is fetched when it is new or any of those
// fields differ. A box's clock is not this machine's, a file restored with an old time (`tar -x`, `cp -p`, a checkout)
// is older than any mark, and a deletion has no time at all; a listing sees all three, and it is the one the session
// checkpoints already take (`manifestSince`). Nothing is hashed: the box is not trusted, so a hash it computes proves
// nothing, and the archive is checked on its own terms by the extractor.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Box, BoxProcess } from "../box/box.ts";
import { BoxError } from "../box/box.ts";
import {
	ASSUMED_FLOOR_BYTES_PER_SECOND,
	BASE_DEADLINE_MS,
	changedEntries,
	DEFAULT_CALL_TIMEOUT_MS,
	DEFAULT_STALL_MS,
	decodePath,
	encodePath,
	excluder,
	exitOnce,
	filesSink,
	filesSource,
	type Listed,
	list,
	type Manifest,
	NO_BYTES,
	nulList,
	type Pipe,
	PULL_PACK_FILES_SCRIPT,
	PULL_PACK_SCRIPT,
	pipeOf,
	type Starter,
	streamStarter,
	transfer,
	UNPACK_FILES_SCRIPT,
	UNPACK_SCRIPT,
	WorkspaceError,
} from "../home/workspace.ts";
import {
	directoryMode,
	type ExtractOptions,
	type Extractor,
	type ExtractStop,
	fileMode,
	MAX_NAMED_SKIPS,
	MAX_PULL_BYTES,
	MAX_PULL_ENTRIES,
	nameProblem,
	noSkips,
	openExtractor,
	removeEntries,
	type Skip,
	type SkipReason,
} from "./extract.ts";

/** What an agent's home keeps to this machine: never pulled back from a box, and seeded read-only. */
export const HOST_OWNED_HOME = ["/learning"] as const;

/** How the bytes of a seed or a pull travel, and how long they may take. */
export type SyncTransport = {
	/** Override how the box's side moves bytes. Default: what `facts().bulk` says (stream, else files). */
	readonly pipe?: Pipe;
	/** The size of the parts when the box's side moves files. Default 32 MiB. */
	readonly chunkBytes?: number;
	/** Deadline of each call that lists. Default 2 minutes. */
	readonly callTimeoutMs?: number;
	/** No byte moved for this long ends the copy with `timeout`. Default 1 minute. */
	readonly stallMs?: number;
	/** The copy ends with `timeout` after this long. Default 2 minutes plus the size at 2 MiB per second. */
	readonly deadlineMs?: number;
};

export type SeedOptions = SyncTransport & {
	/** The directory of this machine to copy. */
	readonly from: string;
	/** The absolute directory in the box it lands in, created when absent. What is already there stays, unless replaced. */
	readonly to: string;
	/** Paths left out, in the pattern language of `WorkspaceOptions.exclude` (`/x` is the top-level `x` only). */
	readonly exclude?: readonly string[];
	/** Paths seeded without any write bit (files 0444 or 0555, directories 0555), in the same pattern language. */
	readonly readOnly?: readonly string[];
	/** The most bytes of files the seed may carry. More is `too_large`, decided before a byte moves. */
	readonly maxBytes?: number;
};

/** What a seed sent. */
export type SeedReceipt = {
	readonly files: number;
	readonly directories: number;
	readonly bytes: number;
	/** Entries of this machine that are not sent: links (never followed), pipes, sockets, devices. */
	readonly skipped: Readonly<Record<SkipReason, number>>;
	readonly totalMs: number;
};

export type PullOptions = SyncTransport & {
	/** The directory in the box. */
	readonly from: string;
	/** The directory of this machine it comes back to, created when absent. */
	readonly to: string;
	/** The mark of the last pull into `to` (`PullReceipt.mark`). Absent: everything is new. */
	readonly since?: Manifest;
	/** Paths never pulled back, in the pattern language of `WorkspaceOptions.exclude`. Never removed either. */
	readonly exclude?: readonly string[];
	/** Remove from `to` what the box no longer has since the mark. Default `false`: a pull only adds and replaces. */
	readonly mirrorDeletes?: boolean;
	/**
	 * When `to` already has a file at a path the box changed: `box` replaces it (the default, for a directory the host
	 * does not write while a box holds it); `newer` keeps the host's when its modification time is later.
	 */
	readonly keep?: "box" | "newer";
	/** The most bytes one pull's archive may carry, headers and names included. Default `MAX_PULL_BYTES`. */
	readonly maxBytes?: number;
	/** The most members one pull may carry, written or skipped. Default `MAX_PULL_ENTRIES`. */
	readonly maxEntries?: number;
	/** Called for each entry that is not written, with the reason: where a host logs it. */
	readonly onSkip?: (skip: Skip) => void;
};

/** What a pull brought back. */
export type PullReceipt = {
	/** The listing the next pull compares against: what `to` now holds of the box, as far as this pull knows. */
	readonly mark: Manifest;
	/** Paths the box listed as new or changed since the mark. */
	readonly changed: number;
	readonly files: number;
	readonly directories: number;
	/** Bytes of the files written. */
	readonly bytes: number;
	/** Entries removed from `to` because the box no longer has them (`mirrorDeletes`). */
	readonly removed: number;
	/** Directories the box removed that `to` keeps, because they still hold something the box never had. */
	readonly keptDirectories: number;
	/** Files whose mode lost a bit to the cap. */
	readonly masked: number;
	readonly skipped: Readonly<Record<SkipReason, number>>;
	/** The first skips, in order, by path and reason; `skipped` counts all of them. */
	readonly skips: readonly Skip[];
	/**
	 * Set when the pull stopped at a limit or at an archive it could not read. What was written is whole and in the
	 * mark; the rest is not, so the next pull asks for it again.
	 */
	readonly stopped?: ExtractStop;
	readonly totalMs: number;
};

const LIST_SKIPS: Readonly<Record<string, SkipReason>> = {
	l: "symlink",
	s: "socket",
	p: "fifo",
	b: "device",
	c: "device",
};

function deadlineOf(options: SyncTransport, bytes: number): { stallMs: number; deadlineMs: number } {
	return {
		stallMs: options.stallMs ?? DEFAULT_STALL_MS,
		deadlineMs: options.deadlineMs ?? BASE_DEADLINE_MS + (bytes / ASSUMED_FLOOR_BYTES_PER_SECOND) * 1000,
	};
}

/**
 * The extractor as the target of `transfer`: it looks like a program whose input is the archive. Once it has stopped
 * it refuses more input, which ends the relay and the box's side.
 */
function extractorSink(extractor: Extractor): Starter {
	return async (context, state) => {
		const { exit, settle } = exitOnce();
		// A cancelled copy (an abort, a stall, a deadline) closes no input: its end is this.
		context.abortSignal?.addEventListener(
			"abort",
			() => settle(err(new BoxError("aborted", "the call was aborted"))),
			{ once: true },
		);
		let failure: WorkspaceError | undefined;
		state.problems.push(() => failure);
		const fail = (cause: unknown) => {
			failure =
				cause instanceof WorkspaceError
					? cause
					: new WorkspaceError(
							"transfer_failed",
							`could not write on this machine: ${cause instanceof Error ? cause.message : String(cause)}`,
							cause,
						);
			settle(ok(1));
		};
		const process: BoxProcess = {
			stdin: {
				write: async (bytes) => {
					let more: boolean;
					try {
						more = await extractor.write(bytes);
					} catch (cause) {
						fail(cause);
						throw cause;
					}
					if (!more) {
						settle(ok(0));
						throw new BoxError("aborted", "the extraction stopped");
					}
				},
				close: async () => {
					try {
						await extractor.finish();
						settle(ok(0));
					} catch (cause) {
						fail(cause);
					}
				},
			},
			stdout: NO_BYTES,
			stderr: NO_BYTES,
			wait: () => exit,
		};
		return ok(process);
	};
}

/**
 * Bring back what changed in a box directory since the last pull, into a directory of this machine. The box lists
 * `from`; every path that is new or listed differently from `since` is packed in the box and read here by the
 * extractor (`extractTar`'s rules: regular files and directories only, safe names only, nothing outside `to`, no link
 * followed, capped modes, `maxBytes` and `maxEntries`). Dotfiles come back like any file. A link, pipe, socket or device
 * in the box is skipped from the listing and counted. With `mirrorDeletes`, what the mark had and the box no longer has
 * is removed first: files and links unlinked, directories only when empty. `exclude` is applied to the listing, to what
 * is removed, and to every member the archive holds, so an excluded path is never written and never removed.
 *
 * A failure of the box or of this machine's file system is an error, and the caller keeps its old mark: what was
 * written stays (each file whole) and the next pull asks for it again.
 */
export async function pullDir(
	box: Box,
	options: PullOptions,
	context: Context,
): Promise<Result<PullReceipt, WorkspaceError>> {
	const started = performance.now();
	const pipe = pipeOf(box, options.pipe, options.chunkBytes);
	if (!pipe.ok) return pipe;
	const skipped = noSkips();
	const skips: Skip[] = [];
	const skip = (entry: Skip) => {
		skipped[entry.reason] += 1;
		if (skips.length < MAX_NAMED_SKIPS) skips.push(entry);
		options.onSkip?.(entry);
	};
	const excluded = excluder(options.exclude);
	const refused: { path: string; type: string }[] = [];
	const listed = await list(
		box,
		options.from,
		{ exclude: options.exclude, callTimeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS },
		context,
		undefined,
		refused,
	);
	if (!listed.ok) return listed;
	for (const entry of refused) skip({ path: entry.path, reason: LIST_SKIPS[entry.type] ?? "unsupported" });

	// What the box has that a pull may write: files and directories with names this machine takes.
	const rootBytes = Buffer.byteLength(options.to);
	const current: Listed[] = [];
	for (const entry of listed.value) {
		if (entry.kind === "symlink") {
			skip({ path: entry.path, reason: "symlink" });
			continue;
		}
		const checked = nameProblem(entry.path, rootBytes);
		if ("reason" in checked) {
			skip({ path: entry.path.replaceAll("\0", "\\0"), reason: checked.reason });
			continue;
		}
		current.push(entry);
	}
	const currentManifest: Manifest = {
		entries: current,
		bytes: current.reduce((sum, entry) => sum + entry.bytes, 0),
	};
	const previous = options.since === undefined ? undefined : withoutExcluded(options.since, excluded);
	const changed = changedEntries(previous, currentManifest);

	let removed = 0;
	let keptDirectories = 0;
	if (options.mirrorDeletes === true && previous !== undefined) {
		const now = new Map(current.map((entry) => [entry.path, entry.kind]));
		const gone = previous.entries
			.filter((entry) => {
				const kind = now.get(entry.path);
				// A path that changed kind goes first, so the new entry does not meet the old one.
				return kind === undefined || kind !== entry.kind;
			})
			.map((entry) => entry.path);
		if (gone.length > 0) {
			const done = await removeEntries(options.to, gone, skip);
			if (!done.ok) return done;
			removed = done.value.removed;
			keptDirectories = done.value.kept;
		}
	}

	const asked = new Map(changed.map((entry) => [entry.path, entry.kind]));
	// The listing's times have nanoseconds; a GNU tar header has whole seconds, too coarse to tell which side wrote last.
	const listedTimes = new Map(changed.map((entry) => [entry.path, Number(entry.mtime)]));
	const outcome = { files: 0, directories: 0, bytes: 0, masked: 0 };
	const written = new Set<string>();
	let stopped: ExtractStop | undefined;
	if (changed.length > 0) {
		const extractOptions: ExtractOptions = {
			maxBytes: options.maxBytes ?? MAX_PULL_BYTES,
			maxEntries: options.maxEntries ?? MAX_PULL_ENTRIES,
			keep: options.keep ?? "box",
			admit: (path, kind) => asked.get(path) === kind && !excluded(path),
			mtimeOf: (path) => listedTimes.get(path),
			onSkip: skip,
		};
		const opened = await openExtractor(options.to, extractOptions);
		if (!opened.ok) return opened;
		const names = nulList(changed.map((entry) => entry.path));
		const wanted = Math.min(
			changed.reduce((sum, entry) => sum + entry.bytes, 0),
			extractOptions.maxBytes ?? MAX_PULL_BYTES,
		);
		let moved: Awaited<ReturnType<typeof transfer>>;
		let stoppedInCopy: ExtractStop | undefined;
		try {
			moved = await transfer(
				pipe.value.kind === "files"
					? filesSource(box, PULL_PACK_FILES_SCRIPT, [options.from], names, pipe.value.chunkBytes)
					: streamStarter(box, ["sh", "-c", PULL_PACK_SCRIPT, "sh", options.from]),
				names,
				extractorSink(opened.value),
				deadlineOf(options, wanted),
				context,
			);
			stoppedInCopy = opened.value.stopped;
		} finally {
			await opened.value.finish().catch(() => {});
		}
		const extracted = await opened.value.finish();
		// The extraction stopping in the copy (a limit, an archive it cannot read) is what ended it, so the copy's own
		// error says nothing more. Any other failure is the pull's error, also when it left the archive cut short.
		if (!moved.ok && stoppedInCopy === undefined) return moved;
		stopped = extracted.stopped;
		outcome.files = extracted.files;
		outcome.directories = extracted.directories;
		outcome.bytes = extracted.bytes;
		outcome.masked = extracted.masked;
		for (const path of extracted.written) written.add(path);
		// A file the host kept as newer is settled until the box changes it again.
		for (const path of extracted.kept) written.add(path);
	}

	// The next mark: what was already in step, and what this pull wrote. A path asked for and not written is left out,
	// so the next pull asks for it again.
	const mark = current.filter((entry) => !asked.has(entry.path) || written.has(entry.path));
	return ok({
		mark: { entries: mark, bytes: mark.reduce((sum, entry) => sum + entry.bytes, 0) },
		changed: changed.length,
		...outcome,
		removed,
		keptDirectories,
		skipped,
		skips,
		...(stopped === undefined ? {} : { stopped }),
		totalMs: performance.now() - started,
	});
}

function withoutExcluded(manifest: Manifest, excluded: (path: string) => boolean): Manifest {
	const entries = manifest.entries.filter((entry) => !excluded(entry.path));
	return { entries, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}

/** `pullDir` for an agent's home: `HOST_OWNED_HOME` is always excluded, and a newer host file is kept by default. */
export function pullAgentHome(
	box: Box,
	options: PullOptions,
	context: Context,
): Promise<Result<PullReceipt, WorkspaceError>> {
	return pullDir(
		box,
		{ keep: "newer", ...options, exclude: [...(options.exclude ?? []), ...HOST_OWNED_HOME] },
		context,
	);
}

type SeedEntry = {
	readonly path: string;
	readonly kind: "file" | "directory";
	/** Where it is on this machine, as bytes: a name need not be UTF-8. */
	readonly real: Buffer;
	readonly size: number;
	readonly mode: number;
	readonly mtime: number;
};

/** The entries of a directory of this machine, in path order, without following a link. */
async function walkHost(
	root: Buffer,
	exclude: (path: string) => boolean,
	readOnly: (path: string) => boolean,
	skipped: Record<SkipReason, number>,
): Promise<SeedEntry[]> {
	const entries: SeedEntry[] = [];
	const visit = async (dir: Buffer, prefix: string) => {
		const names = await readdir(dir, { encoding: "buffer" });
		names.sort(Buffer.compare);
		for (const name of names) {
			const path = prefix === "" ? decodePath(name) : `${prefix}/${decodePath(name)}`;
			if (exclude(path)) continue;
			const real = Buffer.concat([dir, Buffer.from("/"), name]);
			const info = await lstat(real);
			const mtime = info.mtimeMs / 1000;
			if (info.isSymbolicLink()) skipped.symlink += 1;
			else if (info.isFIFO()) skipped.fifo += 1;
			else if (info.isSocket()) skipped.socket += 1;
			else if (info.isBlockDevice() || info.isCharacterDevice()) skipped.device += 1;
			else if (info.isDirectory()) {
				const mode = directoryMode(info.mode);
				entries.push({
					path,
					kind: "directory",
					real,
					size: 0,
					mode: readOnly(path) ? mode & ~0o222 : mode,
					mtime,
				});
				await visit(real, path);
			} else if (info.isFile()) {
				const mode = fileMode(info.mode);
				entries.push({
					path,
					kind: "file",
					real,
					size: info.size,
					mode: readOnly(path) ? mode & ~0o222 : mode,
					mtime,
				});
			} else skipped.unsupported += 1;
		}
	};
	await visit(root, "");
	return entries;
}

const BLOCK = 512;
const MAX_OCTAL_SIZE = 0o77777777777;
const COPY_CHUNK = 64 * 1024;

function octal(block: Buffer, at: number, width: number, value: number): void {
	block.write(`${value.toString(8).padStart(width - 1, "0")}\0`, at, width, "latin1");
}

/** One GNU tar header: the format GNU tar writes by default and every GNU tar reads. */
function gnuHeader(name: Buffer, type: string, size: number, mode: number, mtime: number): Buffer {
	const block = Buffer.alloc(BLOCK);
	name.copy(block, 0, 0, Math.min(name.length, 100));
	octal(block, 100, 8, mode);
	octal(block, 108, 8, 0);
	octal(block, 116, 8, 0);
	if (size > MAX_OCTAL_SIZE) {
		block[124] = 0x80;
		let rest = size;
		for (let at = 135; at > 124; at--) {
			block[at] = rest % 256;
			rest = Math.floor(rest / 256);
		}
	} else octal(block, 124, 12, size);
	octal(block, 136, 12, Math.max(0, Math.floor(mtime)));
	block.fill(0x20, 148, 156);
	block.write(type, 156, 1, "latin1");
	block.write("ustar  \0", 257, 8, "latin1");
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
	return block;
}

const padding = (size: number) => Buffer.alloc(size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));

/** The header blocks of one entry: a GNU long name first when the name does not fit in 100 bytes. */
function headersOf(entry: SeedEntry, size: number): Buffer[] {
	const name = Buffer.from(encodePath(entry.kind === "directory" ? `${entry.path}/` : entry.path));
	const blocks: Buffer[] = [];
	if (name.length > 100) {
		const long = Buffer.concat([name, Buffer.alloc(1)]);
		blocks.push(gnuHeader(Buffer.from("././@LongLink"), "L", long.length, 0o644, 0), long, padding(long.length));
	}
	blocks.push(gnuHeader(name, entry.kind === "directory" ? "5" : "0", size, entry.mode, entry.mtime));
	return blocks;
}

/**
 * The seed's archive, as a program's output. Each file is opened without following a link and checked to be a file
 * still; its header carries the size it has when opened, and exactly that many bytes follow.
 */
function hostArchive(entries: readonly SeedEntry[]): Starter {
	return async (context) => {
		const { exit, settle } = exitOnce();
		let message = "";
		async function* chunks(): AsyncGenerator<Uint8Array> {
			try {
				for (const entry of entries) {
					if (entry.kind === "directory") {
						yield* headersOf(entry, 0);
						continue;
					}
					const file = await open(entry.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
					try {
						const info = await file.stat();
						if (!info.isFile()) throw new Error(`${entry.path} is no longer a file`);
						yield* headersOf(entry, info.size);
						const chunk = Buffer.alloc(COPY_CHUNK);
						let sent = 0;
						while (sent < info.size) {
							const { bytesRead } = await file.read(chunk, 0, Math.min(COPY_CHUNK, info.size - sent), sent);
							if (bytesRead === 0) throw new Error(`${entry.path} shrank while it was seeded`);
							yield Buffer.from(chunk.subarray(0, bytesRead));
							sent += bytesRead;
						}
						yield padding(info.size);
					} finally {
						await file.close();
					}
				}
				yield Buffer.alloc(BLOCK * 2);
				settle(ok(0));
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
				settle(ok(1));
			} finally {
				settle(ok(1));
			}
		}
		const stdout = chunks();
		// A cancelled copy may leave the archive waiting at a chunk nobody reads: end it, which closes its open file.
		context.abortSignal?.addEventListener(
			"abort",
			() => {
				settle(err(new BoxError("aborted", "the call was aborted")));
				void stdout.return(undefined).catch(() => {});
			},
			{ once: true },
		);
		const process: BoxProcess = {
			stdin: { write: async () => {}, close: async () => {} },
			stdout,
			stderr: (async function* () {
				await exit;
				if (message !== "") yield new TextEncoder().encode(message);
			})(),
			wait: () => exit,
		};
		return ok(process);
	};
}

/**
 * Copy a directory of this machine into a box path. Regular files and directories go; a link is never followed (a
 * link to a file outside `from` would carry that file into the box) and is skipped with pipes, sockets and devices,
 * all counted. Modes are capped as a pull caps them (at most 0755, never setuid or group or world write), and paths
 * matching `readOnly` lose every write bit. The box unpacks with its own `tar`, keeping those modes.
 */
export async function seedDir(
	box: Box,
	options: SeedOptions,
	context: Context,
): Promise<Result<SeedReceipt, WorkspaceError>> {
	const started = performance.now();
	const pipe = pipeOf(box, options.pipe, options.chunkBytes);
	if (!pipe.ok) return pipe;
	const skipped = noSkips();
	let entries: SeedEntry[];
	try {
		const root = Buffer.from(await realpath(options.from));
		entries = await walkHost(root, excluder(options.exclude), excluder(options.readOnly), skipped);
	} catch (error) {
		const missing = (error as { code?: unknown }).code === "ENOENT";
		return err(
			new WorkspaceError(
				missing ? "not_found" : "transfer_failed",
				`could not read ${options.from}: ${error instanceof Error ? error.message : String(error)}`,
				error,
			),
		);
	}
	const files = entries.filter((entry) => entry.kind === "file");
	const bytes = files.reduce((sum, entry) => sum + entry.size, 0);
	if (options.maxBytes !== undefined && bytes > options.maxBytes) {
		return err(
			new WorkspaceError(
				"too_large",
				`${options.from} holds ${bytes} bytes of files, the limit is ${options.maxBytes}`,
			),
		);
	}
	const moved = await transfer(
		hostArchive(entries),
		undefined,
		pipe.value.kind === "files"
			? filesSink(box, UNPACK_FILES_SCRIPT, [options.to], pipe.value.chunkBytes)
			: streamStarter(box, ["sh", "-c", UNPACK_SCRIPT, "sh", options.to]),
		deadlineOf(options, bytes),
		context,
	);
	if (!moved.ok) return moved;
	return ok({
		files: files.length,
		directories: entries.length - files.length,
		bytes,
		skipped,
		totalMs: performance.now() - started,
	});
}

/** `seedDir` for an agent's home: `HOST_OWNED_HOME` always goes read-only. */
export function seedAgentHome(
	box: Box,
	options: SeedOptions,
	context: Context,
): Promise<Result<SeedReceipt, WorkspaceError>> {
	return seedDir(box, { ...options, readOnly: [...(options.readOnly ?? []), ...HOST_OWNED_HOME] }, context);
}
