import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Box, BoxError, BoxProcess } from "../box/box.ts";
import { finish, readStream } from "../box/files.ts";

const LIST_SCRIPT = "cd -- \"$1\" || exit 3; exec find . -mindepth 1 -printf '%y\\0%s\\0%m\\0%T@\\0%P\\0%l\\0'";
const HASH_SCRIPT = 'cd -- "$1" || exit 3; exec xargs -0 -r sha256sum -z --';
const PACK_SCRIPT = 'cd -- "$1" || exit 3; exec tar -c -f - --null --no-recursion --numeric-owner -T -';
const UNPACK_SCRIPT = 'mkdir -p -- "$1" && cd -- "$1" || exit 3; exec tar -x -p -f - --no-same-owner';
const PACK_FILES_SCRIPT =
	'cd -- "$1" || exit 3; mkdir -p -- "$2" || exit 4; ( tar -c -f - --null --no-recursion --numeric-owner -T -; echo $? > "$2/status" ) | split -b "$3" -d -a 6 - "$2/c-"; [ "$(cat "$2/status")" = 0 ] || exit 5; rm -f -- "$2/status"; ls -1 -- "$2" | grep "^c-"; true';
const UNPACK_FILES_SCRIPT =
	'mkdir -p -- "$1" && cd -- "$1" || exit 3; { for f in "$2"/c-*; do if [ -e "$f" ]; then cat -- "$f"; fi; done; } | tar -x -p -f - --no-same-owner; s=$?; rm -rf -- "$2"; exit $s';
const SPLIT_FILE_SCRIPT =
	'mkdir -p -- "$2" || exit 4; split -b "$3" -d -a 6 -- "$1" "$2/c-" || exit 5; ls -1 -- "$2" | grep "^c-"; true';
const JOIN_FILE_SCRIPT =
	': > "$1" || exit 3; for f in "$2"/c-*; do if [ -e "$f" ]; then cat -- "$f" >> "$1" || exit 6; fi; done; rm -rf -- "$2"';
const REMOVE_DIR_SCRIPT = 'rm -rf -- "$1"';
const STREAM: Pipe = { kind: "stream" };
const PACK_TIMEOUT_MS = 1_800_000;
const MAKE_PARENT_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")"';
const RECEIVE_SCRIPT = 'cat > "$1"';
const HASH_ONE_SCRIPT = 'sha256sum -- "$1" && wc -c < "$1"';
const PLACE_SCRIPT = 'mv -f -- "$1" "$2"';
const REMOVE_SCRIPT = 'rm -f -- "$1"';
const FIELDS_PER_ENTRY = 6;
const HEX_DIGITS_SHA256 = 64;
const TAIL_BYTES = 2_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_STALL_MS = 60_000;
const BASE_DEADLINE_MS = 120_000;
const ASSUMED_FLOOR_BYTES_PER_SECOND = 2 * 1024 * 1024;
const HASH_BYTES_PER_SECOND = 20 * 1024 * 1024;
const MEGABYTE = 1024 * 1024;

/**
 * Why a workspace call failed. `too_large` is decided from the listing before a byte moves, `unsupported_entry` names
 * a socket, device or pipe, `changed` says the source changed during the copy, `mismatch` that the target is not the
 * source, `transfer_failed` that a program of the copy exited with an error, `box_failed` that a box call failed.
 */
export type WorkspaceErrorCode =
	| "aborted"
	| "timeout"
	| "too_large"
	| "unsupported_entry"
	| "changed"
	| "mismatch"
	| "transfer_failed"
	| "box_failed"
	| "not_found"
	| "invalid";

/** An expected failure of a workspace call. Returned, never thrown. */
export class WorkspaceError extends Error {
	public code: WorkspaceErrorCode;

	constructor(code: WorkspaceErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "WorkspaceError";
		this.code = code;
	}
}

/**
 * One entry of a workspace. Paths are relative to the root and carry non-UTF-8 bytes as the code points U+DC80 to
 * U+DCFF, one per byte, so that every name survives a round trip.
 */
export type ManifestEntry = {
	readonly path: string;
	readonly kind: "file" | "directory" | "symlink";
	/** The size of a file, 0 for everything else. */
	readonly bytes: number;
	/** SHA-256 of a file's content. Absent for directories and links. */
	readonly sha256?: string;
	/** The permission bits as an integer. */
	readonly mode: number;
	/** The link's target, for a symlink. */
	readonly target?: string;
	/** The modification time in seconds with a fraction, as `find` prints it. */
	readonly mtime: string;
};

/** What is in a directory: its entries in path order and the total size of its files. */
export type Manifest = { readonly entries: readonly ManifestEntry[]; readonly bytes: number };

/** How a manifest is made. */
export type WorkspaceOptions = {
	/**
	 * Patterns for what is left out, matched against paths relative to the root. A pattern without `/` matches an
	 * entry of that name at any depth; one with `/` is anchored at the root. `*` matches within one path segment, `**`
	 * across segments, `?` one character. An excluded directory excludes everything in it.
	 */
	readonly exclude?: readonly string[];
	/** Deadline of each call to a box. Default 2 minutes. */
	readonly callTimeoutMs?: number;
};

/**
 * How one side of a copy moves bytes. `stream` is the program's own output (source) or input (target). `files` cuts
 * the archive into files of `chunkBytes` that travel with the box's own `upload` and `download`, which a provider may
 * make much faster than a program's input and output.
 */
export type Pipe = { readonly kind: "stream" } | { readonly kind: "files"; readonly chunkBytes: number };

/** How a single file is moved. */
export type MoveFileOptions = { readonly fromPipe?: Pipe; readonly toPipe?: Pipe };

/** How a directory is moved. */
export type MoveWorkspaceOptions = WorkspaceOptions & {
	/** How the source side and the target side move bytes. Default `stream` on both. */
	readonly fromPipe?: Pipe;
	readonly toPipe?: Pipe;
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

const decoder = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** A path's bytes as a string, with each byte that is not part of a UTF-8 character kept as U+DC00 plus the byte. */
export function decodePath(bytes: Uint8Array): string {
	let out = "";
	let at = 0;
	while (at < bytes.length) {
		const lead = bytes[at] as number;
		if (lead < 0x80) {
			out += String.fromCharCode(lead);
			at += 1;
			continue;
		}
		const length =
			lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
		let character: string | undefined;
		if (length > 0 && at + length <= bytes.length) {
			try {
				character = strict.decode(bytes.subarray(at, at + length));
			} catch {
				character = undefined;
			}
		}
		if (character === undefined) {
			out += String.fromCharCode(0xdc00 + lead);
			at += 1;
		} else {
			out += character;
			at += length;
		}
	}
	return out;
}

/** The bytes of a path string made by `decodePath`. */
export function encodePath(path: string): Uint8Array {
	const bytes: number[] = [];
	for (const character of path) {
		const code = character.codePointAt(0) as number;
		if (code >= 0xdc80 && code <= 0xdcff) bytes.push(code - 0xdc00);
		else bytes.push(...encoder.encode(character));
	}
	return Uint8Array.from(bytes);
}

function patternToRegExp(pattern: string): RegExp {
	let source = "";
	for (let at = 0; at < pattern.length; at++) {
		const character = pattern.charAt(at);
		if (character === "*" && pattern.charAt(at + 1) === "*") {
			source += ".*";
			at += 1;
		} else if (character === "*") source += "[^/]*";
		else if (character === "?") source += "[^/]";
		else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "s");
}

function excluder(patterns: readonly string[] | undefined): (path: string) => boolean {
	const compiled = (patterns ?? [])
		.map((pattern) => pattern.replace(/^\.\//, "").replace(/\/+$/, ""))
		.filter((pattern) => pattern !== "")
		.map((pattern) => ({ anchored: pattern.includes("/"), expression: patternToRegExp(pattern) }));
	return (path) => {
		const segments = path.split("/");
		for (let end = 1; end <= segments.length; end++) {
			const prefix = segments.slice(0, end).join("/");
			const name = segments[end - 1] as string;
			for (const { anchored, expression } of compiled) {
				if (expression.test(anchored ? prefix : name)) return true;
			}
		}
		return false;
	};
}

function boxFailure(what: string, error: BoxError): WorkspaceError {
	if (error.code === "aborted") return new WorkspaceError("aborted", `${what}: the call was aborted`, error);
	if (error.code === "timeout") return new WorkspaceError("timeout", `${what}: ${error.message}`, error);
	return new WorkspaceError("box_failed", `${what}: ${error.message}`, error);
}

type Run = { readonly exitCode: number; readonly stdout: Uint8Array; readonly stderr: string };

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

const KINDS: Record<string, ManifestEntry["kind"] | undefined> = { f: "file", d: "directory", l: "symlink" };
const REFUSED: Record<string, string> = {
	s: "socket",
	p: "named pipe",
	b: "block device",
	c: "character device",
	D: "door",
};

type Listed = Omit<ManifestEntry, "sha256">;

async function list(
	box: Box,
	root: string,
	options: WorkspaceOptions | undefined,
	context: Context,
): Promise<Result<Listed[], WorkspaceError>> {
	const ran = await run(
		box,
		["sh", "-c", LIST_SCRIPT, "sh", root],
		undefined,
		options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
		context,
	);
	if (!ran.ok) return ran;
	if (ran.value.exitCode === 3) return err(new WorkspaceError("not_found", `${root} is not a directory in the box`));
	if (ran.value.exitCode !== 0) {
		return err(
			new WorkspaceError("box_failed", `could not list ${root}: ${ran.value.stderr.trim().slice(-TAIL_BYTES)}`),
		);
	}
	const fields = splitNul(ran.value.stdout);
	if (fields.length % FIELDS_PER_ENTRY !== 0)
		return err(new WorkspaceError("invalid", `the listing of ${root} is cut short`));
	const skip = excluder(options?.exclude);
	const entries: Listed[] = [];
	for (let at = 0; at < fields.length; at += FIELDS_PER_ENTRY) {
		const [type, size, mode, mtime, path, target] = fields.slice(at, at + FIELDS_PER_ENTRY).map(decodePath) as [
			string,
			string,
			string,
			string,
			string,
			string,
		];
		if (skip(path)) continue;
		const kind = KINDS[type];
		if (kind === undefined) {
			return err(
				new WorkspaceError(
					"unsupported_entry",
					`${path} is a ${REFUSED[type] ?? `file of type ${type}`}: only files, directories and links move`,
				),
			);
		}
		entries.push({
			path,
			kind,
			bytes: kind === "file" ? Number(size) : 0,
			mode: Number.parseInt(mode, 8),
			mtime,
			...(kind === "symlink" ? { target } : {}),
		});
	}
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return ok(entries);
}

function splitNul(bytes: Uint8Array): Uint8Array[] {
	const parts: Uint8Array[] = [];
	let from = 0;
	for (let at = 0; at < bytes.length; at++) {
		if (bytes[at] === 0) {
			parts.push(bytes.subarray(from, at));
			from = at + 1;
		}
	}
	return parts;
}

function nulList(paths: readonly string[]): Uint8Array {
	const parts = paths.map((path) => encodePath(`./${path}`));
	const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length + 1, 0));
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length + 1;
	}
	return bytes;
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

type Field = "kind" | "bytes" | "sha256" | "mode" | "target" | "mtime";

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
				if (a.kind === "file" && Math.floor(Number(a.mtime)) !== Math.floor(Number(b.mtime)))
					return `${path} has another modification time`;
			} else if (a[field] !== b[field]) return `${path} has another ${field}`;
		}
	}
	return undefined;
}

type Tail = { text(): string };

/** Collect the end of a stream without holding all of it. */
function tail(stream: AsyncIterable<Uint8Array>): Tail {
	let kept = new Uint8Array(0);
	void (async () => {
		try {
			for await (const chunk of stream) {
				const all = new Uint8Array(kept.length + chunk.length);
				all.set(kept);
				all.set(chunk, kept.length);
				kept = all.subarray(Math.max(0, all.length - TAIL_BYTES));
			}
		} catch {
			// A stream that fails ends the tail; the exit of the program says what happened.
		}
	})();
	return { text: () => decoder.decode(kept).trim() };
}

/** The next value of an iterator, or `undefined` once the signal says stop. */
function raceStop<T>(
	next: Promise<IteratorResult<T>>,
	stopped: Promise<"stopped">,
): Promise<IteratorResult<T> | "stopped"> {
	return Promise.race([next, stopped]);
}

type Piped = { readonly sourceWaitMs: number; readonly targetWaitMs: number };

/**
 * Relay one process's output into another's input, a chunk at a time: a write is awaited before the next read, so a
 * slow target slows the source and nothing but one chunk is held. Ends when the source ends or `stopped` resolves.
 */
async function relay(
	source: AsyncIterable<Uint8Array>,
	target: BoxProcess["stdin"],
	touch: (chunk: Uint8Array) => void,
	stopped: Promise<"stopped">,
): Promise<Piped | "stopped" | "target_closed"> {
	const iterator = source[Symbol.asyncIterator]();
	let sourceWaitMs = 0;
	let targetWaitMs = 0;
	for (;;) {
		const readStart = performance.now();
		const next = await raceStop(iterator.next(), stopped);
		sourceWaitMs += performance.now() - readStart;
		if (next === "stopped") {
			void Promise.resolve(iterator.return?.()).catch(() => {});
			return "stopped";
		}
		if (next.done) break;
		const writeStart = performance.now();
		const wrote = await Promise.race([
			target.write(next.value).then(
				() => "wrote" as const,
				() => "closed" as const,
			),
			stopped,
		]);
		targetWaitMs += performance.now() - writeStart;
		if (wrote === "stopped") return "stopped";
		if (wrote === "closed") {
			void Promise.resolve(iterator.return?.()).catch(() => {});
			return "target_closed";
		}
		touch(next.value);
	}
	return { sourceWaitMs, targetWaitMs };
}

type Starter = (context: Context) => Promise<Result<BoxProcess, BoxError>>;

const streamStarter =
	(box: Box, command: readonly string[]): Starter =>
	(context) =>
		box.exec(command, undefined, context);

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes;
}

const NO_BYTES: AsyncIterable<Uint8Array> = (async function* () {})();

/** A deferred exit that settles once. */
function exitOnce(): {
	readonly exit: Promise<Result<number, BoxError>>;
	settle(result: Result<number, BoxError>): void;
} {
	let resolve: (value: Result<number, BoxError>) => void = () => {};
	const exit = new Promise<Result<number, BoxError>>((done) => {
		resolve = done;
	});
	let settled = false;
	return {
		exit,
		settle: (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		},
	};
}

/**
 * A source that packs into files in the box with one program and then reads them one by one with the box's `download`.
 * The result looks like a process: the chunks are its output, and its exit is 0 only when every chunk arrived.
 */
function filesSource(
	box: Box,
	script: string,
	args: readonly string[],
	input: Uint8Array | undefined,
	chunkBytes: number,
): Starter {
	return async (context) => {
		const dir = `/tmp/pi-transport-move-${randomUUID()}`;
		const { exit, settle } = exitOnce();
		let message = "";
		async function* chunks(): AsyncGenerator<Uint8Array> {
			try {
				const started = await box.exec(
					["sh", "-c", script, "sh", ...args, dir, String(chunkBytes)],
					{ timeoutMs: PACK_TIMEOUT_MS },
					context,
				);
				if (!started.ok) return void settle(err(started.error));
				const packed = await finish(started.value, input);
				if (!packed.ok) return void settle(err(packed.error));
				if (packed.value.exitCode !== 0) {
					message = `packing exited ${packed.value.exitCode}: ${packed.value.stderr.trim().slice(-TAIL_BYTES)}`;
					return void settle(ok(packed.value.exitCode));
				}
				const names = decoder
					.decode(packed.value.stdout)
					.split("\n")
					.filter((name) => name !== "");
				for (const name of names) {
					const got = await box.download([`${dir}/${name}`], context);
					if (!got.ok) return void settle(err(got.error));
					yield (got.value[0] as { bytes: Uint8Array }).bytes;
				}
				settle(ok(0));
			} finally {
				settle(ok(1));
				await box.exec(["sh", "-c", REMOVE_DIR_SCRIPT, "sh", dir], { timeoutMs: 120_000 }, context).then(
					(started) => (started.ok ? finish(started.value) : undefined),
					() => undefined,
				);
			}
		}
		return ok({
			stdin: { write: async () => {}, close: async () => {} },
			stdout: chunks(),
			stderr: (async function* () {
				await exit;
				if (message !== "") yield encoder.encode(message);
			})(),
			wait: () => exit,
		});
	};
}

/**
 * A target that collects what it is written into files of `chunkBytes`, sends each with the box's `upload` into a
 * temporary directory, and on close runs one program that joins them. The result looks like a process: its exit is the
 * joining program's, or 1 when a part could not be sent.
 */
function filesSink(box: Box, script: string, args: readonly string[], chunkBytes: number): Starter {
	return async (context) => {
		const dir = `/tmp/pi-transport-move-${randomUUID()}`;
		const { exit, settle } = exitOnce();
		let message = "";
		let index = 0;
		let held: Uint8Array[] = [];
		let size = 0;
		const send = async (bytes: Uint8Array) => {
			const sent = await box.upload([{ path: `${dir}/c-${String(index++).padStart(6, "0")}`, bytes }], context);
			if (sent.ok) return;
			message = `could not send part ${index}: ${sent.error.message}`;
			settle(ok(1));
			throw sent.error;
		};
		return ok({
			stdin: {
				write: async (bytes) => {
					held.push(bytes);
					size += bytes.length;
					if (size < chunkBytes) return;
					const all = concat(held);
					let at = 0;
					for (; all.length - at >= chunkBytes; at += chunkBytes) await send(all.subarray(at, at + chunkBytes));
					held = at < all.length ? [all.subarray(at)] : [];
					size = all.length - at;
				},
				close: async () => {
					try {
						if (size > 0) await send(concat(held));
						held = [];
						size = 0;
						const started = await box.exec(
							["sh", "-c", script, "sh", ...args, dir],
							{ timeoutMs: PACK_TIMEOUT_MS },
							context,
						);
						if (!started.ok) return settle(err(started.error));
						const joined = await finish(started.value);
						if (!joined.ok) return settle(err(joined.error));
						if (joined.value.exitCode !== 0) message = joined.value.stderr.trim().slice(-TAIL_BYTES);
						settle(ok(joined.value.exitCode));
					} catch {
						settle(ok(1));
					}
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

type Transfer = Piped & { readonly sha256: string; readonly bytes: number };

/**
 * Start a program in each box and relay the first one's output into the second one's input, under a stall limit and
 * an overall deadline. Returns what moved, or why not.
 */
async function transfer(
	startSource: Starter,
	fromInput: Uint8Array | undefined,
	startTarget: Starter,
	limits: { stallMs: number; deadlineMs: number },
	context: Context,
): Promise<Result<Transfer, WorkspaceError>> {
	const { context: inner, cancel } = withCancel(context);
	let reason: "stall" | "deadline" | undefined;
	let stallTimer: NodeJS.Timeout | undefined;
	let signalStopped: () => void = () => {};
	const stopped = new Promise<"stopped">((resolve) => {
		signalStopped = () => resolve("stopped");
	});
	const stop = (why: "stall" | "deadline") => {
		reason = why;
		cancel();
		signalStopped();
	};
	const arm = () => {
		clearTimeout(stallTimer);
		stallTimer = setTimeout(() => stop("stall"), limits.stallMs);
	};
	const deadlineTimer = setTimeout(() => stop("deadline"), limits.deadlineMs);
	const abort = () => {
		cancel();
		signalStopped();
	};
	context.abortSignal?.addEventListener("abort", abort, { once: true });
	try {
		arm();
		const reader = await startSource(inner);
		if (!reader.ok) return err(boxFailure("could not start the source program", reader.error));
		const writer = await startTarget(inner);
		if (!writer.ok) {
			cancel();
			return err(boxFailure("could not start the target program", writer.error));
		}
		const readerErrors = tail(reader.value.stderr);
		const writerErrors = tail(writer.value.stderr);
		void readStream(writer.value.stdout).catch(() => {});
		const feed = (async () => {
			if (fromInput !== undefined) await reader.value.stdin.write(fromInput);
			await reader.value.stdin.close();
		})().catch(() => {});
		const hash = createHash("sha256");
		let bytes = 0;
		const moved = await relay(
			reader.value.stdout,
			writer.value.stdin,
			(chunk) => {
				hash.update(chunk);
				bytes += chunk.length;
				arm();
			},
			stopped,
		);
		if (moved === "target_closed") {
			// The target ended before it had everything: its exit says why. The source is of no use any more.
			const writeExit = await writer.value.wait();
			cancel();
			await reader.value.wait();
			if (reason === "stall")
				return err(new WorkspaceError("timeout", `no byte moved for ${limits.stallMs} ms, after ${bytes} bytes`));
			if (!writeExit.ok) return err(boxFailure("the target program failed", writeExit.error));
			return err(
				new WorkspaceError(
					"transfer_failed",
					`the target program exited ${writeExit.value} before the copy ended: ${writerErrors.text()}`,
				),
			);
		}
		if (moved !== "stopped") await writer.value.stdin.close().catch(() => {});
		await Promise.race([feed, stopped]);
		const [readExit, writeExit] = await Promise.all([reader.value.wait(), writer.value.wait()]);
		if (reason === "stall")
			return err(new WorkspaceError("timeout", `no byte moved for ${limits.stallMs} ms, after ${bytes} bytes`));
		if (reason === "deadline")
			return err(
				new WorkspaceError("timeout", `the copy did not end in ${limits.deadlineMs} ms, after ${bytes} bytes`),
			);
		if (moved === "stopped" || context.abortSignal?.aborted)
			return err(new WorkspaceError("aborted", "the call was aborted"));
		if (!readExit.ok) return err(boxFailure("the source program failed", readExit.error));
		if (!writeExit.ok) return err(boxFailure("the target program failed", writeExit.error));
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (readExit.value !== 0) {
			return err(
				new WorkspaceError(
					"transfer_failed",
					`the source program exited ${readExit.value}: ${readerErrors.text()}`,
				),
			);
		}
		if (writeExit.value !== 0) {
			return err(
				new WorkspaceError(
					"transfer_failed",
					`the target program exited ${writeExit.value}: ${writerErrors.text()}`,
				),
			);
		}
		return ok({ ...moved, sha256: hash.digest("hex"), bytes });
	} finally {
		clearTimeout(stallTimer);
		clearTimeout(deadlineTimer);
		context.abortSignal?.removeEventListener("abort", abort);
	}
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
	const fromPipe = options.fromPipe ?? STREAM;
	const toPipe = options.toPipe ?? STREAM;
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
	const after = await list(from, options.fromRoot, options, context);
	if (!after.ok) return after;
	const none = new Map<string, string | undefined>();
	const changed = firstDifference(listed.value, after.value, ["kind", "bytes", "mode", "mtime", "target"], none, none);
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
	const partial = `${toPath}.part`;
	const prepared = await run(
		to,
		["sh", "-c", MAKE_PARENT_SCRIPT, "sh", toPath],
		undefined,
		DEFAULT_CALL_TIMEOUT_MS,
		context,
	);
	if (!prepared.ok) return prepared;
	const discard = () =>
		run(to, ["sh", "-c", REMOVE_SCRIPT, "sh", partial], undefined, DEFAULT_CALL_TIMEOUT_MS, context);
	const fromPipe = options?.fromPipe ?? STREAM;
	const toPipe = options?.toPipe ?? STREAM;
	const moved = await transfer(
		fromPipe.kind === "files"
			? filesSource(from, SPLIT_FILE_SCRIPT, [fromPath], undefined, fromPipe.chunkBytes)
			: streamStarter(from, ["cat", "--", fromPath]),
		undefined,
		toPipe.kind === "files"
			? filesSink(to, JOIN_FILE_SCRIPT, [partial], toPipe.chunkBytes)
			: streamStarter(to, ["sh", "-c", RECEIVE_SCRIPT, "sh", partial]),
		{
			stallMs: DEFAULT_STALL_MS,
			deadlineMs: BASE_DEADLINE_MS + (seal.bytes / ASSUMED_FLOOR_BYTES_PER_SECOND) * 1000,
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
	if (!placed.ok) return placed;
	if (placed.value.exitCode !== 0) {
		await discard();
		return err(new WorkspaceError("box_failed", `could not place ${toPath}: ${placed.value.stderr.trim()}`));
	}
	return ok({ ms: performance.now() - started });
}
