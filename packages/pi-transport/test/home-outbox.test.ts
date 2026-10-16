import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	fdatasyncSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOutbox } from "../src/home/outbox.ts";

// Every sync the outbox makes, counted: what a power cut would lose is what was not synced. A rename can be made to fail.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		fdatasyncSync: vi.fn(actual.fdatasyncSync),
		fsyncSync: vi.fn(actual.fsyncSync),
		openSync: vi.fn(actual.openSync),
		renameSync: vi.fn(actual.renameSync),
	};
});

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function place(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-outbox-"));
	directories.push(directory);
	return join(directory, "run.sqlite.outbox.jsonl");
}
const writes = (n: number): StorageWrite[] => [{ type: "submission", value: { id: String(n) } as never }];

describe("a runner's outbox", () => {
	// 3,000 commits, the host's acknowledgements 10 commits behind for writes and 5 for lines: entries are pending at every
	// moment the file is cleared out, and the last of them stay.
	const longSession = (outbox: ReturnType<typeof openOutbox>, onAck: (ack: () => void) => void = (ack) => ack()) => {
		for (let commit = 1; commit <= 3_000; commit += 1) {
			outbox.entry(commit, writes(commit));
			outbox.lines(commit, [`line of ${commit}`]);
			if (commit > 10) onAck(() => outbox.ack(commit - 10));
			if (commit > 5) onAck(() => outbox.ackLines(commit - 5));
		}
		outbox.entry(3_001, writes(3_001));
	};
	const keptOfLongSession = [
		...[2_991, 2_992, 2_993, 2_994, 2_995].map((commit) => ({ commit, writes: writes(commit) })),
		...[2_996, 2_997, 2_998, 2_999, 3_000].map((commit) => ({
			commit,
			writes: writes(commit),
			lines: [`line of ${commit}`],
		})),
		{ commit: 3_001, writes: writes(3_001) },
	];
	const rowsIn = (path: string) => readFileSync(path, "utf8").trim().split("\n").length;

	it("keeps its file to what is pending while it runs: acknowledged entries leave the disk too", () => {
		const path = place();
		const outbox = openOutbox(path, { head: 1 });
		longSession(outbox);
		// 12,001 rows with no cleanup: bounded by the threshold, not by the session's history.
		expect(rowsIn(path)).toBeLessThan(2_048);
		expect(outbox.pending()).toEqual(keptOfLongSession);
		outbox.close();
		const again = openOutbox(path, { head: 3_002 });
		expect(again.pending()).toEqual(keptOfLongSession);
		again.close();
	});

	/**
	 * Ways the clearing out fails once: each makes the next one fail, calls `failed` as it does, and gives back what
	 * undoes it.
	 */
	const failures: readonly (readonly [string, (failed: () => void) => () => void])[] = [
		[
			"the rename",
			(failed) => {
				vi.mocked(renameSync).mockImplementationOnce(() => {
					failed();
					throw new Error("the disk refused the rename");
				});
				return () => {};
			},
		],
		[
			"the new file",
			(failed) => {
				const real = vi.mocked(openSync).getMockImplementation() as (
					...args: Parameters<typeof openSync>
				) => number;
				let refused = false;
				vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
					if (!refused && String(args[0]).endsWith(".tmp")) {
						refused = true;
						failed();
						throw new Error("no room for the new file");
					}
					return real(...args);
				});
				return () => {
					vi.mocked(openSync).mockImplementation(real);
				};
			},
		],
	];
	for (const [what, fail] of failures) {
		it(`never fails an acknowledgement when clearing the file out fails at ${what}, and clears it out later`, () => {
			const path = place();
			const outbox = openOutbox(path, { head: 1 });
			let failedNow = false;
			const restore = fail(() => {
				failedNow = true;
			});
			const thrown: unknown[] = [];
			// Whether a temporary file was left beside the outbox right after the failed try.
			const leftAfterFailure: boolean[] = [];
			try {
				longSession(outbox, (ack) => {
					try {
						ack();
					} catch (cause) {
						thrown.push(cause);
					}
					if (failedNow) {
						failedNow = false;
						leftAfterFailure.push(existsSync(`${path}.tmp`));
					}
				});
			} finally {
				restore();
			}
			// The old file stayed whole and in use, nothing was left beside it, and a later try cleared it out.
			expect(thrown).toEqual([]);
			expect(leftAfterFailure).toEqual([false]);
			expect(rowsIn(path)).toBeLessThan(2_048);
			outbox.close();
			const again = openOutbox(path, { head: 3_002 });
			expect(again.pending()).toEqual(keptOfLongSession);
			again.close();
		});
	}

	it("never fails an acknowledgement when the directory sync after clearing out fails, and makes it before the next commit", () => {
		const path = place();
		const outbox = openOutbox(path, { head: 1 });
		const directorySyncs = vi.mocked(fsyncSync);
		directorySyncs.mockClear();
		directorySyncs.mockImplementationOnce(() => {
			throw new Error("the directory sync failed");
		});
		let commit = 0;
		while (directorySyncs.mock.calls.length === 0 && commit < 5_000) {
			commit += 1;
			outbox.entry(commit, writes(commit));
			outbox.ack(commit);
		}
		expect(directorySyncs.mock.calls).toHaveLength(1);
		// The next commit's entry is synced with the directory that names the new file.
		outbox.entry(commit + 1, writes(commit + 1));
		expect(directorySyncs.mock.calls).toHaveLength(2);
		outbox.close();
		const again = openOutbox(path, { head: commit + 2 });
		expect(again.pending()).toEqual([{ commit: commit + 1, writes: writes(commit + 1) }]);
		again.close();
	});

	it("keeps what the host has not acknowledged across a reopen, lines with their commit, in commit order", () => {
		const path = place();
		const outbox = openOutbox(path, { head: 1 });
		for (const commit of [1, 2, 3]) outbox.entry(commit, writes(commit));
		outbox.lines(2, ["line of 2"]);
		outbox.ack(1);
		expect(outbox.pending().map((entry) => entry.commit)).toEqual([2, 3]);
		// After is exclusive: the host holds 2 whole.
		expect(outbox.pending(2, 2).map((entry) => entry.commit)).toEqual([3]);
		// The writes and the lines of a commit are acknowledged apart: lines that came after their writes' ack stay.
		expect(outbox.pending(2)).toEqual([
			{ commit: 2, lines: ["line of 2"] },
			{ commit: 3, writes: writes(3) },
		]);
		expect(outbox.pending(3, 1)).toEqual([{ commit: 2, lines: ["line of 2"] }]);
		outbox.close();
		const again = openOutbox(path, { head: 4 });
		expect(again.pending()).toEqual([
			{ commit: 2, writes: writes(2), lines: ["line of 2"] },
			{ commit: 3, writes: writes(3) },
		]);
		again.ack(3);
		again.close();
		const third = openOutbox(path, { head: 4 });
		expect(third.pending()).toEqual([{ commit: 2, lines: ["line of 2"] }]);
		third.ackLines(2);
		expect(third.pending()).toEqual([]);
		third.close();
	});

	it("syncs an entry before it returns, and a commit's lines at once or with the next sync", async () => {
		const synced = vi.mocked(fdatasyncSync);
		const each = openOutbox(place(), { head: 1 });
		synced.mockClear();
		each.entry(1, writes(1));
		expect(synced).toHaveBeenCalledTimes(1);
		each.lines(1, ["a line"]);
		expect(synced).toHaveBeenCalledTimes(2);
		each.close();
		const next = openOutbox(place(), { head: 1, linesSync: "next", idleSyncMs: 20 });
		synced.mockClear();
		next.entry(1, writes(1));
		next.lines(1, ["a line"]);
		expect(synced).toHaveBeenCalledTimes(1);
		// The next entry's sync takes the lines with it.
		next.entry(2, writes(2));
		expect(synced).toHaveBeenCalledTimes(2);
		// With no entry after them, a moment of quiet.
		next.lines(2, ["a line"]);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(synced).toHaveBeenCalledTimes(3);
		next.close();
	});

	it("keeps a commit's lines when its writes are acknowledged before them", () => {
		const outbox = openOutbox(place(), { head: 1 });
		outbox.entry(1, writes(1));
		outbox.ack(1);
		outbox.lines(1, ["late"]);
		outbox.entry(2, writes(2));
		outbox.lines(2, ["on time"]);
		outbox.ack(2);
		expect(outbox.pending()).toEqual([
			{ commit: 1, lines: ["late"] },
			{ commit: 2, lines: ["on time"] },
		]);
		outbox.ackLines(1);
		expect(outbox.pending()).toEqual([{ commit: 2, lines: ["on time"] }]);
		outbox.close();
	});

	it("drops an entry at or above the store's head at a reopen: its commit never landed, and nobody heard of it", () => {
		const path = place();
		const outbox = openOutbox(path, { head: 5 });
		outbox.entry(5, writes(5));
		outbox.entry(6, writes(6));
		outbox.close();
		const again = openOutbox(path, { head: 6 });
		expect(again.pending().map((entry) => entry.commit)).toEqual([5]);
		again.close();
		// The file holds only what was kept.
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("drops a line the process did not finish writing", () => {
		const path = place();
		const outbox = openOutbox(path, { head: 1 });
		outbox.entry(1, writes(1));
		outbox.close();
		appendFileSync(path, '{"commit":2,"wri');
		const again = openOutbox(path, { head: 3 });
		expect(again.pending().map((entry) => entry.commit)).toEqual([1]);
		again.entry(2, writes(2));
		again.close();
		const third = openOutbox(path, { head: 3 });
		expect(third.pending().map((entry) => entry.commit)).toEqual([1, 2]);
		third.close();
	});

	for (const linesSync of ["each", "next"] as const) {
		it(`loses no commit's lines but the one in flight when the process is killed in a burst (${linesSync})`, async () => {
			for (const delay of [5, 23, 61]) {
				const path = place();
				const writer = spawn(
					process.execPath,
					[join(import.meta.dirname, "home-outbox-writer.mjs"), path, linesSync],
					{
						stdio: ["ignore", "pipe", "inherit"],
					},
				);
				await new Promise<void>((resolve) => writer.stdout.once("data", () => resolve()));
				await new Promise((resolve) => setTimeout(resolve, delay));
				writer.kill("SIGKILL");
				await new Promise((resolve) => writer.once("exit", resolve));
				const reopened = openOutbox(path, { head: Number.MAX_SAFE_INTEGER });
				const entries = reopened.pending();
				reopened.close();
				// It said ready at its 20th commit; on a loaded machine the kill can land before the 21st.
				expect(entries.length, `killed after ${delay} ms`).toBeGreaterThanOrEqual(20);
				const last = entries.at(-1)?.commit ?? 0;
				// Every commit before the last whole entry has its lines: the recorder's write was on the disk when it returned.
				const missing = entries.filter((entry) => entry.commit < last && entry.lines === undefined);
				expect(
					missing.map((entry) => entry.commit),
					`killed after ${delay} ms`,
				).toEqual([]);
				expect(entries.map((entry) => entry.commit)).toEqual(Array.from({ length: last }, (_, n) => n + 1));
			}
		}, 30_000);
	}
});
