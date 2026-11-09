// watchScreen: the runner's viewer reads a computer's screen as frames and drives it, on one connection. Frames are
// pull-paced (each next() is the ack of the frame before it), act() sends the viewer's mapped events, and close() or
// the signal ends both. No error holds a URL or a token. A fake connection; no daemon.
import assert from "node:assert/strict";
import test from "node:test";
import { watchScreen } from "../dist/index.js";

const SECRET_URL = "wss://live.vendor.example/desk/42?token=tok_SECRET42&password=pw_SECRET43";

/**
 * A fake connection whose screen.watch answers frames a test pushes: one per ack, in order, each split into chunks of
 * `chunk` bytes for screen.read. `failWatch` and `failAct` make the next call fail with those words.
 */
function fakeConnection({ chunk = 1 << 20 } = {}) {
	const calls = [];
	const frames = []; // pushed, not yet given
	let seq = 0;
	let wake;
	const held = new Map();
	let failWatch;
	let failAct;
	const client = {
		async call(method, params, options = {}) {
			calls.push({ method, params });
			const signal = options.signal;
			if (method === "screen.watch") {
				if (failWatch) return { ok: false, error: { code: "gone", message: failWatch } };
				while (frames.length === 0) {
					if (signal?.aborted) return { ok: false, error: { code: "aborted", message: "screen.watch was aborted" } };
					await new Promise((resolve) => {
						wake = resolve;
						signal?.addEventListener("abort", resolve, { once: true });
					});
					if (failWatch) return { ok: false, error: { code: "gone", message: failWatch } };
				}
				const frame = frames.shift();
				seq += 1;
				const bytes = Buffer.from(frame.bytes);
				const first = bytes.subarray(0, chunk);
				const eof = first.length === bytes.length;
				const id = eof ? undefined : `s${seq}`;
				if (id) held.set(id, bytes);
				return {
					ok: true,
					value: { seq, changed: true, ...(id ? { id } : {}), size: bytes.length, data: first.toString("base64"), eof, format: frame.format ?? "jpeg", frameWidth: 160, frameHeight: 120, width: 320, height: 240, cursor: [5, 6] },
				};
			}
			if (method === "screen.read") {
				const bytes = held.get(params.id);
				const part = bytes.subarray(params.offset, params.offset + chunk);
				return { ok: true, value: { data: part.toString("base64"), eof: params.offset + part.length >= bytes.length } };
			}
			if (method === "input.actions") {
				if (failAct) return { ok: false, error: { code: "invalid", message: failAct } };
				return { ok: true, value: { done: params.actions.length } };
			}
			return { ok: false, error: { code: "unsupported", message: `no ${method}` } };
		},
		close() {},
	};
	const connection = { client, hello: { version: "1", os: "linux", kind: "desktop", arch: "amd64", groups: ["screen", "input.pointer", "input.keys"] }, close: async () => {} };
	return {
		connection,
		calls,
		watches: () => calls.filter((c) => c.method === "screen.watch"),
		push(bytes, format) {
			frames.push({ bytes, format });
			wake?.();
		},
		failWatch(words) {
			failWatch = words;
			wake?.();
		},
		failAct(words) {
			failAct = words;
		},
	};
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("frames are pull-paced: each next() is the ack of the frame before it, and no frame is fetched before it", async () => {
	const fake = fakeConnection();
	const watch = watchScreen(fake.connection, { maxWidth: 160, quality: 50 });
	const frames = watch.frames[Symbol.asyncIterator]();
	fake.push([1, 2, 3]);
	const first = await frames.next();
	assert.equal(first.done, false);
	assert.deepEqual({ ...first.value, bytes: [...first.value.bytes] }, { seq: 1, format: "jpeg", bytes: [1, 2, 3], frameWidth: 160, frameHeight: 120, width: 320, height: 240, cursor: [5, 6] });
	assert.deepEqual(fake.watches()[0].params, { after: 0, maxWidth: 160, quality: 50 });
	fake.push([4, 5]);
	for (let i = 0; i < 5; i++) await tick();
	assert.equal(fake.watches().length, 1, "the next frame is not asked for before next() acks the one drawn");
	const second = await frames.next();
	assert.equal(second.value.seq, 2);
	assert.equal(fake.watches()[1].params.after, 1, "the second ask acks frame 1");
	await watch.close();
});

test("a frame over a chunk is read on with screen.read and given whole; a phone's PNG says so in format", async () => {
	const fake = fakeConnection({ chunk: 4 });
	const watch = watchScreen(fake.connection);
	const frames = watch.frames[Symbol.asyncIterator]();
	fake.push([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "png");
	const { value } = await frames.next();
	assert.deepEqual([...value.bytes], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assert.equal(value.format, "png");
	assert.deepEqual(fake.calls.filter((c) => c.method === "screen.read").map((c) => c.params.offset), [4, 8]);
	await watch.close();
});

test("act() sends the viewer's mapped events as input.actions on the same connection, and answers each call", async () => {
	const fake = fakeConnection();
	const watch = watchScreen(fake.connection);
	const done = await watch.act([{ type: "move", at: [1, 2] }, { type: "click" }]);
	assert.deepEqual(done, { ok: true, value: { done: 2 } });
	assert.deepEqual(fake.calls.at(-1), { method: "input.actions", params: { actions: [{ type: "move", at: [1, 2] }, { type: "click" }] } });
	await watch.close();
});

test("close() ends the frames, the waiting ask included, and act() then refuses in words", async () => {
	const fake = fakeConnection();
	const watch = watchScreen(fake.connection);
	const frames = watch.frames[Symbol.asyncIterator]();
	const waiting = frames.next();
	await tick();
	await watch.close();
	assert.deepEqual(await waiting, { done: true, value: undefined });
	assert.deepEqual(await frames.next(), { done: true, value: undefined });
	const refused = await watch.act([{ type: "click" }]);
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "gone");
	assert.match(refused.error.message, /the screen watch is closed/);
	assert.equal(fake.calls.filter((c) => c.method === "input.actions").length, 0, "nothing is sent after close");
});

test("the signal ends the frames and makes act() refuse, as close() does", async () => {
	const fake = fakeConnection();
	const controller = new AbortController();
	const watch = watchScreen(fake.connection, { signal: controller.signal });
	const frames = watch.frames[Symbol.asyncIterator]();
	const waiting = frames.next();
	await tick();
	controller.abort();
	assert.deepEqual(await waiting, { done: true, value: undefined });
	const refused = await watch.act([{ type: "click" }]);
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "aborted");
	assert.match(refused.error.message, /the screen watch was aborted/);
});

test("no error holds a URL or a token: a failed act and a failed watch are redacted", async () => {
	const fake = fakeConnection();
	const watch = watchScreen(fake.connection);
	fake.failAct(`the vendor refused at ${SECRET_URL}`);
	const refused = await watch.act([{ type: "click" }]);
	assert.equal(refused.ok, false);
	assert.doesNotMatch(refused.error.message, /SECRET|wss:|https?:|token=|password=/);
	assert.match(refused.error.message, /the vendor refused at \[a URL\]/);
	const frames = watch.frames[Symbol.asyncIterator]();
	fake.failWatch(`the desktop at ${SECRET_URL} went away; key sk_live_SECRET44`);
	await assert.rejects(frames.next(), (error) => {
		assert.equal(error.code, "gone");
		assert.doesNotMatch(error.message, /SECRET|wss:|token=|password=/);
		assert.match(error.message, /went away/);
		return true;
	});
	assert.deepEqual(await frames.next(), { done: true, value: undefined }, "a failed watch is over");
});
