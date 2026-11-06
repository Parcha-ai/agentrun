// DockerProvider's attach, list and network against the fake docker in test/fake-docker.mjs: no Docker needed.
import assert from "node:assert/strict";
import test from "node:test";
import { sweep } from "../dist/index.js";
import { container, fakeDocker, idOf, valuesOf } from "./fake-docker.mjs";

const A = "computer-0000000000aa";
const B = "computer-0000000000bb";
const PAST = "2026-01-01T00:00:00.000Z";

/** a: no network, team a, running; b: open, team b, stopped; plus containers this provider does not count. */
const seeded = (options = {}) =>
	fakeDocker({
		containers: [
			container({ name: A, labels: { team: "a", run: "1" } }),
			container({ name: B, labels: { team: "b", run: "1" }, network: "bridge", running: false, deadline: PAST }),
			container({ name: "computer-0000000000cc", labels: { team: "a", run: "1" }, computer: false }),
			container({ name: "postgres", labels: { team: "a", run: "1" } }),
		],
		...options,
	});

test("attach() by name or by container id finds the computer, with one inspect", async () => {
	const { provider, calls } = seeded();
	const want = { id: idOf(A), name: A };
	assert.deepEqual(await provider.attach({ id: A }), { ok: true, value: want });
	assert.deepEqual(await provider.attach({ id: idOf(A) }), { ok: true, value: want });
	assert.deepEqual(await provider.attach({ id: idOf(A).slice(0, 12) }), { ok: true, value: want });
	assert.deepEqual(calls(), [
		["inspect", "--type", "container", "--format", "{{json .}}", A],
		["inspect", "--type", "container", "--format", "{{json .}}", idOf(A)],
		["inspect", "--type", "container", "--format", "{{json .}}", idOf(A).slice(0, 12)],
	]);
});

test("attach() by id is not_found for a container that is gone or not a computer", async () => {
	const { provider } = seeded();
	for (const id of ["computer-0000000000dd", "computer-0000000000cc", idOf("computer-0000000000cc"), idOf("postgres")]) {
		const attached = await provider.attach({ id });
		assert.equal(attached.ok, false, id);
		assert.equal(attached.error.code, "not_found", id);
		assert.match(attached.error.message, /no Docker computer/);
	}
});

test("attach() refuses an id that is neither a computer's name nor a container id, with no docker call", async () => {
	const { provider, calls } = seeded();
	for (const ref of [{ id: "postgres" }, { id: "computer-xyz" }, { id: "--all" }, { id: "abc" }, { id: "0".repeat(65) }, {}, { id: 7 }, { id: A, labels: { team: "a" } }]) {
		const attached = await provider.attach(ref);
		assert.equal(attached.ok, false, JSON.stringify(ref));
		assert.equal(attached.error.code, "invalid", JSON.stringify(ref));
	}
	assert.deepEqual(calls(), []);
});

test("attach() by labels finds exactly one computer, else says how many match", async () => {
	const { provider, calls } = seeded();
	assert.deepEqual(await provider.attach({ labels: { team: "a" } }), { ok: true, value: { id: idOf(A), name: A } });
	assert.deepEqual(valuesOf(calls()[0], "--filter"), ["label=agentrun.computer=1", "label=team=a"]);
	const two = await provider.attach({ labels: { run: "1" } });
	assert.equal(two.ok, false);
	assert.equal(two.error.code, "invalid");
	assert.match(two.error.message, /2 computers match/);
	const none = await provider.attach({ labels: { team: "z" } });
	assert.equal(none.ok, false);
	assert.equal(none.error.code, "not_found");
	assert.match(none.error.message, /no Docker computer/);
});

test("attach() and list() refuse labels docker cannot filter by, with no docker call", async () => {
	const { provider, calls } = seeded();
	for (const labels of [{}, { "": "a" }, { "a=b": "c" }, { team: 1 }, { "team\0": "a" }, { team: "a\0" }, null, ["team"]]) {
		const attached = await provider.attach({ labels });
		assert.equal(attached.ok, false, JSON.stringify(labels));
		assert.equal(attached.error.code, "invalid", JSON.stringify(labels));
	}
	for (const labels of [{ "": "a" }, { "a=b": "c" }, { team: 1 }, null]) {
		const listed = await provider.list(labels);
		assert.equal(listed.ok, false, JSON.stringify(labels));
		assert.equal(listed.error.code, "invalid", JSON.stringify(labels));
	}
	assert.deepEqual(calls(), []);
});

test("list() reads back every computer with the labels: its labels, deadline, state and network", async () => {
	const { provider, calls } = seeded();
	const listed = await provider.list({});
	assert.equal(listed.ok, true, JSON.stringify(listed));
	const byName = Object.fromEntries(listed.value.map((info) => [info.ref.name, info]));
	assert.deepEqual(Object.keys(byName).sort(), [A, B], "neither a container without the label nor one not named as a computer");
	assert.deepEqual(byName[A].ref, { id: idOf(A), name: A });
	assert.equal(byName[A].labels.team, "a");
	assert.ok(byName[A].deadline instanceof Date);
	assert.ok(byName[A].deadline.getTime() > Date.now());
	assert.equal(byName[A].state, "running");
	assert.equal(byName[A].network, "none");
	assert.equal(byName[B].deadline.toISOString(), PAST);
	assert.equal(byName[B].state, "stopped");
	assert.equal(byName[B].network, "open");
	const [ps, inspect] = calls();
	assert.deepEqual(ps.slice(0, 1), ["ps"]);
	assert.ok(ps.includes("-a") && ps.includes("--no-trunc"), JSON.stringify(ps));
	assert.deepEqual(valuesOf(ps, "--filter"), ["label=agentrun.computer=1"]);
	assert.deepEqual(inspect.slice(0, 4), ["inspect", "--type", "container", "--format"]);
	assert.notEqual(inspect[4], "{{json .}}", "list reads only the fields it reports, not the whole inspect");
	const team = await provider.list({ team: "b" });
	assert.deepEqual(team.value.map((info) => info.ref.name), [B]);
	assert.deepEqual(valuesOf(calls()[2], "--filter"), ["label=agentrun.computer=1", "label=team=b"]);
});

test("list() reports a missing or unreadable deadline as undefined", async () => {
	const { provider } = fakeDocker({
		containers: [container({ name: A, deadline: null }), container({ name: B, deadline: "soon" })],
	});
	const listed = await provider.list({});
	assert.equal(listed.ok, true);
	assert.deepEqual(listed.value.map((info) => info.deadline), [undefined, undefined]);
});

test("list() with no match makes no inspect, and a computer gone between ps and inspect is left out", async () => {
	const empty = seeded();
	assert.deepEqual(await empty.provider.list({ team: "z" }), { ok: true, value: [] });
	assert.deepEqual(empty.calls().map((args) => args[0]), ["ps"]);
	const racing = seeded({ vanish: [B] });
	const listed = await racing.provider.list({});
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.deepEqual(listed.value.map((info) => info.ref.name), [A]);
});

test("network() reads back none, open, or what else the computer is on, never wider", async () => {
	const host = "computer-0000000000ee";
	const { provider } = fakeDocker({
		containers: [
			container({ name: A }),
			container({ name: B, network: "bridge" }),
			container({ name: host, network: "host" }),
			{ ...container({ name: "computer-0000000000ff" }), NetworkSettings: { Networks: { none: {}, extra: {} } } },
		],
	});
	assert.deepEqual(await provider.network({ id: idOf(A), name: A }), { ok: true, value: "none" });
	assert.deepEqual(await provider.network({ id: idOf(B), name: B }), { ok: true, value: "open" });
	const other = await provider.network({ id: idOf(host), name: host });
	assert.equal(other.ok, true);
	assert.match(other.value.other, /host/);
	const joined = await provider.network({ id: "x", name: "computer-0000000000ff" });
	assert.equal(joined.ok, true);
	assert.match(joined.value.other, /extra/);
});

test("network() with the policy the computer has returns it; any change is refused in words", async () => {
	const { provider, calls } = seeded();
	const a = { id: idOf(A), name: A };
	assert.deepEqual(await provider.network(a, "none"), { ok: true, value: "none" });
	const opened = await provider.network(a, "open");
	assert.equal(opened.ok, false);
	assert.equal(opened.error.code, "refused");
	assert.match(opened.error.message, /a Docker computer's network is fixed at create; create a new computer/);
	const closed = await provider.network({ id: idOf(B), name: B }, "none");
	assert.equal(closed.ok, false);
	assert.equal(closed.error.code, "refused");
	assert.match(closed.error.message, /fixed at create/);
	const before = calls().length;
	for (const policy of [{ allow: ["example.com"] }, "wifi"]) {
		const refused = await provider.network(a, policy);
		assert.equal(refused.ok, false);
		assert.equal(refused.error.code, "refused");
	}
	assert.equal(calls().length, before, "a policy Docker never sets is refused with no docker call");
});

test("network() refuses a name this provider does not make, and is not_found for a container that is not a computer", async () => {
	const { provider, calls } = seeded();
	const invalid = await provider.network({ id: "x", name: "postgres" });
	assert.equal(invalid.error.code, "invalid");
	assert.deepEqual(calls(), []);
	for (const name of ["computer-0000000000cc", "computer-0000000000dd"]) {
		const missing = await provider.network({ id: "x", name });
		assert.equal(missing.ok, false);
		assert.equal(missing.error.code, "not_found", name);
	}
});

test("sweep() on Docker deletes the stopped computer past its deadline, since list() lists stopped computers too", async () => {
	const { provider, calls, names } = seeded();
	const swept = await sweep(provider, { labels: { run: "1" }, now: new Date("2026-06-01T00:00:00.000Z") });
	assert.deepEqual(swept, { ok: true, value: { deleted: [B], kept: 1 } });
	assert.ok(calls().some((args) => args[0] === "rm" && args.at(-1) === B));
	assert.deepEqual(names().sort(), [A, "computer-0000000000cc", "postgres"].sort(), "only the expired computer is gone");
});

test("list() inspects at most 50 computers a call, and only the fields it reports, so a fleet past one inspect's 16 MiB is listed whole", async () => {
	// Each container's whole inspect is over 40 KB here: 500 of them in one inspect would pass 16 MiB.
	const pad = "x".repeat(40_000);
	const fleet = Array.from({ length: 500 }, (_, i) => {
		const made = container({ name: `computer-${i.toString(16).padStart(12, "0")}`, labels: { fleet: "1" }, deadline: i < 5 ? PAST : undefined });
		made.Config.Env = [`PAD=${pad}`];
		return made;
	});
	const vanished = fleet[7].Name.slice(1);
	const { provider, calls, names } = fakeDocker({ containers: fleet, vanish: [vanished] });
	const listed = await provider.list({ fleet: "1" });
	assert.equal(listed.ok, true, listed.ok ? "" : listed.error.message.slice(0, 300));
	assert.equal(listed.value.length, 499);
	assert.ok(!listed.value.some((info) => info.ref.name === vanished), "a computer gone between ps and inspect is left out");
	const first = listed.value.find((info) => info.ref.name === fleet[0].Name.slice(1));
	assert.deepEqual(first.ref, { id: fleet[0].Id, name: fleet[0].Name.slice(1) });
	assert.equal(first.labels.fleet, "1");
	assert.equal(first.deadline.toISOString(), PAST);
	assert.equal(first.state, "running");
	assert.equal(first.network, "none");
	const inspects = calls().filter((args) => args[0] === "inspect");
	assert.ok(inspects.every((args) => args.length - 5 <= 50), `batch sizes ${inspects.map((args) => args.length - 5)}`);
	assert.equal(inspects.reduce((sum, args) => sum + args.length - 5, 0), 500);
	const swept = await sweep(provider, { labels: { fleet: "1" }, now: new Date("2026-06-01T00:00:00.000Z") });
	assert.equal(swept.ok, true, swept.ok ? "" : swept.error.message.slice(0, 300));
	const expired = fleet.slice(0, 5).map((made) => made.Name.slice(1));
	assert.deepEqual(swept.value.deleted.sort(), expired);
	assert.equal(swept.value.kept, 494);
	assert.equal(names().length, 495);
	assert.ok(!names().some((name) => expired.includes(name)));
});
