// A computer's live view, as the runner's viewer reads it (tl-browser's handler shape, final): provider.watch(ref,
// handlers, options) gives frames to handlers.frame(frame, ack), the next one asked for only after ack(); input()
// sends the viewer's events, mapped by toAction, on the same connection; close() and the signal end it with no
// ended(); a computer that goes ends it with ended(error), its code gone, unreachable, refused or unsupported, in words
// with no URL. daemonWatch is the one implementation behind every provider's watch. A fake connection; no daemon.
import assert from "node:assert/strict";
import test from "node:test";
import { daemonWatch, toAction } from "../dist/index.js";

const SECRET_URL = "wss://live.vendor.example/desk/42?token=tok_SECRET42&password=pw_SECRET43";
const REF = { id: "c1", name: "computer-000000000001" };

/**
 * A fake computer whose screen.watch answers frames a test pushes, one per ask, each split into chunks of `chunk` bytes
 * for screen.read; `screen` is the screen's size and `frame` the frame's. `failNext(code, words)` makes the next
 * screen.watch fail so; `failAct` does the same for input.actions.
 */
function fakeComputer({ chunk = 1 << 20, screen = [320, 240], frame = [160, 120], groups = ["screen", "input.pointer", "input.keys"] } = {}) {
	const calls = [];
	const frames = [];
	let seq = 0;
	let wake;
	const held = new Map();
	let failWatch;
	let failAct;
	let closed = 0;
	const client = {
		async call(method, params, options = {}) {
			calls.push({ method, params });
			const signal = options.signal;
			if (method === "screen.watch") {
				for (;;) {
					if (failWatch) return { ok: false, error: failWatch };
					if (signal?.aborted) return { ok: false, error: { code: "aborted", message: "screen.watch was aborted" } };
					if (frames.length > 0) break;
					await new Promise((resolve) => {
						wake = resolve;
						signal?.addEventListener("abort", resolve, { once: true });
					});
				}
				const { bytes: given, format } = frames.shift();
				seq += 1;
				const bytes = Buffer.from(given);
				const first = bytes.subarray(0, chunk);
				const eof = first.length === bytes.length;
				const id = eof ? undefined : `s${seq}`;
				if (id) held.set(id, bytes);
				return {
					ok: true,
					value: { seq, changed: true, ...(id ? { id } : {}), size: bytes.length, data: first.toString("base64"), eof, format: format ?? "jpeg", frameWidth: frame[0], frameHeight: frame[1], width: screen[0], height: screen[1] },
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
	const connection = {
		client,
		hello: { version: "1", os: "linux", kind: "desktop", arch: "amd64", groups },
		close: async () => {
			closed += 1;
		},
	};
	const provider = { connect: async (ref) => (ref.id === REF.id ? { ok: true, value: connection } : { ok: false, error: { code: "not_found", message: `no computer ${ref.id} at ${SECRET_URL}` } }) };
	return {
		provider,
		calls,
		watches: () => calls.filter((c) => c.method === "screen.watch"),
		closed: () => closed,
		push(bytes, format) {
			frames.push({ bytes, format });
			wake?.();
		},
		failNext(code, message) {
			failWatch = { code, message };
			wake?.();
		},
		failAct(words) {
			failAct = words;
		},
	};
}

const tick = async (n = 5) => {
	for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Handlers that keep what they are given: the frames, their acks, and ended's errors. */
function recorder() {
	const frames = [];
	const acks = [];
	const ended = [];
	let next;
	return {
		frames,
		acks,
		ended,
		handlers: {
			frame(frame, ack) {
				frames.push(frame);
				acks.push(ack);
				next?.();
			},
			ended(error) {
				ended.push(error);
				next?.();
			},
		},
		/** Resolves once the frame count or ended count is at least n. */
		until: (count) =>
			new Promise((resolve) => {
				const check = () => (count() ? resolve() : (next = check));
				check();
			}),
	};
}

test("frames are paced by the ack: the next frame is not asked for before ack() of the one given", async () => {
	const fake = fakeComputer();
	const r = recorder();
	const watched = await daemonWatch(fake.provider, REF, r.handlers, { maxWidth: 160, quality: 50 });
	assert.equal(watched.ok, true, JSON.stringify(watched));
	fake.push([1, 2, 3]);
	await r.until(() => r.frames.length >= 1);
	assert.deepEqual({ ...r.frames[0], bytes: [...r.frames[0].bytes] }, { seq: 1, format: "jpeg", bytes: [1, 2, 3], width: 320, height: 240, frameWidth: 160, frameHeight: 120 });
	assert.deepEqual(fake.watches()[0].params, { after: 0, maxWidth: 160, quality: 50 });
	fake.push([4, 5]);
	await tick(10);
	assert.equal(fake.watches().length, 1, "no frame is asked for before the ack");
	assert.equal(r.frames.length, 1);
	r.acks[0]();
	await r.until(() => r.frames.length >= 2);
	assert.equal(r.frames[1].seq, 2);
	assert.equal(fake.watches()[1].params.after, 1, "the second ask acks frame 1");
	await watched.value.close();
});

test("a frame over a chunk is read on with screen.read and given whole; a phone's PNG says so in format", async () => {
	const fake = fakeComputer({ chunk: 4 });
	const r = recorder();
	const watched = await daemonWatch(fake.provider, REF, r.handlers);
	fake.push([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "png");
	await r.until(() => r.frames.length >= 1);
	assert.deepEqual([...r.frames[0].bytes], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assert.equal(r.frames[0].format, "png");
	assert.deepEqual(fake.calls.filter((c) => c.method === "screen.read").map((c) => c.params.offset), [4, 8]);
	await watched.value.close();
});

test("width and height are the screen's real pixels: a 2560x1440 screen at maxWidth 1280 is a 1280-wide frame, and a click at the image's middle acts at (1280, 720)", async () => {
	const fake = fakeComputer({ screen: [2560, 1440], frame: [1280, 720] });
	const r = recorder();
	const watched = await daemonWatch(fake.provider, REF, r.handlers, { maxWidth: 1280 });
	fake.push([9]);
	await r.until(() => r.frames.length >= 1);
	const [frame] = r.frames;
	assert.deepEqual([frame.width, frame.height, frame.frameWidth, frame.frameHeight], [2560, 1440, 1280, 720]);
	// The viewer draws the 1280-wide image and scales a click at its middle (640, 360) to the screen's pixels.
	const at = { x: (640 * frame.width) / frame.frameWidth, y: (360 * frame.height) / frame.frameHeight };
	const mapped = [];
	for (const action of ["down", "up"]) {
		const one = toAction({ type: "mouse", action, x: at.x, y: at.y, button: 0, buttons: action === "down" ? 1 : 0, clickCount: 1, modifiers: 0 }, "desktop");
		assert.ok(Array.isArray(one), JSON.stringify(one));
		mapped.push(...one);
	}
	assert.deepEqual(await watched.value.input(mapped), { ok: true, value: { done: 4 } });
	assert.deepEqual(fake.calls.at(-1).params.actions, [
		{ type: "move", at: [1280, 720] },
		{ type: "down", button: "left" },
		{ type: "move", at: [1280, 720] },
		{ type: "up", button: "left" },
	]);
	await watched.value.close();
});

test("close() and the signal each end the watch with no ended(); input() then refuses in words, and close() lets the connection go", async () => {
	for (const how of ["close", "signal"]) {
		const fake = fakeComputer();
		const r = recorder();
		const controller = new AbortController();
		const watched = await daemonWatch(fake.provider, REF, r.handlers, { signal: controller.signal });
		await tick();
		assert.equal(fake.watches().length, 1, `${how}: a watch is waiting`);
		if (how === "close") await watched.value.close();
		else controller.abort();
		await tick(10);
		fake.push([1]);
		await tick(10);
		assert.deepEqual(r.frames, [], `${how}: no frame after the end`);
		assert.deepEqual(r.ended, [], `${how}: no ended() for an end the caller asked for`);
		const refused = await watched.value.input([{ type: "move", at: [1, 1] }]);
		assert.equal(refused.ok, false);
		assert.match(refused.error.message, /the screen watch (is closed|was aborted)/);
		assert.equal(fake.calls.filter((c) => c.method === "input.actions").length, 0, `${how}: nothing is sent after the end`);
		assert.equal(fake.closed(), 1, `${how}: the watch's connection is let go`);
	}
});

test("a computer that goes ends the watch with ended(error): gone, unreachable, refused or unsupported, in words with no URL", async () => {
	for (const [given, want] of [
		["gone", "gone"],
		["timeout", "unreachable"],
		["e2b", "unreachable"],
		["denied", "refused"],
		["invalid", "refused"],
		["unsupported", "unsupported"],
	]) {
		const fake = fakeComputer();
		const r = recorder();
		const watched = await daemonWatch(fake.provider, REF, r.handlers);
		await tick();
		fake.failNext(given, `the computer at ${SECRET_URL} said no; key sk_live_SECRET44`);
		await r.until(() => r.ended.length >= 1);
		assert.equal(r.ended.length, 1, given);
		assert.equal(r.ended[0].code, want, `${given} ends as ${want}`);
		assert.doesNotMatch(r.ended[0].message, /SECRET|wss:|https?:|token=|password=/, given);
		assert.match(r.ended[0].message, /said no/);
		await tick(10);
		assert.equal(r.ended.length, 1, `${given}: ended() once`);
		await watched.value.close();
		assert.equal(r.ended.length, 1, `${given}: no ended() for the close after`);
	}
});

test("watch() refuses a computer with no screen as unsupported, and a ref it cannot connect to in words with no URL; a failed input is redacted", async () => {
	const blind = fakeComputer({ groups: ["exec", "files", "processes"] });
	const r = recorder();
	const unsupported = await daemonWatch(blind.provider, REF, r.handlers);
	assert.equal(unsupported.ok, false);
	assert.equal(unsupported.error.code, "unsupported");
	assert.match(unsupported.error.message, /no screen/);
	assert.equal(blind.closed(), 1, "the connection it opened is let go");
	const missing = await daemonWatch(blind.provider, { id: "c9", name: "computer-000000000009" }, r.handlers);
	assert.equal(missing.ok, false);
	assert.doesNotMatch(missing.error.message, /SECRET|wss:/);
	const fake = fakeComputer();
	const watched = await daemonWatch(fake.provider, REF, recorder().handlers);
	fake.failAct(`the vendor refused at ${SECRET_URL}`);
	const failed = await watched.value.input([{ type: "move", at: [1, 1] }]);
	assert.equal(failed.ok, false);
	assert.match(failed.error.message, /the vendor refused at \[a URL\]/);
	await watched.value.close();
});

test("toAction maps the viewer's events per kind, in the screen's pixels; what a kind cannot take is refused in words", () => {
	// toAction answers the actions (an array), or a Refusal ({ field, message }) naming the event's field it refused.
	const ok = (event, kind) => {
		const mapped = toAction(event, kind);
		assert.ok(Array.isArray(mapped), `${JSON.stringify(event)} on ${kind}: ${JSON.stringify(mapped)}`);
		return mapped;
	};
	const refused = (event, kind, field, words) => {
		const mapped = toAction(event, kind);
		assert.ok(!Array.isArray(mapped), `${JSON.stringify(event)} on ${kind}: refused`);
		assert.equal(mapped.field, field);
		assert.match(mapped.message, words);
	};
	const mouse = (action, x, y, button = 0, modifiers = 0) => ({ type: "mouse", action, x, y, button, buttons: 0, clickCount: 1, modifiers });
	const key = (action, k, code, modifiers = 0, text) => ({ type: "key", action, key: k, code, modifiers, ...(text === undefined ? {} : { text }) });
	// A desktop: the pointer, the wheel, keys and typed text.
	assert.deepEqual(ok(mouse("move", 10.4, 20.6), "desktop"), [{ type: "move", at: [10, 21] }]);
	assert.deepEqual(ok(mouse("down", 5, 6, 2), "desktop"), [{ type: "move", at: [5, 6] }, { type: "down", button: "right" }]);
	assert.deepEqual(ok(mouse("up", 5, 6, 1), "desktop"), [{ type: "move", at: [5, 6] }, { type: "up", button: "middle" }]);
	assert.deepEqual(ok({ type: "wheel", x: 50, y: 60, dx: 0, dy: 240 }, "desktop"), [{ type: "scroll", at: [50, 60], dx: 0, dy: 2, unit: "clicks" }]);
	assert.deepEqual(ok({ type: "wheel", x: 50, y: 60, dx: -30, dy: 0 }, "desktop"), [{ type: "scroll", at: [50, 60], dx: -1, dy: 0, unit: "clicks" }]);
	assert.deepEqual(ok(key("down", "Enter", "Enter"), "desktop"), [{ type: "key", keys: ["enter"] }]);
	assert.deepEqual(ok(key("down", "ArrowLeft", "ArrowLeft"), "desktop"), [{ type: "key", keys: ["left"] }]);
	assert.deepEqual(ok(key("down", "s", "KeyS", 2), "desktop"), [{ type: "key", keys: ["ctrl", "s"] }], "Control+s is a combo");
	assert.deepEqual(ok(key("down", "a", "KeyA"), "desktop"), [], "a printable key's down types nothing: its char does");
	assert.deepEqual(ok(key("char", "é", "", 0, "é"), "desktop"), [{ type: "type", text: "é" }]);
	assert.deepEqual(ok(key("up", "Enter", "Enter"), "desktop"), [], "a key's up is in its down's press");
	refused({ type: "tap", x: 1, y: 2 }, "desktop", "type", /a desktop takes the mouse, the wheel and keys/);
	refused(key("down", "Hyper", "Hyper"), "desktop", "key", /Hyper is not a key/);
	refused(mouse("move", Number.NaN, 2), "desktop", "x", /not a point/);
	// A phone, Android or iPhone: taps, swipes, its buttons and typed text, upright as its frames are.
	for (const kind of ["android", "ios"]) {
		assert.deepEqual(ok({ type: "tap", x: 600.2, y: 300 }, kind), [{ type: "tap", at: [600, 300] }]);
		assert.deepEqual(ok({ type: "swipe", x1: 10, y1: 500, x2: 10, y2: 100, ms: 250 }, kind), [{ type: "swipe", path: [[10, 500], [10, 100]], ms: 250 }]);
		assert.deepEqual(ok({ type: "button", name: "recents" }, kind), [{ type: "button", name: "app_switch" }]);
		assert.deepEqual(ok({ type: "button", name: "back" }, kind), [{ type: "button", name: "back" }]);
		assert.deepEqual(ok(key("char", "x", "", 0, "hi"), kind), [{ type: "type", text: "hi" }]);
		assert.deepEqual(ok(key("down", "Enter", "Enter"), kind), [{ type: "key", keys: ["enter"] }]);
		refused(mouse("down", 1, 2), kind, "type", /a phone takes taps, swipes, its buttons and keys/);
		refused({ type: "wheel", x: 1, y: 2, dx: 0, dy: 1 }, kind, "type", /a phone takes taps, swipes, its buttons and keys/);
	}
});

test("toAction holds what a viewer may send to bounds: it checks every field at run time, caps text, clamps swipes and wheels, and keeps modifiers", () => {
	const actions = (event, kind = "desktop") => {
		const mapped = toAction(event, kind);
		assert.ok(Array.isArray(mapped), `${JSON.stringify(event).slice(0, 120)} on ${kind}: ${JSON.stringify(mapped).slice(0, 200)}`);
		return mapped;
	};
	const refusal = (event, kind, field, words) => {
		let mapped;
		try {
			mapped = toAction(event, kind);
		} catch (error) {
			assert.fail(`${JSON.stringify(event).slice(0, 120)} on ${kind}: threw ${error.message}`);
		}
		assert.ok(!Array.isArray(mapped), `${JSON.stringify(event).slice(0, 120)} on ${kind}: refused`);
		assert.equal(mapped.field, field, mapped.message);
		assert.match(mapped.message, words);
	};
	const key = (k, modifiers = 0, action = "down") => ({ type: "key", action, key: k, code: k, modifiers });
	const mouse = (action, modifiers = 0, button = 0) => ({ type: "mouse", action, x: 10, y: 20, button, buttons: 0, clickCount: 1, modifiers });
	// Every field is checked whatever the type says: a viewer is a browser page.
	for (const [event, field] of [
		[null, "type"],
		[{ type: "teleport", x: 1, y: 2 }, "type"],
		[{ ...mouse("down"), action: "jump" }, "action"],
		[{ ...mouse("down"), button: "left" }, "button"],
		[{ ...mouse("move"), modifiers: "ctrl" }, "modifiers"],
		[{ type: "key", action: "down", key: 13, code: "Enter", modifiers: 0 }, "key"],
		[{ type: "key", action: "press", key: "a", code: "KeyA", modifiers: 0 }, "action"],
		[{ type: "key", action: "char", key: "a", code: "KeyA", text: 5, modifiers: 0 }, "text"],
		[{ type: "wheel", x: 1, y: 2, dx: Number.POSITIVE_INFINITY, dy: 0 }, "dx"],
	]) {
		refusal(event, "desktop", field, /./);
	}
	for (const [event, field] of [
		[{ type: "button", name: "power" }, "name"],
		[{ type: "tap", x: Number.POSITIVE_INFINITY, y: 2 }, "x"],
		[{ type: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, ms: "slow" }, "ms"],
	]) {
		refusal(event, "android", field, /./);
	}
	// Typed text holds at most 64K characters (computerd's MaxTypeRunes), on every kind.
	assert.deepEqual(actions({ type: "key", action: "char", key: "a", code: "", text: "a".repeat(65_536), modifiers: 0 }), [{ type: "type", text: "a".repeat(65_536) }]);
	refusal({ type: "key", action: "char", key: "a", code: "", text: "a".repeat(65_537), modifiers: 0 }, "android", "text", /at most 65536 characters/);
	// A swipe lasts 0 to 1000 ms; a wheel moves at most 20 clicks an event.
	assert.deepEqual(actions({ type: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, ms: 99_999 }, "android"), [{ type: "swipe", path: [[1, 2], [3, 4]], ms: 1000 }]);
	assert.deepEqual(actions({ type: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, ms: -5 }, "ios"), [{ type: "swipe", path: [[1, 2], [3, 4]], ms: 0 }]);
	assert.deepEqual(actions({ type: "wheel", x: 1, y: 2, dx: -1e9, dy: 1e9 }), [{ type: "scroll", at: [1, 2], dx: -20, dy: 20, unit: "clicks" }]);
	// A shortcut keeps Shift: Ctrl+Shift+S is not Ctrl+S.
	assert.deepEqual(actions(key("S", 2 | 8)), [{ type: "key", keys: ["ctrl", "shift", "s"] }]);
	// A modified click keeps its modifiers: the down only moves, and the up clicks with the keys held.
	assert.deepEqual(actions(mouse("down", 2)), [{ type: "move", at: [10, 20] }]);
	assert.deepEqual(actions(mouse("up", 2 | 8)), [{ type: "move", at: [10, 20] }, { type: "click", at: [10, 20], button: "left", keys: ["ctrl", "shift"] }]);
	assert.deepEqual(actions({ ...mouse("up", 8), clickCount: 2 }), [{ type: "move", at: [10, 20] }, { type: "click", at: [10, 20], button: "left", count: 2, keys: ["shift"] }]);
	// A viewer never ends or switches the display.
	refusal(key("Backspace", 2 | 1), "desktop", "key", /would end the display/);
	for (const f of ["F1", "F7", "F12"]) refusal(key(f, 2 | 1), "desktop", "key", /would switch the display/);
	assert.deepEqual(actions(key("F1")), [{ type: "key", keys: ["f1"] }], "F1 alone is a key");
});
