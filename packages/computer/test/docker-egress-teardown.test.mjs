// A Docker computer's egress proxy goes with it, against the fake docker in test/fake-docker.mjs: on a release, on a
// create cut off by its caller after the computer ran, and on a create whose computer never started, whatever became of
// the computer's own removal; and a teardown that stops partway (the process that ran it ended) never leaves a proxy
// running with no computer. The sweep of what computers left behind removes only what its caller owns. No Docker is
// needed.
import assert from "node:assert/strict";
import test from "node:test";
import { sweep } from "../dist/index.js";
import { computerNameFor } from "../dist/provider.js";
import { allowed, fakeDocker, idOf, proxyReport } from "./fake-docker.mjs";

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

test("what may be deleted (1): the leftover sweep never touches a part with neither a run nor an owner label, nor a container or volume named like a proxy that lacks the egress label, even one with the caller's run label", async () => {
	const runOf = (run) => ({ "agentrun.run": run });
	// Each one's computer gone, made long ago: a leftover by every rule but its labels.
	const leftOf = (name, labels) => {
		const made = allowed({ name, allow: ALLOW, labels });
		return { containers: made.containers.filter((one) => one.Name !== `/${name}`), volumes: made.volumes };
	};
	const bare = leftOf("computer-0000000000a1", {}); // the egress label alone: no agentrun.run, no owner
	const named = "computer-0000000000a2-egress"; // a proxy's name, with no label of ours at all
	const namedMine = "computer-0000000000a4-egress"; // a proxy's name and the caller's run label, but never the egress label
	const mine = leftOf("computer-0000000000a3", runOf("run-mine")); // the caller's own, so the sweep is seen to run
	const { provider, names, volumeNames, calls } = fakeDocker({
		containers: [...bare.containers, proxyReport({ id: idOf(named), name: named, labels: {}, cmd: [] }), proxyReport({ id: idOf(namedMine), name: namedMine, labels: runOf("run-mine"), cmd: [] }), ...mine.containers],
		volumes: [...bare.volumes, { Name: named, Labels: {} }, { Name: namedMine, Labels: runOf("run-mine") }, ...mine.volumes],
	});
	const swept = await sweep(provider, { now: new Date(), mine: (labels) => labels["agentrun.run"] === "run-mine" });
	assert.equal(swept.ok, true, JSON.stringify(swept));
	assert.deepEqual(swept.value.leftovers.sort(), [proxyOf("computer-0000000000a3"), `${proxyOf("computer-0000000000a3")} (volume)`]);
	assert.deepEqual(names().sort(), [proxyOf("computer-0000000000a1"), named, namedMine]);
	assert.deepEqual(volumeNames().sort(), [proxyOf("computer-0000000000a1"), named, namedMine]);
	const removed = calls().filter((args) => args[0] === "rm" || (args[0] === "volume" && args[1] === "rm")).flat();
	assert.ok(!removed.some((arg) => arg === named || arg === idOf(named) || arg === namedMine || arg === idOf(namedMine) || arg === proxyOf("computer-0000000000a1") || arg === idOf(proxyOf("computer-0000000000a1"))), `no rm named either: ${JSON.stringify(removed)}`);
});

test("what may be deleted (3): the leftover sweep never removes the proxy of a computer that is there, though its deadline has passed", async () => {
	// A computer still running past its deadline label (a clock that moved, or init not yet done): its proxy is its own,
	// and the computer's release (the janitor's, which removes both in one call) is the only way it goes.
	const PAST = "2026-01-01T00:00:00.000Z";
	const { provider, names, volumeNames } = fakeDocker(allowed({ name: A, allow: ALLOW, deadline: PAST, labels: { "agentrun.run": "run-mine" } }));
	const swept = await provider.sweepLeftovers({ now: new Date() });
	assert.equal(swept.ok, true, JSON.stringify(swept));
	assert.deepEqual(swept.value, []);
	assert.deepEqual([names().sort(), volumeNames()], [[A, proxyOf(A)], [proxyOf(A)]]);
});

test("what may be deleted (3): a computer made while the leftover sweep runs keeps its proxy, though the sweep's first look found no computer and the proxy is older than a create could take", async () => {
	const C = "computer-0000000000c0";
	const made = allowed({ name: C, allow: ALLOW, labels: { "agentrun.run": "run-mine" } });
	const computer = made.containers.find((one) => one.Name === `/${C}`);
	// The proxy, made long ago (allowed's default), and no computer yet: a create under way that is slow.
	const { provider, calls, names, add, proceed } = fakeDocker({ containers: made.containers.filter((one) => one !== computer), volumes: made.volumes, hold: ["inspect"] });
	try {
		const pending = provider.sweepLeftovers({ now: new Date(), mine: () => true });
		// The sweep has read the computers (none) and listed the proxies, and inspects them: the create finishes now.
		await until(() => calls().some((args) => args[0] === "inspect"));
		assert.ok(calls().some((args) => args[0] === "inspect"), "the sweep inspected the proxies");
		add([computer]);
		proceed("inspect");
		const swept = await pending;
		assert.equal(swept.ok, true, JSON.stringify(swept));
		assert.deepEqual(swept.value, [], "nothing of a computer that is there is a leftover");
		assert.deepEqual(names().sort(), [C, proxyOf(C)]);
		assert.ok(!calls().some((args) => args[0] === "rm"), "no rm at all");
	} finally {
		proceed("inspect");
	}
});

test("what may be deleted (3): a leftover whose computer cannot be read is kept: a failed read is never a gone computer", async () => {
	const made = allowed({ name: A, allow: ALLOW, labels: { "agentrun.run": "run-mine" } });
	const { provider, names, volumeNames, calls } = fakeDocker({ containers: made.containers.filter((one) => one.Name !== `/${A}`), volumes: made.volumes, inspectFails: [A] });
	const swept = await provider.sweepLeftovers({ now: new Date(), mine: () => true });
	assert.equal(swept.ok, true, JSON.stringify(swept));
	assert.deepEqual(swept.value, []);
	assert.deepEqual([names(), volumeNames()], [[proxyOf(A)], [proxyOf(A)]]);
	assert.ok(calls().some((args) => args[0] === "inspect" && args.at(-1) === A), "the computer was read");
	assert.ok(!calls().some((args) => args[0] === "rm" || (args[0] === "volume" && args[1] === "rm")), "no removal");
});

test("what may be deleted (2): a Docker leftover with an owner label is never removed, even when its caller calls it its own: Docker makes no agent's computer", async () => {
	const owners = [{ "agentrun.owner": "agent:agent-1", "agentrun.owner-server": "0123456789ab" }, { "agentrun.owner": "agent:agent-1" }, { "agentrun.owner-server": "0123456789ab" }];
	const parts = owners.map((owner, at) => {
		const name = `computer-00000000000${at + 1}`;
		const made = allowed({ name, allow: ALLOW, labels: { "agentrun.run": "run-mine", ...owner } });
		return { containers: made.containers.filter((one) => one.Name !== `/${name}`), volumes: made.volumes };
	});
	const { provider, names, volumeNames } = fakeDocker({ containers: parts.flatMap((one) => one.containers), volumes: parts.flatMap((one) => one.volumes) });
	const swept = await provider.sweepLeftovers({ now: new Date(), mine: () => true });
	assert.equal(swept.ok, true, JSON.stringify(swept));
	assert.deepEqual(swept.value, []);
	assert.equal(names().length, 3);
	assert.equal(volumeNames().length, 3);
});
