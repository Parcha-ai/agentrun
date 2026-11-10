// OrgoProvider against a fake Orgo (test/fake-orgo.mjs): the REST calls through a fake fetch, and everything inside a
// computer through a fake OrgoChannel with a fake computerd behind its stdio bridge. Design (a): computerd runs in the
// Orgo VM, on Orgo's own X display, so the desktop is the same wire as every computer. No key is read from the
// environment, none leaves the Authorization header, and nothing reaches the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { kindOf, serves, sweep } from "../dist/index.js";
import { API, fakeOrgoApi, fakeOrgoChannel, KEY, LABELS_PATH, VNC, WORKSPACE } from "./fake-orgo.mjs";

const orgo = await import("../dist/orgo.js");
const { CAPABILITIES, create, MOUNT, OrgoProvider, orgoName } = orgo;

const RUN = "run-7f3a";
const SPEC = { image: "linux", lifetimeMs: 30 * 60_000, network: "none", labels: { "agentrun.run": RUN, "agentrun.epoch": "3", team: "a" } };
const HOUR = 3_600_000;
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 500, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5 };
const dir = mkdtempSync(join(tmpdir(), "computer-orgo-"));
const DAEMON_PATH = join(dir, "computerd");
const DAEMON_BYTES = Buffer.from("a stand-in for computerd, linux/amd64\n");
writeFileSync(DAEMON_PATH, DAEMON_BYTES);
test.after(() => rmSync(dir, { recursive: true, force: true }));

function setup(options = {}, { api: apiOptions = {}, channel: channelOptions = {} } = {}) {
	const api = fakeOrgoApi(apiOptions);
	const channel = fakeOrgoChannel(channelOptions);
	const provider = create({ apiKey: KEY, workspaceId: WORKSPACE, apiUrl: API, fetch: api.fetch, channel, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...options });
	return { api, channel, provider };
}
/** The key is in an Authorization header and nowhere else: no body, no path, no result, no error. */
const keyless = (value, what) => assert.ok(!JSON.stringify(value ?? null).includes(KEY), `${what} holds the key`);
const secretless = (value, what) => {
	keyless(value, what);
	assert.ok(!JSON.stringify(value ?? null).includes(VNC), `${what} holds the VNC password`);
};
const only = (api) => [...api.computers.values()].at(-1);

/** A computer as create leaves one, seeded into both fakes: its record, its labels file, init running. */
function seeded({ api, channel }, { labels = SPEC.labels, status = "running", deadline = new Date(Date.now() + 30 * 60_000).toISOString(), max = new Date(Date.now() + 720 * HOUR).toISOString(), name, file } = {}) {
	const record = api.add({ name: name ?? orgoName(labels, "0123456789ab", new Date(deadline)), status, ends_at: new Date(Date.now() + HOUR).toISOString() });
	const box = channel.boxOf(record.id);
	box.labels = file ?? JSON.stringify({ name: record.name, labels, deadline, maxDeadline: max, image: "linux", cpus: 1, memoryMb: 4096 });
	box.daemon = { path: "/opt/agentrun/computerd", bytes: DAEMON_BYTES };
	box.init = { deadline, user: "2510:2510", uid: 2510, gid: 2510, display: ":99", max, ownNetwork: true };
	return { record, box, ref: { id: record.id, name: record.name } };
}

test("Orgo: the provider takes its key and workspace as options, reads no environment, and says what is missing without the key", async () => {
	const api = fakeOrgoApi();
	assert.throws(() => create({ workspaceId: WORKSPACE, fetch: api.fetch }), /apiKey/);
	assert.throws(() => create({ apiKey: KEY, fetch: api.fetch }), (error) => /workspaceId/.test(error.message) && !error.message.includes(KEY));
	assert.throws(() => create({ apiKey: KEY, workspaceId: WORKSPACE, fetch: api.fetch, apiUrl: "http://orgo.example/api" }), /https/);
	assert.throws(() => create({ apiKey: KEY, workspaceId: WORKSPACE, fetch: api.fetch, user: "0:0" }), /root/);
	const built = create({ apiKey: KEY, workspaceId: WORKSPACE, fetch: api.fetch });
	assert.ok(built instanceof OrgoProvider);
	assert.equal(built.id, "orgo");
	assert.deepEqual(MOUNT, []);
	assert.deepEqual(
		CAPABILITIES,
		[
			{ kind: "desktop", groups: ["exec", "files", "processes", "screen", "input.pointer", "input.keys"] },
			{ kind: "desktop", groups: ["exec", "files", "screen", "input.pointer", "input.keys"] },
			{ kind: "desktop", groups: ["exec", "screen", "input.pointer", "input.keys"] },
		],
		"what a built provider declares, known without building one: the Linux desktop, then Windows and macOS (orgo-desktop.test.mjs)",
	);
	assert.equal(orgo.ENV, undefined, "the library names no environment variable");
	assert.equal(orgo.fromEnv, undefined, "every setting is an option");
	assert.deepEqual(api.requests, [], "building a provider calls nothing");
});

test("Orgo testConnection: one read of the workspace, which makes nothing; ok with the count; a refused key is unauthorized, in words without it", async () => {
	const fakes = setup();
	seeded(fakes);
	fakes.api.add({ name: "someone-elses-desktop" });
	const tested = await fakes.provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /Orgo answered: 1 computer of this provider/);
	assert.deepEqual(fakes.api.routes(), [`GET /workspaces/${WORKSPACE}`], "one account-level read, and no create");
	assert.deepEqual(fakes.channel.calls, [], "nothing runs in a computer");
	const refused = await create({ apiKey: "not-a-secret", workspaceId: WORKSPACE, apiUrl: API, fetch: fakes.api.fetch }).testConnection();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "unauthorized");
	assert.ok(!refused.error.message.includes("not-a-secret"));
});

test("Orgo: a Linux desktop with computerd as a child of Orgo's own agent, network none, Orgo's lifetime, delete, no mount; it serves the desktop kind", () => {
	const { provider } = setup();
	assert.deepEqual(provider.capabilities(), {
		kind: "desktop",
		lifetime: "janitor",
		network: ["none"],
		networkReadBack: false,
		isolation: "vm",
		os: "linux",
		daemon: "child",
		groups: ["exec", "files", "processes", "screen", "input.pointer", "input.keys"],
		maxLifetimeMs: 720 * HOUR,
		release: ["delete"],
		mount: [],
		vendorAgentPorts: [5999, 6080, 8080],
	});
	assert.equal(serves(provider.capabilities(), "desktop"), true);
	assert.equal(kindOf(provider.capabilities()), "desktop");
	assert.equal(typeof provider.extend, "function");
});

test("Orgo check(): network none, Orgo's sizes, at most 720 h, a template or the base image; no user, workdir, pids or mount; labels outside the provider's namespace", () => {
	const { provider, api } = setup();
	assert.deepEqual(provider.check(SPEC), []);
	assert.deepEqual(provider.check({ ...SPEC, image: "default/my-desktop@1.0.0", cpus: 2, memoryMb: 8192 }), []);
	for (const [change, field, words] of [
		[{ network: "open" }, "network", /none/],
		[{ network: { allow: ["example.com"] } }, "network", /none/],
		[{ memoryMb: 3000 }, "memoryMb", /4096, 8192, 16384 or 32768/],
		[{ cpus: 3 }, "cpus", /0\.5, 1, 2, 4 or 6/],
		[{ lifetimeMs: 721 * HOUR }, "lifetimeMs", /at most/],
		[{ image: "ubuntu:22.04" }, "image", /template/],
		[{ user: "1000:1000" }, "user", /2510:2510/],
		[{ workdir: "/srv" }, "workdir", /\/work/],
		[{ pids: 100 }, "pids", /pids/],
		[{ mount: { kind: "bind", path: "/" } }, "mount", /no mount kind/],
		[{ labels: { "agentrun.computer.name": "x" } }, "labels", /namespace/],
	]) {
		const refusals = provider.check({ ...SPEC, ...change });
		assert.ok(refusals.some((r) => r.field === field && words.test(r.message)), `${JSON.stringify(change)}: ${JSON.stringify(refusals)}`);
	}
	assert.deepEqual(api.requests, [], "check calls nothing");
});

test("Orgo names: computer-<12 hex>, then the run's hash and the epoch when the labels carry them; nothing else of a label", () => {
	assert.equal(orgoName({}, "0123456789ab"), "computer-0123456789ab");
	const name = orgoName(SPEC.labels, "0123456789ab");
	assert.match(name, /^computer-0123456789ab-r[a-z2-7]{16}-e3$/);
	assert.equal(name, orgoName({ ...SPEC.labels, team: "b" }, "0123456789ab"), "only the run and the epoch are in a name");
	assert.notEqual(name, orgoName({ ...SPEC.labels, "agentrun.run": "run-other" }, "0123456789ab"));
	assert.ok(!name.includes(RUN), "the run is hashed, never written as given");
	assert.ok(orgoName({ "agentrun.run": "x".repeat(4000), "agentrun.epoch": String(Number.MAX_SAFE_INTEGER) }, "0123456789ab", new Date(8.64e15)).length <= 80, "a name Orgo can hold");
	// The janitor's deadline, in whole seconds (rounded up, so never before init's own) in base 36: list() reads it.
	const at = new Date("2026-11-08T22:33:04.733Z");
	assert.equal(orgoName(SPEC.labels, "0123456789ab", at), `${name}-d${Math.ceil(at.getTime() / 1000).toString(36)}`);
	assert.equal(orgoName({}, "0123456789ab", at), `computer-0123456789ab-d${Math.ceil(at.getTime() / 1000).toString(36)}`);
});

test("Orgo create: the computer in the workspace, computerd uploaded and installed, Orgo's X socket checked, the labels file, init on :99 as 2510:2510, then the bridge, hello, the daemon and the probe", async () => {
	const { provider, api, channel } = setup();
	const created = await provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	const record = only(api);
	assert.deepEqual(created.value.id, record.id);
	assert.equal(created.value.name, record.name);
	assert.match(record.name, /^computer-[0-9a-f]{12}-r[a-z2-7]{16}-e3-d[0-9a-z]+$/);
	assert.deepEqual(record.asked, { workspace_id: WORKSPACE, name: record.name, os: "linux", ram: 4, cpu: 1, ends_in_hours: 1 });
	const ops = channel.calls.map(({ op, kind }) => (kind ? `${op} ${kind}` : op));
	assert.deepEqual(ops.slice(0, 8), ["upload", "run install", "run orgo-x11", "run orgo-labels", "run orgo-ports", "run orgo-lockdown", "start init", "stdio stdio"]);
	// Every path socket of Orgo's desktop is made root's alone before any tool runs, but the display's own: the tools reach
	// the X server through it, and nothing else (live run 4 found root's D-Bus buses connectable by the tool user).
	assert.deepEqual(channel.calls.find((call) => call.kind === "orgo-lockdown").argv.slice(4), ["/tmp/.X11-unix/X99"]);
	assert.ok(created.value.notes.some((note) => /made root's alone: \/run\/dbus\/system_bus_socket, \/tmp\/dbus-3fd5ustF2v/.test(note)), JSON.stringify(created.value.notes));
	// Init and its programs in a network of their own, loopback alone; the probe tries every port root listens on in
	// Orgo's own network (its agent's, read at create) and the declared ones, on both loopbacks: all refused.
	assert.match(channel.calls.find((call) => call.op === "start").argv.join(" "), /--own-network/);
	const probed = channel.boxes.get(record.id).probes.at(-1);
	for (const port of [8231, 5900, 5999, 6080, 8080]) for (const host of ["127.0.0.1", "[::1]"]) assert.ok(probed.includes(`${host}:${port}`), `the probe tries ${host}:${port}: ${probed.join(", ")}`);
	assert.ok(created.value.notes.some((note) => /Orgo's own network listens on 5900, 8231/.test(note)), JSON.stringify(created.value.notes));
	const upload = channel.calls[0];
	assert.match(upload.path, /^\/tmp\/agentrun-computerd-[0-9a-f]{16}$/);
	assert.equal(upload.size, DAEMON_BYTES.length);
	const x11 = channel.calls.find((call) => call.kind === "orgo-x11");
	assert.equal(x11.argv.at(-1), "/tmp/.X11-unix/X99", "the path socket, which init's own network namespace still reaches");
	const init = channel.boxes.get(record.id).init;
	assert.equal(init.display, ":99", "Orgo's own X server");
	assert.equal(init.user, "2510:2510");
	assert.ok(Date.parse(init.max) > Date.now() + 719 * HOUR, "the most an extend may move it to: the cap");
	assert.equal(channel.calls.find((call) => call.op === "start").how, "bash");
	assert.match(channel.calls.find((call) => call.op === "start").argv.join(" "), / --own-network /, "init in a network of its own, cut off from Orgo's agent beside it");
	const file = JSON.parse(channel.boxes.get(record.id).labels);
	assert.equal(channel.calls.find((call) => call.kind === "orgo-labels").argv.at(-2), LABELS_PATH);
	assert.deepEqual(file.labels, SPEC.labels);
	assert.equal(file.name, record.name);
	assert.equal(file.deadline, init.deadline);
	assert.equal(record.name.slice(record.name.lastIndexOf("-d") + 2), Math.ceil(Date.parse(init.deadline) / 1000).toString(36), "the name's deadline is init's, in whole seconds rounded up");
	assert.equal(file.maxDeadline, init.max);
	assert.deepEqual(api.routes(), ["POST /computers"], "Orgo's REST is the create alone; the rest is the channel");
	for (const request of api.requests) keyless({ ...request, headers: { ...request.headers, authorization: undefined } }, `${request.method} ${request.path}`);
	secretless(created, "create's result");
});

test("Orgo create: a computer Orgo answers creating is waited for until it runs; the start goes through a named session when asked", async () => {
	const { provider, api, channel } = setup({ start: "session" }, { api: { create: "creating", creatingReads: 2 } });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	assert.ok(api.routes().filter((route) => route.startsWith("GET /computers/")).length >= 2);
	assert.equal(channel.calls.find((call) => call.op === "start").how, "session");
});

test("Orgo create: each refusal deletes the computer and says why, never with the key: an install that fails, a sha256 that differs, no X path socket, a daemon that drifts, a probe that reaches out", async () => {
	for (const [channelOptions, words] of [
		[{ install: 5 }, /installing the daemon/],
		[{ sha: "lie" }, /sha256/],
		[{ x11: false }, /\/tmp\/\.X11-unix\/X99.*abstract/],
		[{ box: { display: false } }, /screen/],
		[{ box: { status: { NoNewPrivs: "0" } } }, /no_new_privs/],
		[{ box: { status: { Seccomp: "0" } } }, /daemon seccomp: declared 2/],
		[{ box: { interfaces: ["lo", "eth0"] } }, /daemon network: declared its own \(lo alone\), read back lo, eth0/],
		[{ box: { raised: ["tunl0"] } }, /brought up tunl0/],
		[{ box: { reached: ["1.1.1.1:443"] } }, /1\.1\.1\.1:443/],
		[{ box: { reached: ["127.0.0.1:8231"] } }, /127\.0\.0\.1:8231/],
		[{ box: { interfaces: ["lo", "eth0"] } }, /daemon network: declared its own \(lo alone\), read back lo, eth0/],
	]) {
		const { provider, api } = setup({}, { channel: channelOptions });
		const created = await provider.create(SPEC);
		assert.equal(created.ok, false, JSON.stringify(channelOptions));
		assert.match(created.error.message, words);
		secretless(created, "the refusal");
		const record = only(api);
		assert.equal(record.deleted, true, `${JSON.stringify(channelOptions)}: the computer is deleted`);
		assert.ok(api.routes().includes(`DELETE /computers/${record.id}`));
	}
	const refused = setup({}, { api: { create: "unauthorized" } });
	const unauthorized = await refused.provider.create(SPEC);
	assert.equal(unauthorized.ok, false);
	assert.equal(unauthorized.error.code, "denied");
	keyless(unauthorized, "an unauthorized create");
});

test("Orgo create: init not yet listening is tried again within helloMs; one that never listens is refused and deleted", async () => {
	const patient = setup({ timeouts: { ...TIMEOUTS, helloMs: 5_000 } }, { channel: { notListening: 2 } });
	assert.equal((await patient.provider.create(SPEC)).ok, true);
	assert.equal(patient.channel.calls.filter((call) => call.op === "stdio").length, 3, "two bridges found no daemon, the third did");
	const never = setup({}, { channel: { startFails: "the terminal closed with 4503" } });
	const refused = await never.provider.create(SPEC);
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /4503/);
	assert.equal(only(never.api).deleted, true);
});

test("Orgo create: a daemon that does not answer is refused with what the computer holds: whether init runs, its socket, its log", async () => {
	for (const [channelOptions, words] of [
		[{ bridge: "timeout" }, /init running; socket present; log computerd: init: listening/],
		[{ initDies: true }, /init not running; socket absent; log computerd: init: terminated by signal 15/],
	]) {
		const { provider, api, channel } = setup({}, { channel: channelOptions });
		const created = await provider.create(SPEC);
		assert.equal(created.ok, false);
		assert.match(created.error.message, /the daemon did not answer/);
		assert.match(created.error.message, words);
		assert.ok(channel.calls.some((call) => call.kind === "orgo-status"), "the status read through the channel");
		assert.equal(only(api).deleted, true);
		secretless(created, "the refusal");
	}
});

test("Orgo list: this workspace's computers by name, the run and epoch filtered by the name with nothing run inside; any other label read from the labels file", async () => {
	const fakes = setup();
	const mine = seeded(fakes);
	seeded(fakes, { labels: { "agentrun.run": RUN, "agentrun.epoch": "2" } });
	seeded(fakes, { labels: { "agentrun.run": "run-other", "agentrun.epoch": "3" } });
	fakes.api.add({ name: "someone-elses-desktop" });
	const byRun = await fakes.provider.list({ "agentrun.run": RUN, "agentrun.epoch": "3" });
	assert.equal(byRun.ok, true, JSON.stringify(byRun));
	assert.deepEqual(byRun.value.map((info) => info.ref.id), [mine.ref.id]);
	assert.deepEqual(byRun.value[0].labels, { "agentrun.run": RUN, "agentrun.epoch": "3" });
	assert.equal(byRun.value[0].network, "none");
	assert.equal(byRun.value[0].state, "running");
	const deadline = Date.parse(JSON.parse(mine.box.labels).deadline);
	assert.equal(byRun.value[0].deadline.getTime(), Math.ceil(deadline / 1000) * 1000, "the deadline read from the name: the janitor's");
	assert.deepEqual(fakes.channel.calls, [], "the name is the fast path: nothing runs in a computer");
	const runOnly = await fakes.provider.list({ "agentrun.run": RUN });
	assert.equal(runOnly.value.length, 2);
	const byTeam = await fakes.provider.list({ team: "a" });
	assert.deepEqual(byTeam.value.map((info) => info.ref.id), [mine.ref.id], "the one computer whose labels file says team a");
	assert.equal(fakes.channel.calls.length, 3, "each running computer's labels file read once");
	assert.ok(fakes.channel.calls.every((call) => call.kind === "orgo-labels-read"));
	assert.deepEqual(byTeam.value.find((info) => info.ref.id === mine.ref.id).labels, SPEC.labels);
	const all = await fakes.provider.list({});
	assert.equal(all.value.length, 3, "never a computer whose name is not this provider's");
});

test("Orgo list: a computer that is not running is listed stopped, and never woken to read its labels file", async () => {
	const fakes = setup();
	seeded(fakes, { status: "frozen" });
	const listed = await fakes.provider.list({ "agentrun.run": RUN });
	assert.equal(listed.value[0].state, "stopped");
	const byTeam = await fakes.provider.list({ team: "a" });
	assert.deepEqual(byTeam.value, [], "its labels file cannot be read without waking it, so it proves no other label");
	assert.deepEqual(fakes.channel.calls, []);
});

test("Orgo attach: the labels file is the truth; the spec read back from inside; a name that disagrees with the file is drift", async () => {
	const fakes = setup();
	const { ref } = seeded(fakes);
	const attached = await fakes.provider.attach({ id: ref.id });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.equal(attached.value.name, ref.name);
	assert.equal(attached.value.spec.user, "2510:2510");
	assert.equal(attached.value.spec.network, "none");
	assert.equal(attached.value.spec.kind, "desktop");
	assert.equal(attached.value.spec.image, "linux");
	secretless(attached, "attach");
	const byLabels = await fakes.provider.attach({ labels: { "agentrun.run": RUN, "agentrun.epoch": "3" } });
	assert.equal(byLabels.ok, true);

	const drifted = setup();
	const other = seeded(drifted, { file: JSON.stringify({ name: "x", labels: { "agentrun.run": RUN, "agentrun.epoch": "4" }, deadline: new Date().toISOString(), maxDeadline: new Date(Date.now() + HOUR).toISOString(), image: "linux" }) });
	const refused = await drifted.provider.attach({ id: other.ref.id });
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /epoch/);
	const foreign = drifted.api.add({ name: "someone-elses-desktop" });
	assert.equal((await drifted.provider.attach({ id: foreign.id })).error.code, "not_found");
});

test("Orgo connect: the bridge after hello; a daemon of another version is refused; a computer not this provider's is not_found", async () => {
	const fakes = setup();
	const { ref } = seeded(fakes);
	const connected = await fakes.provider.connect(ref);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	assert.equal(connected.value.hello.kind, "desktop");
	const ran = await connected.value.client.call("exec.run", { argv: ["true"], timeoutMs: 1000 });
	assert.equal(ran.ok, true);
	await connected.value.close();
	const drifted = setup({}, { channel: { box: { hello: { version: "0.0.0-other" } } } });
	const other = seeded(drifted);
	assert.equal((await drifted.provider.connect(other.ref)).error.code, "refused");
	assert.equal((await fakes.provider.connect({ id: ref.id, name: "computer-ffffffffffff" })).error.code, "not_found");
});

test("Orgo network: none, read back by the probe from inside; open or an allowlist is refused in words", async () => {
	const fakes = setup();
	const { ref } = seeded(fakes);
	assert.deepEqual(await fakes.provider.network(ref), { ok: true, value: "none" });
	assert.equal((await fakes.provider.network(ref, "open")).error.code, "refused");
	const reaching = setup({}, { channel: { box: { reached: ["8.8.8.8:443"] } } });
	const one = seeded(reaching);
	const read = await reaching.provider.network(one.ref);
	assert.ok(typeof read.value === "object" && /8\.8\.8\.8/.test(read.value.other), JSON.stringify(read));
});

test("Orgo release delete: DELETE, then waits until Orgo no longer has it; a computer gone already is done; a waking one is tried again; one not this provider's is left", async () => {
	const fakes = setup({}, { api: { waking: 1, lingers: 2 } });
	const { ref, record } = seeded(fakes);
	assert.deepEqual(await fakes.provider.release(ref, "delete"), { ok: true, value: undefined });
	assert.equal(record.deleted, true);
	assert.equal(fakes.api.routes().filter((route) => route === `DELETE /computers/${ref.id}`).length, 2, "a 409 computer_waking is tried again");
	assert.deepEqual(await fakes.provider.release(ref, "delete"), { ok: true, value: undefined }, "idempotent");
	assert.equal((await fakes.provider.release(ref, "stop")).error.code, "unsupported");
	const foreign = fakes.api.add({ name: "someone-elses-desktop" });
	assert.equal((await fakes.provider.release({ id: foreign.id, name: "someone-elses-desktop" }, "delete")).error.code, "invalid");
	assert.equal((await fakes.provider.release({ id: foreign.id, name: ref.name }, "delete")).error.code, "not_found");
	assert.equal(foreign.deleted, false);
});

test("Orgo is janitor-ended: the janitor's sweep deletes a computer past the deadline its name carries, with nothing run inside, and keeps one before it", async () => {
	const fakes = setup();
	const past = seeded(fakes, { deadline: new Date(Date.now() - 60_000).toISOString() });
	const live = seeded(fakes, { labels: { "agentrun.run": RUN, "agentrun.epoch": "4" } });
	const swept = await sweep(fakes.provider, { labels: { "agentrun.run": RUN }, now: new Date() });
	assert.equal(swept.ok, true, JSON.stringify(swept));
	assert.deepEqual(swept.value.deleted, [past.ref.name]);
	assert.equal(past.record.deleted, true);
	assert.equal(live.record.deleted, false);
	assert.deepEqual(fakes.channel.calls, [], "the janitor runs nothing in a computer");
});

test("Orgo extend: Orgo's end moved in whole hours with an Idempotency-Key, then init's deadline, then the labels file; never past the cap", async () => {
	const fakes = setup();
	const { ref, record, box } = seeded(fakes, { max: new Date(Date.now() + 3 * HOUR).toISOString() });
	const extended = await fakes.provider.extend(ref, 2 * HOUR);
	assert.equal(extended.ok, true, JSON.stringify(extended));
	const call = fakes.api.requests.find((request) => request.path === `/computers/${ref.id}/extend`);
	assert.ok(call.headers["idempotency-key"], "an Idempotency-Key, so a retry never adds time twice");
	assert.ok(Number.isInteger(call.body.hours) && call.body.hours >= 1);
	assert.ok(Date.parse(record.ends_at) >= Date.now() + 2 * HOUR - 1000, "Orgo ends it no earlier than asked");
	assert.equal(box.extended.length, 1, "init's deadline moved");
	assert.equal(JSON.parse(box.labels).deadline, extended.value.deadline.toISOString(), "and the labels file");
	// The janitor's deadline, in the name, follows: Orgo renames the computer (PATCH), the rest of its name as it was.
	const renamed = fakes.api.requests.find((request) => request.method === "PATCH" && request.path === `/computers/${ref.id}`);
	assert.ok(renamed, "a PATCH renames the computer");
	assert.equal(record.name, `${ref.name.slice(0, ref.name.lastIndexOf("-d"))}-d${Math.ceil(extended.value.deadline.getTime() / 1000).toString(36)}`);
	assert.equal(JSON.parse(box.labels).name, record.name, "the labels file names it as Orgo does");
	const listed = await fakes.provider.list({ "agentrun.run": RUN });
	assert.equal(listed.value[0].deadline.getTime(), Math.ceil(extended.value.deadline.getTime() / 1000) * 1000, "list() reads the extended deadline");
	// A ref made before the rename still reaches it: a computer is its id and the stable part of its name.
	const connected = await fakes.provider.connect(ref);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	await connected.value.close();
	assert.equal((await fakes.provider.attach({ id: ref.id })).ok, true);
	const past = await fakes.provider.extend(ref, 4 * HOUR);
	assert.equal(past.ok, false);
	assert.equal(past.error.code, "limit");
	assert.equal(box.extended.length, 1, "nothing moved");
	// An extend never moves the deadline earlier: one that would is refused in words, the deadline as it was (live run 4).
	const extends_ = fakes.api.requests.filter((request) => request.path === `/computers/${ref.id}/extend`).length;
	const earlier = await fakes.provider.extend(ref, 60_000);
	assert.equal(earlier.ok, false, JSON.stringify(earlier));
	assert.equal(earlier.error.code, "refused");
	assert.match(earlier.error.message, /earlier/);
	assert.equal(box.extended.length, 1, "init's deadline did not move");
	assert.equal(JSON.parse(box.labels).deadline, extended.value.deadline.toISOString(), "nor the labels file");
	assert.equal(fakes.api.requests.filter((request) => request.path === `/computers/${ref.id}/extend`).length, extends_, "nor Orgo's end");
});

/** The janitor's deadline a name carries (its -d part, base-36 seconds), in ms. */
const nameDeadline = (name) => Number.parseInt(name.slice(name.lastIndexOf("-d") + 2), 36) * 1000;

test("Orgo extend: two at once are taken in turn, and the name's deadline never moves back: a shorter extend whose rename would land after a longer one's leaves the longer's", async () => {
	let longDone;
	const longer = new Promise((resolve) => (longDone = resolve));
	// The shorter call's rename waits until the longer call has finished: without turns, it lands last and moves the
	// name's deadline back, and the janitor, which trusts the name, deletes the desktop early.
	const fakes = setup({}, { api: { hold: ({ method, body }) => (method === "PATCH" && nameDeadline(body.name) < Date.now() + 1.5 * HOUR ? longer : undefined) } });
	const { ref, record, box } = seeded(fakes, { max: new Date(Date.now() + 3 * HOUR).toISOString() });
	const long = fakes.provider.extend(ref, 2 * HOUR).then((result) => (longDone(), result));
	const short = fakes.provider.extend(ref, HOUR);
	const [a, b] = await Promise.all([long, short]);
	assert.equal(a.ok, true, JSON.stringify(a));
	assert.equal(b.ok, false, JSON.stringify(b));
	assert.equal(b.error.code, "refused", "the shorter, taken after the longer, would move the deadline earlier");
	assert.equal(nameDeadline(record.name), Math.ceil(a.value.deadline.getTime() / 1000) * 1000, "the name keeps the longer deadline");
	assert.equal(box.init.deadline, a.value.deadline.toISOString(), "and init");
	assert.equal(JSON.parse(box.labels).deadline, a.value.deadline.toISOString(), "and the labels file");
});

test("Orgo extend: the name's deadline is the one init took, not the one asked, when the daemon answers another time", async () => {
	// The daemon takes 90 s more than asked (as an init that rounds its deadline up would).
	const fakes = setup({}, { channel: { box: { extendAt: (at) => new Date(Date.parse(at) + 90_000).toISOString() } } });
	const { ref, record, box } = seeded(fakes, { max: new Date(Date.now() + 3 * HOUR).toISOString() });
	const asked = Date.now() + 2 * HOUR;
	const extended = await fakes.provider.extend(ref, 2 * HOUR);
	assert.equal(extended.ok, true, JSON.stringify(extended));
	const took = extended.value.deadline.getTime();
	assert.ok(took >= asked + 89_000, "the result is the deadline init took");
	assert.equal(box.init.deadline, extended.value.deadline.toISOString());
	assert.equal(nameDeadline(record.name), Math.ceil(took / 1000) * 1000, "the name's deadline is init's, so the janitor ends it when init does");
	assert.equal(JSON.parse(box.labels).deadline, extended.value.deadline.toISOString(), "and the labels file's");
	assert.equal(JSON.parse(box.labels).name, record.name);
});

test("Orgo lockdown: the script fails when a socket's chown fails, though a later socket locks; and when the scan fails", () => {
	const stubs = mkdtempSync(join(dir, "lockdown-"));
	const sorts = spawnSync("sh", ["-c", "command -v sort"], { encoding: "utf8" }).stdout.trim();
	const stub = (name, body) => writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	stub("chown", '[ "$2" = /run/a.sock ] && exit 1; exit 0');
	stub("chmod", "exit 0");
	const run = (findBody) => {
		stub("find", findBody);
		return spawnSync("sh", ["-c", orgo.LOCKDOWN_SCRIPT, "sh", "/tmp/.X11-unix/X99"], { encoding: "utf8", env: { PATH: `${stubs}:${sorts.slice(0, sorts.lastIndexOf("/"))}:/usr/bin:/bin` } });
	};
	// The first socket's chown fails, the second's goes through: the script must not answer 0.
	const chown = run("printf '%s\\n' /run/a.sock /run/b.sock; exit 0");
	assert.notEqual(chown.status, 0, `the script answered 0 with a socket left open: ${chown.stdout}`);
	assert.match(chown.stdout, /^locked \/run\/b\.sock$/m, "the socket it could lock is locked");
	assert.doesNotMatch(chown.stdout, /^locked \/run\/a\.sock$/m);
	// The scan itself fails partway: the script must not answer 0 on what it found before.
	const scan = run("printf '%s\\n' /run/b.sock; exit 1");
	assert.notEqual(scan.status, 0, `the script answered 0 after its scan failed: ${scan.stdout}`);
	// Every socket locked: 0, each named.
	const fine = run("printf '%s\\n' /run/b.sock /run/c.sock /tmp/.X11-unix/X99; exit 0");
	assert.equal(fine.status, 0, fine.stdout + fine.stderr);
	assert.deepEqual(fine.stdout.trim().split("\n"), ["locked /run/b.sock", "locked /run/c.sock"]);
});

test("Orgo create: a lockdown that leaves a socket open refuses the create in words, and the computer is deleted", async () => {
	const fakes = setup({}, { channel: { lockdown: { exitCode: 1, output: "failed /run/dbus/system_bus_socket\nlocked /tmp/dbus-3fd5ustF2v\n" } } });
	const made = await fakes.provider.create(SPEC);
	assert.equal(made.ok, false, JSON.stringify(made));
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, /making Orgo's desktop sockets root's alone .* failed \(exit 1\)/);
	assert.match(made.error.message, /\/run\/dbus\/system_bus_socket/);
	assert.match(made.error.message, /was deleted/);
	assert.equal(only(fakes.api).deleted, true, "the computer is deleted");
	assert.equal(fakes.channel.calls.some((call) => call.kind === "init"), false, "init never started");
});
