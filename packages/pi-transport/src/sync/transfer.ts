// The transfer under `./sync`: a box directory listed, packed and moved as one tar between a box and this machine, as a
// stream or as checked files, under a stall limit and a deadline. It was part of `home/workspace.ts`; the session moves
// that stay there are deprecated and removed in the next release, and this part stays.
import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal } from "@earendil-works/chord/context";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { type Box, BoxError, type BoxProcess } from "../box/box.ts";
import { finish, readStream } from "../box/files.ts";

// Each entry: type, size, mode, time, path, link target, then its link count and device:inode, which name the hard links
// of a checkpoint's tree.
const LIST_SCRIPT =
	"cd -- \"$1\" || exit 3; exec find . -mindepth 1 -printf '%y\\0%s\\0%m\\0%T@\\0%P\\0%l\\0%n\\0%D:%i\\0'";
export const TAR_CREATE = "tar -c -f - --null --no-recursion --numeric-owner -T -";
// For a pull out of a box whose programs may still write: a listed file that is gone by the time it is packed is a
// warning (`--ignore-failed-read`), and so is one that changed while it was read (tar's exit 1). The archive is whole
// either way, and the next listing sees the change. Two names of one inode both go as files (`--hard-dereference`):
// the host refuses a hard link member, so the second name would never arrive.
const TAR_CREATE_TOLERANT = `{ ${TAR_CREATE.replace(" -T -", " --hard-dereference --ignore-failed-read -T -")} || [ $? -eq 1 ]; }`;
/** @internal `PACK_SCRIPT` for a pull: see `TAR_CREATE_TOLERANT`. */
export const PULL_PACK_SCRIPT = `cd -- "$1" || exit 3; ${TAR_CREATE_TOLERANT}`;
/** @internal */
export const UNPACK_SCRIPT = 'mkdir -p -- "$1" && cd -- "$1" || exit 3; exec tar -x -p -f - --no-same-owner';
// What a part is in the box: its name, SHA-256 and size, one line each, from the box's own view of the file.
export const PART_LIST = `for f in "$2"/c-*; do if [ -e "$f" ]; then printf '%s %s %s\\n' "\${f##*/}" "$(sha256sum < "$f" | cut -c1-64)" "$(wc -c < "$f" | tr -d ' ')"; fi; done`;
export const packFilesScript = (create: string) =>
	`umask 077; cd -- "$1" || exit 3; mkdir -p -- "$2" || exit 4; echo $$ > "$2/pid"; ( ${create}; echo $? > "$2/status" ) | split -b "$3" -d -a 6 - "$2/c-"; [ "$(cat "$2/status")" = 0 ] || exit 5; rm -f -- "$2/status"; ${PART_LIST}`;
/** @internal `PACK_FILES_SCRIPT` for a pull: see `TAR_CREATE_TOLERANT`. */
export const PULL_PACK_FILES_SCRIPT = packFilesScript(TAR_CREATE_TOLERANT);
// The parts that arrived are checked against the list the host sent, before anything is unpacked or joined.
export const CHECK_PARTS = `if [ -s "$2/manifest" ]; then ( cd -- "$2" && sha256sum -c --quiet manifest > /dev/null 2>&1 ) || { rm -rf -- "$2"; exit 66; }; fi`;
/** @internal */
export const UNPACK_FILES_SCRIPT = `u=$(umask); umask 077; mkdir -p -- "$2" && echo $$ > "$2/pid" && cat > "$2/manifest" || exit 7; umask "$u"; ${CHECK_PARTS}; mkdir -p -- "$1" && cd -- "$1" || exit 3; { for f in "$2"/c-*; do if [ -e "$f" ]; then cat -- "$f"; fi; done; } | tar -x -p -f - --no-same-owner; s=$?; rm -rf -- "$2"; exit $s`;
// The programs of a move run as a group of their own (they start under `setsid`) and write their id here; stopping the group
// before the parts go ends a program that a cancelled call left running in the box.
const REMOVE_DIR_SCRIPT = 'if [ -s "$1/pid" ]; then kill -s KILL -- "-$(cat "$1/pid")" 2>/dev/null; fi; rm -rf -- "$1"';
// Makes the parts directory, private to the account that runs the move, and says where it is.
const TEMP_DIR_SCRIPT =
	'd="\x24{TMPDIR:-/tmp}"; d="\x24{d%/}/pi-transport-move-$1"; (umask 077; mkdir -p -- "$d") && printf %s "$d"';
/** The exit code of a program of this package that found a part that is not the one that was sent. */
const EXIT_PARTS_DIFFER = 66;
/** The size of the parts the archive is cut into when a host names none. */
const DEFAULT_CHUNK_BYTES = 32 * 1024 * 1024;
const PACK_TIMEOUT_MS = 1_800_000;
const FIELDS_PER_ENTRY = 8;
export const TAIL_BYTES = 2_000;
/** @internal */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** @internal */
export const DEFAULT_STALL_MS = 60_000;
/** @internal */
export const BASE_DEADLINE_MS = 120_000;
/** @internal */
export const ASSUMED_FLOOR_BYTES_PER_SECOND = 2 * 1024 * 1024;

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
	/** `fifo`, a named pipe, is only in a checkpoint's manifest: a move refuses one. */
	readonly kind: "file" | "directory" | "symlink" | "fifo";
	/** The size of a file, 0 for everything else. */
	readonly bytes: number;
	/** SHA-256 of a file's content. Absent for directories and links. */
	readonly sha256?: string;
	/** The permission bits as an integer. */
	readonly mode: number;
	/** The link's target, for a symlink. */
	readonly target?: string;
	/**
	 * For a file that is another name of an earlier file in path order (a hard link): that file's path. Only a
	 * checkpoint's manifest says so.
	 */
	readonly link?: string;
	/** The modification time in seconds with a fraction, as `find` prints it. */
	readonly mtime: string;
};

/** What is in a directory: its entries in path order and the total size of its files. */
export type Manifest = { readonly entries: readonly ManifestEntry[]; readonly bytes: number };

/** How a manifest is made. */
export type WorkspaceOptions = {
	/**
	 * Patterns for what is left out, matched against paths relative to the root. A pattern without `/` matches an
	 * entry of that name at any depth; one with `/` is anchored at the root, and so is one that starts with `/`
	 * (`/learning` is the top-level `learning` only). `*` matches within one path segment, `**` across segments, `?`
	 * one character. An excluded directory excludes everything in it.
	 */
	readonly exclude?: readonly string[];
	/** Deadline of each call to a box. Default 2 minutes. */
	readonly callTimeoutMs?: number;
	/** The most bytes a box's listing may print; past it the listing is stopped, `too_large`. Default `MAX_LISTING_BYTES`. */
	readonly maxListingBytes?: number;
};

/** The most bytes the host reads of a box's listing (its output and its errors) before it stops the box's program: 64 MiB. */
export const MAX_LISTING_BYTES = 64 * 1024 * 1024;

/**
 * How one side of a copy moves bytes. `stream` is the program's own output (source) or input (target). `files` cuts
 * the archive into parts of `chunkBytes` (default 32 MiB) that travel with the box's own `upload` and `download`,
 * which a provider may make much faster than a program's input and output.
 */
export type Pipe = { readonly kind: "stream" } | { readonly kind: "files"; readonly chunkBytes?: number };

const decoder = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
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

/** @internal Whether a path is left out by `WorkspaceOptions.exclude` patterns. */
export function excluder(patterns: readonly string[] | undefined): (path: string) => boolean {
	const compiled = (patterns ?? [])
		.map((pattern) => pattern.replace(/^\.\//, "").replace(/\/+$/, ""))
		.map((pattern) => ({ rooted: pattern.startsWith("/"), body: pattern.replace(/^\/+/, "") }))
		.filter(({ body }) => body !== "")
		.map(({ rooted, body }) => ({ anchored: rooted || body.includes("/"), expression: patternToRegExp(body) }));
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

/** @internal */
export function boxFailure(what: string, error: BoxError): WorkspaceError {
	if (error.code === "aborted") return new WorkspaceError("aborted", `${what}: the call was aborted`, error);
	if (error.code === "timeout") return new WorkspaceError("timeout", `${what}: ${error.message}`, error);
	return new WorkspaceError("box_failed", `${what}: ${error.message}`, error);
}

export type Run = { readonly exitCode: number; readonly stdout: Uint8Array; readonly stderr: string };

const KINDS: Record<string, ManifestEntry["kind"] | undefined> = { f: "file", d: "directory", l: "symlink" };
const REFUSED: Record<string, string> = {
	s: "socket",
	p: "named pipe",
	b: "block device",
	c: "character device",
	D: "door",
};

/** @internal */
export type Listed = Omit<ManifestEntry, "sha256">;

/**
 * Run a program that takes no input and keep at most `maxBytes` of its output and errors together. Past that the
 * program is stopped (its call is cancelled, which a provider ends) and the rest is never read: a box cannot make the
 * host hold more of a listing than it allows.
 */
async function runBounded(
	box: Box,
	command: readonly string[],
	timeoutMs: number,
	maxBytes: number,
	context: Context,
): Promise<Result<Run, WorkspaceError>> {
	const { context: inner, cancel } = withCancel(context);
	const started = await box.exec(command, { timeoutMs }, inner);
	if (!started.ok) return err(boxFailure(`could not start ${command[0] ?? "a program"}`, started.error));
	const program = started.value;
	void program.stdin.close().catch(() => {});
	let held = 0;
	let over = false;
	const keep = async (stream: AsyncIterable<Uint8Array>) => {
		const parts: Uint8Array[] = [];
		for await (const part of stream) {
			held += part.length;
			if (held > maxBytes) {
				over = true;
				cancel();
				break;
			}
			parts.push(part);
		}
		return concat(parts);
	};
	const [stdout, stderr, exit] = await Promise.all([keep(program.stdout), keep(program.stderr), program.wait()]);
	if (over)
		return err(new WorkspaceError("too_large", `${command[0] ?? "a program"} printed more than ${maxBytes} bytes`));
	if (!exit.ok) return err(boxFailure(`${command[0] ?? "a program"} did not finish`, exit.error));
	return ok({ exitCode: exit.value, stdout, stderr: decoder.decode(stderr) });
}

/**
 * @internal The entries under `root` in the box, in path order. A socket, device or pipe fails the listing with
 * `unsupported_entry`, unless `refused` is given: then it is put there (its `find` type letter) and left out. With
 * `tree` (a checkpoint's listing) a named pipe is an entry, and each further name of a file with more than one is a
 * `link` to the first in path order.
 */
export async function list(
	box: Box,
	root: string,
	options: WorkspaceOptions | undefined,
	context: Context,
	skipped?: { path: string; kind: string; bytes: number }[],
	tree = false,
	refused?: { path: string; type: string }[],
): Promise<Result<Listed[], WorkspaceError>> {
	const ran = await runBounded(
		box,
		["sh", "-c", LIST_SCRIPT, "sh", root],
		options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
		options?.maxListingBytes ?? MAX_LISTING_BYTES,
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
	const inodes = new Map<string, string>();
	for (let at = 0; at < fields.length; at += FIELDS_PER_ENTRY) {
		const [type, size, mode, mtime, path, target, links, inode] = fields
			.slice(at, at + FIELDS_PER_ENTRY)
			.map(decodePath) as [string, string, string, string, string, string, string, string];
		if (skip(path)) {
			skipped?.push({ path, kind: type, bytes: type === "f" ? Number(size) : 0 });
			continue;
		}
		const kind = tree && type === "p" ? "fifo" : KINDS[type];
		if (tree && kind === "file" && Number(links) > 1) inodes.set(path, inode);
		if (kind === undefined && refused !== undefined) {
			refused.push({ path, type });
			continue;
		}
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
	if (inodes.size === 0) return ok(entries);
	// The first name of an inode in path order is the file; every later one is a link to it.
	const first = new Map<string, string>();
	return ok(
		entries.map((entry) => {
			const inode = inodes.get(entry.path);
			if (inode === undefined) return entry;
			const named = first.get(inode);
			if (named === undefined) {
				first.set(inode, entry.path);
				return entry;
			}
			return { ...entry, link: named };
		}),
	);
}

export function splitNul(bytes: Uint8Array): Uint8Array[] {
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

/** @internal The paths as `./<path>` names, each ended by a NUL: what `tar -T - --null` reads. */
export function nulList(paths: readonly string[]): Uint8Array {
	const parts = paths.map((path) => encodePath(`./${path}`));
	const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length + 1, 0));
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length + 1;
	}
	return bytes;
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

/** @internal What a copy collects while its two sides start: how to clean up after them, and what they found wrong. */
export type MoveState = {
	readonly cleanups: (() => Promise<void>)[];
	readonly problems: (() => WorkspaceError | undefined)[];
	/** Holds the stall timer off while `work` runs: a phase that moves no byte (packing, joining) is not a stall. */
	working<T>(work: Promise<T>): Promise<T>;
};
/** @internal How one side of a transfer is started: a program in a box, or something that looks like one. */
export type Starter = (context: Context, state: MoveState) => Promise<Result<BoxProcess, BoxError>>;

/** @internal */
export const streamStarter =
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

/** @internal */
export const NO_BYTES: AsyncIterable<Uint8Array> = (async function* () {})();

/** @internal A deferred exit that settles once. */
export function exitOnce(): {
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

/** The box's temporary directory, and in it a directory with a name no other move has. */
async function partsDirectory(box: Box, context: Context): Promise<Result<string, BoxError>> {
	const started = await box.exec(["sh", "-c", TEMP_DIR_SCRIPT, "sh", randomUUID()], { timeoutMs: 120_000 }, context);
	if (!started.ok) return started;
	const finished = await finish(started.value);
	if (!finished.ok) return finished;
	if (finished.value.exitCode !== 0) {
		return err(new BoxError("unknown", `could not make a directory for the parts: ${finished.value.stderr.trim()}`));
	}
	return ok(decoder.decode(finished.value.stdout).trim());
}

/** Remove a parts directory, also when the call that made it was aborted: this is the cleanup, so nothing cancels it. */
function remover(box: Box, dir: string, context: Context): () => Promise<void> {
	return async () => {
		const started = await box.exec(
			["sh", "-c", REMOVE_DIR_SCRIPT, "sh", dir],
			{ timeoutMs: 120_000 },
			withoutAbortSignal(context),
		);
		if (started.ok) await finish(started.value);
	};
}

/**
 * @internal A source that packs into parts in a directory in the box with one program, then reads them one by one with the box's
 * `download` and checks each against the size and SHA-256 the box gave it. The result looks like a process: the parts
 * are its output, and its exit is 0 only when every part arrived as it is in the box.
 */
export function filesSource(
	box: Box,
	script: string,
	args: readonly string[],
	input: Uint8Array | undefined,
	chunkBytes: number,
): Starter {
	return async (context, state) => {
		const made = await partsDirectory(box, context);
		if (!made.ok) return made;
		const dir = made.value;
		state.cleanups.push(remover(box, dir, context));
		const { exit, settle } = exitOnce();
		// A cancelled call (an abort, a stall, a deadline) ends this side too, whatever it was in the middle of.
		context.abortSignal?.addEventListener(
			"abort",
			() => settle(err(new BoxError("aborted", "the call was aborted"))),
			{ once: true },
		);
		let message = "";
		let problem: WorkspaceError | undefined;
		state.problems.push(() => problem);
		const differ = (text: string) => {
			problem = new WorkspaceError("mismatch", text);
			message = text;
			settle(ok(1));
		};
		async function* chunks(): AsyncGenerator<Uint8Array> {
			try {
				const packed = await state.working(
					(async () => {
						const started = await box.exec(
							["setsid", "--wait", "sh", "-c", script, "sh", ...args, dir, String(chunkBytes)],
							{ timeoutMs: PACK_TIMEOUT_MS },
							context,
						);
						return started.ok ? finish(started.value, input) : started;
					})(),
				);
				if (!packed.ok) return void settle(err(packed.error));
				if (packed.value.exitCode !== 0) {
					message = `packing exited ${packed.value.exitCode}: ${packed.value.stderr.trim().slice(-TAIL_BYTES)}`;
					return void settle(ok(packed.value.exitCode));
				}
				const parts = decoder
					.decode(packed.value.stdout)
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => line.split(" ") as [string, string, string]);
				for (const [name, sha256, size] of parts) {
					const got = await box.download([`${dir}/${name}`], context);
					if (!got.ok) {
						if (got.error.code === "not_found") return differ(`part ${name} is missing in the source box`);
						return void settle(err(got.error));
					}
					const bytes = (got.value[0] as { bytes: Uint8Array }).bytes;
					if (bytes.length !== Number(size)) {
						return differ(`part ${name} came back with ${bytes.length} bytes, the box has ${size}`);
					}
					if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
						return differ(`part ${name} came back different from the one in the box`);
					}
					yield bytes;
				}
				settle(ok(0));
			} finally {
				settle(ok(1));
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
 * @internal A target that collects what it is written into parts of `chunkBytes`, sends each with the box's `upload` into a
 * directory in the box, and on close runs one program that checks the parts against the SHA-256 the host made of each
 * and then joins them. The result looks like a process: its exit is the joining program's, or 1 when a part could not be
 * sent.
 */
export function filesSink(box: Box, script: string, args: readonly string[], chunkBytes: number): Starter {
	return async (context, state) => {
		const made = await partsDirectory(box, context);
		if (!made.ok) return made;
		const dir = made.value;
		state.cleanups.push(remover(box, dir, context));
		const { exit, settle } = exitOnce();
		// A cancelled call (an abort, a stall, a deadline) ends this side too, whatever it was in the middle of.
		context.abortSignal?.addEventListener(
			"abort",
			() => settle(err(new BoxError("aborted", "the call was aborted"))),
			{ once: true },
		);
		let message = "";
		let problem: WorkspaceError | undefined;
		state.problems.push(() => problem);
		let index = 0;
		let held: Uint8Array[] = [];
		let size = 0;
		const sums: string[] = [];
		const send = async (bytes: Uint8Array) => {
			const name = `c-${String(index++).padStart(6, "0")}`;
			sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
			const sent = await box.upload([{ path: `${dir}/${name}`, bytes, mode: 0o600 }], context);
			if (sent.ok) return;
			message = `could not send part ${index}: ${sent.error.message}`;
			settle(ok(1));
			throw sent.error;
		};
		return ok({
			stdin: {
				write: async (bytes) => {
					if (context.abortSignal?.aborted) throw new BoxError("aborted", "the call was aborted");
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
						const joined = await state.working(
							(async () => {
								const started = await box.exec(
									["setsid", "--wait", "sh", "-c", script, "sh", ...args, dir],
									{ timeoutMs: PACK_TIMEOUT_MS },
									context,
								);
								return started.ok ? finish(started.value, encoder.encode(sums.join(""))) : started;
							})(),
						);
						if (!joined.ok) return settle(err(joined.error));
						if (joined.value.exitCode === EXIT_PARTS_DIFFER) {
							problem = new WorkspaceError(
								"mismatch",
								"the target box did not receive the parts as they were sent",
							);
							message = problem.message;
						} else if (joined.value.exitCode !== 0) message = joined.value.stderr.trim().slice(-TAIL_BYTES);
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
 * @internal Start a program in each box and relay the first one's output into the second one's input, under a stall limit and
 * an overall deadline. Returns what moved, or why not.
 */
export async function transfer(
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
	// While a phase that moves no byte runs (`working`), the stall clock is suspended, not refreshed: whatever the limit,
	// the phase cannot be cut as a stall. It starts again when the last such phase ends.
	let held = 0;
	const arm = () => {
		clearTimeout(stallTimer);
		if (held === 0) stallTimer = setTimeout(() => stop("stall"), limits.stallMs);
	};
	const state: MoveState = {
		cleanups: [],
		problems: [],
		working: async (work) => {
			held += 1;
			clearTimeout(stallTimer);
			try {
				return await work;
			} finally {
				held -= 1;
				arm();
			}
		},
	};
	const deadlineTimer = setTimeout(() => stop("deadline"), limits.deadlineMs);
	const abort = () => {
		cancel();
		signalStopped();
	};
	context.abortSignal?.addEventListener("abort", abort, { once: true });
	try {
		arm();
		// Starting a side is a phase that moves no byte, like packing: a box that takes longer than the stall limit to
		// answer a call is slow, not stalled, so the hold is taken before the first call and kept until the side is up.
		const reader = await state.working(startSource(inner, state));
		if (!reader.ok) return err(boxFailure("could not start the source program", reader.error));
		const writer = await state.working(startTarget(inner, state));
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
			const wrong = state.problems.map((problem) => problem()).find((problem) => problem !== undefined);
			if (wrong !== undefined) return err(wrong);
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
		const found = state.problems.map((problem) => problem()).find((problem) => problem !== undefined);
		if (found !== undefined) return err(found);
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
		// On success, on failure and on abort alike: no part is left in either box.
		await Promise.allSettled(state.cleanups.map((cleanup) => cleanup()));
	}
}

/** @internal What a side does: the host's override, else what the box says is fastest, else files of the default size. */
export function pipeOf(
	box: Box,
	override: Pipe | undefined,
	chunkBytes: number | undefined,
): Result<{ readonly kind: "stream" } | { readonly kind: "files"; readonly chunkBytes: number }, WorkspaceError> {
	const pipe: Pipe = override ?? (box.facts().bulk === "stream" ? { kind: "stream" } : { kind: "files" });
	if (pipe.kind === "stream") return ok(pipe);
	const size = pipe.chunkBytes ?? chunkBytes ?? DEFAULT_CHUNK_BYTES;
	if (!Number.isSafeInteger(size) || size < 1) {
		return err(new WorkspaceError("invalid", `a part must be a whole number of bytes, 1 or more, not ${size}`));
	}
	return ok({ kind: "files", chunkBytes: size });
}

/** Whether two entries are the same file as far as a listing can tell: kind, size, mode, target and time. */
/**
 * The entries of `current` that a pull has to copy: new ones, and any whose listing (size, mode, link target or time) or
 * content differs from the same path in `previous`. `moveChanged` copies exactly these, so a budget counts them too.
 */
export function changedEntries(previous: Manifest | undefined, current: Manifest): ManifestEntry[] {
	const before = new Map((previous?.entries ?? []).map((entry) => [entry.path, entry]));
	return current.entries.filter((entry) => {
		const old = before.get(entry.path);
		return old === undefined || !sameListed(old, entry) || old.sha256 !== entry.sha256;
	});
}

export function sameListed(a: Listed, b: Listed): boolean {
	return a.kind === b.kind && a.bytes === b.bytes && a.mode === b.mode && a.target === b.target && a.mtime === b.mtime;
}
