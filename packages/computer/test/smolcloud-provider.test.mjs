// SmolcloudProvider's host against a recorder of smol cloud's REST API (a fetch that answers in the OpenAPI's shapes):
// what the host sends for create, get, list, exec, upload and extend, and how it reads the answers back. The adapter's
// lifecycle is tested once, against its fake host (hosted-provider.test.mjs); smol cloud's own is proven live.
import assert from "node:assert/strict";
import test from "node:test";

const { SmolcloudProvider } = await import("../dist/smolcloud.js");
const { SMOLCLOUD_ENV: ENV, settingsFromEnv, createProvider, createDriftedProvider, createHost, conformanceImage, sweepScope } = await import("../dist/conformance/smolcloud.js");

const KEY = "smolcloud_fake_key_0123456789";
const API = "https://api.example.test";
const CTX = { timeoutMs: 5_000 };
const ID = "mach-0123";

/** A fetch that records each call and answers what route(method, path, body, signal) gives, or settles to: [status, json]. */
function recorder(route) {
	const calls = [];
	const fetch = async (url, init) => {
		const { pathname, search } = new URL(url);
		const body = init.body === undefined ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : Buffer.from(init.body);
		calls.push({ method: init.method, path: `${pathname}${search}`, body, auth: init.headers.Authorization });
		const [status, json] = (await route(init.method, `${pathname}${search}`, body, init.signal)) ?? [404, { detail: "no such route" }];
		return new Response(json === undefined ? null : JSON.stringify(json), { status });
	};
	const provider = new SmolcloudProvider({ apiKey: KEY, apiUrl: API, fetch });
	return { calls, host: provider.host, provider };
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

test("a start whose answer never came is sent again with the same execId, which smol cloud answers with the first try's session: one exec", async () => {
	const sessions = new Map();
	const { calls, host } = recorder((method, path, body, signal) => {
		if (method === "POST" && path.endsWith("/execs")) {
			const first = !sessions.has(body.execId);
			sessions.set(body.execId, body.command);
			// smol cloud started the command, and its answer to the first try is lost.
			if (first) return new Promise((_, fail) => signal.addEventListener("abort", () => fail(signal.reason), { once: true }));
			return [200, { execId: body.execId, done: false }];
		}
		if (method === "GET") return [200, { output: [], next: 0, done: true, exitCode: 0 }];
	});
	const proc = await host.exec(ID, ["true"], { timeoutMs: 50 });
	assert.equal(await proc.wait(), 0);
	const starts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/execs")).map((c) => c.body);
	assert.equal(starts.length, 2, "the start was sent again");
	assert.deepEqual(starts[1], starts[0], "with the same execId and command");
	assert.equal(sessions.size, 1);
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

test("check refuses before any call to smol cloud the labels it would refuse: a name, a value, the image or network list past 255 characters, past 32 labels", async () => {
	const { calls, provider } = recorder(() => [201, { id: ID, state: "started" }]);
	const spec = { image: "alpine:3.20", lifetimeMs: 600_000, network: "none" };
	const long = "x".repeat(256);
	const hosts = Array.from({ length: 12 }, (_, i) => `service-${i}.example.com`);
	const many = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`k${i}`, "v"]));
	const cases = [
		["a name with a capital", { labels: { Team: "test" } }, "labels", /label names of 1 to 63 .*"Team"/],
		["a name ending in a dot", { labels: { "team.": "test" } }, "labels", /"team\."/],
		["a value of 256 characters", { labels: { team: long } }, "labels", /values of at most 255 characters: "team" has 256/],
		["an image of 256 characters", { image: long }, "image", /image in a label of at most 255 characters, and this one has 256/],
		["a network list of 271 characters", { network: { allow: hosts } }, "network", /network list in a label of at most 255 characters, and this one comes to 271/],
		["28 labels and the adapter's own 5", { labels: many }, "labels", /at most 32 labels, the adapter's own among them/],
	];
	for (const [name, more, field, words] of cases) {
		const refusals = provider.check({ ...spec, ...more });
		assert.deepEqual(refusals.map((one) => one.field), [field], name);
		assert.match(refusals[0].message, words, name);
	}
	assert.deepEqual(provider.check({ ...spec, network: { allow: hosts.slice(0, 10) }, labels: { team: "test", "agentrun.run": "run-1", "a/b_c.d-e": "x".repeat(255) } }), []);
	const made = await provider.create({ ...spec, labels: { Team: "test" } }, { requestId: "request-1" });
	assert.deepEqual([made.ok, made.error?.code, calls.length], [false, "refused", 0]);
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
	assert.match(await conformanceImage({ env: {} }), /^ghcr\.io\/parcha-ai\/agentrun-box:[0-9a-f]{12}$/);
	assert.match(sweepScope({ env }), /sha256:[0-9a-f]{12}/);
	assert.doesNotMatch(sweepScope({ env }), new RegExp(KEY));
});

test("the API URL is https alone, loopback included, so the key never crosses in the clear: the provider refuses another before any call", async () => {
	const key = "fake-test-key";
	const heard = [];
	const fetch = async (url) => (heard.push(url), new Response("[]", { status: 200 }));
	for (const apiUrl of ["http://api.smolmachines.com", "http://10.0.0.5:8080", "http://127.0.0.1:8080", "http://[::1]:8080", "http://localhost:8080", "ws://api.smolmachines.com"]) {
		assert.throws(() => new SmolcloudProvider({ apiKey: key, apiUrl, fetch }), (error) => /^the smol cloud API URL must be https, so the key never crosses in the clear/.test(error.message) && !error.message.includes(key), apiUrl);
		await assert.rejects(createProvider({ env: { [ENV.key]: key, [ENV.live]: "1", [ENV.apiUrl]: apiUrl } }), (error) => /^the smol cloud API URL must be https/.test(error.message) && !error.message.includes(key), apiUrl);
	}
	assert.throws(() => new SmolcloudProvider({ apiKey: key, apiUrl: "api.smolmachines.com", fetch }), (error) => /the smol cloud API URL is not a URL/.test(error.message) && !error.message.includes(key));
	assert.deepEqual(heard, [], "no call went out");
	const { host } = new SmolcloudProvider({ apiKey: key, apiUrl: "https://api.smolmachines.com/", fetch });
	await host.list({}, CTX);
	assert.deepEqual(heard, ["https://api.smolmachines.com/v1/machines"]);
});

/** A fetch that records each call and answers what route(method, path) gives, as recorder's does, for a provider made elsewhere. */
function fetchOf(route) {
	const calls = [];
	const fetch = async (url, init) => {
		const { pathname, search } = new URL(url);
		calls.push({ method: init.method, path: `${pathname}${search}` });
		const [status, json] = (await route(init.method, `${pathname}${search}`)) ?? [404, { detail: "no such route" }];
		return new Response(json === undefined ? null : JSON.stringify(json), { status });
	};
	return { calls, fetch };
}

test("the conformance module hands the caller's onNote to the provider: a release whose run folder was not let go cleanly is said through it", async () => {
	// A running Archil computer: release lets go of its folder first, through an exec smol cloud refuses here.
	const labels = { "agentrun.computer": "1", "agentrun.computer.name": "computer-0123456789ab", "agentrun.run": "r1", "agentrun.mount": JSON.stringify({ kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", agent: "a1" }) };
	let deleted = false;
	const { fetch } = fetchOf((method, path) => {
		if (method === "POST" && path === `/v1/machines/${ID}/execs`) return [400, { detail: "no exec here" }];
		if (path !== `/v1/machines/${ID}`) return undefined;
		if (method === "DELETE") {
			deleted = true;
			return [204, undefined];
		}
		if (method === "GET") return deleted ? [404, { detail: "machine not found" }] : [200, { id: ID, state: "started", labels, createdAt: "2026-11-17T00:00:00Z", error: null }];
		return undefined;
	});
	const notes = [];
	const provider = await createProvider({ env: { [ENV.key]: KEY, [ENV.apiUrl]: API, [ENV.live]: "1" }, fetch, timeouts: { pollMs: 1 }, onNote: (note) => notes.push(note) });
	const released = await provider.release({ id: ID, name: "computer-0123456789ab" }, "delete");
	assert.equal(released.ok, true, JSON.stringify(released));
	assert.equal(deleted, true);
	assert.equal(notes.length, 1, JSON.stringify(notes));
	assert.equal(notes[0].computer, "computer-0123456789ab");
	assert.match(notes[0].note, /was deleted, and the run's folder was not let go cleanly/);
});

test("the conformance module's daemon: an option's path, and the drifted twin uploads the one it built", async () => {
	const { fetch } = fetchOf((method, path) => (method === "GET" && path.startsWith("/v1/machines?") ? [200, []] : undefined));
	const env = { [ENV.key]: KEY, [ENV.apiUrl]: API, [ENV.live]: "1" };
	const spec = { image: "alpine:3.20", lifetimeMs: 600_000, network: "none" };
	const options = { env, fetch, daemonPath: "/nonexistent/untangle-option/computerd", buildDaemon: async () => "/nonexistent/untangle-drift/computerd" };
	const made = await (await createProvider(options)).create(spec, { requestId: "req-untangle-smolcloud-1" });
	assert.equal(made.ok, false);
	assert.match(made.error.message, /no daemon binary at \/nonexistent\/untangle-option\/computerd/);
	const drifted = await (await createDriftedProvider(options)).create(spec, { requestId: "req-untangle-smolcloud-2" });
	assert.equal(drifted.ok, false);
	assert.match(drifted.error.message, /no daemon binary at \/nonexistent\/untangle-drift\/computerd/);
});
