import { randomUUID } from "node:crypto";
import { type FileHandle, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal } from "@earendil-works/chord/context";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileKind,
	type FileWatcher,
	LineScanner,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellSpillOptions,
	StreamDecoder,
	type TextLineReader,
	toError,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { type Box, BoxError } from "../box/box.ts";
import { finish } from "../box/files.ts";

const DEFAULT_OP_TIMEOUT_MS = 60_000;
const DEFAULT_STATUS_TIMEOUT_MS = 10_000;
const DEFAULT_WATCH_INTERVAL_MS = 1_000;
/** How long the box has to start a command, when the command's own timeout is shorter. */
const START_TIMEOUT_MS = 30_000;
/** The provider's own deadline lies this far behind ours, so ours reports first and the provider's bounds a leak. */
const CALL_BACKSTOP_MS = 5_000;
const COMMAND_BACKSTOP_MS = 30_000;
const KILL_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 15_000;
/** The longest delay a timer takes. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const SPILL_PIECE_BYTES = 4 * 1024 * 1024;
const DIR_PAGE_ENTRIES = 500;
const STDERR_TAIL_CHARS = 200;
const BARE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const ARGV_FLAG = "PI_TRANSPORT_ARGV";
const STATE_FLAG = "PI_TRANSPORT_STATE";
/** The variable a local box finds its programs by. A command that starts from an empty environment keeps it. */
const BOX_MARKER = "PI_TRANSPORT_BOX";
const EXIT_NO_CWD = 200;
const EXIT_NO_PROGRAM = 201;

/** Exit codes the file scripts report errors with. Every other non-zero exit is `unknown`. */
const FILE_ERROR_CODES: Readonly<Record<number, FileErrorCode>> = {
	3: "not_found",
	4: "is_directory",
	5: "not_directory",
	6: "permission_denied",
	7: "invalid",
};

/**
 * Shell functions every file script starts with. `loops` tells whether the way to a path runs in a circle of
 * symbolic links. `why` sets `w` to the exit code for a path that does not exist: 9 when the way to it loops, 5 when
 * an existing ancestor is not a directory, else 3. `missing` exits with it. `check` passes a path `lstat` would
 * find, `follow` a path `stat` would find. `mkfail` exits the way a recursive `mkdir` of `$1` fails.
 */
const PRELUDE = [
	'loops() { case $(LC_ALL=C realpath -e -- "$1" 2>&1) in *"Too many levels of symbolic links") return 0;; esac; return 1; }',
	'why() { a=$(dirname -- "$1"); if loops "$a"; then w=9; return; fi; while [ "$a" != / ] && [ ! -e "$a" ]; do a=$(dirname -- "$a"); done; if [ -d "$a" ]; then w=3; else w=5; fi; }',
	'missing() { why "$1"; exit "$w"; }',
	'check() { [ -e "$1" ] || [ -L "$1" ] || missing "$1"; }',
	'follow() { [ -e "$1" ] && return; loops "$1" && exit 9; missing "$1"; }',
	'mkfail() { if [ -e "$1" ] || [ -L "$1" ]; then exit 9; fi; why "$1"; [ "$w" = 3 ] && exit 6; exit "$w"; }',
	"",
].join("\n");

const INFO_FORMAT = "'%f\\0%y\\0%s\\0%T@\\0'";
const CANONICAL_SCRIPT = 'follow "$1"; realpath -e -- "$1"';
const READ_SCRIPT = 'follow "$1"; [ -d "$1" ] && exit 4; [ -r "$1" ] || exit 6; cat -- "$1"';
// Lines are read at positions, which a FIFO has none of: it is opened, as a file handle would be, and refused.
const READ_LINES_SCRIPT = `follow "$1"; if [ -p "$1" ]; then : < "$1"; exit 9; fi; ${READ_SCRIPT}`;
// With `$2` set, a symbolic link is refused, and so is a way that loops: pi's local environment reports both alike.
const OPEN_SCRIPT = [
	'if [ "$2" != 1 ]; then follow "$1"; elif [ -L "$1" ]; then exit 7; elif [ ! -e "$1" ]; then why "$1"; [ "$w" = 9 ] && exit 7; exit "$w"; fi',
	'[ -d "$1" ] && exit 4; [ -f "$1" ] || exit 7; [ -r "$1" ] || exit 6',
	`find -L "$1" -maxdepth 0 -printf ${INFO_FORMAT} >&2; cat -- "$1"`,
].join("; ");
const INFO_SCRIPT = `check "$1"; find "$1" -maxdepth 0 -printf ${INFO_FORMAT}`;
const LIST_SCRIPT = `follow "$1"; [ -d "$1" ] || exit 5; [ -r "$1" ] || exit 6; find -H "$1" -mindepth 1 -maxdepth 1 -printf ${INFO_FORMAT}`;
const NAMES_SCRIPT =
	'follow "$1"; [ -d "$1" ] || exit 5; [ -r "$1" ] || exit 6; find -H "$1" -mindepth 1 -maxdepth 1 -printf \'%f\\0\'';
// A directory removed after it was opened has no entries left, as a directory handle would report.
const PAGE_SCRIPT = `cd -- "$1" 2>/dev/null || exit 0; shift; for n in "$@"; do [ -e "./$n" ] || [ -L "./$n" ] || continue; find "./$n" -maxdepth 0 -printf ${INFO_FORMAT}; done`;
const WRITE_HEAD = 'd=$(dirname -- "$1"); mkdir -p -- "$d" 2>/dev/null || mkfail "$d"; [ -d "$1" ] && exit 4';
const WRITE_TAIL = '{ loops "$1" && exit 9; exit 6; }';
const WRITE_SCRIPT = `${WRITE_HEAD}; cat > "$1" || ${WRITE_TAIL}`;
const APPEND_SCRIPT = `${WRITE_HEAD}; cat >> "$1" || ${WRITE_TAIL}`;
const TRUNCATE_SCRIPT = 'follow "$1"; [ -d "$1" ] && exit 4; [ -w "$1" ] || exit 6; truncate -s "$2" -- "$1" || exit 6';
const FLUSH_SCRIPT = 'follow "$1"; [ -d "$1" ] && exit 4; [ -w "$1" ] || exit 6; sync -- "$1" 2>/dev/null || sync';
/**
 * `rename(2)` as the kernel orders its refusals: both directories are walked before the source is looked up, one file
 * under two names is left alone, a directory does not move into itself, nothing replaces one of its own ancestors, and
 * only then do the kinds of the two ends matter. What `mv` still refuses is read from its message.
 */
const RENAME_SCRIPT = [
	'sd=$(dirname -- "$1"); dd=$(dirname -- "$2"); [ -d "$sd" ] || missing "$1"; [ -d "$dd" ] || missing "$2"',
	'[ -e "$1" ] || [ -L "$1" ] || exit 3',
	'[ "$1" = "$2" ] && exit 0',
	'if [ ! -L "$1" ] && [ ! -L "$2" ] && [ "$1" -ef "$2" ]; then exit 0; fi',
	'sdir=0; if [ -d "$1" ] && [ ! -L "$1" ]; then sdir=1; fi',
	'ddir=0; if [ -d "$2" ] && [ ! -L "$2" ]; then ddir=1; fi',
	'if [ $sdir = 1 ]; then case "$(realpath -e -- "$dd")/" in "$(realpath -e -- "$1")"/*) exit 7;; esac; fi',
	'if [ $ddir = 1 ]; then case "$(realpath -e -- "$sd")/" in "$(realpath -e -- "$2")"/*) exit 9;; esac; fi',
	'if [ -e "$2" ] || [ -L "$2" ]; then if [ $sdir = 1 ]; then [ $ddir = 1 ] || exit 5; [ -z "$(find "$2" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ] || exit 9; else [ $ddir = 1 ] && exit 4; fi; fi',
	'm=$(LC_ALL=C mv -fT -- "$1" "$2" 2>&1) && exit 0',
	'case $m in *"Permission denied"|*"Operation not permitted") exit 6;; *"No such file or directory") exit 3;; *"Not a directory") exit 5;; *"Is a directory") exit 4;; *"Invalid argument") exit 7;; esac',
	'printf %s "$m" >&2; exit 9',
].join("; ");
const MKDIR_ALL_SCRIPT = 'mkdir -p -- "$1" 2>/dev/null || mkfail "$1"';
const MKDIR_SCRIPT =
	'd=$(dirname -- "$1"); [ -d "$d" ] || missing "$1"; if [ -e "$1" ] || [ -L "$1" ]; then exit 9; fi; mkdir -- "$1" 2>/dev/null || exit 6';
// `$2` is `recursive`, `$3` is `force`. Node reports a directory removed without `recursive` under a code of its
// own, which pi's environment maps to `unknown`; `force` forgives only a path that is not there.
const REMOVE_SCRIPT = [
	'if [ ! -e "$1" ] && [ ! -L "$1" ]; then why "$1"; if [ "$w" = 3 ] && [ "$3" = 1 ]; then exit 0; fi; exit "$w"; fi',
	'if [ -d "$1" ] && [ ! -L "$1" ] && [ "$2" != 1 ]; then exit 9; fi',
	'rm -rf -- "$1" 2>/dev/null || exit 6',
].join("; ");
const TEMP_ROOT = 't=$TMPDIR; [ -n "$t" ] || t=/tmp';
/**
 * Where a box keeps its commands' group files and tombstones: under its own temporary directory, so a box that is a
 * directory of this machine keeps them to itself and takes them along when it is destroyed. Sets `s`.
 */
const STATE_ROOT = `${TEMP_ROOT}; s=$t/.pi-transport`;
const TEMP_DIR_SCRIPT = `${TEMP_ROOT}; mktemp -d "$t/$1XXXXXX"`;
const TEMP_FILE_SCRIPT = `${TEMP_ROOT}; mktemp --suffix="$2" "$t/$1XXXXXX"`;
const HOME_SCRIPT = 'printf %s "$HOME"';
/**
 * One snapshot of every watch target: four arguments each (path, `1` for recursive, `1` to skip hidden names, the
 * skipped names joined by `/`). Skipped entries are pruned, so a large excluded tree costs nothing.
 */
const SNAPSHOT_SCRIPT = [
	"F='%p\\0%y:%s:%T@:%i\\0'",
	'scan() { p=$1; if [ "$2" = 1 ]; then depth=; else depth="-maxdepth 1"; fi; hidden=$3',
	'[ -e "$p" ] || [ -L "$p" ] || return 0; find -H "$p" -maxdepth 0 -printf "$F"',
	'IFS=/; set -f; set -- $4; set +f; unset IFS; for x in "$@"; do set -- "$@" -o -name "$x"; shift; done',
	'[ "$hidden" = 1 ] && set -- "$@" -o -name \'.*\'',
	'if [ $# -gt 0 ]; then shift; find -H "$p" -mindepth 1 $depth \\( "$@" \\) -prune -o -printf "$F"; else find -H "$p" -mindepth 1 $depth -printf "$F"; fi; }',
	'while [ $# -gt 0 ]; do scan "$1" "$2" "$3" "$4"; shift 4; done',
].join("; ");
/**
 * The first program of a command's own session: it writes its process group down, gives way to a tombstone, then
 * becomes the command. `$1` is the file for the group, `$2` the tombstone, the rest the command.
 */
const LEAD_SCRIPT = 'echo $$ > "$1"; if [ -e "$2" ]; then rm -f "$1" "$2"; exit 130; fi; shift 2; exec "$@"';
/**
 * The first step of a command, in the box's own environment: it finds the state directory there, then gives the
 * wrapper the environment the caller asked for. So a caller that clears or changes `TMPDIR` for its command cannot
 * move the group file away from where a kill looks for it. `$1` is `0` to start from an empty environment; the rest
 * is variables, then the wrapper and its arguments. An empty environment still holds the variable a box marks its
 * programs with, so the box can end them.
 */
const ENTER_SCRIPT = [
	STATE_ROOT,
	"inherit=$1; shift",
	`set -- "${STATE_FLAG}=$s" "$@"`,
	`if [ "$inherit" = 0 ]; then [ -n "$${BOX_MARKER}" ] && set -- "${BOX_MARKER}=$${BOX_MARKER}" "$@"; exec env -i "PATH=${BARE_PATH}" "$@"; fi`,
	'exec env "$@"',
].join("; ");
/**
 * Runs one command as a process group of its own, written down so that a second exec can kill all of it. A kill that
 * comes before the group is written leaves a tombstone, which the command's session looks for after it wrote the
 * group: a late start never runs on. `$1` is the command's id, `$2` its directory, the rest the command.
 *
 * The wrapper stays outside the group and reports how the command ended, 128 plus the signal for one that was
 * killed. The command is exec'd, so an argv never runs a shell builtin of the same name. The wrapper closes its own
 * error output first, so its shell's note about a command a signal ended goes nowhere.
 */
const RUN_SCRIPT = [
	`s=$${STATE_FLAG}; mkdir -p "$s"; f=$s/$1.pid; x=$s/$1.cancel`,
	`cd -- "$2" 2>/dev/null || { printf 'pi-transport:%s:cwd: %s: not found\\n' "$1" "$2" >&2; exit ${EXIT_NO_CWD}; }`,
	"id=$1; shift 2",
	'program() { case $1 in */*) [ -f "$1" ] && [ -x "$1" ]; return;; esac; set -f; IFS=:; for d in $PATH; do [ -n "$d" ] || d=.; if [ -f "$d/$1" ] && [ -x "$d/$1" ]; then set +f; unset IFS; return 0; fi; done; set +f; unset IFS; return 1; }',
	`if [ "$${ARGV_FLAG}" = 0 ]; then if [ -x /bin/bash ]; then set -- /bin/bash -c "$1"; elif program bash; then set -- bash -c "$1"; else set -- sh -c "$1"; fi; fi`,
	`if [ "$${ARGV_FLAG}" = 1 ] && ! program "$1"; then printf 'pi-transport:%s:spawn: %s: not found\\n' "$id" "$1" >&2; exit ${EXIT_NO_PROGRAM}; fi`,
	`unset ${ARGV_FLAG} ${STATE_FLAG}; exec 3>&2 2>/dev/null`,
	`( exec 2>&3 3>&-; exec setsid -w sh -c '${LEAD_SCRIPT}' pi-lead "$f" "$x" "$@" ); c=$?; rm -f "$f"; exit $c`,
].join("; ");
/**
 * Ends a command's process group: asked first, killed after a second. A group that is not written down yet, or whose
 * file exists but is still empty, gets a tombstone, and the file is read once more: either this script sees the
 * group or the command's session sees the tombstone. `$1` is the command's id.
 */
const KILL_SCRIPT = [
	`${STATE_ROOT}; mkdir -p "$s"; f=$s/$1.pid`,
	// dash, the usual /bin/sh, takes `kill -TERM -<group>` but not `kill -TERM -- -<group>`.
	'stop() { g=$(cat "$f" 2>/dev/null); [ -n "$g" ] || return 1; kill -TERM "-$g" 2>/dev/null; i=0; while [ $i -lt 10 ] && kill -0 "-$g" 2>/dev/null; do sleep 0.1; i=$((i+1)); done; kill -KILL "-$g" 2>/dev/null; rm -f "$f"; }',
	'stop && exit 0; touch "$s/$1.cancel"; stop; true',
].join("; ");
const CLEANUP_SCRIPT = `${STATE_ROOT}; for id in "$@"; do f=$s/$id.pid; [ -f "$f" ] && kill -KILL "-$(cat "$f")" 2>/dev/null; rm -f "$f"; done; true`;

/** How `boxEnv` talks to its box. Every field has a default. */
export type BoxEnvOptions = {
	/** Directory the environment starts in. Default: the box's workspace. */
	readonly cwd?: string;
	/** Deadline of one file operation. Default 60 s. */
	readonly opTimeoutMs?: number;
	/** Deadline of a command that has no timeout of its own. Default: none, as in pi's local environment. */
	readonly maxExecMs?: number;
	/** How long a status check may take before the box counts as not answering. Default 10 s. */
	readonly statusTimeoutMs?: number;
	/** How often a watcher compares snapshots. Default 1 s. */
	readonly watchIntervalMs?: number;
	/**
	 * Called once, when the environment finds that its box ended or stopped answering. From then on every call fails
	 * with `reason`. An owner uses it to stop handing this environment out.
	 */
	readonly onLost?: (reason: string) => void;
};

type Finished = { readonly exitCode: number; readonly stdout: Uint8Array; readonly stderr: string };
type Found = {
	readonly name: string;
	readonly kind: FileKind | undefined;
	readonly size: number;
	readonly mtimeMs: number;
};

const encoder = new TextEncoder();

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function isAborted(context: Context): boolean {
	return context.abortSignal?.aborted === true;
}

/**
 * `work`'s result, or a `timeout` error after `timeoutMs` when one is given, or an `aborted` error once the context
 * aborts. Work that is given up on keeps running: its caller cancels it.
 */
function bounded<T>(
	work: Promise<Result<T, BoxError>>,
	timeoutMs: number | undefined,
	context: Context,
): Promise<Result<T, BoxError>> {
	return new Promise((resolve) => {
		const signal = context.abortSignal;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settle = (result: Result<T, BoxError>) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => settle(err(new BoxError("aborted", "the call was aborted")));
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => settle(err(new BoxError("timeout", `no answer in ${timeoutMs} ms`))), timeoutMs);
		}
		work.then(settle, (cause) => settle(err(new BoxError("unknown", toError(cause).message, cause))));
	});
}

/** `find`'s time, seconds with a fraction, as the milliseconds Node's `stat` reports. */
function mtimeMs(seconds: string): number {
	const [whole = "0", fraction = ""] = seconds.split(".");
	return Number(whole) * 1000 + Number(fraction.padEnd(9, "0").slice(0, 9)) / 1e6;
}

/** The records `find -printf` wrote with `INFO_FORMAT`. `kind` is `undefined` for what is no file, directory or link. */
function parseFound(bytes: Uint8Array): Found[] {
	const fields = decode(bytes).split("\0");
	const found: Found[] = [];
	for (let index = 0; index + 3 < fields.length; index += 4) {
		const type = fields[index + 1];
		found.push({
			name: fields[index] ?? "",
			kind: type === "f" ? "file" : type === "d" ? "directory" : type === "l" ? "symlink" : undefined,
			size: Number(fields[index + 2]),
			mtimeMs: mtimeMs(fields[index + 3] ?? "0"),
		});
	}
	return found;
}

function entriesIn(directory: string, found: readonly Found[]): FileInfo[] {
	return found.flatMap((entry) =>
		entry.kind === undefined
			? []
			: [
					{
						name: entry.name,
						path: posix.join(directory, entry.name),
						kind: entry.kind,
						size: entry.size,
						mtimeMs: entry.mtimeMs,
					},
				],
	);
}

/**
 * A command's raw output for its spill file: in memory up to the thresholds, then in a file on this host, so a long
 * and noisy command never holds its whole output in memory. Invariant: a failed write is kept in `error` and is
 * never an unhandled rejection.
 */
class Spill {
	error: Error | undefined;
	readonly #thresholds: ShellSpillOptions;
	readonly #path: string;
	#early: Uint8Array[] = [];
	#bytes = 0;
	#newlines = 0;
	#spilling = false;
	#closed = false;
	#file: FileHandle | undefined;
	#writes: Promise<void> = Promise.resolve();

	constructor(thresholds: ShellSpillOptions, path: string) {
		this.#thresholds = thresholds;
		this.#path = path;
	}

	/** Keep one chunk. Resolves once it is in memory or on disk, so a slow or full disk is felt by the reader. */
	keep(chunk: Uint8Array): Promise<void> {
		if (chunk.length === 0 || this.#closed) return this.#writes;
		if (this.#spilling) return this.#queue(async () => void (await this.#file?.write(chunk)));
		this.#early.push(chunk);
		this.#bytes += chunk.length;
		for (const byte of chunk) if (byte === 0x0a) this.#newlines += 1;
		// Complete or partial lines, counted the way pi's local environment counts them.
		const lines = this.#newlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
		if (this.#bytes <= this.#thresholds.afterBytes && lines <= this.#thresholds.afterLines) return this.#writes;
		this.#spilling = true;
		const early = this.#early;
		this.#early = [];
		return this.#queue(async () => {
			this.#file = await open(this.#path, "w");
			for (const part of early) await this.#file.write(part);
		});
	}

	/** The host file with everything kept, closed, or `undefined` when the output stayed within the thresholds. */
	async close(): Promise<string | undefined> {
		this.#closed = true;
		await this.#writes;
		const file = this.#file;
		this.#file = undefined;
		await file?.close().catch((cause) => {
			this.error ??= toError(cause);
		});
		return this.#spilling && this.error === undefined ? this.#path : undefined;
	}

	/** Close and remove the host file. */
	async discard(): Promise<void> {
		await this.close();
		await rm(this.#path, { force: true }).catch(() => {});
	}

	#queue(write: () => Promise<void>): Promise<void> {
		this.#writes = this.#writes
			.then(() => (this.error === undefined ? write() : undefined))
			.catch((cause) => {
				this.error ??= toError(cause);
			});
		return this.#writes;
	}
}

/**
 * pi's `ExecutionEnv` over one box: every file operation and every command is one bounded `Box.exec` of a fixed
 * script whose paths are arguments, never spliced into the script.
 *
 * Invariants: every call to the box has a deadline. A box that ended or stopped answering is marked lost, and from
 * then on every call fails at once with the same reason and the box is not asked again. A command runs as its own
 * process group, which a timeout or an abort kills with a second exec.
 */
class BoxEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly #box: Box;
	readonly #opTimeoutMs: number;
	readonly #maxExecMs: number | undefined;
	readonly #statusTimeoutMs: number;
	readonly #watchIntervalMs: number;
	readonly #onLost: ((reason: string) => void) | undefined;
	readonly #running = new Set<string>();
	readonly #watchers = new Set<FileWatcher>();
	#lost: string | undefined;
	#home: string | undefined;

	constructor(box: Box, options: BoxEnvOptions) {
		const facts = box.facts();
		this.id = `pi-transport:${facts.provider}:${box.id}`;
		this.cwd = options.cwd ?? facts.workspace;
		this.#box = box;
		this.#opTimeoutMs = options.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
		this.#maxExecMs = options.maxExecMs;
		this.#statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
		this.#watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
		this.#onLost = options.onLost;
	}

	async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#resolve(path, context);
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(posix.join(...parts));
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#file(path, CANONICAL_SCRIPT, [], undefined, context, ({ stdout }) =>
			decode(stdout).replace(/\n$/, ""),
		);
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.#file(path, READ_SCRIPT, [], undefined, context, ({ stdout }) => stdout);
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const read = await this.readBinaryFile(path, context);
		// A byte-order mark stays in the text, as it does when Node reads a file as UTF-8.
		return read.ok ? ok(new TextDecoder("utf-8", { ignoreBOM: true }).decode(read.value)) : read;
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const read = await this.#file(path, READ_LINES_SCRIPT, [], undefined, context, ({ stdout }) => stdout);
		if (!read.ok) return read;
		const lines = decode(read.value).split("\n");
		if (lines.at(-1) === "") lines.pop();
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const read = await this.#file(path, READ_LINES_SCRIPT, [], undefined, context, ({ stdout }) => stdout);
		// A directory opens and fails on its first read, as a file handle on one does.
		if (!read.ok && read.error.code !== "is_directory") return read;
		const text = read.ok ? decode(read.value) : "";
		let at = 0;
		let closed = false;
		return ok({
			readLine: async (lineContext: Context) => {
				if (isAborted(lineContext)) return err(new FileError("aborted", "aborted", path));
				if (closed) return err(new FileError("invalid", "the text line reader is closed", path));
				if (!read.ok) return err(read.error);
				if (at >= text.length) return ok(undefined);
				const newline = text.indexOf("\n", at);
				const end = newline === -1 ? text.length : newline;
				const line = { text: text.slice(at, end), terminated: newline !== -1 };
				at = end + 1;
				return ok(line);
			},
			close: async () => {
				closed = true;
			},
		});
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		// The file as it is now, whole: a rename or a rewrite of the path does not change what the reader sees.
		const opened = await this.#file(
			path,
			OPEN_SCRIPT,
			[options?.noFollow === true ? "1" : "0"],
			undefined,
			context,
			({ stdout, stderr }, resolved) => ({ bytes: stdout, found: parseFound(encoder.encode(stderr))[0], resolved }),
		);
		if (!opened.ok) return opened;
		const { bytes, found, resolved } = opened.value;
		const info: FileInfo = {
			name: posix.basename(resolved),
			path: resolved,
			kind: "file",
			size: bytes.length,
			mtimeMs: found?.mtimeMs ?? 0,
		};
		let closed = false;
		const refused = (readContext: Context): Result<never, FileError> | undefined => {
			if (isAborted(readContext)) return err(new FileError("aborted", "aborted", resolved));
			return closed ? err(new FileError("invalid", "the binary reader is closed", resolved)) : undefined;
		};
		const whole = (value: number) => Number.isSafeInteger(value) && value >= 0;
		return ok({
			info: async (readContext: Context) => refused(readContext) ?? ok(info),
			read: async (offset: number, length: number, readContext: Context) => {
				const stop = refused(readContext);
				if (stop !== undefined) return stop;
				if (!whole(offset) || !whole(length)) {
					return err(new FileError("invalid", "offset and length must be non-negative safe integers", resolved));
				}
				return ok(bytes.slice(offset, offset + length));
			},
			scanLines: async (range: { startLine: number; endLine?: number }, readContext: Context) => {
				const stop = refused(readContext);
				if (stop !== undefined) return stop;
				let scanner: LineScanner;
				try {
					scanner = new LineScanner(range.startLine, range.endLine);
				} catch {
					return err(new FileError("invalid", "invalid line range", resolved));
				}
				scanner.push(bytes);
				return ok(scanner.finish());
			},
			close: async () => {
				closed = true;
			},
		});
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const read = await this.#file(path, INFO_SCRIPT, [], undefined, context, ({ stdout }, resolved) => ({
			found: parseFound(stdout)[0],
			resolved,
		}));
		if (!read.ok) return read;
		const { found, resolved } = read.value;
		if (found?.kind === undefined) {
			return err(new FileError("invalid", `unsupported file type: ${resolved}`, resolved));
		}
		return ok({
			name: posix.basename(resolved),
			path: resolved,
			kind: found.kind,
			size: found.size,
			mtimeMs: found.mtimeMs,
		});
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const info = await this.fileInfo(path, context);
		if (info.ok) return ok(true);
		return info.error.code === "not_found" ? ok(false) : err(info.error);
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#file(path, LIST_SCRIPT, [], undefined, context, ({ stdout }, resolved) =>
			entriesIn(resolved, parseFound(stdout)),
		);
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		// The names now. Each page reads its entries' metadata when asked, so an entry removed meanwhile is skipped.
		const opened = await this.#file(path, NAMES_SCRIPT, [], undefined, context, ({ stdout }, resolved) => ({
			names: decode(stdout)
				.split("\0")
				.filter((name) => name !== ""),
			resolved,
		}));
		if (!opened.ok) return opened;
		const { names: left, resolved: directory } = opened.value;
		let done = false;
		let closed = false;
		return ok({
			next: async (maxEntries: number, pageContext: Context) => {
				if (isAborted(pageContext)) return err(new FileError("aborted", "aborted", directory));
				if (closed) return err(new FileError("invalid", "the directory reader is closed", directory));
				if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
					return err(new FileError("invalid", "maxEntries must be a positive safe integer", directory));
				}
				const entries: FileInfo[] = [];
				// The end is reported by the read that finds nothing left, as a directory handle reports it.
				while (!done && entries.length < maxEntries) {
					const page = left.splice(0, Math.min(maxEntries - entries.length, DIR_PAGE_ENTRIES));
					if (page.length === 0) {
						done = true;
						break;
					}
					const args = [directory, ...page];
					const found = await this.#script(directory, PAGE_SCRIPT, args, undefined, pageContext, ({ stdout }) =>
						entriesIn(directory, parseFound(stdout)),
					);
					if (!found.ok) return found;
					entries.push(...found.value);
				}
				return ok({ entries, done });
			},
			close: async () => {
				closed = true;
			},
		});
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const bytes = typeof content === "string" ? encoder.encode(content) : content;
		return this.#file(path, WRITE_SCRIPT, [], bytes, context, () => undefined);
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const bytes = typeof content === "string" ? encoder.encode(content) : content;
		return this.#file(path, APPEND_SCRIPT, [], bytes, context, () => undefined);
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		if (isAborted(context)) return err(new FileError("aborted", "aborted", path));
		if (!Number.isSafeInteger(size) || size < 0) {
			return err(new FileError("invalid", "file size must be a non-negative safe integer", path));
		}
		return this.#file(path, TRUNCATE_SCRIPT, [String(size)], undefined, context, () => undefined);
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, FLUSH_SCRIPT, [], undefined, context, () => undefined);
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const destination = await this.#resolve(destinationPath, context);
		if (!destination.ok) return destination;
		return this.#file(sourcePath, RENAME_SCRIPT, [destination.value], undefined, context, () => undefined);
	}

	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const script = (options?.recursive ?? true) ? MKDIR_ALL_SCRIPT : MKDIR_SCRIPT;
		return this.#file(path, script, [], undefined, context, () => undefined);
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const flags = [options?.recursive === true ? "1" : "0", options?.force === true ? "1" : "0"];
		return this.#file(path, REMOVE_SCRIPT, flags, undefined, context, () => undefined);
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.#script("/tmp", TEMP_DIR_SCRIPT, [prefix ?? "tmp-"], undefined, context, ({ stdout }) =>
			decode(stdout).trim(),
		);
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const args = [options?.prefix ?? "", options?.suffix ?? ""];
		return this.#script("/tmp", TEMP_FILE_SCRIPT, args, undefined, context, ({ stdout }) => decode(stdout).trim());
	}

	/** Polling snapshots of the targets: a box reports no file events. */
	async watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		const first = targets[0]?.path ?? "";
		const args: string[] = [];
		for (const target of targets) {
			const resolved = await this.#resolve(target.path, context);
			if (!resolved.ok) return resolved;
			args.push(
				resolved.value,
				target.recursive === true ? "1" : "0",
				target.exclude?.hidden === true ? "1" : "0",
				(target.exclude?.names ?? []).join("/"),
			);
		}
		const snapshot = (snapshotContext: Context) =>
			this.#script(first, SNAPSHOT_SCRIPT, args, undefined, snapshotContext, ({ stdout }) => {
				const fields = decode(stdout).split("\0");
				const seen = new Map<string, string>();
				for (let index = 0; index + 1 < fields.length; index += 2) {
					seen.set(fields[index] ?? "", fields[index + 1] ?? "");
				}
				return seen;
			});
		const started = await snapshot(context);
		if (!started.ok) return started;
		// The watcher outlives the call that opened it, so only its own `close` stops its snapshots.
		const polling = withCancel(withoutAbortSignal(context));
		let last = started.value;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let busy: Promise<void> = Promise.resolve();
		const tick = async (): Promise<void> => {
			const now = await snapshot(polling.context);
			if (stopped) return;
			if (!now.ok) {
				stopped = true;
				onChange({ error: now.error });
				return;
			}
			const paths: string[] = [];
			for (const [path, signature] of now.value) if (last.get(path) !== signature) paths.push(path);
			for (const path of last.keys()) if (!now.value.has(path)) paths.push(path);
			last = now.value;
			schedule();
			if (paths.length > 0) onChange({ paths });
		};
		// The next snapshot is taken a whole interval after the last one ended, so a slow box is never asked twice at once.
		const schedule = () => {
			timer = setTimeout(() => {
				busy = tick().catch(() => {});
			}, this.#watchIntervalMs);
		};
		const watcher: FileWatcher = {
			mode: "polling",
			close: async () => {
				stopped = true;
				clearTimeout(timer);
				polling.cancel();
				await busy;
				this.#watchers.delete(watcher);
			},
		};
		this.#watchers.add(watcher);
		schedule();
		return ok(watcher);
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		if (isAborted(context)) return err(new ExecutionError("aborted", "aborted"));
		const timeout = options?.timeout;
		if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
			return err(new ExecutionError("timeout", "invalid timeout: must be a finite number of seconds"));
		}
		if (timeout !== undefined && timeout * 1000 > MAX_TIMEOUT_MS) {
			return err(new ExecutionError("timeout", `invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`));
		}
		const timeoutMs = timeout === undefined ? this.#maxExecMs : timeout * 1000;
		if (typeof command !== "string" && command.length === 0) {
			return err(new ExecutionError("spawn_error", "empty argv: no program to run"));
		}
		if (this.#lost !== undefined) return err(new ExecutionError("unknown", this.#goneMessage()));
		const directory = await this.#resolve(options?.cwd ?? this.cwd, context);
		if (!directory.ok) return err(new ExecutionError("spawn_error", directory.error.message));

		const id = randomUUID();
		const full = [
			...["sh", "-c", ENTER_SCRIPT, "pi-enter", options?.inheritEnv === false ? "0" : "1"],
			...Object.entries(options?.env ?? {}).map(([name, value]) => `${name}=${value}`),
			`${ARGV_FLAG}=${typeof command === "string" ? 0 : 1}`,
			...["sh", "-c", RUN_SCRIPT, "pi-exec", id, directory.value],
			...(typeof command === "string" ? [command] : command),
		];
		// Best effort, and short: it is on the way out of a call.
		const kill = async (): Promise<void> => {
			await this.#call(["sh", "-c", KILL_SCRIPT, "sh", id], undefined, KILL_TIMEOUT_MS, withoutAbortSignal(context));
		};
		const spill =
			options?.spill === undefined
				? undefined
				: new Spill(options.spill, join(tmpdir(), `pi-transport-spill-${id}.log`));
		// The complete output goes to the box in pieces at the end, through a file there.
		const sendSpill = async (): Promise<Result<string | undefined, ExecutionError>> => {
			const failed = (cause: Error) =>
				err<string | undefined, ExecutionError>(
					new ExecutionError("unknown", `failed to preserve complete shell output: ${cause.message}`, cause),
				);
			const local = await spill?.close();
			if (spill?.error !== undefined) return failed(spill.error);
			if (local === undefined) return ok(undefined);
			const sending = withoutAbortSignal(context);
			const remote = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, sending);
			if (!remote.ok) return failed(remote.error);
			const piece = new Uint8Array(SPILL_PIECE_BYTES);
			let file: FileHandle | undefined;
			try {
				file = await open(local, "r");
				for (let at = 0; ; ) {
					const { bytesRead } = await file.read(piece, 0, piece.length, at);
					if (bytesRead === 0) return ok(remote.value);
					const appended = await this.appendFile(remote.value, piece.subarray(0, bytesRead), sending);
					if (!appended.ok) return failed(appended.error);
					at += bytesRead;
				}
			} catch (cause) {
				return failed(toError(cause));
			} finally {
				await file?.close().catch(() => {});
			}
		};

		let settled = false;
		let failure: ExecutionError | undefined;
		let stop: () => void = () => {};
		const stopped = new Promise<Result<number, BoxError>>((resolve) => {
			stop = () => resolve(err(new BoxError("unknown", "the command was stopped")));
		});
		const fail = (error: ExecutionError) => {
			failure ??= error;
			stop();
		};
		// No output reaches the caller after the call settled, for example from a descendant that holds a stream open.
		const emit = (text: string, stream: "stdout" | "stderr") => {
			if (settled || failure !== undefined || text === "" || options?.onOutput === undefined) return;
			try {
				options.onOutput(text, context, { stream });
			} catch (cause) {
				fail(new ExecutionError("callback_error", toError(cause).message, toError(cause)));
			}
		};
		// The wrapper's own error line starts with this, and nothing follows it. Error output is held back while it
		// may still be that line, so the line never reaches the caller, however the box cuts its chunks.
		const marker = `pi-transport:${id}:`;
		let held = "";
		let holding = true;
		const pump = async (bytes: AsyncIterable<Uint8Array>, stream: "stdout" | "stderr"): Promise<void> => {
			const decoder = new StreamDecoder();
			const pass = (text: string) => {
				if (stream === "stdout" || !holding) return emit(text, stream);
				held += text;
				if (held.length < marker.length ? marker.startsWith(held) : held.startsWith(marker)) return;
				holding = false;
				emit(held, stream);
			};
			for await (const chunk of bytes) {
				if (spill !== undefined) {
					await spill.keep(chunk);
					if (spill.error !== undefined) {
						const cause = spill.error;
						fail(
							new ExecutionError("unknown", `failed to preserve complete shell output: ${cause.message}`, cause),
						);
					}
				}
				pass(decoder.decode(chunk));
			}
			pass(decoder.decode());
		};

		this.#running.add(id);
		const call = withCancel(context);
		// A command with no deadline has none in the box either: the box's own lifetime bounds it.
		const backstop =
			timeoutMs === undefined ? undefined : { timeoutMs: Math.min(timeoutMs + COMMAND_BACKSTOP_MS, MAX_TIMEOUT_MS) };
		const launch = this.#box.exec(full, backstop, call.context);
		try {
			// The start itself always has a deadline, so a box that stops answering is found out.
			const startMs =
				timeoutMs === undefined
					? this.#opTimeoutMs
					: Math.max(timeoutMs, Math.min(this.#opTimeoutMs, START_TIMEOUT_MS));
			const started = await bounded(launch, startMs, context);
			if (!started.ok) {
				// Given up before the box answered: a launch that lands later is stopped and read to its end, and the
				// tombstone keeps its command from running.
				void launch
					.then((late) => (late.ok ? Promise.all([kill(), finish(late.value)]) : undefined))
					.catch(() => {});
				if (started.error.code === "aborted") {
					await kill();
					return err(new ExecutionError("aborted", "aborted"));
				}
				await this.#diagnose(started.error, context);
				if (this.#lost !== undefined) return err(new ExecutionError("unknown", this.#goneMessage()));
				if (started.error.code === "timeout") {
					await kill();
					return err(new ExecutionError("timeout", `the box ${this.#box.id} did not start the command in time`));
				}
				return err(
					new ExecutionError(
						"spawn_error",
						`the box ${this.#box.id} did not run the command: ${started.error.message}`,
					),
				);
			}
			const process = started.value;
			// The command gets no input. Its output is read from the moment it starts, and a close that never returns
			// holds nothing up.
			void process.stdin.close().catch(() => {});
			const run = (async (): Promise<Result<number, BoxError>> => {
				const [exit] = await Promise.all([
					process.wait(),
					pump(process.stdout, "stdout"),
					pump(process.stderr, "stderr"),
				]);
				return exit;
			})();
			const exit = await bounded(Promise.race([run, stopped]), timeoutMs, context);
			if (failure !== undefined) {
				await kill();
				return err(failure);
			}
			if (!exit.ok) {
				const interrupted = exit.error.code === "aborted" || exit.error.code === "timeout";
				if (!interrupted) {
					// The command had started, so this is never a spawn error: a caller may retry those.
					await this.#diagnose(exit.error, context);
					const message =
						this.#lost === undefined
							? `the box ${this.#box.id} lost the command: ${exit.error.message}`
							: this.#goneMessage();
					return err(new ExecutionError("unknown", message));
				}
				await kill();
				const error =
					exit.error.code === "aborted"
						? new ExecutionError("aborted", "aborted")
						: new ExecutionError("timeout", `timeout:${(timeoutMs ?? 0) / 1000}`);
				const sent = await sendSpill();
				if (sent.ok && sent.value !== undefined) error.spillPath = sent.value;
				return err(error);
			}
			if (holding && held.startsWith(marker) && (exit.value === EXIT_NO_CWD || exit.value === EXIT_NO_PROGRAM)) {
				return err(new ExecutionError("spawn_error", held.slice(marker.length).trim()));
			}
			if (holding) emit(held, "stderr");
			const sent = await sendSpill();
			if (!sent.ok) return sent;
			return ok({ exitCode: exit.value, ...(sent.value === undefined ? {} : { spillPath: sent.value }) });
		} finally {
			settled = true;
			call.cancel();
			this.#running.delete(id);
			await spill?.discard();
		}
	}

	async cleanup(context: Context): Promise<void> {
		for (const watcher of [...this.#watchers]) await watcher.close(context);
		if (this.#lost !== undefined || this.#running.size === 0) return;
		const command = ["sh", "-c", CLEANUP_SCRIPT, "sh", ...this.#running];
		await this.#call(command, undefined, CLEANUP_TIMEOUT_MS, withoutAbortSignal(context));
	}

	#goneMessage(): string {
		return `the box ${this.#box.id} is gone (${this.#lost}); no tool can run there any more`;
	}

	/** A call failed or ran out of time: find out whether the box itself is gone, and remember it if so. */
	async #diagnose(cause: BoxError, context: Context): Promise<void> {
		if (this.#lost !== undefined) return;
		const status = await bounded(
			this.#box.status(withoutAbortSignal(context)),
			this.#statusTimeoutMs,
			withoutAbortSignal(context),
		);
		let reason: string | undefined;
		if (!status.ok) {
			reason =
				status.error.code === "timeout"
					? `it did not answer a status check in ${this.#statusTimeoutMs} ms`
					: `it cannot be reached: ${status.error.message}`;
		} else if (status.value.state === "ended") {
			const { exitCode } = status.value;
			reason = exitCode === null ? "it ended" : `it ended with exit code ${exitCode}`;
		} else if (cause.code === "gone") {
			reason = cause.message;
		}
		// Two calls may have asked at once: the first answer stands, and the owner hears it once.
		if (reason === undefined || this.#lost !== undefined) return;
		this.#lost = reason;
		try {
			this.#onLost?.(reason);
		} catch {
			// The owner's own failure does not change what this call reports.
		}
	}

	/**
	 * Run `command` in the box with `input`, within `timeoutMs` and the context. The error is `aborted`, `gone` once
	 * the box is lost, `timeout` for a slow call on a live box, or what the box said when it refused the call.
	 */
	async #call(
		command: readonly string[],
		input: Uint8Array | undefined,
		timeoutMs: number,
		context: Context,
	): Promise<Result<Finished, BoxError>> {
		if (isAborted(context)) return err(new BoxError("aborted", "the call was aborted"));
		if (this.#lost !== undefined) return err(new BoxError("gone", this.#goneMessage()));
		const call = withCancel(context);
		const run = async (): Promise<Result<Finished, BoxError>> => {
			const started = await this.#box.exec(command, { timeoutMs: timeoutMs + CALL_BACKSTOP_MS }, call.context);
			return started.ok ? finish(started.value, input) : started;
		};
		try {
			const finished = await bounded(run(), timeoutMs, context);
			if (finished.ok || finished.error.code === "aborted") return finished;
			await this.#diagnose(finished.error, context);
			if (this.#lost !== undefined) return err(new BoxError("gone", this.#goneMessage()));
			if (finished.error.code === "timeout") return finished;
			const message = `the box ${this.#box.id} did not run the call: ${finished.error.message}`;
			return err(new BoxError(finished.error.code, message, finished.error));
		} finally {
			call.cancel();
		}
	}

	/** One script with `args`, its outcome as a `FileError` about `path`. The script's exit code names the error. */
	async #script<T>(
		path: string,
		script: string,
		args: readonly string[],
		input: Uint8Array | undefined,
		context: Context,
		read: (finished: Finished) => T,
	): Promise<Result<T, FileError>> {
		const command = ["sh", "-c", PRELUDE + script, "sh", ...args];
		const finished = await this.#call(command, input, this.#opTimeoutMs, context);
		if (!finished.ok) {
			const { code, message } = finished.error;
			if (code === "aborted") return err(new FileError("aborted", "aborted", path));
			const slow = `the box ${this.#box.id} did not finish the file operation in ${this.#opTimeoutMs} ms: ${path}`;
			return err(new FileError("unknown", code === "timeout" ? slow : message, path, finished.error));
		}
		if (finished.value.exitCode === 0) return ok(read(finished.value));
		const code = FILE_ERROR_CODES[finished.value.exitCode] ?? "unknown";
		const detail = finished.value.stderr.trim().slice(-STDERR_TAIL_CHARS);
		return err(new FileError(code, `${code.replace("_", " ")}: ${path}${detail === "" ? "" : ` (${detail})`}`, path));
	}

	/** A file operation on `path`: the script gets the resolved path as `$1`, then `args`. `read` gets it too. */
	async #file<T>(
		path: string,
		script: string,
		args: readonly string[],
		input: Uint8Array | undefined,
		context: Context,
		read: (finished: Finished, resolved: string) => T,
	): Promise<Result<T, FileError>> {
		const resolved = await this.#resolve(path, context);
		if (!resolved.ok) return resolved;
		const target = resolved.value;
		return this.#script(target, script, [target, ...args], input, context, (finished) => read(finished, target));
	}

	/**
	 * `path` as an absolute path in the box. `~` is the box's home directory, asked for once; a `file:` URL is its
	 * path.
	 */
	async #resolve(path: string, context: Context): Promise<Result<string, FileError>> {
		let normalized = path;
		if (path === "~" || path.startsWith("~/")) {
			if (this.#home === undefined) {
				const home = await this.#script(path, HOME_SCRIPT, [], undefined, context, ({ stdout }) => decode(stdout));
				if (!home.ok) return home;
				this.#home = home.value === "" ? "/" : home.value;
			}
			normalized = posix.join(this.#home, path.slice(1));
		} else if (path.startsWith("file://")) {
			try {
				normalized = fileURLToPath(path, { windows: false });
			} catch {
				// A malformed URL stays an ordinary path, so the file methods keep returning their failures.
			}
		}
		return ok(posix.resolve(this.cwd, normalized));
	}
}

/**
 * pi's `ExecutionEnv` over a box: a session's tools run there while the session, its store and its model calls stay
 * with the host. Its id is `pi-transport:<provider>:<box id>`, one file namespace per box. A box that ended or
 * stopped answering is a tool error on every later call, never a hang.
 */
export function boxEnv(box: Box, options: BoxEnvOptions = {}): ExecutionEnv {
	return new BoxEnv(box, options);
}
