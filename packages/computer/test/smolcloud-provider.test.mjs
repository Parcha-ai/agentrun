// SmolcloudProvider's host against a recorder of smol cloud's REST API (a fetch that answers in the OpenAPI's shapes):
// what the host sends for create, get, list, exec, upload and extend, and how it reads the answers back. The adapter's
// lifecycle is tested once, against its fake host (hosted-provider.test.mjs); smol cloud's own is proven live.
import assert from "node:assert/strict";
import test from "node:test";

const { SmolcloudProvider } = await import("../dist/smolcloud.js");
const { SMOLCLOUD_ENV: ENV, settingsFromEnv, createProvider, createHost, conformanceImage, sweepScope } = await import("../dist/conformance/smolcloud.js");

const KEY = "smolcloud_fake_key_0123456789";
const API = "https://api.example.test";
const CTX = { timeoutMs: 5_000 };
const ID = "mach-0123";

/** A fetch that records each call and answers what route(method, path) gives: [status, json] or a function of the body. */
function recorder(route) {
	const calls = [];
	const fetch = async (url, init) => {
		const { pathname, search } = new URL(url);
		const body = init.body === undefined ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : Buffer.from(init.body);
		calls.push({ method: init.method, path: `${pathname}${search}`, body, auth: init.headers.Authorization });
		const [status, json] = route(init.method, `${pathname}${search}`, body) ?? [404, { detail: "no such route" }];
		return new Response(json === undefined ? null : JSON.stringify(json), { status });
	};
	const host = new SmolcloudProvider({ apiKey: KEY, apiUrl: API, fetch }).host;
	return { calls, host };
}

test("create names the machine agr-<name> on amd64 with the labels and a size, the idle stop off and the delete timer at the backstop; a 409 is exists, the account's cap limit", async () => {
	const { calls, host } = recorder((method) => (method === "POST" ? [201, { id: ID, state: "started" }] : undefined));
	const backstopAt = new Date(Date.now() + 3_600_000).toISOString();
	const labels = { "agentrun.computer": "1", "agentrun.computer.name": "computer-0123456789ab" };
	assert.deepEqual(await host.create({ name: "computer-0123456789ab", image: "alpine:3.20", labels, lifetimeMs: 600_000, backstopAt, egress: false }, CTX), { id: ID });
	const { ttlSeconds, ...body } = calls[0].body;
	assert.deepEqual(body, {
		name: "agr-computer-0123456789ab",
		source: { type: "image", reference: "alpine:3.20", arch: "amd64" },
		labels,
		resources: { cpus: 2, memoryMb: 4096 },
		autoStopSeconds: 0,
		start: true,
	});
	assert.ok(ttlSeconds > 3_590 && ttlSeconds <= 3_600, `ttlSeconds ${ttlSeconds} counts to the backstop`);
	assert.equal(calls[0].auth, `Bearer ${KEY}`);
	const taken = recorder(() => [409, { detail: "a machine named agr-computer-0123456789ab already exists", code: "conflict" }]).host;
	await assert.rejects(taken.create({ name: "computer-0123456789ab", image: "alpine:3.20", labels, lifetimeMs: 1, backstopAt, egress: false }, CTX), (error) => error.code === "exists" && /already exists/.test(error.message));
	const capped = recorder(() => [422, { detail: "concurrency limit reached: an account without a card can run 4 machines at once", code: "unprocessable" }]).host;
	await assert.rejects(capped.create({ name: "computer-0123456789ab", image: "alpine:3.20", labels, lifetimeMs: 1, backstopAt, egress: false }, CTX), (error) => error.code === "limit" && /4 machines at once/.test(error.message));
});

test("get and list read smol cloud's states as the adapter's, a deleted record as none, and list asks for every label", async () => {
	const states = { creating: "starting", started: "running", stopped: "stopped", paused: "stopped", error: "gone", deleting: "gone" };
	const machines = [...Object.keys(states), "deleted"].map((state, i) => ({ id: `mach-${i}`, state, labels: { a: "1" }, createdAt: "2026-11-17T00:00:00Z", error: state === "error" ? "start failed: no capacity" : null }));
	const { calls, host } = recorder((method, path) => (path.startsWith("/v1/machines?") ? [200, machines] : [200, machines.find((m) => path.endsWith(m.id))]));
	const listed = await host.list({ "agentrun.computer": "1", "agentrun.computer.name": "computer-x" }, CTX);
	assert.equal(calls[0].path, "/v1/machines?label=agentrun.computer%3D1&label=agentrun.computer.name%3Dcomputer-x");
	assert.deepEqual(
		listed.map((m) => m.state),
		Object.values(states),
	);
	assert.equal(listed.find((m) => m.state === "gone" && m.why)?.why, "start failed: no capacity");
	assert.deepEqual(listed[0].createdAt, new Date("2026-11-17T00:00:00Z"));
	assert.equal(await host.get("mach-6", CTX), undefined, "a deleted record is none");
	await assert.rejects(recorder(() => [404, { detail: "machine not found" }]).host.get(ID, CTX), (error) => error.code === "not_found");
});

test("exec sends argv as given, an argv with an empty word as one /bin/sh -c line; output by offset, stdin as numbered frames, the exit code; kill deletes it", async () => {
	const reads = [
		{ output: [{ stream: "stdout", data: Buffer.from("out").toString("base64") }], next: 3, done: false },
		{ output: [{ stream: "stderr", data: Buffer.from("err").toString("base64") }], next: 6, done: true, exitCode: 7 },
	];
	const { calls, host } = recorder((method, path) => {
		if (method === "POST" && path.endsWith("/execs")) return [201, {}];
		if (method === "POST" && path.endsWith("/stdin")) return [200, {}];
		// Past the reads given, the exec is gone: its output ends with no exit code.
		if (method === "GET") return reads.length > 0 ? [200, reads.shift()] : [404, { detail: "exec not found" }];
		if (method === "DELETE") return [204, undefined];
	});
	const proc = await host.exec(ID, ["printf", "", "x"], CTX);
	assert.deepEqual(calls[0].body.command, ["/bin/sh", "-c", "exec printf '' x"]);
	assert.equal(calls[0].body.interactive, true);
	await proc.write(Buffer.from("hi"));
	await proc.end();
	const [out, err] = await Promise.all([proc.stdout, proc.stderr].map(async (stream) => Buffer.concat(await stream.toArray()).toString()));
	assert.deepEqual([out, err, await proc.wait()], ["out", "err", 7]);
	const execId = calls[0].body.execId;
	assert.deepEqual(
		calls.filter((c) => c.path.endsWith("/stdin")).map((c) => c.body),
		[{ seq: 1, data: Buffer.from("hi").toString("base64") }, { seq: 2, eof: true }],
	);
	assert.deepEqual(
		calls.filter((c) => c.method === "GET").map((c) => c.path),
		[`/v1/machines/${ID}/execs/${execId}?after=0&wait=25`, `/v1/machines/${ID}/execs/${execId}?after=3&wait=25`],
	);
	const plain = await host.exec(ID, ["cat"], CTX);
	const started = calls.findLast((c) => c.path.endsWith("/execs"));
	assert.deepEqual(started.body.command, ["cat"]);
	await plain.kill();
	assert.deepEqual(calls.at(-1), { method: "DELETE", path: `/v1/machines/${ID}/execs/${started.body.execId}`, body: undefined, auth: `Bearer ${KEY}` });
});

/** A recorder whose exec starts, then answers every read of its output 503 and refuses its delete. */
function unreadable() {
	return recorder((method, path) => {
		if (method === "POST" && path.endsWith("/execs")) return [201, {}];
		if (method === "GET") return [503, { detail: "control restarting" }];
		if (method === "DELETE") return [400, { detail: "refused" }];
	});
}

test("kill stops the output read at once, while smol cloud answers no read and refuses the delete", async () => {
	const { calls, host } = unreadable();
	const reads = () => calls.filter((c) => c.method === "GET").length;
	const proc = await host.exec(ID, ["sleep", "600"], CTX);
	while (reads() === 0) await new Promise((resolve) => setImmediate(resolve));
	await proc.kill();
	const read = reads();
	let timer;
	const late = new Promise((resolve) => (timer = setTimeout(resolve, 3_000, "still reading 3 s after kill")));
	assert.equal(await Promise.race([proc.wait(), late]), -1);
	clearTimeout(timer);
	assert.equal(reads(), read, "no read after kill");
});

test("the output read gives up in words, naming the exec and the last answer, once no read was answered for 5 minutes", async (t) => {
	const { calls, host } = unreadable();
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const proc = await host.exec(ID, ["sleep", "600"], CTX);
	let settled;
	proc.wait().then((code) => (settled = code), (error) => (settled = error));
	for (let i = 0; settled === undefined && i < 1_000; i++) {
		await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.tick(5_000);
	}
	const { execId } = calls[0].body;
	assert.ok(settled instanceof Error, `wait() answered ${settled}`);
	assert.match(settled.message, new RegExp(`no read of exec ${execId}'s output for 5 minutes.*answered 503: control restarting`));
});

test("upload puts the bytes at the guest path through the files API; extend changes the deadline label alone", async () => {
	const { calls, host } = recorder(() => [200, {}]);
	await host.upload(ID, "/tmp/agentrun/computerd", new Uint8Array([1, 2, 3]), CTX);
	assert.deepEqual([calls[0].method, calls[0].path, [...calls[0].body]], ["PUT", `/v1/machines/${ID}/files/tmp/agentrun/computerd`, [1, 2, 3]]);
	await host.extend(ID, new Date("2026-11-17T01:00:00Z"), CTX);
	assert.deepEqual([calls[1].method, calls[1].path, calls[1].body], ["PATCH", `/v1/machines/${ID}/labels`, { labels: { "agentrun.computer.deadline": "2026-11-17T01:00:00.000Z" } }]);
});

test("the conformance module reads COMPUTER_SMOLCLOUD_* alone, after its live switch; the sweep's host needs none and its scope never shows the key", async () => {
	assert.throws(() => settingsFromEnv({ SMOLCLOUD_API_KEY: KEY }), (error) => /set COMPUTER_SMOLCLOUD_API_KEY/.test(error.message) && !error.message.includes(KEY));
	const env = { [ENV.key]: KEY };
	assert.deepEqual(settingsFromEnv({ ...env, [ENV.apiUrl]: API }), { apiKey: KEY, apiUrl: API });
	await assert.rejects(createProvider({ env }), /set AGENTRUN_COMPUTER_LIVE_SMOLCLOUD=1/);
	assert.equal((await createProvider({ env: { ...env, [ENV.live]: "1" } })).capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal((await createHost({ env })).descriptor.id, "smolcloud");
	assert.equal(await conformanceImage({ env: {} }), "alpine:3.20");
	assert.match(sweepScope({ env }), /sha256:[0-9a-f]{12}/);
	assert.doesNotMatch(sweepScope({ env }), new RegExp(KEY));
});
