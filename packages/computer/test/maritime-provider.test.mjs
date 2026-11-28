// MaritimeProvider's host against a stand-in for Maritime's virtual machines API (fake-maritime.mjs: a fetch for the
// control plane and each VM's data plane): what the host sends for create (the VM, then agentrun-dial as a background
// command), get, list and delete, how it reads the answers back, agentrun-dial's log, exit and second start, and the
// provider's Core conformance cases over dial, the machine booted from the command's env (bootDial). The adapter's
// lifecycle is tested once, against its fake host (hosted-provider.test.mjs, hosted-dial.test.mjs); Maritime's own is
// proven live, from packages/serve/scripts/dial-conformance.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ATTACH_CLOSE, AttachHub, MemoryMachineTokens, mintedComputer } from "../dist/index.js";
import { boxImageRef } from "../dist/box-image.js";
import { dialLaunch } from "../dist/hosted/scripts.js";
import * as registry from "../dist/providers.js";
import { bootDial, dialServer, PUBLIC_URL, socketPair } from "./fake-dial-host.mjs";
import { fakeMaritime, KEY, refuse } from "./fake-maritime.mjs";

const { MaritimeProvider, create } = await import("../dist/maritime.js");
const { MARITIME } = await import("../dist/descriptors/index.js");
const maritimeModule = await import("../dist/conformance/maritime.js");

const CTX = { timeoutMs: 5_000 };
const NAME = "computer-0123456789ab";
const LABELS = { "agentrun.computer": "1", "agentrun.computer.name": NAME, "agentrun.run": "run-1" };
const BOOT = { AGENTRUN_ATTACH_URL: "wss://agentrun.example.com/v2/computers/attach", AGENTRUN_ATTACH_TOKEN: `art_${"0".repeat(64)}`, AGENTRUN_DAEMON_URL: "https://agentrun.example.com/v2/computers/daemon", AGENTRUN_DAEMON_SHA256: "0".repeat(64), AGENTRUN_INIT_ARGS: "--deadline 2026-11-28T12:00:00.000Z" };
const IMAGE = boxImageRef();
const request = (more = {}) => ({ name: NAME, image: IMAGE, labels: LABELS, lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: true, boot: { env: BOOT }, ...more });
const dir = mkdtempSync(join(tmpdir(), "computer-maritime-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, Buffer.from("a stand-in for computerd, linux/amd64\n"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const TIMEOUTS = { requestMs: 2_000, createMs: 3_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 1_000, pollMs: 1, listedMs: 500, listedStableMs: 0 };
const DAY_MS = 24 * 3_600_000;

function maritimeOf(options, more = {}) {
	const vendor = fakeMaritime(options);
	const provider = new MaritimeProvider({ apiKey: KEY, fetch: vendor.fetch, timeouts: { pollMs: 1 }, ...more });
	return { vendor, provider, host: provider.host };
}
const posts = (vendor, path) => vendor.calls.filter((call) => call.method === "POST" && call.path === path);
const planeCalls = (vendor) => vendor.calls.filter((call) => call.host.endsWith(".sb.mtm.sh"));

test("the descriptor: a dial sandbox under MARITIME_API_KEY, every network form through init, no mount, the box image prepared; the host a janitor's microVM with no exec, upload or extend", () => {
	assert.equal(MARITIME.id, "maritime");
	assert.equal(MARITIME.label, "Maritime");
	assert.deepEqual(MARITIME.keys, [{ name: "MARITIME_API_KEY", option: "apiKey", required: true }]);
	assert.deepEqual([MARITIME.connect, MARITIME.network, MARITIME.mounts, MARITIME.defaultImage, MARITIME.prepareImage], ["dial", ["none", "open", "allow"], [], undefined, true]);
	const { host, provider } = maritimeOf();
	assert.deepEqual(host.facts, { daemon: "child", isolation: "microvm", lifetime: "janitor", maxLifetimeMs: DAY_MS - 300_000, arch: "amd64", vendorAgentPorts: [], connect: "dial" });
	assert.deepEqual([host.exec, host.upload, host.download, host.extend], [undefined, undefined, undefined, undefined]);
	assert.equal(provider.capabilities().kind, "linux");
	assert.throws(() => new MaritimeProvider({ apiKey: "" }), /options\.apiKey, a Maritime API key, is required/);
	assert.throws(() => new MaritimeProvider({ apiKey: KEY, apiUrl: "http://api.maritime.sh" }), /the Maritime API URL must be https/);
	assert.throws(() => new MaritimeProvider({ apiKey: KEY, fetch: "no" }), /options\.fetch must be a function/);
	assert.ok(create({ apiKey: KEY }) instanceof Promise);
});

test("create posts the name, the image, the labels as metadata as they are, egress to all, no idle timer and the backstop as the time limit, with no boot env; then starts agentrun-dial as a background command with the whole boot env", async () => {
	const { vendor, host } = maritimeOf();
	const { id } = await host.create(request(), CTX);
	assert.match(id, /^sbx-/);
	const [post] = posts(vendor, "/v1/sandboxes");
	assert.equal(post.headers.Authorization, `Bearer ${KEY}`);
	const { timeLimitSeconds, ...body } = post.body;
	assert.deepEqual(body, { name: NAME, from: IMAGE, metadata: LABELS, network: { egress: "all" }, keepAwake: true });
	assert.ok(timeLimitSeconds > 3_590 && timeLimitSeconds <= 3_600, `the time limit is the backstop's: ${timeLimitSeconds}`);
	// The command goes to the VM's own data plane, with its secret, once the VM reads running.
	const [command] = posts(vendor, "/v1/commands");
	assert.equal(command.host, `api-${id}.sb.mtm.sh`);
	assert.equal(command.headers["X-Maritime-Token"], vendor.sandboxes.get(id).sandbox.secret);
	assert.equal(command.headers.Authorization, undefined, "the API key never goes to a VM");
	assert.deepEqual(command.body, { cmd: ["sh", "-c", dialLaunch()], env: BOOT, background: true });
	assert.ok(!JSON.stringify(command.body.cmd).includes(BOOT.AGENTRUN_ATTACH_TOKEN), "the token is in the command's env, never its words");
	const gets = vendor.calls.filter((call) => call.method === "GET" && call.path === `/v1/sandboxes/${id}`);
	assert.ok(gets.length >= 1, "the VM was read until it ran");
});

test("create sends a size as Maritime's vcpu and memoryMib, a time limit of 24 h at most and 60 s at least, and refuses a request with no boot env before any call", async () => {
	const { vendor, host } = maritimeOf();
	await host.create(request({ cpus: 4, memoryMb: 8192, backstopAt: new Date(Date.now() + 2 * DAY_MS).toISOString() }), CTX);
	assert.deepEqual([posts(vendor, "/v1/sandboxes")[0].body.vcpu, posts(vendor, "/v1/sandboxes")[0].body.memoryMib, posts(vendor, "/v1/sandboxes")[0].body.timeLimitSeconds], [4, 8192, 86_400]);
	await host.create(request({ name: "computer-0123456789ac", backstopAt: new Date(Date.now() + 1_000).toISOString() }), CTX);
	assert.equal(posts(vendor, "/v1/sandboxes")[1].body.timeLimitSeconds, 60);
	const before = vendor.calls.length;
	await assert.rejects(host.create(request({ boot: undefined }), CTX), (error) => error.code === "invalid" && /no boot env/.test(error.message));
	assert.equal(vendor.calls.length, before);
});

test("labels: the metadata Maritime stores is read back exactly by get and by the provider's list; a value that is no string is none of ours", async () => {
	const { vendor, host, provider } = maritimeOf();
	const labels = { ...LABELS, "agentrun.epoch": "2", "agentrun.computer.deadline": new Date(Date.now() + 600_000).toISOString(), team: "x".repeat(200) };
	const { id } = await host.create(request({ labels }), CTX);
	assert.deepEqual(vendor.sandboxes.get(id).sandbox.metadata, labels);
	assert.deepEqual((await host.get(id, CTX)).labels, labels);
	vendor.sandboxes.get(id).sandbox.metadata = { ...labels, odd: 7 };
	assert.deepEqual((await host.get(id, CTX)).labels, labels);
	const listed = await provider.list({ "agentrun.run": "run-1" });
	assert.equal(listed.ok, true, JSON.stringify(listed.error));
	assert.deepEqual(listed.value.map((info) => [info.ref, info.labels]), [[{ id, name: NAME }, labels]]);
});

test("a create of a name Maritime holds live answers that VM (200), read as exists: no second VM and no command started; a 409 is exists too", async () => {
	const { vendor, host } = maritimeOf();
	const { id } = await host.create(request(), CTX);
	await assert.rejects(host.create(request(), CTX), (error) => error.code === "exists" && error.message.includes(NAME) && error.message.includes(id));
	assert.equal(vendor.sandboxes.size, 1);
	assert.equal(posts(vendor, "/v1/commands").length, 1);
	const taken = maritimeOf({ answer: (method, url) => (method === "POST" && url.pathname === "/v1/sandboxes" ? refuse(409, "idempotency_conflict", "Another create holds this key") : undefined) });
	await assert.rejects(taken.host.create(request(), CTX), (error) => error.code === "exists");
});

test("not_found: get of a VM Maritime has not is none; delete of one is done; dialLog and dialExit of one no command started here are none, and its redial is not_found", async () => {
	const { host } = maritimeOf();
	assert.equal(await host.get("sbx-nothere", CTX), undefined);
	await host.delete("sbx-nothere", CTX);
	assert.equal(await host.dialLog("sbx-nothere", CTX), undefined);
	assert.equal(await host.dialExit("sbx-nothere", CTX), undefined);
	await assert.rejects(host.redial("sbx-nothere", CTX), (error) => error.code === "not_found");
});

test("delete ends the VM by its id and is safe to repeat; get then reads it none (Maritime keeps an ended VM's record), and a listing leaves it out", async () => {
	const { vendor, host } = maritimeOf();
	const { id } = await host.create(request(), CTX);
	await host.delete(id, CTX);
	assert.deepEqual(
		vendor.calls.filter((call) => call.method === "DELETE").map((call) => call.path),
		[`/v1/sandboxes/${id}`],
	);
	assert.equal(vendor.sandboxes.get(id).sandbox.state, "ended");
	assert.equal(await host.get(id, CTX), undefined, "an ended VM is none");
	assert.deepEqual(await host.list({ "agentrun.computer": "1" }, CTX), []);
	await host.delete(id, CTX);
	assert.equal(await host.dialExit(id, CTX), undefined, "what this process kept of its command went with it");
});

test("list asks for the computers' name prefix, reads every page by cursor, and keeps only VMs that carry every label asked: others' VMs, ended ones and those of other names are left out", async () => {
	const { vendor, host } = maritimeOf({ pageSize: 2 });
	const ours = vendor.add({ name: NAME, metadata: LABELS });
	vendor.add({ name: "computer-aaaaaaaaaaaa", metadata: { ...LABELS, "agentrun.run": "run-2" } });
	vendor.add({ name: "computer-bbbbbbbbbbbb", metadata: {} });
	vendor.add({ name: "computer-cccccccccccc", metadata: LABELS, state: "ended" });
	vendor.add({ name: "my-own-vm", metadata: LABELS });
	const paused = vendor.add({ name: "computer-dddddddddddd", metadata: LABELS, state: "paused" });
	const listed = await host.list({ "agentrun.run": "run-1" }, CTX);
	assert.deepEqual(listed.map((m) => [m.id, m.state]).sort(), [[ours.id, "running"], [paused.id, "stopped"]].sort());
	const pages = vendor.calls.filter((call) => call.method === "GET" && call.path === "/v1/sandboxes");
	assert.ok(pages.length >= 3, `every page was read: ${pages.length}`);
	assert.deepEqual(pages.map((call) => [call.query.namePrefix, call.query.limit]), pages.map(() => ["computer-", "100"]));
	assert.deepEqual(pages.slice(1).map((call) => call.query.cursor), ["2", "4"].slice(0, pages.length - 1));
});

test("get reads Maritime's states as the adapter's: starting and resuming starting, running, pausing and paused stopped, error and any other stopped with Maritime's words; its size and its time", async () => {
	const { vendor, host } = maritimeOf();
	const states = { starting: "starting", resuming: "starting", running: "running", pausing: "stopped", paused: "stopped", error: "stopped", hibernating: "stopped" };
	for (const [state, ours] of Object.entries(states)) {
		const made = vendor.add({ name: `computer-${state.padEnd(12, "0").slice(0, 12)}`, metadata: LABELS, state, vcpu: 4, memoryMib: 8192 });
		vendor.sandboxes.get(made.id).reads = -1_000;
		if (state === "error") made.endedReason = "image_pull_failed";
		const read = await host.get(made.id, CTX);
		assert.equal(read.state, ours, state);
		assert.deepEqual(read.resources, { cpus: 4, memoryMb: 8192, diskGb: 10 }, state);
		assert.ok(read.createdAt instanceof Date, state);
		if (ours === "stopped" && state !== "pausing" && state !== "paused") assert.match(read.why, new RegExp(`Maritime reads it ${state}`), state);
	}
	const errored = [...vendor.sandboxes.values()].find(({ sandbox }) => sandbox.state === "error").sandbox;
	assert.match((await host.get(errored.id, CTX)).why, /image_pull_failed/);
});

test("a VM that errors or ends before it runs fails create in Maritime's words (the adapter then ends it by its name), agentrun-dial never started; one still starting at the bound is a timeout", async () => {
	// The VM errors at its first read.
	const errors = maritimeOf({
		startReads: 1_000,
		answer: (method, url) => {
			if (method === "GET" && url.pathname.startsWith("/v1/sandboxes/")) Object.assign([...errors.vendor.sandboxes.values()][0].sandbox, { state: "error", endedReason: "image_pull_failed" });
		},
	});
	await assert.rejects(errors.host.create(request(), CTX), (error) => error.code === "vendor" && /error/.test(error.message) && /image_pull_failed/.test(error.message) && /agentrun-dial was not started/.test(error.message));
	assert.deepEqual(posts(errors.vendor, "/v1/commands"), []);
	const slow = maritimeOf({ startReads: 1_000_000 });
	await assert.rejects(slow.host.create(request(), { timeoutMs: 200 }), (error) => error.code === "timeout" && /did not read running within/.test(error.message));
	assert.deepEqual(posts(slow.vendor, "/v1/commands"), []);
});

test("a create whose command Maritime refuses (401 at the data plane, or 402 past every retry) ends the VM it made, in the refusal's own code", async () => {
	for (const [status, code, why] of [[401, "denied", "unauthenticated"], [402, "limit", "plan_required"]]) {
		const { vendor, host } = maritimeOf({ answer: (method, url) => (method === "POST" && url.pathname === "/v1/commands" ? refuse(status, why, "the plane said no") : undefined) });
		await assert.rejects(host.create(request(), CTX), (error) => error.code === code && /it made was ended/.test(error.message) && error.message.includes(why));
		assert.deepEqual(vendor.live(), [], `${status}: a VM create made is never left running`);
	}
});

test("dialLog and dialExit read agentrun-dial's command from the VM's data plane: none while it runs (through any silence), its output and its exit code after; a kill is 128 and its signal; redial starts the same command again", async () => {
	const { vendor, host } = maritimeOf();
	const { id } = await host.create(request(), CTX);
	const [first] = vendor.commands.keys();
	for (let i = 0; i < 5; i++) assert.equal(await host.dialExit(id, CTX), undefined, "running: no exit, however long it is quiet");
	assert.equal(await host.dialLog(id, CTX), "");
	vendor.write(first, { stderr: "agentrun-dial: fetching computerd é" });
	assert.equal(await host.dialLog(id, CTX), "agentrun-dial: fetching computerd é", "a UTF-8 log reads whole");
	vendor.exit(first, 3, { stdout: "", stderr: "agentrun-dial: the daemon fetch failed: 503\n" });
	assert.equal(await host.dialExit(id, CTX), 3);
	assert.match(await host.dialLog(id, CTX), /the daemon fetch failed: 503/);
	await host.redial(id, CTX);
	const started = posts(vendor, "/v1/commands");
	assert.equal(started.length, 2);
	assert.deepEqual(started[1].body, started[0].body, "the same command, the same env");
	assert.equal(await host.dialExit(id, CTX), undefined, "the new command runs");
	const second = [...vendor.commands.keys()].at(-1);
	Object.assign(vendor.commands.get(second), { state: "killed", signal: "SIGKILL" });
	assert.equal(await host.dialExit(id, CTX), 137);
	Object.assign(vendor.commands.get(second), { signal: "SIGTERM" });
	assert.equal(await host.dialExit(id, CTX), 143);
	const reads = planeCalls(vendor).filter((call) => call.method === "GET");
	assert.ok(reads.every((call) => call.path.startsWith("/v1/commands/") && call.headers["X-Maritime-Token"] === vendor.sandboxes.get(id).sandbox.secret));
});

test("Maritime's errors are codes in its words, never the key: 401 denied, 402 and 429 limit, 400 invalid; a 429 create is sent again, a create with no answer never", async () => {
	let creates = 0;
	const busy = maritimeOf({ answer: (method, url) => (method === "POST" && url.pathname === "/v1/sandboxes" && ++creates === 1 ? refuse(429, "rate_limited", "Slow down") : undefined) });
	await busy.host.create(request(), CTX);
	assert.equal(posts(busy.vendor, "/v1/sandboxes").length, 2, "a 429 made nothing, so it is sent again");
	for (const [status, why, code] of [[401, "unauthenticated", "denied"], [402, "trial_size_limit", "limit"], [400, "invalid_size", "invalid"], [403, "account_suspended", "denied"]]) {
		const { host } = maritimeOf({ answer: (method, url) => (url.pathname === "/v1/sandboxes" ? refuse(status, why, "no") : undefined) });
		await assert.rejects(host.create(request(), CTX), (error) => error.code === code && error.message.includes(why) && !error.message.includes(KEY), `${status} ${why}`);
	}
	let sent = 0;
	const lost = new MaritimeProvider({
		apiKey: KEY,
		fetch: async (url, init) => {
			if (init.method === "POST") sent += 1;
			throw new TypeError("fetch failed");
		},
	});
	await assert.rejects(lost.host.create(request(), CTX));
	assert.equal(sent, 1, "a create that got no answer may have made a VM: the adapter finds it by its name");
});

test("check holds a size to Maritime's (1 to 16 vCPUs, whole GiB from 1 to 64) and an image to an OCI reference: Maritime's templates and snapshots hold no agentrun-dial", () => {
	const { host } = maritimeOf();
	assert.deepEqual(host.check({ cpus: 4, memoryMb: 8192, image: IMAGE }), []);
	assert.deepEqual(host.check({ cpus: 16, memoryMb: 65_536, image: "ghcr.io/me/my-box:1" }), []);
	assert.deepEqual(host.check({ image: "docker.io/me/box@sha256:" + "a".repeat(64) }), []);
	for (const cpus of [0, 17, 1.5, "2"]) assert.deepEqual(host.check({ cpus }).map(({ field }) => field), ["cpus"], String(cpus));
	for (const memoryMb of [512, 1000, 70_000, 98_304]) assert.deepEqual(host.check({ memoryMb }).map(({ field }) => field), ["memoryMb"], String(memoryMb));
	for (const image of ["base", "python", "desktop-linux", "my-snapshot", "ghcr.io/me/box tag", "/box", "ghcr.io//box", 7]) {
		assert.deepEqual(host.check({ image }).map(({ field, message }) => [field, /agentrun-dial/.test(message)]), [["image", true]], String(image));
	}
});

test("prepareImage answers the box image's public tag with no call: Maritime pulls it at the first create", async () => {
	const { vendor, provider } = maritimeOf();
	assert.deepEqual(await provider.prepareImage(), { ok: true, value: IMAGE });
	assert.deepEqual(vendor.calls, []);
});

test("the provider dials: kind linux, a microVM, no exec or upload; a server with no public address calls Maritime for nothing", async () => {
	const { vendor, provider } = maritimeOf({}, { dial: { tokens: new MemoryMachineTokens(), hub: new AttachHub() } });
	assert.equal(provider.id, "maritime");
	assert.equal(provider.host.facts.connect, "dial");
	const caps = provider.capabilities();
	assert.deepEqual([caps.kind, caps.isolation, caps.network], ["linux", "microvm", ["none", "open", "allow"]]);
	const refused = await provider.create({ image: IMAGE, lifetimeMs: 600_000, network: "none" }, { requestId: "maritime-no-address" });
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /^Maritime machines dial this server, and it has no public https address/);
	assert.deepEqual(vendor.calls, []);
});

/** The fake's VMs boot from agentrun-dial's command: its env, as the VM's process gets it, dials `dial`. */
function dialing(dial, more = {}) {
	const daemon = readFileSync(DAEMON_PATH);
	const booted = [];
	const vendor = fakeMaritime({
		start: (sandbox, command) => {
			if (command.cmd?.[2] === dialLaunch()) booted.push(bootDial(command.env, dial, { daemon }));
		},
		...more,
	});
	return { vendor, booted };
}

test("a Maritime VM over dial, as serve builds it: the VM boots, its command dials, its daemon answers linux; release ends it", async () => {
	const dial = dialServer();
	const { vendor, booted } = dialing(dial);
	const provider = new MaritimeProvider({ apiKey: KEY, fetch: vendor.fetch, dial, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const created = await provider.create({ image: IMAGE, lifetimeMs: 600_000, network: "none" }, { requestId: "maritime-over-dial" });
	assert.equal(created.ok, true, created.ok ? "" : `${created.error.code}: ${created.error.message}`);
	assert.equal(booted[0]?.dialed, true, "the VM's daemon is the server's: it dialed");
	const connection = await provider.connect(created.value);
	assert.equal(connection.ok, true, connection.ok ? "" : `${connection.error.code}: ${connection.error.message}`);
	assert.equal(connection.value.hello.kind, "linux");
	await connection.value.close();
	const released = await provider.release(created.value, "delete");
	assert.equal(released.ok, true, released.ok ? "" : `${released.error.code}: ${released.error.message}`);
	assert.deepEqual(vendor.live(), []);
});

/** The run's server for provider.dial-token, over the fake's commands: the token each VM was given, and a dial as any machine. */
function dialKitOf(vendor, dial, made) {
	const attach = (token, socket) => {
		const minted = dial.tokens.check(token);
		if (minted === undefined) return socket.close(ATTACH_CLOSE.unauthorized, "no machine has this token");
		void dial.hub.accept(mintedComputer(minted.machine, minted.mint), socket);
	};
	return () => ({
		check: (token, at) => dial.tokens.check(token, at)?.machine,
		token: (ref) => [...vendor.commands.values()].findLast((command) => vendor.sandboxes.get(command.sandboxId)?.sandbox.name === ref.name)?.env.AGENTRUN_ATTACH_TOKEN,
		async dialAs(token, hello) {
			const [server, machine] = socketPair();
			machine.onText((text) => {
				const asked = JSON.parse(text);
				if (typeof asked.id !== "number") return;
				machine.send(JSON.stringify({ jsonrpc: "2.0", id: asked.id, ...(asked.method === "hello" ? { result: hello } : { error: { code: -32601, message: `${asked.method} is not a method` } }) }));
			});
			const closed = new Promise((done) => machine.onClose((code) => done(code)));
			attach(token, server);
			return Promise.race([closed, new Promise((done) => setTimeout(done, 2_000))]);
		},
		unreachable() {
			const before = posts(vendor, "/v1/sandboxes").length;
			return { provider: new MaritimeProvider({ ...made, dial: { tokens: dial.tokens, hub: dial.hub } }), creates: () => posts(vendor, "/v1/sandboxes").length - before };
		},
	});
}

test("the provider's Core conformance cases pass through Maritime's REST calls and the dial, provider.dial-token among them, and leave nothing behind", { timeout: 60_000 }, async () => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const dial = dialServer();
	const { vendor } = dialing(dial);
	const options = { apiKey: KEY, fetch: vendor.fetch, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS };
	const provider = new MaritimeProvider({ ...options, dial });
	// Not provider.deadline or drift.arch: they run programs, which the fake machine's daemon only echoes.
	const cases = conformanceCases.filter((one) => ["provider", "health", "drift"].includes(one.group) && one.level === "core" && !["provider.deadline", "drift.arch"].includes(one.id));
	const report = await runConformance(provider, { image: IMAGE, cases, dial: dialKitOf(vendor, dial, options), caseTimeoutMs: 20_000, cleanupTimeoutMs: 5_000 });
	assert.ok(report.results.length >= 3, report.results.map(({ id }) => id).join(" "));
	assert.equal(report.results.find(({ id }) => id === "provider.dial-token")?.status, "pass", JSON.stringify(report.results.find(({ id }) => id === "provider.dial-token")));
	assert.deepEqual(
		report.results.filter(({ status }) => status === "fail").map(({ id, reason }) => `${id}: ${reason}`),
		[],
	);
	assert.deepEqual(vendor.live(), [], "every VM made was ended");
	assert.equal(PUBLIC_URL.startsWith("http://127.0.0.1"), true);
});

test("maritime is in the registry, and its conformance module reads COMPUTER_MARITIME_* alone, after its live switch, and refuses a dialKit off the public server", async () => {
	assert.ok(registry.providerIds.includes("maritime"));
	assert.equal((await registry.providerModule("maritime")).create, create);
	assert.deepEqual(maritimeModule.ENV, { live: "AGENTRUN_COMPUTER_LIVE_MARITIME", key: "COMPUTER_MARITIME_API_KEY", apiUrl: "COMPUTER_MARITIME_API_URL", image: "COMPUTER_MARITIME_IMAGE", daemon: "COMPUTER_MARITIME_DAEMON" });
	assert.throws(() => maritimeModule.settingsFromEnv({ MARITIME_API_KEY: KEY }), (error) => /set COMPUTER_MARITIME_API_KEY/.test(error.message) && !error.message.includes(KEY));
	const env = { COMPUTER_MARITIME_API_KEY: KEY };
	assert.deepEqual(maritimeModule.settingsFromEnv(env), { apiKey: KEY });
	assert.deepEqual(maritimeModule.settingsFromEnv({ ...env, COMPUTER_MARITIME_API_URL: "https://api.maritime.test" }), { apiKey: KEY, apiUrl: "https://api.maritime.test" });
	await assert.rejects(maritimeModule.createProvider({ env }), /set AGENTRUN_COMPUTER_LIVE_MARITIME=1/);
	assert.equal((await maritimeModule.createProvider({ env: { ...env, AGENTRUN_COMPUTER_LIVE_MARITIME: "1" } })).capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal((await maritimeModule.createHost({ env })).descriptor.id, "maritime");
	assert.match(maritimeModule.sweepScope({ env }), /^the Maritime account of the key sha256:[0-9a-f]{12} at https:\/\/api\.maritime\.sh$/);
	assert.ok(!maritimeModule.sweepScope({ env }).includes(KEY));
	assert.equal(await maritimeModule.conformanceImage({ env }), IMAGE);
	assert.equal(await maritimeModule.conformanceImage({ env: { ...env, COMPUTER_MARITIME_IMAGE: "ghcr.io/me/box:1" } }), "ghcr.io/me/box:1");
	assert.throws(() => maritimeModule.dialKit({ env }), /^Error: Maritime's machines dial the server that minted their tokens, and this run has no public server: run its Core with packages\/serve\/scripts\/dial-conformance\.mjs --provider maritime/);
});
