// The live view's seam under a computer or a viewer that misbehaves (#2017's review and security read): a frame is
// read whole by its size and never past it, the inputs in flight are capped, and no error or failure carries a URL,
// an endpoint or a secret, in any of the shapes they come in. Fakes only.
import assert from "node:assert/strict";
import test from "node:test";
import { redactWords, watchScreen } from "../dist/index.js";

const hello = { version: "1", os: "linux", kind: "desktop", arch: "amd64", groups: ["screen", "input.pointer", "input.keys"] };

/** A connection whose screen.watch answers `frame` once, and whose screen.read and input.actions are the test's. */
function connectionOf({ frame, read, act }) {
	const calls = [];
	let given = false;
	const client = {
		async call(method, params, options = {}) {
			calls.push({ method, params });
			if (method === "screen.watch") {
				if (given) return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ ok: false, error: { code: "aborted", message: "aborted" } }), { once: true }));
				given = true;
				return { ok: true, value: frame };
			}
			// Each read takes a turn of the event loop, as a real one does: an endless reader cannot starve the test's timers.
			if (method === "screen.read") return new Promise((resolve) => setImmediate(() => resolve(read(params))));
			if (method === "input.actions") return act(params, options);
			return { ok: false, error: { code: "unsupported", message: method } };
		},
		close() {},
	};
	return { connection: { client, hello, close: async () => {} }, calls };
}

const bytes = (n) => Buffer.from(Array.from({ length: n }, (_, i) => i % 256));
const base = { seq: 1, changed: true, format: "jpeg", frameWidth: 4, frameHeight: 4, width: 4, height: 4 };

test("a frame whose answer has no eof is read on by its size: a missing eof is never taken as the end", { timeout: 10_000 }, async () => {
	const whole = bytes(10);
	const { connection } = connectionOf({
		frame: { ...base, id: "w1", size: 10, data: whole.subarray(0, 4).toString("base64") },
		read: ({ offset }) => {
			const part = whole.subarray(offset, offset + 4);
			return { ok: true, value: { data: part.toString("base64"), eof: offset + part.length >= 10 } };
		},
	});
	const watch = watchScreen(connection);
	const { value } = await watch.frames[Symbol.asyncIterator]().next();
	assert.deepEqual([...value.bytes], [...whole]);
	await watch.close();
});

test("a frame is never read past the size it said, never over the largest frame, and must add up to its size", { timeout: 10_000 }, async () => {
	// Reads that go on past the size: refused at the first byte past it.
	const endless = connectionOf({ frame: { ...base, id: "w1", size: 10, data: bytes(4).toString("base64"), eof: false }, read: () => ({ ok: true, value: { data: bytes(4).toString("base64"), eof: false } }) });
	await assert.rejects(watchScreen(endless.connection).frames[Symbol.asyncIterator]().next(), (error) => {
		assert.equal(error.code, "invalid");
		assert.match(error.message, /past the 10 bytes it said/);
		return true;
	});
	assert.ok(endless.calls.filter((c) => c.method === "screen.read").length <= 2, "it stops at the size, not later");
	// A size over the largest frame: refused before any read.
	const huge = connectionOf({ frame: { ...base, id: "w1", size: 2 ** 40, data: bytes(4).toString("base64"), eof: false }, read: () => assert.fail("no read of a frame too large") });
	await assert.rejects(watchScreen(huge.connection).frames[Symbol.asyncIterator]().next(), /more than the largest frame/);
	// An eof before the size: refused, the frame is short.
	const short = connectionOf({ frame: { ...base, id: "w1", size: 10, data: bytes(4).toString("base64"), eof: false }, read: () => ({ ok: true, value: { data: bytes(2).toString("base64"), eof: true } }) });
	await assert.rejects(watchScreen(short.connection).frames[Symbol.asyncIterator]().next(), /6 bytes of the 10 it said/);
});

test("act() caps the inputs in flight: one more than the cap is refused at once, as limit, in words", { timeout: 10_000 }, async () => {
	const waiting = [];
	const { connection } = connectionOf({
		frame: { ...base, size: 1, data: bytes(1).toString("base64"), eof: true },
		act: () => new Promise((resolve) => waiting.push(resolve)),
	});
	const watch = watchScreen(connection);
	const inFlight = Array.from({ length: 8 }, () => watch.act([{ type: "move", at: [1, 1] }]));
	const over = await watch.act([{ type: "move", at: [1, 1] }]);
	assert.equal(over.ok, false);
	assert.equal(over.error.code, "limit");
	assert.match(over.error.message, /8 inputs are in flight/);
	for (const resolve of waiting) resolve({ ok: true, value: { done: 1 } });
	await Promise.all(inFlight);
	assert.equal((await (async () => {
		const next = watch.act([{ type: "move", at: [1, 1] }]);
		waiting.at(-1)?.({ ok: true, value: { done: 1 } });
		return next;
	})()).ok, true, "once they answered, inputs are taken again");
	await watch.close();
});

test("a failed action's words in an answer are redacted too: a device's stderr never reaches the viewer with its endpoint", { timeout: 10_000 }, async () => {
	const { connection } = connectionOf({
		frame: { ...base, size: 1, data: bytes(1).toString("base64"), eof: true },
		act: () => ({ ok: true, value: { done: 0, failed: { index: 0, kind: "phone", message: "action 0: input tap on the phone failed: error: device 'live.phone-harness.com:22220' not found" } } }),
	});
	const watch = watchScreen(connection);
	const answered = await watch.act([{ type: "tap", at: [1, 1] }]);
	assert.equal(answered.ok, true);
	assert.doesNotMatch(answered.value.failed.message, /phone-harness\.com|22220/);
	assert.match(answered.value.failed.message, /input tap on the phone failed/);
	await watch.close();
});

test("redactWords takes out every secret shape a vendor or a device may echo", () => {
	for (const [words, gone] of [
		["GET https://api.vendor.example/v1/x?k=1 failed", /https:|vendor\.example/],
		["api_key=sk_live_abc123456 refused", /sk_live_abc123456/],
		["access_token=eyJhbGciOiJIUzI1NiJ9.e30.x refused", /eyJhbGci/],
		["Authorization: Bearer abcdefghijklmnop refused", /abcdefghijklmnop/],
		["the key sk-proj-ABCDEF1234567890 is not valid", /sk-proj-ABCDEF1234567890/],
		// 20 characters after ghp_: inside redactWords' rule (16 or more), and short of a real token's 36, so the
		// source export's github_token rule (30 or more) does not take this fixture for a key.
		["the token ghp_ABCDEFGHIJKLMNOPQRST expired", /ghp_ABCDEFGHIJ/],
		["fetch of user:hunter2@db.internal failed", /hunter2/],
		["failed to connect to 'live.phone-harness.com:22220'", /phone-harness\.com:22220/],
		["no route to 10.1.2.3:5555", /10\.1\.2\.3:5555/],
		["the code ph_abcdefghijklmnopqrstuvwxyz is wrong", /ph_abcdefghij/],
	]) {
		assert.doesNotMatch(redactWords(words), gone, words);
	}
	assert.equal(redactWords("action 2: 640,360 is off the 360x640 screen"), "action 2: 640,360 is off the 360x640 screen", "points and sizes are kept");
});
