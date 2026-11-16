// watchScreen on a computer that lists screen.ahead (computerd on a desktop): two asks are kept in flight, the second
// one frame ahead, so frames come at the computer's pace and not one each round trip; next() still gives one frame at a
// time, and a frame bettered before it was asked for is dropped. A fake connection that answers as computerd does.
import assert from "node:assert/strict";
import test from "node:test";
import { watchScreen } from "../dist/index.js";

/**
 * A computer whose screen.watch answers as computerd's: one ask at a time, in the order sent; an after one past the
 * newest frame waits as an ask for the newest does, an older one gets the newest at once, and one further on is
 * refused. change() is the screen changing: the waiting ask gets the new frame. `features` is its hello's.
 */
function computer({ features = { "screen.ahead": true } } = {}) {
	const calls = [];
	const queue = [];
	let seq = 0;
	let newest;
	const frame = () => ({
		ok: true,
		value: { seq, changed: true, size: newest.length, data: Buffer.from(newest).toString("base64"), eof: true, format: "jpeg", frameWidth: 4, frameHeight: 4, width: 4, height: 4 },
	});
	const serve = () => {
		while (queue.length > 0) {
			const ask = queue[0];
			if (ask.after > seq + 1) {
				queue.shift();
				ask.resolve({ ok: false, error: { code: "invalid", message: `after ${ask.after} is past the newest frame, ${seq}` } });
				continue;
			}
			const after = ask.after === seq + 1 ? seq : ask.after;
			if (after < seq) {
				queue.shift();
				ask.resolve(frame());
				continue;
			}
			return;
		}
	};
	const client = {
		call(method, params, options = {}) {
			calls.push({ method, params });
			if (method !== "screen.watch") return Promise.resolve({ ok: false, error: { code: "unsupported", message: `no ${method}` } });
			return new Promise((resolve) => {
				const ask = { after: params.after, resolve };
				queue.push(ask);
				options.signal?.addEventListener(
					"abort",
					() => {
						const at = queue.indexOf(ask);
						if (at >= 0) queue.splice(at, 1);
						resolve({ ok: false, error: { code: "aborted", message: "screen.watch was aborted" } });
					},
					{ once: true },
				);
				serve();
			});
		},
	};
	const hello = { version: "1", os: "linux", kind: "desktop", arch: "amd64", groups: ["screen", "input.pointer", "input.keys"], features };
	return {
		connection: { client, hello, close: async () => {} },
		asks: () => calls.filter((c) => c.method === "screen.watch").map((c) => c.params.after),
		waiting: () => queue.length,
		/** The screen changes; with aheadFirst, the ask ahead got the turn first (computerd's handlers race for it). */
		change(bytes, { aheadFirst = false } = {}) {
			seq += 1;
			newest = bytes;
			const turn = aheadFirst && queue.length > 1 ? queue.splice(1, 1)[0] : queue.shift();
			if (turn) turn.resolve(frame());
			serve();
		},
	};
}

const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("asked ahead: two asks are in flight from the start, the second one frame ahead of the first", async () => {
	const fake = computer();
	const watch = watchScreen(fake.connection);
	const frames = watch.frames[Symbol.asyncIterator]();
	const first = frames.next();
	await settle();
	assert.deepEqual(fake.asks(), [0, 1], "after 0, and after 1 ahead of it");
	fake.change([1]);
	assert.equal((await first).value.seq, 1);
	await settle();
	// Before the viewer has drawn frame 1, the computer is already asked for the two after it.
	assert.deepEqual(fake.asks(), [0, 1, 2]);
	assert.equal(fake.waiting(), 2);
	await watch.close();
});

test("asked ahead: frames come as the screen changes, not one each round trip, and each is given once, in order", async () => {
	const fake = computer();
	const watch = watchScreen(fake.connection);
	const frames = watch.frames[Symbol.asyncIterator]();
	const seen = [];
	for (let n = 1; n <= 5; n++) {
		const next = frames.next();
		await settle();
		fake.change([n]);
		const { value } = await next;
		seen.push([value.seq, value.bytes[0]]);
	}
	assert.deepEqual(seen, [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
	assert.ok(fake.asks().every((after, i, all) => i === 0 || after >= all[i - 1]), `asks rise: ${fake.asks()}`);
	await watch.close();
});

test("asked ahead: a frame bettered before next() asked for it is dropped, and the newest given", async () => {
	const fake = computer();
	const watch = watchScreen(fake.connection);
	const frames = watch.frames[Symbol.asyncIterator]();
	const first = frames.next();
	await settle();
	fake.change([1]);
	assert.equal((await first).value.seq, 1);
	await settle();
	// The viewer is still drawing frame 1 while the screen changes twice: both asks in flight answer.
	fake.change([2]);
	fake.change([3]);
	await settle();
	const { value } = await frames.next();
	assert.equal(value.seq, 3, "frame 2 was bettered before it was asked for");
	assert.equal(value.bytes[0], 3);
	await watch.close();
});

test("asked ahead: two asks answering the same newest frame give it once", async () => {
	const fake = computer();
	const watch = watchScreen(fake.connection);
	const frames = watch.frames[Symbol.asyncIterator]();
	const first = frames.next();
	await settle();
	fake.change([1]);
	assert.equal((await first).value.seq, 1);
	await settle();
	// The ask ahead gets frame 2; the ask before it, its after now older than the newest, gets frame 2 again at once.
	fake.change([2], { aheadFirst: true });
	await settle();
	const second = await frames.next();
	assert.equal(second.value.seq, 2);
	const third = frames.next();
	await settle();
	fake.change([3]);
	assert.equal((await third).value.seq, 3, "frame 2 is not given twice");
	await watch.close();
});

test("close() cancels both asks in flight", async () => {
	const fake = computer();
	const watch = watchScreen(fake.connection);
	const frames = watch.frames[Symbol.asyncIterator]();
	const waiting = frames.next();
	await settle();
	assert.equal(fake.waiting(), 2);
	await watch.close();
	assert.deepEqual(await waiting, { done: true, value: undefined });
	assert.equal(fake.waiting(), 0);
});

test("a computer that does not list screen.ahead is asked one frame at a time, after each next()", async () => {
	const fake = computer({ features: {} });
	const watch = watchScreen(fake.connection);
	const frames = watch.frames[Symbol.asyncIterator]();
	const first = frames.next();
	await settle();
	assert.deepEqual(fake.asks(), [0]);
	fake.change([1]);
	assert.equal((await first).value.seq, 1);
	await settle();
	assert.deepEqual(fake.asks(), [0], "nothing is asked before next() acks frame 1");
	const second = frames.next();
	await settle();
	assert.deepEqual(fake.asks(), [0, 1]);
	fake.change([2]);
	assert.equal((await second).value.seq, 2);
	await watch.close();
});
