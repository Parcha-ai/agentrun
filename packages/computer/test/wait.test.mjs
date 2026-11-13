// waitUntil, the bounded wait a provider's release uses until the vendor reads a computer back as ended: reads until a
// state is done, with pauses that double from minMs to maxMs, within boundMs and the caller's signal. No vendor here.
import assert from "node:assert/strict";
import test from "node:test";
import { waitUntil } from "../dist/index.js";

/** A read that answers states in turn (the last one again once they run out), recording when each read began. */
function reads(...states) {
	const at = [];
	let next = 0;
	const read = async () => {
		at.push(Date.now());
		return states[Math.min(next++, states.length - 1)];
	};
	return { read, at, count: () => at.length };
}

test("waitUntil returns the first state that is done, at once when the first read is", async () => {
	const first = reads({ finished: 137 });
	const started = Date.now();
	assert.deepEqual(await waitUntil(first.read, (s) => s.finished !== null, { boundMs: 5_000, minMs: 1_000 }), { ok: true, value: { finished: 137 } });
	assert.equal(first.count(), 1);
	assert.ok(Date.now() - started < 500, "no pause before a read that is done");
	const later = reads({ finished: null }, { finished: null }, { finished: 0 });
	assert.deepEqual(await waitUntil(later.read, (s) => s.finished !== null, { boundMs: 5_000, minMs: 10, maxMs: 20 }), { ok: true, value: { finished: 0 } });
	assert.equal(later.count(), 3, "it reads until done, and no more");
});

test("waitUntil pauses between reads, doubling from minMs up to maxMs", async () => {
	const running = reads("running", "running", "running", "running", "running", "done");
	const waited = await waitUntil(running.read, (s) => s === "done", { boundMs: 10_000, minMs: 40, maxMs: 120 });
	assert.equal(waited.ok, true, JSON.stringify(waited));
	const gaps = running.at.slice(1).map((at, i) => at - (running.at[i] ?? at));
	// Timers never fire early by more than a millisecond's rounding; they may fire late on a loaded host.
	for (const [i, least] of [40, 80, 120, 120, 120].entries()) assert.ok(gaps[i] >= least - 2, `pause ${i + 1}: ${gaps[i]} ms, at least ${least}`);
	assert.ok(gaps[3] < 1_000 && gaps[4] < 1_000, `pauses stop growing at maxMs: ${gaps.join(", ")} ms`);
});

test("waitUntil ends at boundMs as a timeout that names what it waited for and the last state read, and reads no more", async () => {
	const running = reads({ finished: null });
	const started = Date.now();
	const waited = await waitUntil(running.read, (s) => s.finished !== null, {
		boundMs: 300,
		minMs: 20,
		maxMs: 40,
		what: "computer-0123456789ab to finish",
		describe: (s) => (s.finished === null ? "poll null: it still runs" : `exit code ${s.finished}`),
	});
	assert.equal(waited.ok, false);
	assert.equal(waited.error.code, "timeout");
	assert.match(waited.error.message, /computer-0123456789ab to finish/);
	assert.match(waited.error.message, /0\.3 s/);
	assert.match(waited.error.message, /poll null: it still runs/);
	const took = Date.now() - started;
	assert.ok(took >= 295 && took < 2_000, `the wait took ${took} ms, bounded by 300`);
	const count = running.count();
	assert.ok(count >= 3, `${count} reads within the bound`);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(running.count(), count, "no read after the wait ended");
});

test("waitUntil bounds a read that never answers, and gives the read a signal that aborts at the bound", async () => {
	let given;
	const waited = await waitUntil(
		(signal) => {
			given = signal;
			return new Promise(() => {});
		},
		() => true,
		{ boundMs: 100, what: "the sandbox to finish" },
	);
	assert.equal(waited.error?.code, "timeout");
	assert.match(waited.error.message, /no read had answered/);
	assert.equal(given?.aborted, true, "the read's signal aborted when the bound passed");
});

test("waitUntil ends at the caller's abort, naming the last state; an aborted signal reads nothing", async () => {
	const running = reads("still running");
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 120);
	const waited = await waitUntil(running.read, (s) => s === "done", { boundMs: 10_000, minMs: 20, maxMs: 40, signal: controller.signal, what: "the sandbox to finish", describe: (s) => s });
	assert.equal(waited.error?.code, "aborted");
	assert.match(waited.error.message, /the sandbox to finish/);
	assert.match(waited.error.message, /still running/);
	const none = reads("done");
	const early = await waitUntil(none.read, (s) => s === "done", { boundMs: 10_000, signal: AbortSignal.abort() });
	assert.equal(early.error?.code, "aborted");
	assert.equal(none.count(), 0);
});

test("waitUntil takes a read that throws or rejects as not done: it reads again, and a timeout names the failure", async () => {
	let n = 0;
	const flaky = async () => {
		n++;
		if (n === 1) throw new Error("the server is busy");
		return n >= 3 ? "done" : "running";
	};
	assert.deepEqual(await waitUntil(flaky, (s) => s === "done", { boundMs: 5_000, minMs: 10, maxMs: 20 }), { ok: true, value: "done" });
	const failing = await waitUntil(
		() => {
			throw new Error("permission denied for this app");
		},
		() => true,
		{ boundMs: 100, minMs: 10, maxMs: 20 },
	);
	assert.equal(failing.error?.code, "timeout");
	assert.match(failing.error.message, /permission denied for this app/);
});

test("waitUntil refuses a bound or pause that is not a positive number of ms", async () => {
	const read = async () => "done";
	for (const options of [{ boundMs: 0 }, { boundMs: Number.NaN }, { boundMs: 100, minMs: 0 }, { boundMs: 100, minMs: 50, maxMs: 10 }]) {
		await assert.rejects(waitUntil(read, () => true, options), RangeError, JSON.stringify(options));
	}
});
