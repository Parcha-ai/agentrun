import { closeSync, fdatasyncSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { StorageWrite } from "@earendil-works/pi-durable";

/** One commit as a runner ships it: its writes, and the recorder's lines for it once they came. */
export type OutboxEntry = {
	readonly commit: number;
	readonly writes: readonly StorageWrite[];
	readonly lines?: readonly unknown[];
};

/**
 * When the lines of a commit reach the disk. `each`: their own sync, before the recorder's `write` returns. `next`: a
 * synchronous write at once (a process that dies keeps them), synced with the next entry, after a second of quiet, or
 * at `flush()`; a machine that stops loses at most the newest commit's lines, which the next open's snapshot covers.
 */
export type LinesSync = "each" | "next";

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
	/** The entries the host has not acknowledged, after `after` (exclusive), in commit order. */
	pending(after?: number): readonly OutboxEntry[];
	/** The host holds every commit up to `commit`: those entries go. */
	ack(commit: number): void;
	/** Sync whatever was written and not yet synced. */
	flush(): void;
	close(): void;
}

type Line = { commit: number; writes: StorageWrite[] } | { commit: number; lines: unknown[] } | { ack: number };

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

/**
 * Open the outbox at `path`, keeping the entries the host has not acknowledged and that committed. The file is written
 * again with only those, whole, and renamed into place.
 */
export function openOutbox(path: string, options: OutboxOptions): Outbox {
	const linesSync = options.linesSync ?? "each";
	const idleSyncMs = options.idleSyncMs ?? 1_000;
	const entries = new Map<number, { writes: StorageWrite[]; lines?: unknown[] }>();
	for (const line of wholeLines(path)) {
		if ("ack" in line) {
			for (const commit of entries.keys()) if (commit <= line.ack) entries.delete(commit);
		} else if ("writes" in line) {
			entries.set(line.commit, { writes: line.writes });
		} else {
			const entry = entries.get(line.commit);
			if (entry !== undefined) entry.lines = line.lines;
		}
	}
	// Written before a commit that never landed: the store does not have it, and nobody heard of it.
	for (const commit of entries.keys()) if (commit >= options.head) entries.delete(commit);

	const temp = `${path}.tmp`;
	const fresh = openSync(temp, "w");
	try {
		for (const [commit, entry] of [...entries].sort(([left], [right]) => left - right)) {
			writeSync(fresh, `${JSON.stringify({ commit, writes: entry.writes })}\n`);
			if (entry.lines !== undefined) writeSync(fresh, `${JSON.stringify({ commit, lines: entry.lines })}\n`);
		}
		fdatasyncSync(fresh);
	} finally {
		closeSync(fresh);
	}
	renameSync(temp, path);
	syncDirectory(path);

	const file = openSync(path, "a");
	let dirty = false;
	let idle: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const append = (line: Line) => {
		if (closed) throw new Error("the outbox is closed");
		writeSync(file, `${JSON.stringify(line)}\n`);
	};
	const sync = () => {
		clearTimeout(idle);
		idle = undefined;
		fdatasyncSync(file);
		dirty = false;
	};

	return {
		entry(commit, writes) {
			append({ commit, writes: [...writes] });
			// The lines written since the last sync go with this one.
			sync();
			entries.set(commit, { writes: [...writes] });
		},
		lines(commit, lines) {
			append({ commit, lines: [...lines] });
			const entry = entries.get(commit);
			if (entry !== undefined) entry.lines = [...lines];
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
		pending(after = -1) {
			return [...entries]
				.filter(([commit]) => commit > after)
				.sort(([left], [right]) => left - right)
				.map(([commit, entry]) => ({
					commit,
					writes: entry.writes,
					...(entry.lines === undefined ? {} : { lines: entry.lines }),
				}));
		},
		ack(commit) {
			// Not synced: an ack lost with the machine only sends those commits again, and the host has them.
			append({ ack: commit });
			for (const known of entries.keys()) if (known <= commit) entries.delete(known);
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
