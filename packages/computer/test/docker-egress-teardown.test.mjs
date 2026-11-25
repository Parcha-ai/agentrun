// A Docker computer's egress proxy goes with it, against the fake docker in test/fake-docker.mjs: on a release, on a
// create cut off by its caller after the computer ran, and on a create whose computer never started, whatever became of
// the computer's own removal; and a teardown that stops partway (the process that ran it ended) never leaves a proxy
// running with no computer. The sweep of what computers left behind removes only what its caller owns. No Docker is
// needed.
import assert from "node:assert/strict";
import test from "node:test";
import { sweep } from "../dist/index.js";
import { computerNameFor } from "../dist/provider.js";
import { allowed, fakeDocker, idOf } from "./fake-docker.mjs";

const A = "computer-0000000000aa";
const ALLOW = ["pypi.org"];
const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: { allow: ALLOW } };
const ref = (name) => ({ id: idOf(name), name });
const proxyOf = (name) => `${name}-egress`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `check` holds, inside the 60 s the fake holds a step for: each docker call is a process of its own, slow
 *  on a loaded host. */
const until = async (check) => {
	for (const end = Date.now() + 50_000; Date.now() < end && !check(); ) await wait(20);
};

test("release(delete) removes the egress proxy even when the computer's own removal never ends, and fails naming the computer", async () => {
	const { provider, names } = fakeDocker({ ...allowed({ name: A, allow: ALLOW }), removing: { [A]: null } });
	const released = await provider.release(ref(A), "delete");
	assert.equal(released.ok, false, "the computer is still there: the release says so");
	assert.match(released.error.message, new RegExp(A));
	assert.ok(!names().includes(proxyOf(A)), `the proxy is gone; left: ${names().join(", ")}`);
});

test("a release that stops between its docker calls (the process that ran it ended) never leaves the proxy running without its computer", async () => {
	const { provider, calls, names, proceed } = fakeDocker({ ...allowed({ name: A, allow: ALLOW }), hold: ["ps"] });
	try {
		const pending = provider.release(ref(A), "delete");
		// The release's first look for the proxy, held: this is as far as a release that ended here got.
		await until(() => calls().some((args) => args[0] === "ps"));
		assert.ok(calls().some((args) => args[0] === "ps"), "the release looked for the proxy");
		const there = names();
		assert.ok(!there.includes(proxyOf(A)) || there.includes(A), `a release cut here leaves the proxy with no computer: ${there.join(", ")}`);
		proceed("ps");
		assert.deepEqual(await pending, { ok: true, value: undefined });
		assert.deepEqual(names(), []);
	} finally {
		proceed("ps");
	}
});

test("create() cut off by its caller after the computer ran removes the proxy even when the computer's removal never ends", async () => {
	const requestId = "teardown-cut";
	const name = computerNameFor(requestId);
	const { provider, calls, names, proceed } = fakeDocker({ hold: ["hello"], removing: { [name]: null } });
	const controller = new AbortController();
	try {
		const pending = provider.create(SPEC, { requestId, signal: controller.signal });
		// The computer ran, and create waits on its daemon's hello: the run is cut there.
		await until(() => calls().some((args) => args[0] === "exec"));
		assert.ok(names().includes(name) && names().includes(proxyOf(name)), `the computer and its proxy ran: ${names().join(", ")}`);
		controller.abort();
		const made = await pending;
		assert.equal(made.ok, false);
		assert.equal(made.error.code, "aborted", made.error.message);
		assert.ok(!names().includes(proxyOf(name)), `the proxy is gone; left: ${names().join(", ")}`);
	} finally {
		proceed("hello");
	}
});

test("create() whose proxy is up and whose computer never started removes the proxy even when the computer's removal never ends", async () => {
	const requestId = "teardown-partial";
	const name = computerNameFor(requestId);
	// The computer's docker run makes its container and fails to start it (exit 125, left Created), and Docker never
	// finishes removing it.
	const { provider, names } = fakeDocker({ runFails: true, removing: { [name]: null } });
	const made = await provider.create(SPEC, { requestId });
	assert.equal(made.ok, false);
	assert.match(made.error.message, /^docker run failed: /);
	assert.ok(!names().includes(proxyOf(name)), `the proxy is gone; left: ${names().join(", ")}`);
});

test("the sweep of leftovers removes only the proxies and volumes its caller owns: another owner's, and a live computer's, stay", async () => {
	const runOf = (run) => ({ "agentrun.run": run });
	const leftOf = (name, run) => {
		const made = allowed({ name, allow: ALLOW, labels: runOf(run) });
		return { containers: made.containers.filter((one) => one.Name !== `/${name}`), volumes: made.volumes };
	};
	const B = "computer-0000000000bb"; // this owner's run, its computer gone
	const C = "computer-0000000000cc"; // another owner's run, its computer gone
	const live = allowed({ name: A, allow: ALLOW, labels: runOf("run-mine") });
	const mine = leftOf(B, "run-mine");
	const theirs = leftOf(C, "run-theirs");
	const { provider, names, volumeNames } = fakeDocker({
		containers: [...live.containers, ...mine.containers, ...theirs.containers],
		volumes: [...live.volumes, ...mine.volumes, ...theirs.volumes],
	});
	const asked = [];
	const swept = await sweep(provider, { now: new Date(), mine: (labels) => (asked.push(labels["agentrun.run"]), labels["agentrun.run"] === "run-mine") });
	assert.equal(swept.ok, true, JSON.stringify(swept));
	assert.deepEqual(swept.value.leftovers.sort(), [proxyOf(B), `${proxyOf(B)} (volume)`]);
	assert.deepEqual(names().sort(), [A, proxyOf(A), proxyOf(C)]);
	assert.deepEqual(volumeNames().sort(), [proxyOf(A), proxyOf(C)]);
	assert.ok(asked.includes("run-theirs"), "the owner was asked of the other run's leftovers");
});
