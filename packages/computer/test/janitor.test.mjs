// The janitor against a fake provider: no Docker needed.
import assert from "node:assert/strict";
import test from "node:test";
import { sweep } from "../dist/index.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const at = (ms) => new Date(NOW.getTime() + ms);

/** A provider that lists `computers` ({name, deadline}) and records every list and release. */
function fakeProvider(computers, { lifetime = "janitor", failRelease = [], listed } = {}) {
	const calls = [];
	const provider = {
		id: "fake",
		version: "0",
		capabilities: () => ({ lifetime, network: ["none"], isolation: "container", os: "linux", daemon: ["exec"] }),
		async list(labels, context) {
			calls.push(["list", labels, context?.signal instanceof AbortSignal]);
			if (listed) return listed;
			const infos = computers.map(({ name, deadline }) => ({ ref: { id: `id-${name}`, name }, labels: {}, deadline, state: "running", network: "none" }));
			return { ok: true, value: infos };
		},
		async release(ref, how) {
			calls.push(["release", ref.name, how]);
			if (failRelease.includes(ref.name)) return { ok: false, error: { code: "docker", message: `cannot remove ${ref.name}` } };
			return { ok: true, value: undefined };
		},
	};
	return { provider, calls };
}

test("sweep() deletes every computer whose deadline has passed and keeps the rest", async () => {
	const { provider, calls } = fakeProvider([
		{ name: "past", deadline: at(-1) },
		{ name: "now", deadline: at(0) },
		{ name: "future", deadline: at(1) },
		{ name: "later", deadline: at(86_400_000) },
	]);
	const swept = await sweep(provider, { now: NOW, labels: { team: "a" } });
	assert.deepEqual(swept, { ok: true, value: { deleted: ["past", "now"], kept: 2 } });
	assert.deepEqual(calls, [
		["list", { team: "a" }, false],
		["release", "past", "delete"],
		["release", "now", "delete"],
	]);
});

test("sweep() deletes a computer whose deadline is missing or unreadable: it fails closed", async () => {
	const { provider } = fakeProvider([
		{ name: "missing", deadline: undefined },
		{ name: "unreadable", deadline: new Date("never") },
		{ name: "future", deadline: at(60_000) },
	]);
	assert.deepEqual(await sweep(provider, { now: NOW }), { ok: true, value: { deleted: ["missing", "unreadable"], kept: 1 } });
});

test("sweep() with no labels lists every computer, and compares with the time now by default", async () => {
	const { provider, calls } = fakeProvider([
		{ name: "past", deadline: new Date(Date.now() - 60_000) },
		{ name: "future", deadline: new Date(Date.now() + 600_000) },
	]);
	assert.deepEqual(await sweep(provider), { ok: true, value: { deleted: ["past"], kept: 1 } });
	assert.deepEqual(calls[0], ["list", {}, false]);
});

test("sweep() refuses a provider whose vendor ends computers itself, with no call", async () => {
	const { provider, calls } = fakeProvider([{ name: "past", deadline: at(-1) }], { lifetime: "vendor" });
	const swept = await sweep(provider, { now: NOW });
	assert.equal(swept.ok, false);
	assert.equal(swept.error.code, "refused");
	assert.match(swept.error.message, /lifetime "vendor".*ends its computers itself/);
	assert.deepEqual(calls, []);
});

test("sweep() returns list's error as it is", async () => {
	const failed = { ok: false, error: { code: "docker", message: "the docker CLI (docker) was not found" } };
	const { provider } = fakeProvider([], { listed: failed });
	assert.deepEqual(await sweep(provider, { now: NOW }), failed);
});

test("sweep() goes on past a computer it cannot delete, then says which it deleted and which it could not", async () => {
	const { provider, calls } = fakeProvider(
		[
			{ name: "a", deadline: at(-1) },
			{ name: "b", deadline: at(-1) },
			{ name: "c", deadline: at(-1) },
		],
		{ failRelease: ["b"] },
	);
	const swept = await sweep(provider, { now: NOW });
	assert.equal(swept.ok, false);
	assert.equal(swept.error.code, "docker");
	assert.match(swept.error.message, /deleted a, c/);
	assert.match(swept.error.message, /cannot remove b/);
	assert.deepEqual(calls.filter(([what]) => what === "release").map(([, name]) => name), ["a", "b", "c"]);
});

test("sweep() stops when aborted, and says what it had deleted", async () => {
	const before = fakeProvider([{ name: "a", deadline: at(-1) }]);
	const aborted = await sweep(before.provider, { now: NOW, signal: AbortSignal.abort() });
	assert.equal(aborted.ok, false);
	assert.equal(aborted.error.code, "aborted");
	assert.deepEqual(before.calls, []);

	const controller = new AbortController();
	const { provider, calls } = fakeProvider([
		{ name: "a", deadline: at(-1) },
		{ name: "b", deadline: at(-1) },
	]);
	const release = provider.release;
	provider.release = async (ref, how) => {
		const released = await release(ref, how);
		controller.abort();
		return released;
	};
	const midway = await sweep(provider, { now: NOW, signal: controller.signal });
	assert.equal(midway.ok, false);
	assert.equal(midway.error.code, "aborted");
	assert.match(midway.error.message, /deleted a/);
	assert.deepEqual(calls.filter(([what]) => what === "release").map(([, name]) => name), ["a"]);
	assert.equal(calls[0][2], true, "the signal is passed to list");
});

test("sweep() refuses a now that is not a time, with no call", async () => {
	const { provider, calls } = fakeProvider([{ name: "a", deadline: at(-1) }]);
	for (const now of [new Date("never"), "2026-11-06", 0]) {
		const swept = await sweep(provider, { now });
		assert.equal(swept.ok, false);
		assert.equal(swept.error.code, "invalid");
	}
	assert.deepEqual(calls, []);
});
