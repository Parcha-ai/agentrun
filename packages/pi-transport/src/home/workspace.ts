import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { type Box, BoxError } from "../box/box.ts";
import { finish } from "../box/files.ts";
import {
	ASSUMED_FLOOR_BYTES_PER_SECOND,
	BASE_DEADLINE_MS,
	boxFailure,
	CHECK_PARTS,
	changedEntries,
	DEFAULT_CALL_TIMEOUT_MS,
	DEFAULT_STALL_MS,
	decodePath,
	encodePath,
	exitOnce,
	filesSink,
	filesSource,
	type Listed,
	list,
	type Manifest,
	type ManifestEntry,
	NO_BYTES,
	nulList,
	PART_LIST,
	type Pipe,
	packFilesScript,
	pipeOf,
	type Run,
	type Starter,
	sameListed,
	splitNul,
	streamStarter,
	TAIL_BYTES,
	TAR_CREATE,
	transfer,
	UNPACK_FILES_SCRIPT,
	UNPACK_SCRIPT,
	WorkspaceError,
	type WorkspaceOptions,
} from "../sync/transfer.ts";
import { TAR_END, tarHeaders, tarPadding } from "./tar.ts";

// The listing, packing and transfer moved to `../sync/transfer.ts`, which `./sync` is built on. This file keeps the
// session moves, which are deprecated and removed in the next release; it re-exports what its importers took from here.
export {
	changedEntries,
	encodePath,
	type Manifest,
	type ManifestEntry,
	type Pipe,
	WorkspaceError,
	type WorkspaceErrorCode,
	type WorkspaceOptions,
} from "../sync/transfer.ts";

// Its own text codecs, as `../sync/transfer.ts` keeps its own: an exported one would put node's `util` types in the
// built declarations.
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const HASH_SCRIPT = 'cd -- "$1" || exit 3; exec xargs -0 -r sha256sum -z --';
const PACK_SCRIPT = `cd -- "$1" || exit 3; exec ${TAR_CREATE}`;
const PACK_FILES_SCRIPT = packFilesScript(TAR_CREATE);
const SPLIT_FILE_SCRIPT = `umask 077; mkdir -p -- "$2" || exit 4; echo $$ > "$2/pid"; split -b "$3" -d -a 6 -- "$1" "$2/c-" || exit 5; ${PART_LIST}`;
const JOIN_FILE_SCRIPT = `u=$(umask); umask 077; mkdir -p -- "$2" && echo $$ > "$2/pid" && cat > "$2/manifest" || exit 7; umask "$u"; ${CHECK_PARTS}; : > "$1" || exit 3; for f in "$2"/c-*; do if [ -e "$f" ]; then cat -- "$f" >> "$1" || exit 6; fi; done; rm -rf -- "$2"`;
const MAKE_PARENT_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")"';
const RECEIVE_SCRIPT = 'cat > "$1"';
/** A sealed file of no bytes sends none: the receiver reads /dev/null, never an exec stdin whose end `docker exec -i` can lose. */
const EMPTY_INPUT = "exec </dev/null; ";
// Hashed through standard input: with a name on the command line, GNU sha256sum escapes a newline or backslash in it.
const HASH_ONE_SCRIPT = 'sha256sum < "$1" && wc -c < "$1"';
const PLACE_SCRIPT = 'mv -f -- "$1" "$2"';
const REMOVE_SCRIPT = 'rm -f -- "$1"';
const HEX_DIGITS_SHA256 = 64;
const HASH_BYTES_PER_SECOND = 20 * 1024 * 1024;
const MEGABYTE = 1024 * 1024;

/** How a single file is moved. */
export type MoveFileOptions = {
	/** Override how the source side and the target side move bytes. Default: what each box's `facts().bulk` says. */
	readonly fromPipe?: Pipe;
	readonly toPipe?: Pipe;
	/** The size of the parts when a side moves files and names no size. Default 32 MiB. */
	readonly chunkBytes?: number;
	/** No byte moved for this long ends the copy. Default 60 s. */
	readonly stallMs?: number;
	/** The whole copy must end within this. Default: a base and the time the file's size needs at an assumed floor. */
	readonly deadlineMs?: number;
};

/** How a directory is moved. */
export type MoveWorkspaceOptions = WorkspaceOptions & {
	/**
	 * Override how the source side and the target side move bytes. Default: what each box's `facts().bulk` says, so a
	 * copy from Docker to a box that says nothing streams out of one and moves files into the other.
	 */
	readonly fromPipe?: Pipe;
	readonly toPipe?: Pipe;
	/** The size of the parts when a side moves files and names no size. Default 32 MiB. */
	readonly chunkBytes?: number;
	readonly fromRoot: string;
	readonly toRoot: string;
	/** The most bytes of files that may move. More is `too_large`. */
	readonly maxBytes?: number;
	/** The copy fails with `timeout` when no byte moves for this long. Default 1 minute. */
	readonly stallMs?: number;
	/** The copy fails with `timeout` after this long. Default 2 minutes plus the size at 2 MiB per second. */
	readonly deadlineMs?: number;
};

/** What a move did and how long each part took. */
export type WorkspaceReceipt = {
	readonly files: number;
	readonly directories: number;
	readonly symlinks: number;
	readonly bytes: number;
	readonly totalMs: number;
	readonly manifestMs: number;
	readonly copyMs: number;
	readonly verifyMs: number;
	/** Megabytes (2^20 bytes) per second of the copy part alone. */
	readonly megabytesPerSecond: number;
	/** Time the relay waited for the source to produce data, and for the target to take it. */
	readonly sourceWaitMs: number;
	readonly targetWaitMs: number;
	/** The side the relay waited on more. */
	readonly limit: "source" | "target";
};

/** Run a program in a box to its end, with input, under a deadline. */
async function run(
	box: Box,
	command: readonly string[],
	input: Uint8Array | undefined,
	timeoutMs: number,
	context: Context,
): Promise<Result<Run, WorkspaceError>> {
	const started = await box.exec(command, { timeoutMs }, context);
	if (!started.ok) return err(boxFailure(`could not start ${command[0] ?? "a program"}`, started.error));
	const finished = await finish(started.value, input);
	if (!finished.ok) return err(boxFailure(`${command[0] ?? "a program"} did not finish`, finished.error));
	return ok(finished.value);
}

async function hashFiles(
	box: Box,
	root: string,
	files: readonly Listed[],
	options: WorkspaceOptions | undefined,
	context: Context,
): Promise<Result<Map<string, string>, WorkspaceError>> {
	const hashes = new Map<string, string>();
	if (files.length === 0) return ok(hashes);
	const total = files.reduce((sum, file) => sum + file.bytes, 0);
	const timeoutMs = (options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS) + (total / HASH_BYTES_PER_SECOND) * 1000;
	const ran = await run(
		box,
		["sh", "-c", HASH_SCRIPT, "sh", root],
		nulList(files.map((file) => file.path)),
		timeoutMs,
		context,
	);
	if (!ran.ok) return ran;
	if (ran.value.exitCode !== 0) {
		const gone = /No such file or directory/.test(ran.value.stderr);
		return err(
			new WorkspaceError(
				gone ? "changed" : "box_failed",
				`could not hash the files of ${root}: ${ran.value.stderr.trim().slice(-TAIL_BYTES)}`,
			),
		);
	}
	for (const record of splitNul(ran.value.stdout)) {
		const hash = decoder.decode(record.subarray(0, HEX_DIGITS_SHA256));
		const name = decodePath(record.subarray(HEX_DIGITS_SHA256 + 2));
		hashes.set(name.replace(/^\.\//, ""), hash);
	}
	return ok(hashes);
}

/** What is in a box's directory, without moving it: every entry with its size, mode and, for files, SHA-256. */
export async function manifestOf(
	box: Box,
	root: string,
	options: WorkspaceOptions | undefined,
	context: Context,
): Promise<Result<Manifest, WorkspaceError>> {
	const listed = await list(box, root, options, context);
	if (!listed.ok) return listed;
	return withHashes(box, root, listed.value, options, context);
}

async function withHashes(
	box: Box,
	root: string,
	listed: readonly Listed[],
	options: WorkspaceOptions | undefined,
	context: Context,
): Promise<Result<Manifest, WorkspaceError>> {
	const hashes = await hashFiles(
		box,
		root,
		listed.filter((entry) => entry.kind === "file"),
		options,
		context,
	);
	if (!hashes.ok) return hashes;
	const entries: ManifestEntry[] = [];
	for (const entry of listed) {
		if (entry.kind !== "file") {
			entries.push(entry);
			continue;
		}
		const sha256 = hashes.value.get(entry.path);
		if (sha256 === undefined) return err(new WorkspaceError("changed", `${entry.path} vanished while it was hashed`));
		entries.push({ ...entry, sha256 });
	}
	return ok({ entries, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) });
}

type Field = "kind" | "bytes" | "sha256" | "mode" | "target" | "link" | "mtime" | "mtimeExact";

/**
 * The whole seconds of a time as `find` prints it, the part a tar header keeps. Read from the text: as a number, a
 * time a nanosecond short of the next second rounds up to it.
 */
function wholeSeconds(mtime: string): string {
	return mtime.split(".")[0] ?? mtime;
}

/** The first path where two manifests differ, in path order, with what differs. */
function firstDifference(
	before: readonly Listed[],
	after: readonly Listed[],
	fields: readonly Field[],
	sha: ReadonlyMap<string, string | undefined>,
	shaAfter: ReadonlyMap<string, string | undefined>,
): string | undefined {
	const left = new Map(before.map((entry) => [entry.path, entry]));
	const right = new Map(after.map((entry) => [entry.path, entry]));
	for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
		const a = left.get(path);
		const b = right.get(path);
		if (a === undefined) return `${path} is not in the source`;
		if (b === undefined) return `${path} is missing`;
		for (const field of fields) {
			if (field === "sha256") {
				if (sha.get(path) !== shaAfter.get(path)) return `${path} has other content`;
			} else if (field === "mode") {
				if (a.kind !== "symlink" && a.mode !== b.mode)
					return `${path} has mode ${b.mode.toString(8)}, not ${a.mode.toString(8)}`;
			} else if (field === "mtime") {
				if (a.kind === "file" && wholeSeconds(a.mtime) !== wholeSeconds(b.mtime))
					return `${path} has another modification time: ${b.mtime}, not ${a.mtime}`;
			} else if (field === "mtimeExact") {
				if (a.kind === "file" && a.mtime !== b.mtime) return `${path} has another modification time`;
			} else if (a[field] !== b[field]) return `${path} has another ${field}`;
		}
	}
	return undefined;
}

/**
 * Copy a directory from one box to another through this process as a `tar` stream, then check the target against the
 * source. The source is listed and hashed before any byte moves (and refused with `too_large` or `unsupported_entry`
 * from the listing alone), listed again after the copy (`changed` when it differs), and the target is listed and
 * hashed (`mismatch`, naming the first path that differs). Kept: contents, modes, links as links, empty directories and
 * modification times in whole seconds. Not kept: owners and extended attributes. The target is written into, so a
 * target that already holds other files fails the check.
 */
export async function moveWorkspace(
	from: Box,
	to: Box,
	options: MoveWorkspaceOptions,
	context: Context,
): Promise<Result<WorkspaceReceipt, WorkspaceError>> {
	const started = performance.now();
	const fromPipeResult = pipeOf(from, options.fromPipe, options.chunkBytes);
	if (!fromPipeResult.ok) return fromPipeResult;
	const toPipeResult = pipeOf(to, options.toPipe, options.chunkBytes);
	if (!toPipeResult.ok) return toPipeResult;
	const fromPipe = fromPipeResult.value;
	const toPipe = toPipeResult.value;
	const listed = await list(from, options.fromRoot, options, context);
	if (!listed.ok) return listed;
	const files = listed.value.filter((entry) => entry.kind === "file");
	const bytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
	if (options.maxBytes !== undefined && bytes > options.maxBytes) {
		return err(
			new WorkspaceError(
				"too_large",
				`the workspace holds ${bytes} bytes of files, the limit is ${options.maxBytes}`,
			),
		);
	}
	const before = await withHashes(from, options.fromRoot, listed.value, options, context);
	if (!before.ok) return before;
	const manifestMs = performance.now() - started;

	const copyStart = performance.now();
	const names = nulList(listed.value.map((entry) => entry.path));
	const moved = await transfer(
		fromPipe.kind === "files"
			? filesSource(from, PACK_FILES_SCRIPT, [options.fromRoot], names, fromPipe.chunkBytes)
			: streamStarter(from, ["sh", "-c", PACK_SCRIPT, "sh", options.fromRoot]),
		names,
		toPipe.kind === "files"
			? filesSink(to, UNPACK_FILES_SCRIPT, [options.toRoot], toPipe.chunkBytes)
			: streamStarter(to, ["sh", "-c", UNPACK_SCRIPT, "sh", options.toRoot]),
		{
			stallMs: options.stallMs ?? DEFAULT_STALL_MS,
			deadlineMs: options.deadlineMs ?? BASE_DEADLINE_MS + (bytes / ASSUMED_FLOOR_BYTES_PER_SECOND) * 1000,
		},
		context,
	);
	if (!moved.ok) return moved;
	const copyMs = performance.now() - copyStart;

	const verifyStart = performance.now();
	// The source again, as it was listed and hashed before: full timestamps and every file's hash, so that a rewrite of
	// the same size within the same second is seen too.
	const afterListed = await list(from, options.fromRoot, options, context);
	if (!afterListed.ok) return afterListed;
	const after = await withHashes(from, options.fromRoot, afterListed.value, options, context);
	if (!after.ok) return after;
	const shaFirst = new Map(before.value.entries.map((entry) => [entry.path, entry.sha256]));
	const shaSecond = new Map(after.value.entries.map((entry) => [entry.path, entry.sha256]));
	const changed = firstDifference(
		before.value.entries,
		after.value.entries,
		["kind", "bytes", "mode", "mtimeExact", "target", "sha256"],
		shaFirst,
		shaSecond,
	);
	if (changed !== undefined)
		return err(new WorkspaceError("changed", `the source changed during the copy: ${changed}`));
	const landed = await manifestOf(to, options.toRoot, { callTimeoutMs: options.callTimeoutMs }, context);
	if (!landed.ok) return landed;
	const shaBefore = new Map(before.value.entries.map((entry) => [entry.path, entry.sha256]));
	const shaLanded = new Map(landed.value.entries.map((entry) => [entry.path, entry.sha256]));
	const different = firstDifference(
		before.value.entries,
		landed.value.entries,
		["kind", "bytes", "sha256", "mode", "target", "mtime"],
		shaBefore,
		shaLanded,
	);
	if (different !== undefined)
		return err(new WorkspaceError("mismatch", `the target is not the source: ${different}`));
	const verifyMs = performance.now() - verifyStart;

	const count = (kind: ManifestEntry["kind"]) => before.value.entries.filter((entry) => entry.kind === kind).length;
	return ok({
		files: count("file"),
		directories: count("directory"),
		symlinks: count("symlink"),
		bytes,
		totalMs: performance.now() - started,
		manifestMs,
		copyMs,
		verifyMs,
		megabytesPerSecond: bytes / MEGABYTE / Math.max(copyMs / 1000, 0.001),
		sourceWaitMs: moved.value.sourceWaitMs,
		targetWaitMs: moved.value.targetWaitMs,
		limit: moved.value.targetWaitMs > moved.value.sourceWaitMs ? "target" : "source",
	});
}

/**
 * Copy one file between boxes through this process and check it by SHA-256 and size against `seal`: on the way out
 * (what the source sent), and on the target. The file appears at `toPath` whole or not at all.
 */
export async function moveFile(
	from: Box,
	fromPath: string,
	to: Box,
	toPath: string,
	seal: { readonly sha256: string; readonly bytes: number },
	options: MoveFileOptions | undefined,
	context: Context,
): Promise<Result<{ ms: number }, WorkspaceError>> {
	const started = performance.now();
	const fromPipeResult = pipeOf(from, options?.fromPipe, options?.chunkBytes);
	if (!fromPipeResult.ok) return fromPipeResult;
	const toPipeResult = pipeOf(to, options?.toPipe, options?.chunkBytes);
	if (!toPipeResult.ok) return toPipeResult;
	const fromPipe = fromPipeResult.value;
	const toPipe = toPipeResult.value;
	// A name of this call's own: another move to the same path never writes, checks or removes this file.
	const partial = `${toPath}.part-${randomUUID()}`;
	const prepared = await run(
		to,
		["sh", "-c", MAKE_PARENT_SCRIPT, "sh", toPath],
		undefined,
		DEFAULT_CALL_TIMEOUT_MS,
		context,
	);
	if (!prepared.ok) return prepared;
	// The cleanup of a call that was cancelled must not be cancelled with it.
	const discard = () =>
		run(
			to,
			["sh", "-c", REMOVE_SCRIPT, "sh", partial],
			undefined,
			DEFAULT_CALL_TIMEOUT_MS,
			withoutAbortSignal(context),
		);
	const moved = await transfer(
		fromPipe.kind === "files"
			? filesSource(from, SPLIT_FILE_SCRIPT, [fromPath], undefined, fromPipe.chunkBytes)
			: streamStarter(from, ["cat", "--", fromPath]),
		undefined,
		toPipe.kind === "files"
			? filesSink(to, JOIN_FILE_SCRIPT, [partial], toPipe.chunkBytes)
			: streamStarter(to, ["sh", "-c", (seal.bytes === 0 ? EMPTY_INPUT : "") + RECEIVE_SCRIPT, "sh", partial]),
		{
			stallMs: options?.stallMs ?? DEFAULT_STALL_MS,
			deadlineMs: options?.deadlineMs ?? BASE_DEADLINE_MS + (seal.bytes / ASSUMED_FLOOR_BYTES_PER_SECOND) * 1000,
		},
		context,
	);
	if (!moved.ok) {
		await discard();
		return moved;
	}
	if (moved.value.bytes !== seal.bytes || moved.value.sha256 !== seal.sha256) {
		await discard();
		return err(
			new WorkspaceError(
				"mismatch",
				`${fromPath} is not the sealed file: it sent ${moved.value.bytes} bytes, the seal names ${seal.bytes}`,
			),
		);
	}
	const hashed = await run(
		to,
		["sh", "-c", HASH_ONE_SCRIPT, "sh", partial],
		undefined,
		DEFAULT_CALL_TIMEOUT_MS + (seal.bytes / HASH_BYTES_PER_SECOND) * 1000,
		context,
	);
	if (!hashed.ok) {
		await discard();
		return hashed;
	}
	const [line, size] = decoder.decode(hashed.value.stdout).split("\n");
	if (
		hashed.value.exitCode !== 0 ||
		line?.slice(0, HEX_DIGITS_SHA256) !== seal.sha256 ||
		Number(size) !== seal.bytes
	) {
		await discard();
		return err(new WorkspaceError("mismatch", `${toPath} on the target is not the sealed file`));
	}
	const placed = await run(
		to,
		["sh", "-c", PLACE_SCRIPT, "sh", partial, toPath],
		undefined,
		DEFAULT_CALL_TIMEOUT_MS,
		context,
	);
	if (!placed.ok) {
		await discard();
		return placed;
	}
	if (placed.value.exitCode !== 0) {
		await discard();
		return err(new WorkspaceError("box_failed", `could not place ${toPath}: ${placed.value.stderr.trim()}`));
	}
	return ok({ ms: performance.now() - started });
}

/**
 * Like `manifestOf`, but a file that is the same as in `previous` as far as a listing can tell (kind, size, mode, link
 * target and time) takes its SHA-256 from there and is not read. A rewrite that keeps size and time is not seen: the
 * next `manifestOf` is the one that reads everything.
 */
export async function manifestSince(
	box: Box,
	root: string,
	previous: Manifest | undefined,
	options: WorkspaceOptions | undefined,
	context: Context,
): Promise<Result<Manifest, WorkspaceError>> {
	return since(box, root, previous, options, context, false);
}

/** @internal `manifestSince` for a checkpoint: named pipes are entries and hard links say so (see `list`). */
export function treeSince(
	box: Box,
	root: string,
	previous: Manifest | undefined,
	options: WorkspaceOptions | undefined,
	context: Context,
): Promise<Result<Manifest, WorkspaceError>> {
	return since(box, root, previous, options, context, true);
}

async function since(
	box: Box,
	root: string,
	previous: Manifest | undefined,
	options: WorkspaceOptions | undefined,
	context: Context,
	tree: boolean,
): Promise<Result<Manifest, WorkspaceError>> {
	const listed = await list(box, root, options, context, undefined, tree);
	if (!listed.ok) return listed;
	const before = new Map((previous?.entries ?? []).map((entry) => [entry.path, entry]));
	const reused = new Map<string, string>();
	const toRead: Listed[] = [];
	for (const entry of listed.value) {
		if (entry.kind !== "file") continue;
		const old = before.get(entry.path);
		if (old?.sha256 !== undefined && sameListed(old, entry)) reused.set(entry.path, old.sha256);
		else toRead.push(entry);
	}
	const hashes = await hashFiles(box, root, toRead, options, context);
	if (!hashes.ok) return hashes;
	const entries: ManifestEntry[] = [];
	for (const entry of listed.value) {
		if (entry.kind !== "file") {
			entries.push(entry);
			continue;
		}
		const sha256 = reused.get(entry.path) ?? hashes.value.get(entry.path);
		if (sha256 === undefined) return err(new WorkspaceError("changed", `${entry.path} vanished while it was hashed`));
		entries.push({ ...entry, sha256 });
	}
	return ok({ entries, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) });
}

/** What `moveChanged` did. */
export type ChangedReceipt = {
	/** Entries copied: new or different from what the target held. */
	readonly changed: number;
	/** Entries removed from the target because the source no longer has them. */
	readonly removed: number;
	/** Bytes of the files copied. */
	readonly bytes: number;
	readonly totalMs: number;
};

/**
 * Bring a directory in `to` from the state `previous` describes to the state `current` describes, copying what is new or
 * different and removing what is gone, then check what was copied against `current`: each copied file's SHA-256, and
 * the kind of each entry. The target must hold `previous`'s tree. A file of the source that changed after `current`
 * was taken is `mismatch` (it names the path); nothing is promised about the target then, and the caller starts the
 * tree again from a copy it trusts. The same transport rules as `moveWorkspace`: each side by its box's `bulk` fact.
 * The target unpacks with its own `tar`, links included: it is a box, never a directory of the host (a checkpoint's
 * vault keeps contents and a record instead, see `CheckpointVault`).
 */
export async function moveChanged(
	from: Box,
	to: Box,
	options: MoveWorkspaceOptions & { readonly previous: Manifest | undefined; readonly current: Manifest },
	context: Context,
): Promise<Result<ChangedReceipt, WorkspaceError>> {
	const started = performance.now();
	const fromPipeResult = pipeOf(from, options.fromPipe, options.chunkBytes);
	if (!fromPipeResult.ok) return fromPipeResult;
	const toPipeResult = pipeOf(to, options.toPipe, options.chunkBytes);
	if (!toPipeResult.ok) return toPipeResult;
	const before = new Map((options.previous?.entries ?? []).map((entry) => [entry.path, entry]));
	const now = new Map(options.current.entries.map((entry) => [entry.path, entry]));
	const changed = changedEntries(options.previous, options.current);
	const removed = [...before.keys()].filter((path) => {
		const entry = now.get(path);
		// A path that changed kind is removed first, so the new entry does not meet the old one.
		return entry === undefined || entry.kind !== before.get(path)?.kind;
	});
	const bytes = changed.reduce((sum, entry) => sum + entry.bytes, 0);
	if (options.maxBytes !== undefined && bytes > options.maxBytes) {
		return err(new WorkspaceError("too_large", `${bytes} bytes of files changed, the limit is ${options.maxBytes}`));
	}
	if (removed.length > 0) {
		const gone = await run(
			to,
			["sh", "-c", 'cd -- "$1" && xargs -0 -r rm -rf --', "sh", options.toRoot],
			nulList(removed),
			options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
			context,
		);
		if (!gone.ok) return gone;
		if (gone.value.exitCode !== 0) {
			return err(new WorkspaceError("box_failed", `could not remove what is gone: ${gone.value.stderr.trim()}`));
		}
	}
	if (changed.length > 0) {
		const names = nulList(changed.map((entry) => entry.path));
		const fromPipe = fromPipeResult.value;
		const toPipe = toPipeResult.value;
		const moved = await transfer(
			fromPipe.kind === "files"
				? filesSource(from, PACK_FILES_SCRIPT, [options.fromRoot], names, fromPipe.chunkBytes)
				: streamStarter(from, ["sh", "-c", PACK_SCRIPT, "sh", options.fromRoot]),
			names,
			toPipe.kind === "files"
				? filesSink(to, UNPACK_FILES_SCRIPT, [options.toRoot], toPipe.chunkBytes)
				: streamStarter(to, ["sh", "-c", UNPACK_SCRIPT, "sh", options.toRoot]),
			{
				stallMs: options.stallMs ?? DEFAULT_STALL_MS,
				deadlineMs: options.deadlineMs ?? BASE_DEADLINE_MS + (bytes / ASSUMED_FLOOR_BYTES_PER_SECOND) * 1000,
			},
			context,
		);
		if (!moved.ok) return moved;
		// What arrived, read in the target and compared with the moment `current` was taken.
		const files = changed.filter((entry) => entry.kind === "file");
		const landed = await hashFiles(to, options.toRoot, files, options, context);
		if (!landed.ok) return landed;
		for (const entry of files) {
			if (landed.value.get(entry.path) !== entry.sha256) {
				return err(new WorkspaceError("mismatch", `${entry.path} is not as it was when the checkpoint was taken`));
			}
		}
	}
	return ok({ changed: changed.length, removed: removed.length, bytes, totalMs: performance.now() - started });
}

/** What `exclude` left out of a workspace. */
export type Excluded = {
	/** The patterns that were applied. */
	readonly patterns: readonly string[];
	/** The top-most entries left out (a directory stands for what is in it), at most 50, sorted. */
	readonly entries: readonly string[];
	/** How many more top-most entries there were than `entries` names. */
	readonly more: number;
	/** Files left out, all of them, and their bytes. */
	readonly files: number;
	readonly bytes: number;
};

const MAX_EXCLUDED_ENTRIES = 50;

/**
 * What the `exclude` patterns leave out of the tree at `root`, without reading any of it. A named pipe is an entry of
 * the tree here, as in a checkpoint.
 */
export async function excludedOf(
	box: Box,
	root: string,
	options: WorkspaceOptions | undefined,
	context: Context,
): Promise<Result<Excluded, WorkspaceError>> {
	const skipped: { path: string; kind: string; bytes: number }[] = [];
	const listed = await list(box, root, options, context, skipped, true);
	if (!listed.ok) return listed;
	const gone = new Set(skipped.map((entry) => entry.path));
	const top = skipped
		.map((entry) => entry.path)
		.filter((path) => !hasExcludedAncestor(path, gone))
		.sort();
	return ok({
		patterns: [...(options?.exclude ?? [])],
		entries: top.slice(0, MAX_EXCLUDED_ENTRIES),
		more: Math.max(0, top.length - MAX_EXCLUDED_ENTRIES),
		files: skipped.filter((entry) => entry.kind === "f").length,
		bytes: skipped.reduce((sum, entry) => sum + entry.bytes, 0),
	});
}

function hasExcludedAncestor(path: string, gone: ReadonlySet<string>): boolean {
	for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
		if (gone.has(path.slice(0, at))) return true;
	}
	return false;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MTIME_TEXT = /^-?[0-9]+(\.[0-9]+)?$/;

/**
 * @internal What is wrong with a checkpoint's tree, or `undefined`: every path is relative, has no empty, `.` or `..`
 * segment, is named once and is inside a directory named before it; a file has a SHA-256 and a size; a hard link names
 * a file before it with the same content; a symlink has a target. The box made the listing, so the host checks it
 * before it keeps it and again before it sends it to another box.
 */
export function treeProblem(manifest: Manifest): string | undefined {
	const seen = new Map<string, ManifestEntry>();
	for (const entry of manifest.entries) {
		const path = entry.path;
		if (typeof path !== "string" || path.includes("\0")) return "an entry has no path";
		const segments = path.split("/");
		if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
			return `${JSON.stringify(path)} is not a path inside the tree`;
		}
		if (seen.has(path)) return `${path} is named twice`;
		const parent = segments.slice(0, -1).join("/");
		if (parent !== "" && seen.get(parent)?.kind !== "directory") return `${path} is not in a directory of the tree`;
		if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) return `${path} has no mode`;
		if (typeof entry.mtime !== "string" || !MTIME_TEXT.test(entry.mtime)) return `${path} has no time`;
		if (entry.kind === "file") {
			if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) return `${path} has no SHA-256`;
			if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return `${path} has no size`;
			if (entry.link !== undefined) {
				const named = seen.get(entry.link);
				if (named?.kind !== "file" || named.link !== undefined || named.sha256 !== entry.sha256) {
					return `${path} is a hard link to ${entry.link}, which is not a file before it with its content`;
				}
			}
		} else if (entry.kind === "symlink") {
			if (typeof entry.target !== "string" || entry.target === "" || entry.target.includes("\0")) {
				return `${path} is a link with no target`;
			}
		} else if (entry.kind !== "directory" && entry.kind !== "fifo") {
			return `${path} is of a kind a checkpoint does not keep`;
		}
		seen.set(path, entry);
	}
	return undefined;
}

// The content of files, one after the other with nothing between, in the order of the NUL-separated names on standard
// input. The host knows each one's size from the listing and cuts the stream there; it is never an archive.
const CONTENT_SCRIPT = 'cd -- "$1" || exit 3; exec xargs -0 -r cat --';
const CONTENT_FILES_SCRIPT = `umask 077; cd -- "$1" || exit 3; mkdir -p -- "$2" || exit 4; echo $$ > "$2/pid"; ( xargs -0 -r cat --; echo $? > "$2/status" ) | split -b "$3" -d -a 6 - "$2/c-"; [ "$(cat "$2/status")" = 0 ] || exit 5; rm -f -- "$2/status"; ${PART_LIST}`;

/** Where a file's content goes on the host: kept whole under its SHA-256, or not at all. */
export type ContentSink = {
	write(bytes: Uint8Array): Promise<void>;
	/**
	 * The content is whole: kept only when it is the SHA-256 and the size it was opened with. An error with the code
	 * `invalid` says it was not; any other is the host's own (a full disk).
	 */
	end(): Promise<Result<void, Error & { readonly code?: string }>>;
	/** Nothing is kept. */
	abort(): Promise<void>;
};

/** One file whose content a pull wants: a path in the box, and the SHA-256 and size the listing gave it. */
export type WantedContent = { readonly path: string; readonly sha256: string; readonly bytes: number };

/**
 * The target of a pull of contents: it looks like a program whose input is the files' bytes end to end. It cuts them
 * at each file's size and gives each to `keep`, which keeps it only when it hashes to what the listing said. More
 * bytes than the files hold, fewer, or other bytes are `mismatch`, naming the file.
 */
function contentSink(
	items: readonly WantedContent[],
	keep: (sha256: string, bytes: number) => Promise<Result<ContentSink, Error>>,
): Starter {
	return async (context, state) => {
		const { exit, settle } = exitOnce();
		context.abortSignal?.addEventListener(
			"abort",
			() => settle(err(new BoxError("aborted", "the call was aborted"))),
			{ once: true },
		);
		let message = "";
		let problem: WorkspaceError | undefined;
		state.problems.push(() => problem);
		let index = 0;
		let left = 0;
		let sink: ContentSink | undefined;
		state.cleanups.push(async () => {
			const open = sink;
			sink = undefined;
			await open?.abort();
		});
		const fail = (error: WorkspaceError): WorkspaceError => {
			problem = error;
			message = error.message;
			settle(ok(1));
			return error;
		};
		const changed = (item: WantedContent | undefined) =>
			fail(
				new WorkspaceError(
					"mismatch",
					item === undefined
						? "the box sent more bytes than the files it listed hold"
						: `${item.path} is not as it was when the checkpoint was taken`,
				),
			);
		const notKept = (item: WantedContent, cause: unknown) =>
			fail(
				new WorkspaceError(
					"transfer_failed",
					`could not keep ${item.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
					cause,
				),
			);
		return ok({
			stdin: {
				write: async (chunk) => {
					if (context.abortSignal?.aborted) throw new BoxError("aborted", "the call was aborted");
					if (problem !== undefined) throw problem;
					let at = 0;
					while (at < chunk.length) {
						const item = items[index];
						if (item === undefined) throw changed(undefined);
						if (sink === undefined) {
							const opened = await keep(item.sha256, item.bytes);
							if (!opened.ok) throw notKept(item, opened.error);
							sink = opened.value;
							left = item.bytes;
						}
						const take = Math.min(left, chunk.length - at);
						// A write the host cannot make (a full disk) ends this side now, with its error: the copy does not
						// wait for a stall to notice.
						try {
							await sink.write(chunk.subarray(at, at + take));
						} catch (cause) {
							throw notKept(item, cause);
						}
						at += take;
						left -= take;
						if (left === 0) {
							const done = await sink.end();
							sink = undefined;
							if (!done.ok) throw done.error.code === "invalid" ? changed(item) : notKept(item, done.error);
							index += 1;
						}
					}
				},
				close: async () => {
					if (problem !== undefined) return;
					if (index < items.length) changed(items[index]);
					else settle(ok(0));
				},
			},
			stdout: NO_BYTES,
			stderr: (async function* () {
				await exit;
				if (message !== "") yield encoder.encode(message);
			})(),
			wait: () => exit,
		});
	};
}

/** @internal How a pull of contents moves bytes and how long it may take. */
export type PullContentsOptions = {
	readonly fromPipe?: Pipe;
	readonly chunkBytes?: number;
	readonly stallMs?: number;
	readonly deadlineMs?: number;
};

/**
 * @internal Bring the content of files out of a box: each to `keep`, under the SHA-256 the listing gave it, checked as
 * it arrives. The box sends bytes only, never names or an archive, and the host makes nothing of them but the content
 * `keep` keeps. Each SHA-256 moves once; a file of no bytes is kept without asking the box.
 */
export async function pullContents(
	from: Box,
	root: string,
	wanted: readonly WantedContent[],
	keep: (sha256: string, bytes: number) => Promise<Result<ContentSink, Error>>,
	options: PullContentsOptions,
	context: Context,
): Promise<Result<{ readonly files: number; readonly bytes: number }, WorkspaceError>> {
	const fromPipe = pipeOf(from, options.fromPipe, options.chunkBytes);
	if (!fromPipe.ok) return fromPipe;
	const once = new Map<string, WantedContent>();
	for (const item of wanted) {
		if (!SHA256_HEX.test(item.sha256)) return err(new WorkspaceError("invalid", `${item.path} has no SHA-256`));
		if (!once.has(item.sha256)) once.set(item.sha256, item);
	}
	const items = [...once.values()];
	for (const item of items.filter((one) => one.bytes === 0)) {
		const opened = await keep(item.sha256, 0);
		if (!opened.ok) {
			return err(new WorkspaceError("transfer_failed", `could not keep ${item.path}: ${opened.error.message}`));
		}
		const done = await opened.value.end();
		if (!done.ok) {
			return err(
				done.error.code === "invalid"
					? new WorkspaceError("mismatch", `${item.path} is not as it was when it was listed`)
					: new WorkspaceError(
							"transfer_failed",
							`could not keep ${item.path}: ${done.error.message}`,
							done.error,
						),
			);
		}
	}
	const sent = items.filter((one) => one.bytes > 0);
	const bytes = sent.reduce((sum, item) => sum + item.bytes, 0);
	if (sent.length > 0) {
		const names = nulList(sent.map((item) => item.path));
		const moved = await transfer(
			fromPipe.value.kind === "files"
				? filesSource(from, CONTENT_FILES_SCRIPT, [root], names, fromPipe.value.chunkBytes)
				: streamStarter(from, ["sh", "-c", CONTENT_SCRIPT, "sh", root]),
			names,
			contentSink(sent, keep),
			{
				stallMs: options.stallMs ?? DEFAULT_STALL_MS,
				deadlineMs: options.deadlineMs ?? BASE_DEADLINE_MS + (bytes / ASSUMED_FLOOR_BYTES_PER_SECOND) * 1000,
			},
			context,
		);
		if (!moved.ok) return moved;
	}
	return ok({ files: items.length, bytes });
}

/** The header of one entry of a checkpoint's tree, as the box's `tar` is to make it. */
function headersOf(entry: ManifestEntry): Uint8Array[] {
	const name = encodePath(entry.kind === "directory" ? `${entry.path}/` : entry.path);
	const mtime = Math.trunc(Number(wholeSeconds(entry.mtime)));
	if (entry.kind === "file" && entry.link !== undefined) {
		return tarHeaders({ name, type: "1", size: 0, mode: entry.mode, mtime, link: encodePath(entry.link) });
	}
	if (entry.kind === "file") return tarHeaders({ name, type: "0", size: entry.bytes, mode: entry.mode, mtime });
	if (entry.kind === "symlink") {
		return tarHeaders({ name, type: "2", size: 0, mode: 0o777, mtime, link: encodePath(entry.target ?? "") });
	}
	return tarHeaders({ name, type: entry.kind === "directory" ? "5" : "6", size: 0, mode: entry.mode, mtime });
}

/**
 * A checkpoint's tree as a tar stream that looks like a program's output: written on the host from the record, with
 * each file's content read through `open`, for the target box's own `tar` to unpack. A content that is missing, or
 * not the size its record says, ends it with exit 1.
 */
function treeArchive(
	entries: readonly ManifestEntry[],
	open: (sha256: string) => AsyncIterable<Uint8Array> | undefined,
): Starter {
	return async (context) => {
		const { exit, settle } = exitOnce();
		let message = "";
		async function* chunks(): AsyncGenerator<Uint8Array> {
			try {
				for (const entry of entries) {
					yield* headersOf(entry);
					if (entry.kind !== "file" || entry.link !== undefined) continue;
					const content = open(entry.sha256 ?? "");
					if (content === undefined) throw new Error(`the vault does not hold the content of ${entry.path}`);
					let sent = 0;
					for await (const chunk of content) {
						sent += chunk.length;
						if (sent > entry.bytes)
							throw new Error(`the content of ${entry.path} is longer than its record says`);
						yield chunk;
					}
					if (sent !== entry.bytes)
						throw new Error(`the content of ${entry.path} is shorter than its record says`);
					yield tarPadding(entry.bytes);
				}
				yield TAR_END;
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
		return ok({
			stdin: { write: async () => {}, close: async () => {} },
			stdout,
			stderr: (async function* () {
				await exit;
				if (message !== "") yield encoder.encode(message);
			})(),
			wait: () => exit,
		});
	};
}

/** @internal Where a checkpoint's tree is restored, and with what limits. */
export type RestoreTreeOptions = WorkspaceOptions & {
	readonly toRoot: string;
	readonly toPipe?: Pipe;
	readonly chunkBytes?: number;
	/** The most bytes of files that may move. More is `too_large`. */
	readonly maxBytes?: number;
	readonly stallMs?: number;
	readonly deadlineMs?: number;
};

/**
 * @internal Make a checkpoint's tree in a box: the host writes a tar stream from the record (directories, files with
 * their content from `open`, links, hard links and named pipes, with their modes and times in whole seconds) and the
 * box's own `tar` unpacks it. Links are made there and nowhere else. The tree is then listed and hashed in the box and
 * must be the record (`mismatch` names the first path that is not). `exclude` is not used: the record already leaves
 * out what was excluded.
 */
export async function restoreTree(
	to: Box,
	manifest: Manifest,
	open: (sha256: string) => AsyncIterable<Uint8Array> | undefined,
	options: RestoreTreeOptions,
	context: Context,
): Promise<Result<{ readonly files: number; readonly bytes: number }, WorkspaceError>> {
	const problem = treeProblem(manifest);
	if (problem !== undefined) return err(new WorkspaceError("invalid", `the checkpoint's tree is not one: ${problem}`));
	const toPipe = pipeOf(to, options.toPipe, options.chunkBytes);
	if (!toPipe.ok) return toPipe;
	const files = manifest.entries.filter((entry) => entry.kind === "file" && entry.link === undefined);
	const bytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
	if (options.maxBytes !== undefined && bytes > options.maxBytes) {
		return err(
			new WorkspaceError(
				"too_large",
				`the checkpoint holds ${bytes} bytes of files, the limit is ${options.maxBytes}`,
			),
		);
	}
	const moved = await transfer(
		treeArchive(manifest.entries, open),
		undefined,
		toPipe.value.kind === "files"
			? filesSink(to, UNPACK_FILES_SCRIPT, [options.toRoot], toPipe.value.chunkBytes)
			: streamStarter(to, ["sh", "-c", UNPACK_SCRIPT, "sh", options.toRoot]),
		{
			stallMs: options.stallMs ?? DEFAULT_STALL_MS,
			deadlineMs: options.deadlineMs ?? BASE_DEADLINE_MS + (bytes / ASSUMED_FLOOR_BYTES_PER_SECOND) * 1000,
		},
		context,
	);
	if (!moved.ok) return moved;
	const listed = await list(to, options.toRoot, { callTimeoutMs: options.callTimeoutMs }, context, undefined, true);
	if (!listed.ok) return listed;
	const landed = await withHashes(to, options.toRoot, listed.value, { callTimeoutMs: options.callTimeoutMs }, context);
	if (!landed.ok) return landed;
	const different = firstDifference(
		manifest.entries,
		landed.value.entries,
		["kind", "bytes", "sha256", "mode", "target", "link", "mtime"],
		new Map(manifest.entries.map((entry) => [entry.path, entry.sha256])),
		new Map(landed.value.entries.map((entry) => [entry.path, entry.sha256])),
	);
	if (different !== undefined)
		return err(new WorkspaceError("mismatch", `the target is not the checkpoint: ${different}`));
	return ok({ files: files.length, bytes });
}
