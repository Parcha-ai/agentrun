// VercelProvider's host against a stand-in for Vercel Sandbox's REST API (fake-vercel.mjs: a fetch that answers in the
// shapes of Vercel's own client, its commands scripted or real processes here): what the host sends for create, get,
// list, delete, exec and extend, how it reads the answers back, and the exec pre-check over it. The adapter's
// lifecycle is tested once, against its fake host (hosted-provider.test.mjs); Vercel's own is proven live.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";
import { fakeExecHost } from "./fake-exec-host.mjs";
import { fakeVercel, PROJECT, TEAM, TOKEN } from "./fake-vercel.mjs";

const { VercelProvider, create } = await import("../dist/vercel.js");
const { VERCEL } = await import("../dist/descriptors/index.js");
const { packLabels } = await import("../dist/hosted/values.js");
const { checkExecStream, formatExecStream } = await import("../dist/conformance/exec-stream.js");
const { VERCEL_ENV: ENV, settingsFromEnv, createProvider, createHost, conformanceImage, sweepScope } = await import("../dist/conformance/vercel.js");

const CTX = { timeoutMs: 5_000 };
const NAME = "computer-0123456789ab";
const LABELS = { "agentrun.computer": "1", "agentrun.computer.name": NAME };
const HAS_PROC = existsSync("/proc/self/stat");
const request = (more = {}) => ({ name: NAME, image: "agentrun-box:0123456789ab", labels: { agentrun: NAME }, lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: false, ...more });

function vercelOf(options) {
	const vendor = fakeVercel(options);
	const provider = new VercelProvider({ token: TOKEN, teamId: TEAM, projectId: PROJECT, fetch: vendor.fetch, timeouts: { pollMs: 1 } });
	return { vendor, provider, host: provider.host };
}

/** A whole stream's text. */
const textOf = async (stream) => Buffer.concat(await stream.toArray()).toString("utf8");

test("the descriptor: a sandbox under VERCEL_TOKEN with the team and project ids required, every network form through init, no mount, the box image prepareImage() answers", async () => {
	assert.equal(VERCEL.id, "vercel");
	assert.deepEqual(VERCEL.keys, [
		{ name: "VERCEL_TOKEN", option: "token", required: true },
		{ name: "VERCEL_TEAM_ID", option: "teamId", required: true },
		{ name: "VERCEL_PROJECT_ID", option: "projectId", required: true },
	]);
	assert.deepEqual([VERCEL.network, VERCEL.mounts, VERCEL.prepareImage], [["none", "open", "allow"], [], true]);
	const { provider } = vercelOf();
	const image = await provider.prepareImage();
	assert.match(image.value, /^agentrun-box:[0-9a-f]{12}$/);
	assert.deepEqual(await provider.prepareImage(), image, "a second call answers the same image");
	assert.equal(provider.host.facts.arch, "amd64");
	assert.deepEqual(provider.host.facts.labels, { count: 5, packed: { valueBytes: 256 } });
	assert.throws(() => new VercelProvider({ token: "", teamId: TEAM, projectId: PROJECT }), /options\.token, a Vercel access token, is required/);
	assert.throws(() => new VercelProvider({ token: TOKEN, teamId: "team x", projectId: PROJECT }), (error) => /options\.teamId is required/.test(error.message) && !error.message.includes(TOKEN));
	assert.throws(() => new VercelProvider({ token: TOKEN, teamId: TEAM }), /options\.projectId is required/);
});

test("create posts the name, the image, the lifetime as the timeout, persistent false, the vCPUs, the tags and deny-all for no egress; the team and project on the call", async () => {
	const { vendor, host } = vercelOf();
	assert.deepEqual(await host.create(request({ cpus: 4 }), CTX), { id: NAME });
	const [call] = vendor.calls;
	assert.deepEqual([call.method, call.path, call.query], ["POST", "/v3/sandboxes", { teamId: TEAM }]);
	assert.deepEqual(call.body, { projectId: PROJECT, name: NAME, image: "agentrun-box:0123456789ab", timeout: 600_000, persistent: false, ports: [], resources: { vcpus: 4 }, tags: { agentrun: NAME }, networkPolicy: { mode: "deny-all" } });
	await host.create(request({ name: "computer-0123456789ac", egress: true }), CTX);
	assert.equal(vendor.calls[1].body.networkPolicy, undefined, "egress leaves Vercel's own policy, allow-all");
	assert.deepEqual(vendor.calls[1].body.resources, { vcpus: 2 });
});

test("a create of a name the project holds is exists (unverified until the live run: Vercel's 409); an image the project lacks says how to push the box image", async () => {
	const { host } = vercelOf();
	await host.create(request(), CTX);
	await assert.rejects(host.create(request(), CTX), (error) => error.code === "exists" && /409: sandbox_already_exists: A sandbox named computer-0123456789ab already exists/.test(error.message));
	const missing = new VercelProvider({ token: TOKEN, teamId: TEAM, projectId: "prj_other", fetch: fakeVercel().fetch }).host;
	await assert.rejects(missing.create(request(), CTX), (error) => error.code === "invalid" && /vercel vcr build docker \. agentrun-box:[0-9a-f]{12} --push/.test(error.message));
	const denied = new VercelProvider({ token: "fake-test-key-other", teamId: TEAM, projectId: PROJECT, fetch: fakeVercel().fetch }).host;
	await assert.rejects(denied.list({}, CTX), (error) => error.code === "denied" && !error.message.includes("fake-test-key-other"));
});

test("get reads a sandbox by name without waking it, its status as the adapter's state, its end as the session's start plus its timeout; a name Vercel lacks is not_found", async () => {
	const { vendor, host } = vercelOf();
	await host.create(request(), CTX);
	const machine = await host.get(NAME, CTX);
	const { session, sandbox } = vendor.sandboxes.get(NAME);
	assert.deepEqual(vendor.calls.at(-1).query, { teamId: TEAM, projectId: PROJECT, resume: "false" });
	assert.deepEqual(machine, { id: NAME, labels: { agentrun: NAME }, state: "running", createdAt: new Date(sandbox.createdAt), endsAt: new Date(session.startedAt + 600_000) });
	const states = { pending: "starting", running: "running", stopping: "gone", snapshotting: "gone", stopped: "gone", failed: "gone", aborted: "gone", resuming: "stopped" };
	for (const [status, state] of Object.entries(states)) {
		sandbox.status = status;
		session.stopReason = status === "failed" ? "the VM could not boot" : undefined;
		const read = await host.get(NAME, CTX);
		assert.equal(read.state, state, status);
		if (status === "failed") assert.equal(read.why, "the VM could not boot");
		if (status === "resuming") assert.equal(read.why, "Vercel reads its status as resuming");
	}
	await assert.rejects(host.get("computer-ffffffffffff", CTX), (error) => error.code === "not_found");
});

test("list asks for the project's computers by name prefix, by the one tag asked, every page", async () => {
	const { vendor, host } = vercelOf({ pageSize: 2 });
	for (let i = 0; i < 5; i++) await host.create(request({ name: `computer-00000000000${i}`, labels: { agentrun: `computer-00000000000${i}` } }), CTX);
	const all = await host.list({}, CTX);
	assert.deepEqual(all.map((one) => one.id), [0, 1, 2, 3, 4].map((i) => `computer-00000000000${i}`));
	const pages = vendor.calls.filter((call) => call.path === "/v2/sandboxes");
	assert.deepEqual(pages.map((call) => call.query.cursor), [undefined, "2", "4"]);
	assert.deepEqual(pages[0].query, { teamId: TEAM, project: PROJECT, namePrefix: "computer-" });
	const one = await host.list({ agentrun: "computer-000000000003" }, CTX);
	assert.deepEqual(one.map((machine) => machine.id), ["computer-000000000003"]);
	assert.equal(vendor.calls.at(-1).query.tags, "agentrun:computer-000000000003");
});

test("labels: the adapter's and the caller's go packed in 5 tags of 256 characters at most, and read back exactly through the provider's list", async () => {
	const { vendor, provider, host } = vercelOf();
	const labels = { ...LABELS, "agentrun.run": "run-1", "agentrun.epoch": "2", "agentrun.computer.deadline": new Date(Date.now() + 600_000).toISOString(), "agentrun.computer.network": "none", team: "x".repeat(200) };
	const packed = packLabels(labels, NAME, host.facts.labels);
	await host.create(request({ labels: packed.labels }), CTX);
	const stored = vendor.sandboxes.get(NAME).sandbox.tags;
	assert.ok(Object.keys(stored).length <= 5 && Object.values(stored).every((value) => value.length <= 256), JSON.stringify(stored));
	const listed = await provider.list({ "agentrun.run": "run-1" });
	assert.equal(listed.ok, true, JSON.stringify(listed.error));
	assert.deepEqual(listed.value.map((info) => [info.ref, info.labels]), [[{ id: NAME, name: NAME }, labels]]);
	const tooMany = provider.check({ image: "agentrun-box:0123456789ab", lifetimeMs: 600_000, network: "none", labels: { blob: randomBytes(1_500).toString("hex") } });
	assert.deepEqual(tooMany.map((one) => one.field), ["labels"], "labels past 5 packed tags are refused before any call");
});

test("delete deletes by name and reads back as none; a name Vercel no longer has is done; release deletes and waits for the readback", async () => {
	const { vendor, provider, host } = vercelOf();
	await host.create(request({ labels: packLabels(LABELS, NAME, host.facts.labels).labels }), CTX);
	await host.delete(NAME, CTX);
	assert.deepEqual([vendor.calls.at(-1).method, vendor.calls.at(-1).path, vendor.calls.at(-1).query], ["DELETE", `/v2/sandboxes/${NAME}`, { teamId: TEAM, projectId: PROJECT }]);
	await assert.rejects(host.get(NAME, CTX), (error) => error.code === "not_found");
	await host.delete(NAME, CTX);
	await host.create(request({ labels: packLabels(LABELS, NAME, host.facts.labels).labels }), CTX);
	const released = await provider.release({ id: NAME, name: NAME }, "delete");
	assert.equal(released.ok, true, JSON.stringify(released.error));
	assert.equal(vendor.sandboxes.has(NAME), false);
});

test("exec runs argv as root with stdin attached; stdin goes by offset, end closes it, output comes as text apart on stdout and stderr, then the exit code; kill sends SIGKILL", async () => {
	const { vendor, host } = vercelOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["cat", "-"], CTX);
	const start = vendor.calls.find((call) => call.path.endsWith("/cmd"));
	assert.deepEqual([start.path, start.body], [`/v2/sandboxes/sessions/${vendor.sandboxes.get(NAME).session.id}/cmd`, { command: "cat", args: ["-"], sudo: true, attachStdin: true }]);
	const id = [...vendor.commands.keys()][0];
	await proc.write(Buffer.from("héllo"));
	await proc.write(Buffer.from(" world"));
	await proc.end();
	const stdin = vendor.calls.filter((call) => call.path.endsWith("/stdin")).map((call) => call.body);
	assert.deepEqual(stdin, [{ data: Buffer.from("héllo").toString("base64"), offset: 0 }, { data: Buffer.from(" world").toString("base64"), offset: 6 }, { close: true, offset: 12 }]);
	const record = vendor.command(id);
	record.out("stdout", "out ");
	record.out("stderr", "err");
	record.out("stdout", "more");
	record.exit(3);
	assert.deepEqual([await textOf(proc.stdout), await textOf(proc.stderr), await proc.wait()], ["out more", "err", 3]);
	const killed = await host.exec(NAME, ["sleep", "600"], CTX);
	await killed.kill();
	assert.equal(vendor.command([...vendor.commands.keys()][1]).killed, 9);
});

test("a character split across two chunks of the log stream arrives whole, as does one split inside a stdin write's bytes", async () => {
	// Each line's bytes come one byte a chunk: every multi-byte character of the stream is split.
	const { vendor, host } = vercelOf({ split: (bytes) => [...bytes].map((byte) => new Uint8Array([byte])) });
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["cat"], CTX);
	const record = vendor.command([...vendor.commands.keys()][0]);
	record.out("stdout", "é😀ü\r\nend");
	record.exit(0);
	assert.equal(await textOf(proc.stdout), "é😀ü\r\nend");
	assert.equal(await proc.wait(), 0);
});

test("75 s of silence on the log stream is no end: the stream stays open, unread again, and the output after it comes, then the exit", async (t) => {
	const { vendor, host } = vercelOf();
	await host.create(request(), CTX);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const proc = await host.exec(NAME, ["sleep", "100"], CTX);
	const record = vendor.command([...vendor.commands.keys()][0]);
	let settled;
	proc.wait().then((code) => (settled = code), (error) => (settled = error));
	const out = textOf(proc.stdout);
	for (let at = 0; at < 75; at++) {
		await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.tick(1_000);
	}
	assert.equal(settled, undefined, "the process still runs after 75 s of nothing");
	assert.equal(vendor.calls.filter((call) => call.path.endsWith("/logs")).length, 1, "one log stream, never read again");
	record.out("stdout", "late");
	record.exit(0);
	assert.equal(await out, "late");
	assert.equal(await proc.wait(), 0);
});

test("a log stream that drops is read again from the start, the text already given skipped: nothing lost, nothing twice", async () => {
	const { vendor, host } = vercelOf({ dropAfter: 2 });
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["seq", "4"], CTX);
	const record = vendor.command([...vendor.commands.keys()][0]);
	for (const line of ["1\n", "2\n", "3\n"]) record.out("stdout", line);
	record.out("stderr", "warn\n");
	record.exit(0);
	assert.deepEqual([await textOf(proc.stdout), await textOf(proc.stderr), await proc.wait()], ["1\n2\n3\n", "warn\n", 0]);
	assert.equal(vendor.calls.filter((call) => call.path.endsWith("/logs")).length, 2);
});

test("a log stream that ends before the command's last write, which the command read then finds exited, still gives that write: byte-exact, in order, once", async () => {
	let wrote = false;
	// The first stream closes cleanly after one line; the command writes its last output and exits before its read answers.
	const onStatus = (record) => {
		if (wrote) return;
		wrote = true;
		record.out("stdout", "last é😀\n");
		record.out("stderr", "bye");
		record.exit(0);
	};
	const { vendor, host } = vercelOf({ cutAfter: 1, onStatus });
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["sh", "-c", "work"], CTX);
	const record = vendor.command([...vendor.commands.keys()][0]);
	record.out("stdout", "first ");
	record.out("stdout", "second ");
	assert.deepEqual([await textOf(proc.stdout), await textOf(proc.stderr), await proc.wait()], ["first second last é😀\n", "bye", 0]);
	assert.equal(wrote, true);
});

test("a command read that keeps failing while the log stream stays readable ends the exec with the read's failure after READ_TRIES, in bounded time", async (t) => {
	const { vendor, host } = vercelOf({ statusFails: true });
	await host.create(request(), CTX);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const proc = await host.exec(NAME, ["true"], CTX);
	const record = vendor.command([...vendor.commands.keys()][0]);
	record.out("stdout", "done\n");
	record.exit(0);
	let settled;
	proc.wait().then((code) => (settled = code), (error) => (settled = error));
	const out = textOf(proc.stdout).catch((error) => error);
	for (let at = 0; at < 300 && settled === undefined; at++) {
		for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.tick(1_000);
	}
	assert.ok(settled instanceof Error, `the exec ends within 300 s of failed reads, not ${String(settled)}`);
	assert.match(settled.message, /503/);
	const reads = vendor.calls.filter((call) => call.method === "GET" && /\/cmd\/[^/]+$/.test(call.path));
	assert.equal(reads.length, 3 * 10, "READ_TRIES reads, each sent 3 times");
	await out;
});

test("an error line on the log stream ends the command in Vercel's words", async () => {
	const { vendor, host } = vercelOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["sleep", "600"], CTX);
	vendor.command([...vendor.commands.keys()][0]).lines.push({ stream: "error", data: { code: "sandbox_stopped", message: "The sandbox was stopped" } });
	vendor.command([...vendor.commands.keys()][0]).wake();
	await assert.rejects(proc.wait(), /Vercel ended command cmd_\d+'s output: sandbox_stopped: The sandbox was stopped/);
});

test("extend moves the session's end by the difference, never earlier; past the plan's cap is a limit", async () => {
	const { vendor, host } = vercelOf();
	await host.create(request(), CTX);
	const { session } = vendor.sandboxes.get(NAME);
	const end = session.startedAt + 600_000;
	await host.extend(NAME, new Date(end + 300_000), CTX);
	assert.deepEqual(vendor.calls.at(-1).body, { duration: 300_000 });
	assert.equal(vendor.calls.at(-1).path, `/v2/sandboxes/sessions/${session.id}/extend-timeout`);
	const before = vendor.calls.length;
	await host.extend(NAME, new Date(end), CTX);
	assert.equal(vendor.calls.filter((call) => call.path.endsWith("/extend-timeout")).length, 1, "an end earlier than the session's moves nothing");
	assert.ok(vendor.calls.length > before);
	await assert.rejects(host.extend(NAME, new Date(end + 48 * 3_600_000), CTX), (error) => error.code === "limit" && /exceeds your plan's maximum/.test(error.message));
});

test("check takes a registry reference, 1 or an even 2 to 8 vCPUs, and memory only at 2048 MiB a vCPU", () => {
	const { provider } = vercelOf();
	const spec = { lifetimeMs: 600_000, network: "none" };
	for (const image of ["agentrun-box:0123456789ab", "my-repo", "vercel/sandbox/universal", "vcr.vercel.com/team/project/repo:v1", `repo@sha256:${"a".repeat(64)}`]) assert.deepEqual(provider.check({ ...spec, image }), [], image);
	for (const image of ["ghcr.io/parcha-ai/agentrun-box:abc", "Repo", "a/b", 7]) assert.deepEqual(provider.check({ ...spec, image }).map((one) => one.field), ["image"], String(image));
	assert.deepEqual(provider.check({ ...spec, image: "my-repo", cpus: 4, memoryMb: 8192 }), []);
	assert.deepEqual(provider.check({ ...spec, image: "my-repo", cpus: 3 }).map((one) => one.field), ["cpus"]);
	assert.deepEqual(provider.check({ ...spec, image: "my-repo", cpus: 2, memoryMb: 2048 }).map((one) => one.message), ["a Vercel sandbox has 2048 MiB a vCPU, so 4096 here: name cpus, not memoryMb"]);
});

test("the exec passes every check of the exec pre-check, over real processes behind the log stream and stdin calls", async (t) => {
	if (!HAS_PROC) return t.skip("no /proc here");
	const local = fakeExecHost();
	t.after(() => local.stopAll());
	const { host } = vercelOf({ backend: local });
	await host.create(request(), CTX);
	const report = await checkExecStream(host, NAME, { longMs: 2_000, stepMs: 5_000, largeBytes: 1024 * 1024, largeMs: 30_000, unreadMs: 1_000 });
	assert.equal(report.pass, true, formatExecStream(report));
});

test("the conformance module reads COMPUTER_VERCEL_* alone, after its live switch; the sweep's host needs none and its scope never shows the token", async () => {
	assert.throws(() => settingsFromEnv({ VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM, VERCEL_PROJECT_ID: PROJECT }), (error) => /set COMPUTER_VERCEL_TOKEN/.test(error.message) && !error.message.includes(TOKEN));
	const env = { [ENV.key]: TOKEN, [ENV.team]: TEAM, [ENV.project]: PROJECT };
	assert.throws(() => settingsFromEnv({ [ENV.key]: TOKEN, [ENV.team]: TEAM }), /set COMPUTER_VERCEL_PROJECT_ID/);
	assert.deepEqual(settingsFromEnv(env), { token: TOKEN, teamId: TEAM, projectId: PROJECT });
	await assert.rejects(createProvider({ env }), /set AGENTRUN_COMPUTER_LIVE_VERCEL=1/);
	assert.equal((await createProvider({ env: { ...env, [ENV.live]: "1" } })).capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal((await createHost({ env })).descriptor.id, "vercel");
	assert.match(await conformanceImage({ env: {} }), /^agentrun-box:[0-9a-f]{12}$/);
	assert.equal(await conformanceImage({ env: { [ENV.image]: "team/project/mine:v1" } }), "team/project/mine:v1");
	assert.match(sweepScope({ env }), /prj_fake0123 of team team_fake0123, by the token sha256:[0-9a-f]{12}/);
	assert.doesNotMatch(sweepScope({ env }), new RegExp(TOKEN));
	assert.equal((await create({ token: TOKEN, teamId: TEAM, projectId: PROJECT })).host.descriptor.label, "Vercel Sandbox");
});
