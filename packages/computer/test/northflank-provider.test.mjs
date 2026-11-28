// NorthflankProvider's host against a stand-in for the Northflank API (fake-northflank.mjs: a fetch for its REST calls and
// a WebSocket for its command-exec socket's JSON messages, its commands scripted or run on a backend here): what the host
// sends for create, get, list, delete and exec, how it reads the answers and the messages back, the exec pre-check over
// it, and the provider's Core conformance cases through it. The adapter's lifecycle is tested once, against its fake
// host (hosted-provider.test.mjs); Northflank's own is proven live.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeExecHost } from "./fake-exec-host.mjs";
import { fakeHost } from "./fake-host.mjs";
import { fakeNorthflank, PLANS, PROJECT, TOKEN } from "./fake-northflank.mjs";
import { withSh } from "./fake-text-host.mjs";

const { NorthflankProvider, create } = await import("../dist/northflank.js");
const { NORTHFLANK } = await import("../dist/descriptors/index.js");
const { boxImageRef } = await import("../dist/box-image.js");
const { PID_KILL } = await import("../dist/hosted/scripts.js");
const { packLabels } = await import("../dist/hosted/values.js");
const { checkExecStream, formatExecStream } = await import("../dist/conformance/exec-stream.js");
const { NORTHFLANK_ENV: ENV, settingsFromEnv, createProvider, createHost, conformanceImage, sweepScope } = await import("../dist/conformance/northflank.js");

const CTX = { timeoutMs: 5_000 };
const NAME = "computer-0123456789ab";
const IMAGE = "ghcr.io/example/box:1";
const LABELS = { "agentrun.computer": "1", "agentrun.computer.name": NAME };
const HAS_PROC = existsSync("/proc/self/stat");
const request = (more = {}) => ({ name: NAME, image: IMAGE, labels: { agentrun: NAME }, lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: false, ...more });
const dir = mkdtempSync(join(tmpdir(), "computer-northflank-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, Buffer.from("a stand-in for computerd, linux/amd64\n"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 2_000 };

function northflankOf(options, more = {}) {
	const vendor = fakeNorthflank(options);
	const provider = new NorthflankProvider({ token: TOKEN, projectId: PROJECT, ...(options?.teamId ? { teamId: options.teamId } : {}), fetch: vendor.fetch, webSocket: vendor.webSocket, timeouts: { pollMs: 1 }, ...more });
	return { vendor, provider, host: provider.host };
}

/** A whole stream's text. */
const textOf = async (stream) => Buffer.concat(await stream.toArray()).toString("utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** The newest session the fake holds, once its socket opened and its init was read. */
const sessionOf = async (vendor, count = 1) => {
	while (vendor.sessions.size < count) await tick();
	return [...vendor.sessions.values()].at(-1);
};
/** A machine of fake-host.mjs's, as a backend whose commands run under withSh (the pid wrapper and its kill). */
const shBackend = (host) => ({ create: (req, ctx) => host.create(req, ctx), delete: (id, ctx) => host.delete(id, ctx), exec: withSh(host) });

test("the descriptor: a sandbox under NORTHFLANK_API_TOKEN and a project of the customer's own, every network form through init, no mount, the box image prepared; the host a janitor's microVM with packed labels", () => {
	assert.equal(NORTHFLANK.id, "northflank");
	assert.equal(NORTHFLANK.label, "Northflank");
	assert.deepEqual(NORTHFLANK.keys, [
		{ name: "NORTHFLANK_API_TOKEN", option: "token", required: true },
		{ name: "NORTHFLANK_COMPUTER_PROJECT_ID", option: "projectId", required: true },
		{ name: "NORTHFLANK_COMPUTER_TEAM_ID", option: "teamId", required: false },
	]);
	assert.ok(!NORTHFLANK.keys.some((key) => key.name === "NORTHFLANK_PROJECT_ID"), "never the name Northflank sets inside its own services");
	assert.deepEqual([NORTHFLANK.network, NORTHFLANK.mounts, NORTHFLANK.defaultImage, NORTHFLANK.prepareImage], [["none", "open", "allow"], [], undefined, true]);
	const { host } = northflankOf();
	assert.deepEqual(host.facts, { daemon: "child", isolation: "microvm", lifetime: "janitor", maxLifetimeMs: 604_800_000 - 300_000, arch: "amd64", vendorAgentPorts: [], labels: { bytes: 262_144, packed: {} } });
	assert.throws(() => new NorthflankProvider({ token: "", projectId: PROJECT }), /options\.token, a Northflank API token, is required/);
	assert.throws(() => new NorthflankProvider({ token: TOKEN }), /options\.projectId is required/, "no default project");
	assert.throws(() => new NorthflankProvider({ token: TOKEN, projectId: "My Project" }), /options\.projectId is required/);
	assert.throws(() => new NorthflankProvider({ token: TOKEN, projectId: PROJECT, teamId: "../x" }), /options\.teamId/);
	assert.throws(() => new NorthflankProvider({ token: TOKEN, projectId: PROJECT, apiUrl: "http://api.northflank.com" }), /the Northflank API URL must be https/);
});

test("prepareImage answers the box image's public tag, with no call", async () => {
	const { vendor, provider } = northflankOf();
	assert.deepEqual(await provider.prepareImage(), { ok: true, value: boxImageRef() });
	assert.equal(vendor.calls.length, 0);
});

test("create posts the name, the plan of the size, the image under sleep infinity, one instance, the labels as annotations and the expiry at the backstop; then scales to one; the name is the id", async () => {
	const { vendor, host } = northflankOf();
	assert.deepEqual(await host.create(request({ labels: { agentrun: NAME, "agentrun-0": "abc" } }), CTX), { id: NAME });
	const [post, scale] = vendor.calls;
	assert.deepEqual([post.method, post.path], ["POST", `/v1/projects/${PROJECT}/services/deployment`]);
	const { createOptions, ...body } = post.body;
	assert.deepEqual(body, {
		name: NAME,
		billing: { deploymentPlan: "nf-compute-200" },
		deployment: {
			instances: 1,
			external: { imagePath: IMAGE },
			docker: { configType: "customEntrypointCustomCommand", customEntrypoint: "/bin/sh", customCommand: "-c 'exec sleep infinity'" },
			metadata: { annotations: { agentrun: NAME, "agentrun-0": "abc" } },
		},
	});
	assert.ok(createOptions.expiryTime >= 3_599 && createOptions.expiryTime <= 3_600, `the expiry is the backstop's, ${createOptions.expiryTime} s`);
	assert.deepEqual([scale.method, scale.path, scale.body], ["POST", `/v1/projects/${PROJECT}/services/${NAME}/scale`, { instances: 1 }]);
	assert.equal(vendor.calls.length, 2);
});

test("create: a size picks its plan, one field alone its plan's other; one no plan has is invalid before any call; the expiry is held to Northflank's 300 s to 7 days", async () => {
	const sizes = [[{ cpus: 1 }, "nf-compute-100-2"], [{ memoryMb: 8192 }, "nf-compute-400"], [{ cpus: 8, memoryMb: 16_384 }, "nf-compute-800-16"], [{}, "nf-compute-200"]];
	for (const [size, plan] of sizes) {
		const { vendor, host } = northflankOf();
		await host.create(request(size), CTX);
		assert.equal(vendor.calls[0].body.billing.deploymentPlan, plan, JSON.stringify(size));
		assert.ok(PLANS.includes(plan));
	}
	const { vendor, host } = northflankOf();
	await assert.rejects(host.create(request({ cpus: 3 }), CTX), (error) => error.code === "invalid" && /no Northflank plan has 3 vCPUs/.test(error.message));
	assert.equal(vendor.calls.length, 0);
	for (const [backstopMs, expiry] of [[60_000, 300], [30 * 24 * 3_600_000, 604_800]]) {
		const one = northflankOf();
		await one.host.create(request({ backstopAt: new Date(Date.now() + backstopMs).toISOString() }), CTX);
		assert.equal(one.vendor.calls[0].body.createOptions.expiryTime, expiry);
	}
});

test("an organisation token's team goes before the project in every path, REST and exec", async () => {
	const { vendor, host } = northflankOf({ teamId: "my-team" });
	await host.create(request(), CTX);
	assert.equal(vendor.calls[0].path, `/v1/teams/my-team/projects/${PROJECT}/services/deployment`);
	const proc = await host.exec(NAME, ["true"], CTX);
	(await sessionOf(vendor)).end(0);
	assert.equal(await proc.wait(), 0);
	assert.equal(vendor.calls.find((call) => call.method === "WS").path, `/v1/command-exec/teams/my-team/projects/${PROJECT}/services/${NAME}`);
});

test("labels: the adapter's and the caller's go packed into the annotations, and read back exactly through the provider's list, another run's computer left out", async () => {
	const { vendor, provider, host } = northflankOf();
	const labels = { ...LABELS, "agentrun.run": "run-1", "agentrun.epoch": "2", "agentrun.computer.deadline": new Date(Date.now() + 600_000).toISOString(), "agentrun.computer.network": "none", team: "x".repeat(200) };
	const packed = packLabels(labels, NAME, host.facts.labels);
	assert.equal(packed.problem, undefined);
	await host.create(request({ labels: packed.labels }), CTX);
	const other = "computer-ba9876543210";
	await host.create(request({ name: other, labels: packLabels({ ...labels, "agentrun.run": "run-2", "agentrun.computer.name": other }, other, host.facts.labels).labels }), CTX);
	const stored = vendor.services.get(NAME).service.deployment.metadata.annotations;
	assert.ok(Object.keys(stored).every((key) => /^[a-z0-9-]+$/.test(key)), Object.keys(stored).join(" "));
	const listed = await provider.list({ "agentrun.run": "run-1" });
	assert.equal(listed.ok, true, JSON.stringify(listed.error));
	assert.deepEqual(listed.value.map((info) => [info.ref, info.labels]), [[{ id: NAME, name: NAME }, labels]]);
});

test("a create of a name the project holds is exists (unverified until the live run: Northflank's 409); a rate cap is a limit; a token Northflank refuses is denied, never echoed", async () => {
	const { host } = northflankOf();
	await host.create(request(), CTX);
	await assert.rejects(host.create(request(), CTX), (error) => error.code === "exists" && /409: A service with the name computer-0123456789ab already exists/.test(error.message));
	const limited = northflankOf({ rateLimited: true }).host;
	await assert.rejects(limited.create(request(), CTX), (error) => error.code === "limit" && /Rate limit exceeded/.test(error.message));
	const vendor = fakeNorthflank();
	const denied = new NorthflankProvider({ token: "fake-test-key-other", projectId: PROJECT, fetch: vendor.fetch, webSocket: vendor.webSocket }).host;
	await assert.rejects(denied.list({}, CTX), (error) => error.code === "denied" && !error.message.includes("fake-test-key-other"));
});

test("get reads a service: PENDING and IN_PROGRESS are starting, COMPLETED running, FAILED gone, one past its expiry stopped, a status unknown stopped in words; its plan's size; one Northflank lacks is none", async () => {
	const { vendor, host } = northflankOf();
	await host.create(request(), CTX);
	const { service } = vendor.services.get(NAME);
	assert.deepEqual(await host.get(NAME, CTX), { id: NAME, labels: { agentrun: NAME }, state: "running", createdAt: new Date(service.createdAt), resources: { cpus: 2, memoryMb: 4096 } });
	for (const [status, state] of Object.entries({ PENDING: "starting", IN_PROGRESS: "starting", COMPLETED: "running", FAILED: "gone", PAUSING: "stopped" })) {
		service.status.deployment.status = status;
		const read = await host.get(NAME, CTX);
		assert.equal(read.state, state, status);
		if (status === "FAILED") assert.equal(read.why, "Northflank reads its deployment FAILED");
		if (status === "PAUSING") assert.match(read.why, /"PAUSING", which this provider does not know/);
	}
	service.status.deployment.status = "COMPLETED";
	service.expiredAt = new Date().toISOString();
	assert.deepEqual([(await host.get(NAME, CTX)).state, (await host.get(NAME, CTX)).why], ["stopped", `Northflank paused it at its expiry, ${service.expiredAt}`]);
	service.deployment.metadata.annotations = JSON.stringify({ agentrun: NAME, "agentrun-0": "x" });
	assert.deepEqual((await host.get(NAME, CTX)).labels, { agentrun: NAME, "agentrun-0": "x" }, "annotations as a JSON string are read too");
	assert.equal(await host.get("computer-ffffffffffff", CTX), undefined);
	await assert.rejects(host.get("../projects", CTX), (error) => error.code === "not_found");
});

test("list reads every page and keeps the project's computers alone: a listing that answers more (another app, another computer) is filtered here by the name the packed labels carry, and each kept one is read by get for its annotations", async () => {
	const { vendor, host } = northflankOf({ pageSize: 2 });
	for (let i = 0; i < 4; i++) await host.create(request({ name: `computer-00000000000${i}`, labels: { agentrun: `computer-00000000000${i}` } }), CTX);
	vendor.add("computer-other00000", { annotations: { agentrun: "computer-other00000" } });
	vendor.add("my-app");
	const before = vendor.calls.length;
	const one = await host.list({ agentrun: "computer-000000000002" }, CTX);
	assert.deepEqual(one.map((machine) => [machine.id, machine.labels]), [["computer-000000000002", { agentrun: "computer-000000000002" }]]);
	const calls = vendor.calls.slice(before);
	const pages = calls.filter((call) => call.path === `/v1/projects/${PROJECT}/services`);
	assert.deepEqual(pages.map((call) => call.query.cursor), [undefined, "2", "4"]);
	assert.equal(pages[0].query.per_page, "100");
	assert.deepEqual(calls.filter((call) => call.path !== `/v1/projects/${PROJECT}/services`).map((call) => [call.method, call.path]), [["GET", `/v1/projects/${PROJECT}/services/computer-000000000002`]], "one get, for the one kept");
	const all = await host.list({}, CTX);
	assert.deepEqual(all.map((machine) => machine.id).sort(), ["computer-000000000000", "computer-000000000001", "computer-000000000002", "computer-000000000003", "computer-other00000"], "every computer- service, never my-app");
	assert.deepEqual(all.find((machine) => machine.id === "computer-other00000").labels, { agentrun: "computer-other00000" });
	// One deleted between the listing and its get is left out, not an error.
	const fetch = vendor.fetch;
	const gone = new NorthflankProvider({ token: TOKEN, projectId: PROJECT, webSocket: vendor.webSocket, fetch: async (url, init) => {
		if (new URL(url).pathname.endsWith("/services/computer-000000000001")) vendor.services.delete("computer-000000000001");
		return fetch(url, init);
	} }).host;
	assert.equal((await gone.list({}, CTX)).some((machine) => machine.id === "computer-000000000001"), false);
});

test("delete deletes by id and reads back as none; one Northflank no longer has is done; release deletes and waits for the readback", async () => {
	const { vendor, provider, host } = northflankOf();
	await host.create(request({ labels: packLabels(LABELS, NAME, host.facts.labels).labels }), CTX);
	await host.delete(NAME, CTX);
	assert.deepEqual([vendor.calls.at(-1).method, vendor.calls.at(-1).path], ["DELETE", `/v1/projects/${PROJECT}/services/${NAME}`]);
	assert.equal(await host.get(NAME, CTX), undefined);
	await host.delete(NAME, CTX);
	await host.create(request({ labels: packLabels(LABELS, NAME, host.facts.labels).labels }), CTX);
	const released = await provider.release({ id: NAME, name: NAME }, "delete");
	assert.equal(released.ok, true, JSON.stringify(released.error));
	assert.equal(vendor.services.has(NAME), false);
	assert.equal(vendor.calls.at(-1).method, "GET", "the last call is the read-back after the delete");
});

test("exec opens the command-exec socket and sends its init: the token there, never in the URL, argv under the pid wrapper with no shell, root, latin1, no tty; stdin goes as payload messages, end as stdInEnd; stdOut and stdErr are the streams, and output after the completion still comes before the exit", async () => {
	const { vendor, host } = northflankOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["cat", "-"], CTX);
	const ws = vendor.calls.find((call) => call.method === "WS");
	assert.equal(ws.url, `wss://api.northflank.com/v1/command-exec/projects/${PROJECT}/services/${NAME}`);
	const session = await sessionOf(vendor);
	assert.deepEqual(ws.init.data.auth, { type: "apiToken", apiToken: TOKEN });
	const { command, ...context } = ws.init.data.context;
	assert.deepEqual(context, { shell: "none", user: "root", group: "root", encoding: "latin1", tty: false });
	assert.deepEqual([command[0], command.slice(4)], ["sh", ["cat", "-"]], "argv under the pid wrapper, Northflank having no kill");
	await proc.write(Buffer.from("héllo"));
	await proc.write(Buffer.from(" world"));
	await proc.end();
	assert.deepEqual([Buffer.concat(session.stdin).toString("utf8"), session.ended], ["héllo world", true]);
	session.out("stdout", "out ");
	session.out("stderr", "err");
	session.complete(3);
	session.out("stdout", "more");
	session.close();
	assert.deepEqual([await textOf(proc.stdout), await textOf(proc.stderr), await proc.wait()], ["out more", "err", 3]);
	assert.equal(vendor.sockets[0].readyState, 3);
});

test("a completion with no close is read after 30 s with no more output, and the socket is closed then", async (t) => {
	const { vendor, host } = northflankOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["true"], CTX);
	const session = await sessionOf(vendor);
	await tick();
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let settled;
	proc.wait().then((code) => (settled = code), (error) => (settled = error));
	session.complete(0);
	for (let at = 0; at < 3; at++) await tick();
	t.mock.timers.tick(20_000);
	session.out("stdout", "late");
	for (let at = 0; at < 3; at++) await tick();
	t.mock.timers.tick(20_000);
	for (let at = 0; at < 3; at++) await tick();
	assert.equal(settled, undefined, "output 20 s after the completion starts the wait again");
	t.mock.timers.tick(10_000);
	for (let at = 0; at < 5; at++) await tick();
	assert.equal(await proc.wait(), 0);
	assert.equal(await textOf(proc.stdout), "late");
	assert.deepEqual([vendor.sockets[0].readyState, vendor.sockets[0].closedWith], [3, 1000]);
});

test("a character split across two messages arrives whole, on stdout and on stderr: every byte rides as one latin1 code point", async () => {
	const { vendor, host } = northflankOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["cat"], CTX);
	const session = await sessionOf(vendor);
	const text = "é😀ü\r\nend";
	const bytes = Buffer.from(text, "utf8");
	session.out("stdout", bytes, { pieces: [...bytes].map(() => 1) });
	session.out("stderr", Buffer.from("😀"), { pieces: [1, 2, 1] });
	session.out("stdout", Buffer.from([0x00, 0xff, 0x80]));
	session.end(0);
	const [out, err] = await Promise.all([proc.stdout.toArray(), textOf(proc.stderr)]);
	assert.deepEqual([Buffer.concat(out), err, await proc.wait()], [Buffer.concat([bytes, Buffer.from([0x00, 0xff, 0x80])]), "😀", 0]);
	await proc.stdin?.end?.();
});

test("75 s of silence on the exec socket is no end: the process still runs, and the output after it comes, then the exit", async (t) => {
	const { vendor, host } = northflankOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["sleep", "100"], CTX);
	const session = await sessionOf(vendor);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let settled;
	proc.wait().then((code) => (settled = code), (error) => (settled = error));
	const out = textOf(proc.stdout);
	for (let at = 0; at < 75; at++) {
		await tick();
		t.mock.timers.tick(1_000);
	}
	assert.equal(settled, undefined, "the process still runs after 75 s of nothing");
	assert.equal(vendor.calls.filter((call) => call.method === "WS").length, 1, "one socket, never opened again");
	session.out("stdout", "late");
	session.end(0);
	assert.equal(await out, "late");
	assert.equal(await proc.wait(), 0);
});

test("kill is the pid wrapper's kill script on a second exec socket, by the pid and start time the first command named", async () => {
	const { vendor, host } = northflankOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["sleep", "600"], CTX);
	const session = await sessionOf(vendor);
	for (let at = 0; at < 5; at++) await tick();
	await proc.kill();
	const killer = [...vendor.sessions.values()].at(-1);
	assert.notEqual(killer, session);
	assert.deepEqual([killer.argv[0], killer.argv[2], killer.argv.slice(4)], ["sh", PID_KILL, [session.pid, session.start]]);
	assert.equal(session.killed, true);
	assert.equal(await proc.wait(), 137);
});

test("an init Northflank refuses is denied, in its words, the token never echoed", async () => {
	const { vendor, host } = northflankOf();
	await host.create(request(), CTX);
	const other = new NorthflankProvider({ token: "fake-test-key-other", projectId: PROJECT, fetch: vendor.fetch, webSocket: vendor.webSocket }).host;
	const failed = await other.exec(NAME, ["true"], CTX).then((proc) => proc.wait()).then((code) => `exited ${code}`, (error) => error);
	assert.ok(failed instanceof Error, `the exec failed: ${failed}`);
	assert.equal(failed.code, "denied");
	assert.match(failed.message, /Northflank refused the command on computer-0123456789ab: Invalid API token/);
	assert.doesNotMatch(failed.message, /fake-test-key-other/);
});

test("an error message from Northflank ends the exec in its words", async () => {
	const { vendor, host } = northflankOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["true"], CTX);
	const session = await sessionOf(vendor);
	session.send({ type: "error", data: { message: "container not running" } });
	await assert.rejects(proc.wait(), /Northflank ended the command on computer-0123456789ab: container not running/);
});

test("output nobody reads ends the exec once 64 MiB of it waits: the socket closes, and the exec fails in words that say why", async () => {
	const { vendor, host } = northflankOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["yes"], CTX);
	const session = await sessionOf(vendor);
	const mib = Buffer.alloc(1024 * 1024, 0x79);
	for (let at = 0; at < 65; at++) session.out("stdout", mib);
	for (let at = 0; at < 500 && vendor.sockets[0].readyState !== 3; at++) await tick();
	assert.equal(vendor.sockets[0].readyState, 3, "the socket closes at the bound, with the output still unread");
	const [out, failed] = await Promise.all([textOf(proc.stdout), proc.wait().then((code) => new Error(`exited ${code}`), (error) => error)]);
	assert.ok(out.length < 64 * 1024 * 1024, "the output past the bound was dropped, not kept");
	assert.match(failed.message, /output not read passed 64 MiB/);
});

test("a start's abort listener goes once the start settles: one long-lived signal over many execs keeps none", async () => {
	const { vendor, host } = northflankOf();
	await host.create(request(), CTX);
	const signal = new AbortController().signal;
	let listeners = 0;
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	signal.addEventListener = (type, listener, options) => {
		if (type === "abort") listeners += 1;
		add(type, listener, options);
	};
	signal.removeEventListener = (type, listener, options) => {
		if (type === "abort") listeners -= 1;
		remove(type, listener, options);
	};
	for (let at = 0; at < 20; at++) {
		const proc = await host.exec(NAME, ["true"], { ...CTX, signal });
		(await sessionOf(vendor, at + 1)).end(0);
		assert.equal(await proc.wait(), 0);
	}
	assert.equal(listeners, 0, "every start removed the abort listener it added");
});

test("an exec on a service Northflank lacks is not_found: the socket never opens, and get says why", async () => {
	const { host } = northflankOf();
	await assert.rejects(host.exec("computer-ffffffffffff", ["true"], CTX), (error) => error.code === "not_found" && /no Northflank service computer-ffffffffffff/.test(error.message));
});

test("check takes a registry image and a plan's size: another image, or cpus or memoryMb no plan has, is refused before any call", () => {
	const { vendor, provider } = northflankOf();
	const spec = { lifetimeMs: 600_000, network: "none" };
	assert.deepEqual(provider.check({ ...spec, image: IMAGE }), []);
	assert.deepEqual(provider.check({ ...spec, image: "ubuntu:24.04", cpus: 2, memoryMb: 4096 }), []);
	assert.deepEqual(provider.check({ ...spec, image: IMAGE, memoryMb: 2048 }), []);
	assert.deepEqual(provider.check({ ...spec, image: "Not An Image" }).map((one) => one.field), ["image"]);
	assert.deepEqual(provider.check({ ...spec, image: IMAGE, cpus: 3 }).map((one) => one.field), ["cpus"]);
	assert.deepEqual(provider.check({ ...spec, image: IMAGE, cpus: 4, memoryMb: 4096 }).map((one) => one.field), ["cpus"]);
	assert.deepEqual(provider.check({ ...spec, image: IMAGE, memoryMb: 3000 }).map((one) => one.field), ["memoryMb"]);
	assert.match(provider.check({ ...spec, image: IMAGE, cpus: 3 })[0].message, /2 vCPUs with 4096 MB/);
	assert.equal(vendor.calls.length, 0);
});

test("the exec passes every check of the exec pre-check, over real processes behind the exec socket's messages", { timeout: 120_000 }, async (t) => {
	if (!HAS_PROC) return t.skip("no /proc here");
	const local = fakeExecHost();
	t.after(() => local.stopAll());
	const { host } = northflankOf({ backend: local });
	await host.create(request(), CTX);
	const report = await checkExecStream(host, NAME, { longMs: 2_000, stepMs: 10_000, largeBytes: 1024 * 1024, largeMs: 30_000, unreadMs: 1_000 });
	assert.equal(report.pass, true, formatExecStream(report));
});

test("the provider's Core conformance cases pass through the Northflank REST calls and exec socket, the daemon uploaded through stdin, and leave nothing behind", { timeout: 120_000 }, async () => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const cases = conformanceCases.filter((one) => one.group === "provider" && one.level === "core" && one.id !== "provider.deadline");
	const machines = fakeHost();
	const { vendor, provider } = northflankOf({ backend: shBackend(machines.host) }, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const report = await runConformance(provider, { image: IMAGE, cases, caseTimeoutMs: 30_000, cleanupTimeoutMs: 10_000 });
	assert.ok(report.results.length >= 3, report.results.map(({ id }) => id).join(" "));
	assert.deepEqual(
		report.results.filter(({ status }) => status !== "pass").map(({ id, status, reason }) => `${id} ${status}: ${reason}`),
		[],
	);
	assert.deepEqual(report.cleanup.sweep.stillThere, []);
	assert.equal(vendor.services.size, 0, "every service made was deleted");
	assert.ok(machines.uploads.length > 0 && machines.uploads.every(({ through }) => through === "exec"), "the daemon went through the exec socket's stdin");
});

test("the conformance module reads COMPUTER_NORTHFLANK_* alone, after its live switch; the project is required; the sweep's host needs no switch and its scope never shows the token", async () => {
	assert.throws(() => settingsFromEnv({ NORTHFLANK_API_TOKEN: TOKEN, NF_API_TOKEN: TOKEN }), (error) => /set COMPUTER_NORTHFLANK_TOKEN/.test(error.message) && !error.message.includes(TOKEN));
	const env = { [ENV.key]: TOKEN };
	assert.throws(() => settingsFromEnv({ ...env, NORTHFLANK_PROJECT_ID: "theirs" }), /set COMPUTER_NORTHFLANK_PROJECT_ID .*never from NORTHFLANK_PROJECT_ID/);
	env[ENV.project] = PROJECT;
	assert.deepEqual(settingsFromEnv(env), { token: TOKEN, projectId: PROJECT });
	assert.deepEqual(settingsFromEnv({ ...env, [ENV.team]: "my-team", [ENV.apiUrl]: "https://api.northflank.test" }), { token: TOKEN, projectId: PROJECT, teamId: "my-team", apiUrl: "https://api.northflank.test" });
	await assert.rejects(createProvider({ env }), /set AGENTRUN_COMPUTER_LIVE_NORTHFLANK=1/);
	assert.equal((await createProvider({ env: { ...env, [ENV.live]: "1" } })).capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal((await createHost({ env })).descriptor.id, "northflank");
	assert.equal(await conformanceImage({ env: {} }), boxImageRef());
	assert.equal(await conformanceImage({ env: { [ENV.image]: IMAGE } }), IMAGE);
	assert.match(sweepScope({ env }), new RegExp(`the Northflank project ${PROJECT} at https://api\\.northflank\\.com, by the token sha256:[0-9a-f]{12}`));
	assert.doesNotMatch(sweepScope({ env }), new RegExp(TOKEN));
	assert.equal((await create({ token: TOKEN, projectId: PROJECT })).host.descriptor.label, "Northflank");
});

test("the provider's source reads no environment and holds no project, team or service of anyone's: each comes from its caller", () => {
	const source = readFileSync(new URL("../dist/northflank.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /process\.env/);
	assert.doesNotMatch(source, /projectId\s*=\s*"|teamId\s*=\s*"/, "no default project or team");
});
