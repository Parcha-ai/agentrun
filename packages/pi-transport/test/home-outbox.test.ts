import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openOutbox } from "../src/home/outbox.ts";

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
	it("keeps what the host has not acknowledged across a reopen, lines with their commit, in commit order", () => {
		const path = place();
		const outbox = openOutbox(path, { head: 1 });
		for (const commit of [1, 2, 3]) outbox.entry(commit, writes(commit));
		outbox.lines(2, ["line of 2"]);
		outbox.ack(1);
		expect(outbox.pending().map((entry) => entry.commit)).toEqual([2, 3]);
		// After is exclusive: the host holds 2 whole.
		expect(outbox.pending(2).map((entry) => entry.commit)).toEqual([3]);
		outbox.close();
		const again = openOutbox(path, { head: 4 });
		expect(again.pending()).toEqual([
			{ commit: 2, writes: writes(2), lines: ["line of 2"] },
			{ commit: 3, writes: writes(3) },
		]);
		again.close();
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
				expect(entries.length, `killed after ${delay} ms`).toBeGreaterThan(20);
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
