// The protocol extension's types and cases: kind and daemon mode, coreGroups, the shared lifetime rule, checkActions and
// KEYS, and each screen, input, touch, apps and lifetime case run against fake desktops and phones that declare their
// groups (test/fake-device.mjs): each case passes on a good fake and fails on one broken the way it checks for. A
// Docker-shaped computer skips every new case in words and still passes Core. No Docker, no daemon, no X server, no phone.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
	checkActions,
	checkLifetime,
	conformanceCases,
	coreGroups,
	formatReport,
	GROUPS,
	isKey,
	KEYS,
	kindRefusals,
	MAX_ACTIONS,
	MAX_BATCH_WAIT_MS,
	MAX_KEY_REPEAT,
	MAX_PNG_BYTES,
	readPng,
	runConformance,
} from "../dist/index.js";
import { fakeComputers } from "./fake-computer.mjs";
import { fakeDevices, fakeFetch, png, pngOf, testClock, virtualClock } from "./fake-device.mjs";

const IMAGE = "fixture:image";
const dir = mkdtempSync(join(tmpdir(), "computer-groups-"));
after(() => rmSync(dir, { recursive: true, force: true }));
/** The fixture's bytes on this machine: the fake knows the fixture by where the case puts it, not by what it is. */
const FIXTURE = join(dir, "fixture.bin");
writeFileSync(FIXTURE, Buffer.alloc(10_000, 7));

const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasons = (report) => Object.fromEntries(report.results.filter((r) => r.reason).map((r) => [r.id, r.reason]));
const byId = (...ids) => {
	const found = conformanceCases.filter((c) => ids.includes(c.id));
	assert.deepEqual(found.map((c) => c.id).sort(), [...ids].sort(), "every case asked for is in the suite");
	return found;
};
const run = (provider, ids, extra = {}) => runConformance(provider, { image: IMAGE, cases: byId(...ids), fixture: FIXTURE, fetch: fakeFetch, clock: testClock, patience: 1000, ...extra });
/**
 * The patience of a run against a broken fake, whose case waits it out to fail: a few of t.until's 200 ms polls, not a
 * second. Each such run's words pin the failure it must find, so a run cut short another way turns it red, never green.
 */
const BROKEN_PATIENCE = 300;

const NEW_CASES = [
	"health.kind-consistent",
	"screen.screenshot-size",
	"screen.watch",
	"input.click-lands",
	"input.type-text",
	"input.key-table-refuses-unknown",
	"input.actions-stops-at-first-failure",
	"touch.tap",
	"touch.swipe",
	"touch.pinch",
	"apps.install-launch",
	"apps.ui-tree-shape",
	"lifetime.extend",
];
const DESKTOP_CASES = ["health.kind-consistent", "provider.check-refuses", "screen.screenshot-size", "screen.watch", "input.click-lands", "input.type-text", "input.key-table-refuses-unknown", "input.actions-stops-at-first-failure"];
const PHONE_CASES = ["health.kind-consistent", "provider.check-refuses", "screen.screenshot-size", "touch.tap", "touch.swipe", "touch.pinch", "apps.install-launch", "apps.ui-tree-shape"];

test("the suite has the extension's 13 new cases, each at its level and with the needs the spec gives it", () => {
	const levels = Object.fromEntries(byId(...NEW_CASES).map((c) => [c.id, [c.level, c.needs]]));
	assert.deepEqual(levels, {
		"health.kind-consistent": ["core", []],
		"screen.screenshot-size": ["core", ["screen"]],
		"screen.watch": ["core", ["screen"]],
		"input.click-lands": ["core", ["input.pointer"]],
		"input.type-text": ["core", ["input.keys"]],
		"input.key-table-refuses-unknown": ["core", ["input.keys"]],
		"input.actions-stops-at-first-failure": ["core", ["input.pointer"]],
		"touch.tap": ["core", ["input.touch"]],
		"touch.swipe": ["core", ["input.touch"]],
		"touch.pinch": ["full", ["input.touch"]],
		"apps.install-launch": ["core", ["apps.install", "apps", "files"]],
		"apps.ui-tree-shape": ["core", ["apps.ui_tree"]],
		"lifetime.extend": ["full", ["extend"]],
	});
});

test("coreGroups: computerd brings exec, files, processes and network none (a child daemon its vendor's agent too); a desktop adds screen and keyboard and pointer; a phone needs screen and touch", () => {
	const linux = ["exec", "files", "processes", "network:none"];
	const child = [...linux, "vendor-agent"];
	assert.deepEqual(coreGroups("linux", "pid1"), linux);
	assert.deepEqual(coreGroups("linux", "child"), child);
	assert.deepEqual(coreGroups("desktop", "pid1"), [...linux, "screen", "input.pointer", "input.keys"]);
	assert.deepEqual(coreGroups("desktop", "child"), [...child, "screen", "input.pointer", "input.keys"]);
	assert.deepEqual(coreGroups("desktop", "none"), ["screen", "input.pointer", "input.keys"]);
	assert.deepEqual(coreGroups("android", "none"), ["screen", "input.touch"]);
	assert.deepEqual(coreGroups("ios", "none"), ["screen", "input.touch"]);
});

test("kindRefusals: only the pairs of kind, os and daemon the spec lists are valid", () => {
	for (const [kind, os, daemon] of [
		["linux", "linux", "pid1"],
		["linux", "linux", "child"],
		["desktop", "linux", "pid1"],
		["desktop", "linux", "child"],
		["desktop", "linux", "none"],
		["android", "android", "none"],
		["ios", "ios", "none"],
	]) {
		assert.deepEqual(kindRefusals({ kind, os, daemon }), [], `${kind} ${os} ${daemon}`);
	}
	for (const [kind, os, daemon, words] of [
		["linux", "linux", "none", /a linux computer has daemon pid1 or child, not "none"/],
		["android", "android", "pid1", /daemon none, not "pid1"/],
		["ios", "linux", "none", /runs ios, not os "linux"/],
		["desktop", "android", "pid1", /runs linux or windows or macos, not os "android"/],
		["phone", "android", "none", /kind "phone" is not one of linux, desktop, android, ios/],
	]) {
		const refusals = kindRefusals({ kind, os, daemon });
		assert.equal(refusals.length, 1, `${kind} ${os} ${daemon}: ${JSON.stringify(refusals)}`);
		assert.equal(refusals[0].field, "kind");
		assert.match(refusals[0].message, words);
	}
});

test("checkLifetime: one rule for every provider: required, above 0, and at most maxLifetimeMs, in words", () => {
	const caps = { lifetime: "vendor", maxLifetimeMs: 24 * 60 * 60_000 };
	assert.deepEqual(checkLifetime(60_000, caps), []);
	assert.deepEqual(checkLifetime(caps.maxLifetimeMs, caps), []);
	const over = checkLifetime(caps.maxLifetimeMs + 1, caps);
	assert.deepEqual(over, [{ field: "lifetimeMs", message: "lifetimeMs is at most 1 day (86400000 ms), this provider's cap; ask for a new computer after that" }]);
	assert.match(checkLifetime(5 * 60_000 + 1, { lifetime: "vendor", maxLifetimeMs: 5 * 60_000 })[0].message, /at most 5 min \(300000 ms\)/);
	assert.match(checkLifetime(90_001, { lifetime: "vendor", maxLifetimeMs: 90_000 })[0].message, /at most 90 s \(90000 ms\)/);
	for (const lifetimeMs of [undefined, 0, -1, 1.5, Number.NaN, "60000"]) {
		const [refusal, ...rest] = checkLifetime(lifetimeMs, caps);
		assert.deepEqual(rest, []);
		assert.equal(refusal.field, "lifetimeMs");
		assert.match(refusal.message, /required.*after which the vendor ends the computer/);
	}
	assert.match(checkLifetime(0, { ...caps, lifetime: "janitor" })[0].message, /the janitor deletes the computer/);
});

test("KEYS is the spec's table, and a key is a name in it or one printable ASCII character", () => {
	assert.deepEqual(KEYS, [
		"enter", "tab", "space", "backspace", "delete", "escape", "insert",
		"up", "down", "left", "right", "home", "end", "pageup", "pagedown",
		"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
		"shift", "ctrl", "alt", "super", "capslock",
	]);
	for (const key of ["enter", "f12", "capslock", "a", "A", "1", "/", "~", "!"]) assert.equal(isKey(key), true, key);
	for (const key of ["Enter", "Return", "Hyper_Q", " ", "\t", "é", "ab", "", "F13", 1, null]) assert.equal(isKey(key), false, JSON.stringify(key));
	assert.deepEqual(GROUPS, ["exec", "files", "processes", "screen", "input.pointer", "input.keys", "input.touch", "apps", "apps.install", "apps.ui_tree", "cdp", "stream", "downloads"]);
});

test("checkActions: the whole batch first: its shape, its length, each key, each action's group, a pixel scroll and the summed wait", () => {
	const all = ["input.pointer", "input.keys", "input.touch"];
	const valid = [
		{ type: "move", at: [1, 2] },
		{ type: "down", button: "right" },
		{ type: "up" },
		{ type: "click", at: [3, 4], count: 3, keys: ["shift", "a"] },
		{ type: "drag", path: [[0, 0], [5, 5], [9, 9]] },
		{ type: "scroll", dy: -3, unit: "clicks" },
		{ type: "key", keys: ["ctrl", "s"], repeat: 2 },
		{ type: "hold", keys: ["alt"], ms: 100 },
		{ type: "type", text: "anything at all, ü too" },
		{ type: "tap", at: [5, 5], count: 2 },
		{ type: "long_press", at: [5, 5], ms: 800 },
		{ type: "swipe", path: [[1, 1], [2, 2]] },
		{ type: "pinch", at: [5, 5], scale: 0.5 },
		{ type: "button", name: "app_switch" },
		{ type: "wait", ms: 10 },
	];
	assert.equal(checkActions(valid, all), undefined);
	assert.equal(checkActions([], []), undefined, "an empty batch is valid anywhere");
	const failure = (actions, groups = all, options) => {
		const failed = checkActions(actions, groups, options);
		assert.ok(failed, `expected ${JSON.stringify(actions).slice(0, 120)} to be refused`);
		assert.ok(failed.message.length > 0);
		return [failed.index, failed.kind];
	};
	assert.deepEqual(failure("click"), [0, "invalid"]);
	assert.deepEqual(failure(Array.from({ length: MAX_ACTIONS + 1 }, () => ({ type: "wait", ms: 0 }))), [MAX_ACTIONS, "limit"]);
	assert.equal(checkActions(Array.from({ length: MAX_ACTIONS }, () => ({ type: "wait", ms: 0 })), all), undefined, "MAX_ACTIONS is allowed");
	assert.deepEqual(failure([{ type: "click", at: [1, 1] }, { type: "key", keys: ["Hyper_Q"] }]), [1, "invalid"]);
	assert.deepEqual(failure([{ type: "click", at: [1, 1], keys: ["Return"] }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "key", keys: [] }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "drag", path: [[1, 1]] }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "click", count: 4 }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "move", at: [1, "2"] }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "teleport" }]), [0, "invalid"]);
	assert.deepEqual(failure([null]), [0, "invalid"]);
	// A null is given (has is !== undefined), and is no number, point, list or name: the daemon's check pins the same.
	assert.deepEqual(failure([{ type: "click", at: [1, 1] }, { type: "move", at: [null, 20] }]), [1, "invalid"]);
	assert.deepEqual(failure([{ type: "move", at: null }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "click", at: null }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "wait", ms: null }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "hold", keys: ["shift"], ms: null }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "key", keys: ["a"], repeat: null }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "down", button: null }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "click", count: null }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "click", keys: null }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "drag", path: [[0, 0], [null, 1]] }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "scroll", dy: null, unit: "clicks" }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "scroll", dx: null, unit: "clicks" }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "type", text: null }]), [0, "invalid"]);
	assert.deepEqual(failure([{ type: "wait", ms: 1 }, { type: "tap", at: [1, 1] }], ["input.pointer"]), [1, "unsupported"]);
	assert.deepEqual(failure([{ type: "wait", ms: 1 }], []), [0, "unsupported"]);
	assert.deepEqual(failure([{ type: "scroll", dy: 10, unit: "px" }], all, { pixelScroll: false }), [0, "unsupported"]);
	assert.equal(checkActions([{ type: "scroll", dy: 10, unit: "px" }], all), undefined, "a pixel scroll where the implementer has one");
	assert.deepEqual(failure([{ type: "wait", ms: MAX_BATCH_WAIT_MS - 10 }, { type: "hold", keys: ["shift"], ms: 5 }, { type: "wait", ms: 6 }]), [2, "limit"]);
	assert.equal(checkActions([{ type: "wait", ms: MAX_BATCH_WAIT_MS }], all), undefined, "MAX_BATCH_WAIT_MS is allowed");
});

test("checkActions counts every duration toward the batch's cap and bounds a key's repeat (review: unbounded durations and repeat)", () => {
	const all = ["input.pointer", "input.keys", "input.touch"];
	const failure = (actions) => {
		const failed = checkActions(actions, all);
		assert.ok(failed, `expected ${JSON.stringify(actions)} to be refused`);
		assert.ok(failed.message.length > 0);
		return [failed.index, failed.kind];
	};
	assert.deepEqual(failure([{ type: "long_press", at: [1, 1], ms: 2 ** 52 }]), [0, "limit"]);
	assert.deepEqual(failure([{ type: "wait", ms: 200_000 }, { type: "swipe", path: [[1, 1], [2, 2]], ms: 100_001 }]), [1, "limit"]);
	assert.deepEqual(failure([{ type: "pinch", at: [1, 1], scale: 2, ms: MAX_BATCH_WAIT_MS + 1 }]), [0, "limit"]);
	assert.deepEqual(failure([{ type: "hold", keys: ["shift"], ms: 1 }, { type: "long_press", at: [1, 1], ms: MAX_BATCH_WAIT_MS }]), [1, "limit"]);
	assert.equal(checkActions([{ type: "long_press", at: [1, 1], ms: MAX_BATCH_WAIT_MS }], all), undefined, "a long press of the whole cap is allowed");
	// An ms on an action that has no duration is not counted: a negative one cannot buy back time (review: extra durations).
	assert.deepEqual(failure([{ type: "key", keys: ["a"], ms: -300_001 }, { type: "wait", ms: 600_001 }]), [1, "limit"]);
	assert.deepEqual(failure([{ type: "click", at: [1, 1], ms: -1 }, { type: "wait", ms: MAX_BATCH_WAIT_MS + 1 }]), [1, "limit"]);
	assert.equal(MAX_KEY_REPEAT, 100);
	assert.deepEqual(failure([{ type: "key", keys: ["a"], repeat: 1e9 }]), [0, "limit"]);
	assert.deepEqual(failure([{ type: "key", keys: ["a"], repeat: MAX_KEY_REPEAT + 1 }]), [0, "limit"]);
	assert.equal(checkActions([{ type: "key", keys: ["a"], repeat: MAX_KEY_REPEAT }], all), undefined, "MAX_KEY_REPEAT is allowed");
});

test("screen.screenshot-size reads no more than the largest PNG it accepts, however big the provider says the shot is (review: unbounded shot reads)", async () => {
	for (const [broken, words] of [
		["screen-huge-size", new RegExp(`says 1099511627776 bytes, more than ${MAX_PNG_BYTES} bytes`)],
		["screen-endless", /bytes read of 1048576, and still no eof/],
	]) {
		const { provider } = fakeDevices({ broken });
		const started = Date.now();
		const report = await run(provider, ["screen.screenshot-size"], { caseTimeoutMs: 20_000 });
		assert.equal(statuses(report)["screen.screenshot-size"], "fail", broken);
		assert.match(reasons(report)["screen.screenshot-size"], words, broken);
		assert.ok(Date.now() - started < 15_000, `${broken}: refused at once, not read to the case's timeout`);
	}
	assert.equal(MAX_PNG_BYTES, 2 ** 25 * 4 + 16_384 + 4 * 1024 * 1024);
});

test("checkActions refuses undefined among the keys, wherever it is, and does not let it hide a later bad key (review: undefined keys pass the check)", () => {
	for (const keys of [[undefined], ["a", undefined], [undefined, "Hyper_Q"]]) {
		const failed = checkActions([{ type: "key", keys }], ["input.keys"]);
		assert.ok(failed, `keys ${JSON.stringify(keys)} must be refused`);
		assert.deepEqual([failed.index, failed.kind], [0, "invalid"], JSON.stringify(keys));
		assert.match(failed.message, /^action 0: undefined is not a key/);
	}
	const later = checkActions([{ type: "click", at: [1, 1], keys: ["shift"] }, { type: "click", at: [1, 1], keys: [undefined] }], ["input.pointer", "input.keys"]);
	assert.deepEqual([later?.index, later?.kind], [1, "invalid"], "a click whose held keys hold undefined");
});

test("readPng reads a PNG's size and pixels, undoing its filters, and refuses what is not a PNG in words", () => {
	const image = readPng(png(7, 5, (x, y) => [x * 30, y * 50, (x + y) % 256]));
	assert.deepEqual([image.width, image.height], [7, 5]);
	assert.deepEqual(image.rgb(6, 4), [180, 200, 10]);
	assert.deepEqual(image.rgb(3, 1), [90, 50, 4]);
	assert.throws(() => image.rgb(7, 0), /outside the 7x5 screenshot/);
	assert.throws(() => readPng(Buffer.from("GIF89a and then some more bytes past thirty-three")), /not a PNG/);
});

test("readPng decodes every pixel when it reads: a valid IHDR with no IDAT, one that is not zlib, or short pixels is refused at once (review: unreadable screenshots pass)", () => {
	// 4x4 RGB: 4 rows of a filter byte and 12 bytes of pixels.
	assert.throws(() => readPng(pngOf({ width: 4, height: 4 })), /^Error: the screenshot's PNG has no IDAT$/);
	assert.throws(() => readPng(pngOf({ width: 4, height: 4, idat: Buffer.from("these bytes are not zlib") })), /^Error: the screenshot's PNG does not inflate: /);
	assert.throws(() => readPng(pngOf({ width: 4, height: 4, idat: deflateSync(Buffer.alloc(10)) })), /^Error: the screenshot's PNG holds 10 bytes of pixels, not the 52 its IHDR gives$/);
	assert.throws(() => readPng(pngOf({ width: 4, height: 4, idat: deflateSync(Buffer.alloc(52, 9)) })), /^Error: the screenshot's PNG has filter 9 on row 0$/);
	for (const fields of [{ depth: 16 }, { interlace: 1 }, { colorType: 5 }, { depth: 4, colorType: 3 }]) {
		const { depth = 8, colorType = 2, interlace = 0 } = fields;
		const words = `the screenshot's PNG is bit depth ${depth}, color type ${colorType}, interlace ${interlace}: the suite reads 8-bit, non-interlaced images`;
		assert.throws(() => readPng(pngOf({ width: 4, height: 4, ...fields, idat: deflateSync(Buffer.alloc(200)) })), { message: words }, JSON.stringify(fields));
	}
});

test("readPng holds what it inflates to the exact size IHDR gives and bounds the size: a zlib bomb is refused, not inflated (review: bad screenshots stall the runner)", () => {
	// 64 MiB of zeros, deflated to about 64 KiB, behind an IHDR of 16x16 RGB: 16 rows of 1 + 48 bytes.
	const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024));
	assert.ok(bomb.length < 128 * 1024, `the bomb is ${bomb.length} bytes`);
	assert.throws(() => readPng(pngOf({ width: 16, height: 16, idat: bomb })), { message: "the screenshot's PNG inflates past the 784 bytes its IHDR gives" });
	// One byte over is refused the same way: the bound is exact.
	assert.throws(() => readPng(pngOf({ width: 16, height: 16, idat: deflateSync(Buffer.alloc(785)) })), { message: "the screenshot's PNG inflates past the 784 bytes its IHDR gives" });
	assert.deepEqual(readPng(pngOf({ width: 16, height: 16, idat: deflateSync(Buffer.alloc(784)) })).rgb(15, 15), [0, 0, 0]);
	for (const [width, height] of [[0, 16], [16, 0], [16_385, 1], [1, 16_385], [8_193, 8_193], [2 ** 31, 2 ** 31]]) {
		assert.throws(
			() => readPng(pngOf({ width, height, idat: bomb })),
			{ message: `the screenshot's PNG is ${width}x${height}: the suite reads 1 to 16384 pixels a side and at most 33554432 pixels` },
			`${width}x${height}`,
		);
	}
});

test("a linux computer with computerd as PID 1, as Docker declares, skips every new case but kind-consistent in words, and passes Core", async () => {
	const { provider } = fakeComputers();
	const report = await run(provider, [...NEW_CASES, "provider.check-refuses"]);
	const skipped = Object.fromEntries(report.results.filter((r) => r.status === "skip").map((r) => [r.id, [r.reason, r.undeclared]]));
	assert.deepEqual(skipped, {
		"screen.screenshot-size": ["the provider does not declare screen", ["screen"]],
		"screen.watch": ["the provider does not declare screen", ["screen"]],
		"input.click-lands": ["the provider does not declare input.pointer", ["input.pointer"]],
		"input.type-text": ["the provider does not declare input.keys", ["input.keys"]],
		"input.key-table-refuses-unknown": ["the provider does not declare input.keys", ["input.keys"]],
		"input.actions-stops-at-first-failure": ["the provider does not declare input.pointer", ["input.pointer"]],
		"touch.tap": ["the provider does not declare input.touch", ["input.touch"]],
		"touch.swipe": ["the provider does not declare input.touch", ["input.touch"]],
		"touch.pinch": ["the provider does not declare input.touch", ["input.touch"]],
		"apps.install-launch": ["the provider does not declare apps.install", ["apps.install", "apps"]],
		"apps.ui-tree-shape": ["the provider does not declare apps.ui_tree", ["apps.ui_tree"]],
		"lifetime.extend": ["the provider has no extend()", ["extend"]],
	});
	assert.deepEqual(statuses(report)["health.kind-consistent"], "pass", reasons(report)["health.kind-consistent"]);
	assert.deepEqual(statuses(report)["provider.check-refuses"], "pass", reasons(report)["provider.check-refuses"]);
	assert.equal(report.core, "pass", formatReport(report));
	assert.deepEqual(report.undeclared, ["screen", "input.pointer", "input.keys", "input.touch", "apps.install", "apps", "apps.ui_tree", "extend"]);
	const text = formatReport(report).trimEnd().split("\n");
	assert.equal(text.at(-1), "core PASS 2/2 · 10 optional cases skipped, not declared · full 0/2 · screen input.pointer input.keys input.touch apps.install apps apps.ui_tree extend not declared");
	// A case its kind does not require is never filed under core: a linux computer's report has no core screen line.
	assert.deepEqual(text.filter((line) => /^core (screen|input|touch|apps) /.test(line)), [], text.join("\n"));
	assert.ok(text.some((line) => /^optional screen +screenshot-size watch +- 2$/.test(line)), text.join("\n"));
	assert.ok(text.includes("  - screen.screenshot-size: the provider does not declare screen"), text.join("\n"));
});

test("a desktop that declares screen, pointer and keys passes every desktop case against the fixture's log", async () => {
	const { provider } = fakeDevices();
	const report = await run(provider, DESKTOP_CASES);
	assert.deepEqual(reasons(report), {});
	assert.ok(report.results.every((r) => r.status === "pass"));
	assert.equal(report.core, "pass");
	assert.match(formatReport(report), /^computer conformance · fake-device · desktop, daemon pid1 · computerd 1\.0\.0 linux\/amd64\n/);
});

test("an Android phone with daemon none passes every phone case through its in-process client, on an open network", async () => {
	const { provider, made } = fakeDevices({ kind: "android" });
	const report = await run(provider, ["health.hello", "health.ping", ...PHONE_CASES]);
	assert.deepEqual(reasons(report), {});
	assert.ok(report.results.every((r) => r.status === "pass"));
	assert.equal(report.core, "pass");
	assert.ok(made.length > 0 && made.every(({ spec }) => spec.network === "open"), "a phone, whose kind does not require network none, is tested on open");
	assert.match(formatReport(report), /^computer conformance · fake-device · android, daemon none · the provider 1\.0\.0 android\/amd64\n/);
});

test("lifetime.extend passes a provider whose extend moves the deadline: the computer outlives its 45 s, and the cap from create and an earlier deadline are refused", { timeout: 120_000 }, async () => {
	const { provider } = fakeDevices();
	const report = await run(provider, ["lifetime.extend"]);
	assert.deepEqual(statuses(report), { "lifetime.extend": "pass" }, reasons(report)["lifetime.extend"]);
});

test("apps.launch-terminate needs apps alone: a phone with no UI tree and no files is seen launching Settings in its screenshot", async () => {
	const groups = ["screen", "input.touch", "apps"];
	const seen = await run(fakeDevices({ kind: "android", groups }).provider, ["apps.launch-terminate"]);
	assert.deepEqual(statuses(seen), { "apps.launch-terminate": "pass" }, reasons(seen)["apps.launch-terminate"]);
	// Its broken twin, launch-hidden on the same groups, is a BROKEN row below.
});

/** The lifetimes provider.deadline asked for, in order: the run's shared computer is not the case's. */
const deadlineLifetimes = (made) => made.filter(({ spec }) => spec.labels?.["agentrun.conformance.case"] === "deadline").map(({ spec }) => spec.lifetimeMs);

test("provider.deadline sees the end of a 45 s lifetime on the run's clock, with no wait in a test", { timeout: 10_000 }, async () => {
	const { provider, made } = fakeDevices();
	const report = await run(provider, ["provider.deadline"]);
	assert.deepEqual(statuses(report), { "provider.deadline": "pass" }, reasons(report)["provider.deadline"]);
	assert.deepEqual(deadlineLifetimes(made), [45_000]);
});

/**
 * provider.deadline on a host slow to start a computer, measured on a clock that reads no wall clock (virtualClock): the
 * fake's creates take exactly their createMs on it, so what the case computes from them is exact. The run's shared
 * computer is made first, at once; createMs then gives each of the case's creates in turn.
 */
const slowHost = (createMs) => {
	const clock = virtualClock();
	const { provider, made } = fakeDevices({ clock, createMs: [0, ...createMs] });
	return { made, ran: run(provider, ["provider.deadline"], { clock }) };
};

test("provider.deadline, when the first create outlasts its 45 s lifetime, asks once more for exactly 45 s past twice what create took, and passes", async () => {
	// 50 s of a 45 s lifetime fails as Docker's does; the retry asks for 45 + 2 x 50 = 145 s, takes 50 s, and leaves 95 s.
	const { made, ran } = slowHost([50_000, 50_000]);
	const report = await ran;
	assert.deepEqual(statuses(report), { "provider.deadline": "pass" }, reasons(report)["provider.deadline"]);
	assert.deepEqual(deadlineLifetimes(made), [45_000, 145_000]);
});

test("provider.deadline skips in words, never passes, when the retry is still too slow for its lifetime", async () => {
	const { made, ran } = slowHost([50_000, 1_000_000]);
	const report = await ran;
	assert.deepEqual(statuses(report), { "provider.deadline": "skip" });
	assert.equal(
		reasons(report)["provider.deadline"],
		"create took 1000 s of a lifetime of 145 s (the first took 50 s of 45 s): this host starts a computer too slowly for the case to watch its deadline; desktop-3's lifetime of 145 s ended before create finished (it took 1000 s)",
	);
	assert.deepEqual(deadlineLifetimes(made), [45_000, 145_000]);
	assert.equal(report.core, "fail", "a Core case that could not run is no pass");
});

/** For each case: a fake broken the way the case checks for, and what the failure says. */
const BROKEN = [
	["health.kind-consistent", { hello: { kind: "linux" } }, /hello's kind is the one the provider declares: expected "desktop", got "linux"/],
	["health.kind-consistent", { hello: { groups: ["exec", "files", "processes", "screen", "input.pointer"] } }, /hello's groups are the ones the provider declares/],
	["provider.check-refuses", { broken: "no-cap" }, /past maxLifetimeMs, refuses lifetimeMs in words/],
	["screen.screenshot-size", { broken: "screen-size" }, /the PNG's size \(IHDR\), against the shot's width and height: expected \[321,240\], got \[320,240\]/],
	["screen.screenshot-size", { broken: "screen-region" }, /the PNG of region \[80,60,160,120\]: its size/],
	["screen.screenshot-size", { broken: "screen-colors" }, /the fixture's top left quadrant, at \(50, 50\): expected \[255,0,0\], got \[255,255,0\]/],
	// Review (unreadable screenshots pass): every shot is decoded whole, on a phone too, and a region shot as well.
	["screen.screenshot-size", { broken: "screen-corrupt-idat" }, /^the shot: the screenshot's PNG does not inflate: /],
	["screen.screenshot-size", { kind: "android", broken: "screen-corrupt-idat" }, /^the shot: the screenshot's PNG does not inflate: /],
	["screen.screenshot-size", { kind: "android", broken: "screen-no-idat" }, /^the shot: the screenshot's PNG has no IDAT$/],
	["screen.screenshot-size", { kind: "android", broken: "screen-region-corrupt" }, /^the shot of region \[90,160,180,320\]: the screenshot's PNG does not inflate: /],
	["input.click-lands", { broken: "click-offset" }, /the fixture's log of a click at 40,60/],
	["input.type-text", { broken: "type-case" }, /the text the fixture got: expected "Hello, agentrun! 123", got "hello, agentrun! 123"/],
	["input.key-table-refuses-unknown", { broken: "no-precheck" }, /^done, for a batch whose second action names a key not in KEYS: expected 0, got 1/],
	["input.actions-stops-at-first-failure", { broken: "no-stop" }, /^done, for \[move to 50,50, left down, move off-screen to 100000,100000, click 150,150\]: expected 2, got 4/],
	// Review (held buttons go unchecked): the batch fails with the left button down, and the failure must release it.
	["input.actions-stops-at-first-failure", { broken: "no-release" }, /^the left button the stopped batch pressed at 50,50, released in the fixture's log: still not so/],
	["touch.tap", { kind: "android", broken: "tap-offset" }, /a tap at 180,256 was logged down at 185,256/],
	["touch.swipe", { kind: "android", broken: "swipe-stuck" }, /a swipe to 180,192 was logged ending at 180,448/],
	["touch.pinch", { kind: "android", broken: "pinch-together" }, /a pinch apart: the fingers went from 40 px apart to 20 px/],
	["apps.install-launch", { kind: "android", broken: "terminate-stays" }, /ai\.agentrun\.fixture no longer in front after apps\.terminate: still not so/],
	["apps.ui-tree-shape", { kind: "android", broken: "tree-types" }, /apps\.ui_tree: root\.children\[0\]\.enabled is "true", not a boolean/],
	["lifetime.extend", { broken: "extend-noop" }, /list\(\) shows the deadline .*, not the extended/],
	["lifetime.extend", { broken: "extend-past-cap" }, /extend past maxLifetimeMs \(7200001 ms\): expected an error, got ok/],
	// Review (lifetime boundaries go unchecked): the cap counts from create, and an extend never moves the deadline earlier.
	["lifetime.extend", { broken: "extend-shortens" }, /^extend to 60 s, earlier than the current deadline: expected an error, got ok/],
	["lifetime.extend", { broken: "extend-per-call" }, /^extend to 7170 s, past create \+ maxLifetimeMs \(7200000 ms\): expected an error, got ok/],
	["screen.watch", { broken: "watch-stale" }, /a pointer move to \d+,\d+ gave no new frame/],
	["screen.watch", { broken: "watch-size" }, /the first frame's (JPEG|PNG) is \d+x\d+, not the \d+x\d+ it says/],
	// Review (missing cursors pass; unreadable frames pass): a move must show the cursor where it went, and a frame decodes.
	["screen.watch", { broken: "watch-no-cursor" }, /a pointer move to \d+,\d+ gave no frame with the cursor there/],
	["screen.watch", { broken: "watch-corrupt-png" }, /^the first frame's PNG does not decode: the screenshot's PNG does not inflate/],
	["screen.watch", { broken: "watch-corrupt-jpeg" }, /^the first frame's JPEG does not decode: .*no scan/],
	["apps.launch-terminate", { kind: "android", groups: ["screen", "input.touch", "apps"], broken: "launch-hidden" }, /^com\.android\.settings shown after apps\.launch: a screenshot other than the one before it/],
];

for (const [id, options, words] of BROKEN) {
	test(`${id} fails a fake that is broken (${JSON.stringify(options)})`, async () => {
		const { provider } = fakeDevices(options);
		const report = await run(provider, [id], { patience: BROKEN_PATIENCE });
		assert.equal(statuses(report)[id], "fail", `${id}: ${reasons(report)[id] ?? "passed"}`);
		assert.match(reasons(report)[id], words);
	});
}

test("every case of the device groups is failed by some broken fake: one added without one turns this red", () => {
	// Read from the cases the suite runs, not a list kept by hand: the hand list could not miss a case it never named.
	const guarded = conformanceCases.filter((c) => ["screen", "input", "touch", "apps", "lifetime"].includes(c.group) || c.id === "health.kind-consistent").map((c) => c.id);
	assert.ok(guarded.length >= NEW_CASES.length, "the device groups hold every case named above");
	const failed = new Set(BROKEN.map(([id]) => id));
	assert.deepEqual(
		guarded.filter((id) => !failed.has(id)),
		[],
		"a case no broken fake fails",
	);
});

test("a Core case whose group the kind requires fails when it is not declared; an optional one skips and Core still passes", async () => {
	const missing = fakeDevices({ groups: ["exec", "files", "processes", "screen", "input.pointer"] });
	const report = await run(missing.provider, ["health.kind-consistent", "input.type-text", "input.click-lands"]);
	assert.deepEqual(statuses(report), { "health.kind-consistent": "fail", "input.type-text": "fail", "input.click-lands": "pass" });
	assert.equal(reasons(report)["health.kind-consistent"], "a desktop computer with daemon pid1 must declare input.keys");
	assert.equal(reasons(report)["input.type-text"], "a desktop computer with daemon pid1 must declare input.keys: the provider does not declare input.keys");
	assert.equal(report.core, "fail");
	assert.deepEqual(report.undeclared, []);

	const desktopWithApps = fakeDevices({ extend: false, stream: false });
	const optional = await run(desktopWithApps.provider, ["input.click-lands", "touch.tap", "apps.ui-tree-shape", "screen.watch"]);
	assert.deepEqual(statuses(optional), { "input.click-lands": "pass", "touch.tap": "skip", "apps.ui-tree-shape": "skip", "screen.watch": "pass" }, formatReport(optional));
	assert.equal(optional.core, "pass", formatReport(optional));
	assert.deepEqual(optional.undeclared, ["input.touch", "apps.ui_tree"]);
	assert.match(formatReport(optional), /core PASS 2\/2 · 2 optional cases skipped, not declared/);
	assert.match(formatReport(optional), /^core input +click-lands +✓ 1$/m, "a group its kind requires stays under core");
	assert.match(formatReport(optional), /^optional touch +tap +- 1$/m);
});

test("a phone that declares neither files nor apps.ui_tree skips the touch cases: no way to observe the effect", async () => {
	const { provider } = fakeDevices({ kind: "android", groups: ["screen", "input.touch"] });
	const report = await run(provider, ["touch.tap", "touch.swipe"]);
	assert.deepEqual(statuses(report), { "touch.tap": "skip", "touch.swipe": "skip" });
	assert.equal(reasons(report)["touch.tap"], "no way to observe the effect: declare files or apps.ui_tree");
	assert.equal(report.core, "fail", "a skip for no way to observe is not a skip for an undeclared group: Core cannot pass on it");
});

test("a case that needs the fixture skips in words when the run was given none, and Core cannot pass on that skip", async () => {
	const { provider } = fakeDevices();
	const report = await runConformance(provider, { image: IMAGE, cases: byId("input.click-lands"), patience: 1000 });
	assert.deepEqual(statuses(report), { "input.click-lands": "skip" });
	assert.match(reasons(report)["input.click-lands"], /^no fixture was given: --fixture names computerd-fixture for a desktop/);
	assert.equal(report.core, "fail");
});

test("a fixture that starts but never logs ready is stopped when its case fails, on a desktop and on a phone (review: failed fixtures stay running)", async () => {
	const desktop = fakeDevices({ broken: "fixture-never-ready", chunk: 1 << 20 });
	let afterwards;
	const desktopCases = [
		{ id: "input.with-fixture", level: "core", group: "input", needs: [], run: async (t) => void (await t.fixture()) },
		{ id: "input.after-it", level: "core", group: "input", needs: [], run: async (t) => void (afterwards = readPng(Buffer.from((await t.call("screen.shot", {})).data, "base64")).rgb(50, 50)) },
	];
	const desktopReport = await runConformance(desktop.provider, { image: IMAGE, cases: desktopCases, fixture: FIXTURE, patience: BROKEN_PATIENCE });
	assert.deepEqual(statuses(desktopReport), { "input.with-fixture": "fail", "input.after-it": "pass" }, JSON.stringify(reasons(desktopReport)));
	assert.match(reasons(desktopReport)["input.with-fixture"], /^the desktop fixture logged ready: still not so/);
	assert.deepEqual(afterwards, [40, 40, 40], "the bare screen after the case whose fixture never logged ready: the fixture was stopped");

	const phone = fakeDevices({ kind: "android", broken: "fixture-never-ready" });
	let foreground;
	const phoneCases = [
		{ id: "apps.with-fixture", level: "core", group: "apps", needs: [], run: async (t) => void (await t.fixture()) },
		{ id: "apps.after-it", level: "core", group: "apps", needs: [], run: async (t) => void ({ foreground } = await t.call("apps.list", {})) },
	];
	const phoneReport = await runConformance(phone.provider, { image: IMAGE, cases: phoneCases, fixture: FIXTURE, patience: BROKEN_PATIENCE });
	assert.deepEqual(statuses(phoneReport), { "apps.with-fixture": "fail", "apps.after-it": "pass" }, JSON.stringify(reasons(phoneReport)));
	assert.match(reasons(phoneReport)["apps.with-fixture"], /^the fixture app logged ready: still not so/);
	assert.equal(foreground, null, "the app in front after the case whose fixture app never logged ready: it was terminated");
});

test("the fixture a case started is stopped when the case ends", async () => {
	const { provider } = fakeDevices({ chunk: 1 << 20 });
	const corner = async (t) => readPng(Buffer.from((await t.call("screen.shot", {})).data, "base64")).rgb(50, 50);
	let during;
	let afterwards;
	const cases = [
		{ id: "input.with-fixture", level: "core", group: "input", needs: [], run: async (t) => void (await t.fixture(), (during = await corner(t))) },
		{ id: "input.after-it", level: "core", group: "input", needs: [], run: async (t) => void (afterwards = await corner(t)) },
	];
	const report = await runConformance(provider, { image: IMAGE, cases, fixture: FIXTURE, patience: 1000 });
	assert.deepEqual(statuses(report), { "input.with-fixture": "pass", "input.after-it": "pass" }, JSON.stringify(reasons(report)));
	assert.deepEqual([during, afterwards], [[255, 0, 0], [40, 40, 40]], "the fixture's top left quadrant during its case, and the bare screen after");
});
