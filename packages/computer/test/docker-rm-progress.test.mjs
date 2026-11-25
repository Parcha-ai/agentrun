// DockerProvider against the fake docker in test/fake-docker.mjs when a container's removal is already under way: docker
// rm answers "removal of container ... is already in progress", which means the container is going away. Each removal
// waits, bounded, until it is gone and then counts it removed; one still there when the bound runs out fails in words that
// name it. No Docker is needed.
import assert from "node:assert/strict";
import test from "node:test";
import { DockerProvider } from "../dist/docker.js";
import { releaseOlder, runLabels } from "../dist/index.js";
import { computerNameFor } from "../dist/provider.js";
import { allowed, container, fakeDocker, idOf } from "./fake-docker.mjs";

const A = "computer-0000000000aa";
const B = "computer-0000000000bb";
const ALLOW = ["pypi.org"];
const PAST = "2026-01-01T00:00:00.000Z";
const ref = (name) => ({ id: idOf(name), name });
/** The inspects of `key` after the first rm of it: the provider looking until it is gone. */
const looksAfterRm = (calls, key) => {
	const all = calls();
	const rm = all.findIndex((args) => args[0] === "rm" && args.at(-1) === key);
	return rm < 0 ? 0 : all.slice(rm + 1).filter((args) => args[0] === "inspect" && args.at(-1) === key).length;
};

test("release(delete) of a computer whose removal is already under way waits until it is gone, then is ok", async () => {
	const { provider, calls, names } = fakeDocker({ containers: [container({ name: A })], removing: { [A]: 400 } });
	const released = await provider.release(ref(A), "delete");
	assert.deepEqual(released, { ok: true, value: undefined });
	assert.deepEqual(names(), []);
	assert.ok(looksAfterRm(calls, A) >= 1, "the provider looked until the container was gone");
});

test("releaseOlder at epoch 2 releases an epoch-1 computer whose removal is already under way", async () => {
	const { provider, names } = fakeDocker({ containers: [container({ name: A, labels: runLabels("r", 1) })], removing: { [A]: 400 } });
	const released = await releaseOlder(provider, "r", 2);
	assert.equal(released.ok, true, JSON.stringify(released));
	assert.deepEqual(released.value.released.map((one) => one.name), [A]);
	assert.deepEqual(names(), []);
});

test("release(delete) of an allowlist computer whose proxy's removal is already under way waits for the proxy, then removes its volume", async () => {
	const seeded = allowed({ name: A, allow: ALLOW });
	const { provider, calls, names, volumeNames } = fakeDocker({ ...seeded, removing: { "-egress": 400 } });
	const released = await provider.release(ref(A), "delete");
	assert.deepEqual(released, { ok: true, value: undefined });
	assert.deepEqual([names(), volumeNames()], [[], []]);
	assert.ok(looksAfterRm(calls, idOf(`${A}-egress`)) >= 1, "the provider looked until the proxy was gone");
});

test("sweepLeftovers removes a leftover proxy whose removal is already under way, and then its volume", async () => {
	const seeded = allowed({ name: B, allow: ALLOW, deadline: PAST });
	const proxy = seeded.containers.find((one) => one.Name === `/${B}-egress`);
	const { provider, names, volumeNames } = fakeDocker({ containers: [proxy], volumes: seeded.volumes, removing: { "-egress": 400 } });
	const swept = await provider.sweepLeftovers({ now: new Date() });
	assert.deepEqual(swept, { ok: true, value: [`${B}-egress`, `${B}-egress (volume)`] });
	assert.deepEqual([names(), volumeNames()], [[], []]);
});

test("create() whose proxy ends before it is ready, and whose proxy's removal is already under way, says its proxy and volume were removed", async () => {
	const { provider, names, volumeNames } = fakeDocker({ egress: "exits", removing: { "-egress": 400 } });
	const made = await provider.create({ image: "debian:bookworm-slim", lifetimeMs: 600_000, network: { allow: ALLOW } }, { requestId: "rm-progress-proxy" });
	assert.equal(made.ok, false);
	assert.match(made.error.message, /egress proxy .* ended .*; the computer computer-[0-9a-f]{12} was never run, and its proxy and volume were removed$/);
	assert.deepEqual([names(), volumeNames()], [[], []]);
});

test("create() whose docker run made the container and failed, while that container's removal is already under way, waits for it and removes its proxy and volume too", async () => {
	const requestId = "rm-progress-run";
	const name = computerNameFor(requestId);
	const { provider, calls, names, volumeNames } = fakeDocker({ runFails: true, removing: { [name]: 400 } });
	const made = await provider.create({ image: "debian:bookworm-slim", lifetimeMs: 600_000, network: { allow: ALLOW } }, { requestId });
	assert.equal(made.ok, false);
	assert.match(made.error.message, /^docker run failed: .*OCI runtime create failed/);
	assert.deepEqual([names(), volumeNames()], [[], []], "the computer, its proxy and its volume are all gone");
	assert.ok(looksAfterRm(calls, idOf(name)) >= 1, "the provider looked until the computer was gone");
});

test("a removal already under way that never ends fails release(delete) once the bound runs out, in words that name the container", { timeout: 5_000 }, async () => {
	// The bound is the provider's settleMs, set far below its default 10 s: the test waits out a bound of its own.
	const { provider, names } = fakeDocker({ containers: [container({ name: A })], removing: { [A]: null }, settleMs: 300 });
	const started = Date.now();
	const released = await provider.release(ref(A), "delete");
	assert.equal(released.ok, false);
	assert.deepEqual([released.error.code, released.error.vendor], ["vendor", "docker"]);
	assert.equal(released.error.message, `docker rm ${A} failed: docker answered that the removal of ${A} was already in progress, and it was still there when the 0.3 s bound ran out`);
	assert.ok(Date.now() - started >= 300, "it waited out the bound");
	assert.deepEqual(names(), [A]);
});

test("at the provider's default bound (no settleMs given), a removal already under way that never ends fails release(delete) after 10 s, in words that name it", { timeout: 30_000 }, async () => {
	// The one test that waits out the production bound, SETTLE_MS, on purpose: every other one sets a short settleMs.
	const { provider, names } = fakeDocker({ containers: [container({ name: A })], removing: { [A]: null } });
	const released = await provider.release(ref(A), "delete");
	assert.equal(released.ok, false);
	assert.deepEqual([released.error.code, released.error.vendor], ["vendor", "docker"]);
	assert.equal(released.error.message, `docker rm ${A} failed: docker answered that the removal of ${A} was already in progress, and it was still there when the 10 s bound ran out`);
	assert.deepEqual(names(), [A]);
});

test("the bounds a test may set (settleMs, settleQuietMs) are whole milliseconds above 0 that a timer can hold; anything else is refused when the provider is made", () => {
	for (const bad of [0, -1, 1.5, 2 ** 31, Number.NaN, "300"]) {
		for (const name of ["settleMs", "settleQuietMs"]) {
			assert.throws(() => new DockerProvider({ daemonPath: "/nonexistent", [name]: bad }), new RegExp(`^Error: the provider's ${name} must be a whole number of milliseconds above 0`), `${name}: ${String(bad)}`);
		}
	}
	assert.doesNotThrow(() => new DockerProvider({ daemonPath: "/nonexistent", settleMs: 300, settleQuietMs: 100 }));
});

test("sweepLeftovers aborted while a proxy's removal is under way ends aborted, naming the proxy", async () => {
	const seeded = allowed({ name: B, allow: ALLOW, deadline: PAST });
	const proxy = seeded.containers.find((one) => one.Name === `/${B}-egress`);
	const { provider } = fakeDocker({ containers: [proxy], removing: { "-egress": null } });
	const swept = await provider.sweepLeftovers({ now: new Date(), signal: AbortSignal.timeout(1_000) });
	assert.equal(swept.ok, false);
	assert.equal(swept.error.code, "aborted");
	assert.equal(swept.error.message, `docker rm of the egress proxy ${B}-egress was aborted while docker was still removing ${idOf(`${B}-egress`)}`);
});
