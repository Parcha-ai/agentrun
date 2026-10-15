import { describe, expect, it } from "vitest";
import { GONE_BOUND_MS, waitNotRunning } from "./box-env-support.ts";

// `exec` returns when an abort or a timeout is answered, and a start that lands late is killed after it returned. The live tests therefore poll for absence
// with `waitNotRunning`: it must return the moment the group is gone, and it must fail, naming the command, when the group never goes.
describe("waitNotRunning, the check for a command that was stopped", () => {
	it("returns as soon as the command is gone, after a late kill", async () => {
		let polls = 0;
		const began = Date.now();
		await waitNotRunning(() => ++polls < 4, "a command", 5_000, 10);
		expect(polls).toBe(4);
		expect(Date.now() - began).toBeLessThan(2_000);
	});

	it("returns at once when it is already gone, and polls once", async () => {
		let polls = 0;
		await waitNotRunning(() => {
			polls += 1;
			return false;
		}, "a command");
		expect(polls).toBe(1);
	});

	it("fails after its bound, naming the command, when it never goes (best effort is never 'never')", async () => {
		const began = Date.now();
		await expect(
			waitNotRunning(async () => true, "the aborted command pi-transport-abort-1", 200, 20),
		).rejects.toThrow(/the aborted command pi-transport-abort-1 was still running 200 ms after exec returned/);
		expect(Date.now() - began).toBeGreaterThanOrEqual(200);
		expect(Date.now() - began).toBeLessThan(5_000);
	});

	it("cuts a check that hangs at the deadline, and a late 'gone' is not success", async () => {
		const began = Date.now();
		await expect(waitNotRunning(() => new Promise<boolean>(() => {}), "a hung check", 200, 20)).rejects.toThrow(
			/a hung check was still running 200 ms/,
		);
		expect(Date.now() - began).toBeLessThan(2_000);
		await expect(
			waitNotRunning(
				() => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
				"a late check",
				200,
				20,
			),
		).rejects.toThrow(/a late check was still running/);
	});

	it("takes an async check, and its bound is long enough for a loaded box", () => {
		expect(GONE_BOUND_MS).toBeGreaterThanOrEqual(15_000);
	});
});
