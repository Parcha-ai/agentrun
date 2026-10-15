import {
	closeSync,
	constants,
	fdatasyncSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { StorageWrite } from "@earendil-works/pi-durable";

/**
 * One commit as a runner ships it: its writes, and the recorder's lines for it once they came. The host acknowledges
 * each part apart, so either may be gone: a commit with no lines never gets any.
 */
export type OutboxEntry = {
	readonly commit: number;
	readonly writes?: readonly StorageWrite[];
	readonly lines?: readonly unknown[];
};

/**
 * When the lines of a commit reach the disk. `each`: their own sync, before the recorder's `write` returns. `next`: a
 * synchronous write at once (a process that dies keeps them), synced with the next entry, after a second of quiet, or
 * at `flush()`; a machine that stops loses at most the newest commit's lines, which the next open's snapshot covers.
 */
export type LinesSync = "each" | "next";

/** The fewest rows an outbox file holds before acknowledged ones are cleared out while it runs. */
const COMPACT_AT_ROWS = 1_024;

export type OutboxOptions = {
	/** The sequence the store's next commit takes: an entry at or above it never committed and is dropped. */
	readonly head: number;
	readonly linesSync?: LinesSync;
	/** How long `next` waits for quiet before it syncs. Default 1 s. */
	readonly idleSyncMs?: number;
};

/**
 * A runner's commits that the host has not acknowledged, in a file beside the store (`<store>.outbox.jsonl`). An entry
 * is written and synced before its commit, so a commit that landed is in the outbox even when the process died before
 * the host heard of it. Every write is synchronous: a record that has returned is on the disk.
 */
export interface Outbox {
	/** The writes of the commit that takes `commit`, synced before the store commits them. */
	entry(commit: number, writes: readonly StorageWrite[]): void;
	/** The recorder's lines for `commit`, appended to its entry before this returns. */
	lines(commit: number, lines: readonly unknown[]): void;
	/** What the host has not acknowledged, in commit order: writes after `after`, lines after `linesAfter` (exclusive). */
	pending(after?: number, linesAfter?: number): readonly OutboxEntry[];
	/** The host holds the writes of every commit up to `commit`: they go. */
	ack(commit: number): void;
	/** The host holds the lines of every commit up to `commit`: they go. */
	ackLines(commit: number): void;
	/** Sync whatever was written and not yet synced. */
	flush(): void;
	close(): void;
}

type Line =
	| { commit: number; writes: StorageWrite[] }
	| { commit: number; lines: unknown[] }
	| { ack: number }
	| { ackLines: number };

/** The whole lines of a file: a last line without its newline is a write the process did not finish, and is dropped. */
function wholeLines(path: string): Line[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw cause;
	}
	const end = text.lastIndexOf("\n");
	if (end < 0) return [];
	return text
		.slice(0, end)
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Line);
}

function syncDirectory(path: string): void {
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

function pendingOf(
	writes: ReadonlyMap<number, StorageWrite[]>,
	lines: ReadonlyMap<number, unknown[]>,
	after: number,
	linesAfter: number,
): OutboxEntry[] {
	const commits = [...new Set([...writes.keys(), ...lines.keys()])].sort((left, right) => left - right);
	const out: OutboxEntry[] = [];
	for (const commit of commits) {
		const made = commit > after ? writes.get(commit) : undefined;
		const recorded = commit > linesAfter ? lines.get(commit) : undefined;
		if (made === undefined && recorded === undefined) continue;
		out.push({
			commit,
			...(made === undefined ? {} : { writes: made }),
			...(recorded === undefined ? {} : { lines: recorded }),
		});
	}
	return out;
}

/**
 * Open the outbox at `path`, keeping the entries the host has not acknowledged and that committed. The file is written
 * again with only those, whole, and renamed into place.
 */
export function openOutbox(path: string, options: OutboxOptions): Outbox {
	const linesSync = options.linesSync ?? "each";
	const idleSyncMs = options.idleSyncMs ?? 1_000;
	const writes = new Map<number, StorageWrite[]>();
	const lines = new Map<number, unknown[]>();
	const drop = (from: Map<number, unknown>, upTo: number) => {
		for (const commit of from.keys()) if (commit <= upTo) from.delete(commit);
	};
	for (const line of wholeLines(path)) {
		if ("ack" in line) drop(writes, line.ack);
		else if ("ackLines" in line) drop(lines, line.ackLines);
		else if ("writes" in line) writes.set(line.commit, line.writes);
		else lines.set(line.commit, line.lines);
	}
	// Written before a commit that never landed: the store does not have it, and nobody heard of it.
	for (const from of [writes, lines])
		for (const commit of from.keys()) if (commit >= options.head) from.delete(commit);

	/**
	 * The file again with only what is pending, whole, renamed into place, and kept open to append to: there is no moment
	 * when the path holds the new file and the outbox writes to the old one. Before the rename, a failure leaves the old
	 * file as it was, and the temporary file is removed. The caller syncs the directory once it writes to the new file.
	 */
	const rewrite = (): { readonly file: number; readonly rows: number } => {
		const temp = `${path}.tmp`;
		const fresh = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND);
		let rows = 0;
		try {
			for (const entry of pendingOf(writes, lines, -1, -1)) {
				if (entry.writes !== undefined) {
					writeSync(fresh, `${JSON.stringify({ commit: entry.commit, writes: entry.writes })}\n`);
					rows += 1;
				}
				if (entry.lines !== undefined) {
					writeSync(fresh, `${JSON.stringify({ commit: entry.commit, lines: entry.lines })}\n`);
					rows += 1;
				}
			}
			fdatasyncSync(fresh);
			renameSync(temp, path);
		} catch (cause) {
			closeSync(fresh);
			try {
				unlinkSync(temp);
			} catch {
				// Gone already, or it stays: the next rewrite truncates it, and nothing reads it.
			}
			throw cause;
		}
		return { file: fresh, rows };
	};
	const opened = rewrite();
	let file = opened.file;
	// Rows in the file now: acknowledgements add rows and remove none, until the file is written again.
	let rows = opened.rows;
	try {
		syncDirectory(path);
	} catch (cause) {
		closeSync(file);
		throw cause;
	}
	let dirty = false;
	let idle: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	// A rename into place whose directory sync failed: the next sync before a commit makes it again.
	let directoryDirty = false;
	// The rows at which the file is cleared out next: higher after a try that failed.
	let compactAt = COMPACT_AT_ROWS;
	const append = (line: Line) => {
		if (closed) throw new Error("the outbox is closed");
		writeSync(file, `${JSON.stringify(line)}\n`);
		rows += 1;
	};
	const sync = () => {
		clearTimeout(idle);
		idle = undefined;
		fdatasyncSync(file);
		dirty = false;
		if (directoryDirty) {
			syncDirectory(path);
			directoryDirty = false;
		}
	};

	/**
	 * The file follows what is pending, not the session's history: once acknowledged rows far outnumber what is left,
	 * it is written again with only that. It is housekeeping and never fails the acknowledgement that set it off: a
	 * failure leaves the old file whole and in use, and the next try waits until the file has grown as much again.
	 */
	const compact = () => {
		if (rows < compactAt || rows <= 4 * (writes.size + lines.size)) return;
		let fresh: { readonly file: number; readonly rows: number };
		try {
			fresh = rewrite();
		} catch {
			compactAt = rows * 2;
			return;
		}
		const old = file;
		file = fresh.file;
		rows = fresh.rows;
		compactAt = COMPACT_AT_ROWS;
		// Everything pending is in the new file, synced: nothing written to the old one waits for a sync.
		dirty = false;
		clearTimeout(idle);
		idle = undefined;
		try {
			closeSync(old);
		} catch {
			// A file no path names any more: closing it loses nothing.
		}
		try {
			syncDirectory(path);
		} catch {
			directoryDirty = true;
		}
	};

	return {
		entry(commit, made) {
			append({ commit, writes: [...made] });
			// The lines written since the last sync go with this one.
			sync();
			writes.set(commit, [...made]);
		},
		lines(commit, recorded) {
			append({ commit, lines: [...recorded] });
			lines.set(commit, [...recorded]);
			if (linesSync === "each") {
				sync();
				return;
			}
			dirty = true;
			idle ??= setTimeout(() => {
				if (!closed && dirty) sync();
			}, idleSyncMs);
			idle.unref?.();
		},
		pending(after = -1, linesAfter = -1) {
			return pendingOf(writes, lines, after, linesAfter);
		},
		ack(commit) {
			// Not synced: an ack lost with the machine only sends those commits again, and the host has them.
			append({ ack: commit });
			drop(writes, commit);
			compact();
		},
		ackLines(commit) {
			append({ ackLines: commit });
			drop(lines, commit);
			compact();
		},
		flush() {
			if (dirty) sync();
		},
		close() {
			if (closed) return;
			if (dirty) sync();
			closed = true;
			clearTimeout(idle);
			closeSync(file);
		},
	};
}
