// The janitor against a fake provider: no Docker needed.
import assert from "node:assert/strict";
import test from "node:test";
import { ownerLabels, sweep } from "../dist/index.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const at = (ms) => new Date(NOW.getTime() + ms);

/** A provider that lists `computers` ({name, deadline, labels?, detachedAt?}) and records every list and release. */
function fakeProvider(computers, { lifetime = "janitor", failRelease = [], listed, maxLifetimeMs = 30 * 86_400_000, persistence } = {}) {
	const calls = [];
	const provider = {
		id: "fake",
		version: "0",
		capabilities: () => ({ kind: "linux", lifetime, network: ["none"], isolation: "container", os: "linux", daemon: "pid1", groups: ["exec"], maxLifetimeMs, ...(persistence ? { persistence } : {}) }),
		async list(labels, context) {
			calls.push(["list", labels, context?.signal instanceof AbortSignal]);
			if (listed) return listed;
			const infos = computers.map(({ name, deadline, state = "running", labels = {}, detachedAt, owned, owner }) => ({
				ref: { id: `id-${name}`, name },
				labels,
				deadline,
				state,
				network: "none",
				...(detachedAt ? { detachedAt } : {}),
				...(owned === undefined ? {} : { owned }),
				...(owner === undefined ? {} : { owner }),
			}));
			return { ok: true, value: infos };
		},
		async release(ref, how) {
			calls.push(["release", ref.name, how]);
			if (failRelease.includes(ref.name)) return { ok: false, error: { code: "vendor", vendor: "docker", message: `cannot remove ${ref.name}` } };
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

test("sweep() deletes a stopped computer past its deadline as it does a running one: a computer stops itself then", async () => {
	const { provider, calls } = fakeProvider([
		{ name: "stopped-past", deadline: at(-1), state: "stopped" },
		{ name: "running-past", deadline: at(-1), state: "running" },
		{ name: "stopped-future", deadline: at(60_000), state: "stopped" },
		{ name: "stopped-missing", deadline: undefined, state: "stopped" },
	]);
	assert.deepEqual(await sweep(provider, { now: NOW }), { ok: true, value: { deleted: ["stopped-past", "running-past", "stopped-missing"], kept: 1 } });
	assert.deepEqual(
		calls.filter(([what]) => what === "release"),
		[
			["release", "stopped-past", "delete"],
			["release", "running-past", "delete"],
			["release", "stopped-missing", "delete"],
		],
	);
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

const PERSISTS = { keepsState: true, resume: false };
const agent = (id, idleTtlMs) => ownerLabels({ agent: id, ...(idleTtlMs === undefined ? {} : { idleTtlMs }) });

test("sweep() never deletes an agent's computer by a deadline: past, missing or unreadable, it is kept", async () => {
	const { provider, calls } = fakeProvider(
		[
			{ name: "owned-past", deadline: at(-1), labels: agent("a1") },
			{ name: "owned-none", deadline: undefined, labels: agent("a1"), state: "stopped", detachedAt: at(-86_400_000) },
			{ name: "run-past", deadline: at(-1) },
		],
		{ persistence: PERSISTS },
	);
	assert.deepEqual(await sweep(provider, { now: NOW }), { ok: true, value: { deleted: ["run-past"], kept: 2 } });
	assert.deepEqual(calls.filter(([what]) => what === "release"), [["release", "run-past", "delete"]]);
});

test("sweep() of a provider that declares no persistence keeps no agent's computer: an owner label a caller put on a run's spec, or an info marked owned, keeps nothing past its deadline", async () => {
	const { provider, calls } = fakeProvider([
		{ name: "labelled-past", deadline: at(-1), labels: agent("a1") },
		{ name: "unreadable-past", deadline: at(-1), labels: { "agentrun.owner": "nobody" } },
		{ name: "marked-past", deadline: at(-1), owned: true },
		{ name: "labelled-ahead", deadline: at(60_000), labels: agent("a1") },
	]);
	assert.deepEqual(await sweep(provider, { now: NOW }), { ok: true, value: { deleted: ["labelled-past", "unreadable-past", "marked-past"], kept: 1 } });
	assert.deepEqual(calls.filter(([what]) => what === "release").map(([, , how]) => how), ["delete", "delete", "delete"]);
});

test("sweep() keeps a computer its provider lists as owned, with no owner label and no deadline; a run's computer with no deadline is still swept", async () => {
	const { provider, calls } = fakeProvider(
		[
			{ name: "owned", deadline: undefined, owned: true },
			{ name: "owned-known", deadline: undefined, owned: true, owner: { agent: "gone" } },
			{ name: "run-none", deadline: undefined },
		],
		{ persistence: PERSISTS },
	);
	assert.deepEqual(await sweep(provider, { now: NOW }), { ok: true, value: { deleted: ["run-none"], kept: 2 } });
	assert.deepEqual(calls.filter(([what]) => what === "release"), [["release", "run-none", "delete"]]);
	// An owned info whose owner the listing knows still goes by its owner's rules: gone, it is deleted.
	assert.deepEqual(await sweep(provider, { now: NOW, ownerGone: (id) => id === "gone" }), { ok: true, value: { deleted: ["owned-known", "run-none"], kept: 1 } });
});

test("sweep() deletes an agent's computer whose owner is gone, by the caller's answer, and keeps one whose owner is there", async () => {
	const { provider } = fakeProvider(
		[
			{ name: "gone-owner", deadline: undefined, labels: agent("gone") },
			{ name: "kept-owner", deadline: undefined, labels: agent("here") },
		],
		{ persistence: PERSISTS },
	);
	const asked = [];
	const ownerGone = async (id) => (asked.push(id), id === "gone");
	assert.deepEqual(await sweep(provider, { now: NOW, ownerGone }), { ok: true, value: { deleted: ["gone-owner"], kept: 1 } });
	assert.deepEqual(asked, ["gone", "here"]);
});

test("sweep() deletes an agent's computer detached for longer than its owner's idle TTL; one attached, or detached for less, or with no TTL, is kept", async () => {
	const { provider } = fakeProvider(
		[
			{ name: "idle-long", deadline: undefined, labels: agent("a1", 3_600_000), state: "stopped", detachedAt: at(-3_600_000) },
			{ name: "idle-short", deadline: undefined, labels: agent("a1", 3_600_000), state: "stopped", detachedAt: at(-3_599_999) },
			{ name: "attached", deadline: undefined, labels: agent("a1", 1) },
			{ name: "no-ttl", deadline: undefined, labels: agent("a1"), state: "stopped", detachedAt: at(-30 * 86_400_000) },
		],
		{ persistence: PERSISTS },
	);
	assert.deepEqual(await sweep(provider, { now: NOW }), { ok: true, value: { deleted: ["idle-long"], kept: 3 } });
});

test("sweep() keeps a computer whose owner label cannot be read: it never deletes an agent's state on a rule it cannot read", async () => {
	const { provider, calls } = fakeProvider(
		[
			{ name: "odd-owner", deadline: at(-1), labels: { "agentrun.owner": "nobody" } },
			{ name: "odd-ttl", deadline: at(-1), labels: { "agentrun.owner": "agent:a1", "agentrun.idle-ttl-ms": "soon" }, state: "stopped", detachedAt: at(-86_400_000) },
		],
		{ persistence: PERSISTS },
	);
	assert.deepEqual(await sweep(provider, { now: NOW, ownerGone: () => true }), { ok: true, value: { deleted: [], kept: 2 } });
	assert.deepEqual(calls.filter(([what]) => what === "release"), []);
});

test("sweep() of a provider that declares persistence under lifetime vendor sweeps its agents' computers alone; its vendor ends the rest", async () => {
	const { provider } = fakeProvider(
		[
			{ name: "run-past", deadline: at(-1) },
			{ name: "gone-owner", deadline: undefined, labels: agent("gone") },
		],
		{ lifetime: "vendor", persistence: PERSISTS },
	);
	assert.deepEqual(await sweep(provider, { now: NOW, ownerGone: (id) => id === "gone" }), { ok: true, value: { deleted: ["gone-owner"], kept: 1 } });
});

test("sweep() returns list's error as it is", async () => {
	const failed = { ok: false, error: { code: "vendor", vendor: "docker", message: "the docker CLI (docker) was not found" } };
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
	assert.deepEqual([swept.error.code, swept.error.vendor], ["vendor", "docker"], "the first failure's code and vendor are kept");
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

test("sweep() counts a deadline more than maxLifetimeMs past now as unreadable, and deletes it; a minute of skew is kept", async () => {
	const hour = 3_600_000;
	const { provider } = fakeProvider(
		[
			{ name: "at-cap", deadline: at(hour) },
			{ name: "skewed", deadline: at(hour + 59_000) },
			{ name: "past-cap", deadline: at(hour + 61_000) },
			{ name: "far", deadline: at(365 * 86_400_000) },
		],
		{ maxLifetimeMs: hour },
	);
	const swept = await sweep(provider, { now: NOW });
	assert.deepEqual(swept, { ok: true, value: { deleted: ["past-cap", "far"], kept: 2 } });
});

test("sweep() of a provider that declares no maxLifetimeMs keeps a far deadline: no over-cap line it cannot read", async () => {
	const { provider } = fakeProvider([{ name: "far", deadline: at(365 * 86_400_000) }], { maxLifetimeMs: null });
	assert.deepEqual(await sweep(provider, { now: NOW }), { ok: true, value: { deleted: [], kept: 1 } });
});

test("sweep() of a provider with sweepLeftovers removes what its computers left behind after the computers, with the same labels and time, and reports it", async () => {
	const { provider, calls } = fakeProvider([{ name: "past", deadline: at(-1) }, { name: "future", deadline: at(1) }]);
	provider.sweepLeftovers = async ({ labels, now, signal }) => {
		calls.push(["sweepLeftovers", labels, now.toISOString(), signal instanceof AbortSignal]);
		return { ok: true, value: ["gone-egress", "gone-egress (volume)"] };
	};
	const swept = await sweep(provider, { now: NOW, labels: { team: "a" }, signal: new AbortController().signal });
	assert.deepEqual(swept, { ok: true, value: { deleted: ["past"], kept: 1, leftovers: ["gone-egress", "gone-egress (volume)"] } });
	assert.deepEqual(calls.map((call) => call[0]), ["list", "release", "sweepLeftovers"], "the computers first: a released computer takes its own parts");
	assert.deepEqual(calls.at(-1), ["sweepLeftovers", { team: "a" }, NOW.toISOString(), true]);
	// Its failure is the sweep's, after the computers it deleted, in words.
	provider.sweepLeftovers = async () => ({ ok: false, error: { code: "vendor", vendor: "docker", message: "docker volume rm x failed" } });
	const failed = await sweep(provider, { now: NOW });
	assert.equal(failed.ok, false);
	assert.deepEqual([failed.error.code, failed.error.vendor], ["vendor", "docker"]);
	assert.match(failed.error.message, /deleted past.*could not remove what its computers left behind: docker volume rm x failed/);
});
