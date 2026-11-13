// Agent37Provider's host on a fake Agent37 (fake-agent37.mjs): the REST API as a fetch, and an instance's SSH as
// ssh2's own Server on loopback, reached through a fake WebSocket. What Agent37's host decides is tested here: the
// create's body, get, list and delete, the status and network read-back, setLabels' GET then whole PATCH, the error
// codes, check()'s shapes and cap, and an exec's stdin, stdout, stderr, exit code and kill. The adapter's lifecycle is
// tested once, against its fake host (hosted-provider.test.mjs); Agent37's own is proven live.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as registry from "../dist/providers.js";
import { API_URL, fakeAgent37, fakeRest, KEY, keyPair, PROXY } from "./fake-agent37.mjs";

const agent37 = await import("../dist/agent37.js");
const { Agent37Provider, create, workspaceOf } = agent37;
const conformanceModule = await import("../dist/conformance/agent37.js");
const { AGENT37_ENV: ENV, settingsFromEnv, sweepScope } = conformanceModule;

const CTX = { timeoutMs: 10_000 };
const COMPUTER = "agentrun.computer";
const SSH_KEY = keyPair().private;
const BARE = "sk_live_bare_key_must_never_be_used";

/** A provider on the fake, and the fake; the sshd is closed after the test. */
async function setup(t, options = {}) {
	const fake = await fakeAgent37();
	t.after(() => fake.sshd.close());
	const provider = new Agent37Provider({ ...fake.options, ...options });
	return { fake, provider, host: provider.host };
}

/** A REST-only provider: no sshd. */
function restOnly(options = {}) {
	const rest = fakeRest();
	const ssh2 = { Client: class {} };
	const provider = new Agent37Provider({ apiKey: KEY, sshKey: SSH_KEY, ssh2, fetch: rest.fetch, apiUrl: API_URL, proxyDomain: PROXY, ...options });
	return { rest, provider, host: provider.host };
}

const request = (labels = {}) => ({ name: "computer-0123456789ab", image: "agent37-base", labels: { [COMPUTER]: "1", "agentrun.computer.name": "computer-0123456789ab", "agentrun.computer.image": "agent37-base", ...labels }, network: "none" });

/** Runs argv to its end: its exit code, stdout and stderr. */
async function run(host, id, argv, input) {
	const made = await host.exec(id, argv, { stdin: input !== undefined }, CTX);
	assert.ok(made.ok);
	const proc = made.value;
	const out = [];
	const err = [];
	const reading = Promise.all([
		(async () => {
			for await (const chunk of proc.stdout) out.push(Buffer.from(chunk));
		})(),
		(async () => {
			for await (const chunk of proc.stderr) err.push(Buffer.from(chunk));
		})(),
	]);
	if (input !== undefined) {
		await proc.write(Buffer.from(input));
		await proc.end();
	}
	const code = await proc.wait();
	await reading;
	return { code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function until(check, ms = 5_000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

// --- what it declares ---

test("an Agent37 computer is kind linux with daemon child, network none read back, the sshd's and the web terminal's ports, and a 24 h janitor", () => {
	const { provider } = restOnly();
	const caps = provider.capabilities();
	assert.equal(caps.kind, "linux");
	assert.deepEqual(caps.groups, ["exec", "files", "processes"]);
	assert.equal(caps.daemon, "child");
	assert.equal(caps.lifetime, "janitor");
	assert.equal(caps.maxLifetimeMs, 24 * 3_600_000);
	assert.deepEqual(caps.network, ["none"]);
	assert.equal(caps.networkReadBack, true);
	assert.deepEqual(caps.vendorAgentPorts, [22022, 7681]);
	assert.deepEqual(caps.mount, ["archil"]);
	assert.equal(caps.isolation, "vm");
	assert.equal(restOnly({ type: "default" }).provider.capabilities().isolation, "gvisor");
});

test("the provider takes the key and the SSH key as options, a key's contents never a path, and refuses a type or region Agent37 has not", async () => {
	const ssh2 = { Client: class {} };
	await assert.rejects(create({ sshKey: SSH_KEY, ssh2 }), /options\.apiKey/);
	await assert.rejects(create({ apiKey: KEY, ssh2 }), /options\.sshKey/);
	await assert.rejects(create({ apiKey: KEY, sshKey: "/home/user/.ssh/id_ed25519", ssh2 }), (error) => {
		assert.match(error.message, /never a path/);
		assert.doesNotMatch(error.message, new RegExp(KEY));
		return true;
	});
	assert.throws(() => new Agent37Provider({ apiKey: KEY, sshKey: SSH_KEY, ssh2: {} }), /ssh2 package/);
	assert.throws(() => new Agent37Provider({ apiKey: KEY, sshKey: SSH_KEY, ssh2, apiUrl: "http://api.agent37.com" }), /https URL/);
	assert.throws(() => new Agent37Provider({ apiKey: KEY, sshKey: SSH_KEY, ssh2, type: "gpu" }), /vm or default/);
	assert.throws(() => new Agent37Provider({ apiKey: KEY, sshKey: SSH_KEY, ssh2, region: "mars" }), /us, eu or ap-south/);
	assert.throws(() => new Agent37Provider({ apiKey: KEY, sshKey: SSH_KEY, ssh2, region: "eu", type: "default" }), /takes type vm/);
	// ssh2 is the host's package when not given.
	assert.equal((await create({ apiKey: KEY, sshKey: SSH_KEY })).id, "agent37");
});

test("check() refuses more than 4 CPUs (Agent37 would give 4 without saying so), a size that is no shape, a bad template, and metadata past 4 KB", () => {
	const { provider } = restOnly();
	const spec = { image: "agent37-base", lifetimeMs: 600_000, network: "none" };
	const fields = (more) => provider.check({ ...spec, ...more }).map((one) => one.field);
	assert.deepEqual(fields({}), []);
	assert.deepEqual(fields({ cpus: 4, memoryMb: 16_384 }), []);
	assert.deepEqual(fields({ cpus: 2 }), []);
	assert.match(provider.check({ ...spec, cpus: 8 }).find((one) => one.field === "cpus").message, /at most 4 CPUs.*gives 4/);
	assert.deepEqual(fields({ cpus: 3 }), ["cpus"]);
	assert.deepEqual(fields({ cpus: 2, memoryMb: 8192 }), ["memoryMb"]);
	assert.deepEqual(fields({ image: "Not A Template" }), ["image"]);
	assert.deepEqual(fields({ image: "my-template@v3" }), []);
	assert.deepEqual(fields({ labels: { big: "x".repeat(4000) } }), ["labels"]);
	assert.deepEqual(fields({ labels: { small: "x".repeat(100) } }), []);
});

// --- REST ---

test("create posts the template, type, region, name, labels as metadata, deny-all, auto-sleep off and no public port, with the key as a Bearer token", async () => {
	const { rest, host } = restOnly();
	const made = await host.create({ ...request(), cpus: 4, memoryMb: 8192 }, CTX);
	assert.ok(made.ok);
	const [call] = rest.calls;
	assert.deepEqual([call.method, call.path, call.auth], ["POST", "/v1/instances", `Bearer ${KEY}`]);
	assert.deepEqual(call.body, {
		template: "agent37-base",
		type: "vm",
		region: "us",
		resources: { cpu: 4, memory: 8 },
		name: "computer-0123456789ab",
		metadata: request().labels,
		network: "deny-all",
		auto_sleep: false,
		public_ports: [],
	});
	await host.create({ ...request(), network: "open" }, CTX);
	assert.equal(rest.calls[1].body.network, "allow-all", "an Archil computer's root is open");
	assert.equal(rest.calls[1].body.resources, undefined, "no size asked, none sent");
});

test("get reads an instance back as a machine; an unknown id is none; list matches labels over the whole workspace; delete twice is done", async () => {
	const { rest, host } = restOnly();
	const { value } = await host.create(request({ "agentrun.conformance": "run-1" }), CTX);
	await host.create(request({ "agentrun.conformance": "run-2" }), CTX);
	const machine = (await host.get(value.id, CTX)).value;
	assert.equal(machine.id, value.id);
	assert.equal(machine.state, "running");
	assert.equal(machine.network, "none");
	assert.deepEqual(machine.size, { cpus: 2, memoryMb: 4096 });
	assert.equal(machine.image.resolved, `sha256:${"d".repeat(64)}`);
	assert.deepEqual(machine.createdAt, new Date(1_800_000_000_000));
	assert.equal(machine.drift, undefined);
	assert.equal(machine.labels["agentrun.conformance"], "run-1");
	assert.deepEqual((await host.get("zzzzzzzzzz", CTX)).value, undefined);
	assert.deepEqual((await host.get("not an id", CTX)).value, undefined, "an id that is not Agent37's is none, never a URL");
	const listed = (await host.list({ "agentrun.conformance": "run-1" }, CTX)).value;
	assert.deepEqual(listed.map((one) => one.id), [value.id]);
	assert.equal((await host.list({ [COMPUTER]: "1" }, CTX)).value.length, 2);
	assert.ok((await host.delete(value.id, CTX)).ok);
	assert.ok((await host.delete(value.id, CTX)).ok, "a repeat's 404 is done");
	assert.equal(rest.instances.has(value.id), false);
	rest.fail("GET", /^\/v1\/instances$/, new Response(JSON.stringify({ data: [], has_more: true }), { status: 200 }));
	await assert.rejects(host.list({}, CTX), /would miss machines/);
});

test("the status mapping: every Agent37 status is one of the adapter's states, and one it does not know is failed with why", async () => {
	const { rest, host } = restOnly();
	const { value } = await host.create(request(), CTX);
	const states = {
		running: "running",
		provisioning: "starting",
		starting: "starting",
		waking: "starting",
		restarting: "starting",
		updating: "starting",
		stopping: "stopped",
		stopped: "stopped",
		sleeping: "stopped",
		failed: "failed",
		deleting: "going",
		deleted: "going",
	};
	for (const [status, state] of Object.entries(states)) {
		rest.instances.get(value.id).status = status;
		assert.equal((await host.get(value.id, CTX)).value.state, state, status);
	}
	rest.instances.get(value.id).status = "melting";
	const odd = (await host.get(value.id, CTX)).value;
	assert.equal(odd.state, "failed");
	assert.match(odd.why, /melting/);
	rest.instances.get(value.id).status = "failed";
	rest.instances.get(value.id).status_reason = { code: "boot_failed", message: "the VM did not boot" };
	assert.equal((await host.get(value.id, CTX)).value.why, "the VM did not boot");
});

test("network read-back: deny-all is none, allow-all open, an allow list or any public port other; a create's options read back wrong are drift", async () => {
	const { rest, host } = restOnly();
	const { value } = await host.create(request(), CTX);
	const instance = rest.instances.get(value.id);
	const network = async () => (await host.get(value.id, CTX)).value.network;
	assert.equal(await network(), "none");
	instance.network = "allow-all";
	assert.equal(await network(), "open");
	instance.network = { allow: ["example.com"] };
	assert.match((await network()).other, /allow list/);
	instance.network = "deny-all";
	instance.public_ports = [{ port: 8080, auth: "public" }];
	assert.match((await network()).other, /public ports \(8080\)/);
	instance.public_ports = [];
	Object.assign(instance, { type: "default", region: "eu", auto_sleep: true, template: "other" });
	const { drift } = (await host.get(value.id, CTX)).value;
	assert.equal(drift.length, 4);
	for (const field of ["template", "type", "region", "auto_sleep"]) assert.ok(drift.some((one) => one.startsWith(`${field}:`)), field);
});

test("setLabels reads the instance, then PATCHes the whole metadata, since a PATCH replaces it", async () => {
	const { rest, host } = restOnly();
	const { value } = await host.create(request({ keep: "me" }), CTX);
	rest.calls.length = 0;
	assert.ok((await host.setLabels(value.id, { "agentrun.computer.deadline": "2026-11-13T08:00:00.000Z" }, CTX)).ok);
	assert.deepEqual(rest.calls.map((one) => [one.method, one.path]), [
		["GET", `/v1/instances/${value.id}`],
		["PATCH", `/v1/instances/${value.id}`],
	]);
	assert.deepEqual(rest.calls[1].body, { metadata: { ...request({ keep: "me" }).labels, "agentrun.computer.deadline": "2026-11-13T08:00:00.000Z" } });
	assert.equal(rest.instances.get(value.id).metadata.keep, "me");
});

test("the error codes: Agent37's envelope codes, then the status, flat transport codes, and a refused key never echoed", async () => {
	const { rest, host } = restOnly();
	const cases = [
		[401, { error: { code: "invalid_api_key", message: "Invalid API key" } }, "denied"],
		[403, { error: { code: "ip_not_allowed", message: "no" } }, "denied"],
		[400, { error: { code: "invalid_request", message: "bad" } }, "invalid"],
		[402, { error: { code: "insufficient_balance", message: "top up" } }, "limit"],
		[409, { error: { code: "instance_limit_reached", message: "50" } }, "limit"],
		[503, { error: { code: "no_capacity", message: "later" } }, "limit"],
		[429, { error: { code: "rate_limited", message: "slow" } }, "limit"],
		[429, { error: "rate_limited" }, "limit"],
		[404, { error: { code: "not_found", message: "gone" } }, "not_found"],
		[403, {}, "denied"],
		[502, { error: "bad_gateway" }, "vendor"],
		[500, null, "vendor"],
	];
	for (const [status, body, code] of cases) {
		rest.fail("POST", /^\/v1\/instances$/, new Response(body === null ? "oops" : JSON.stringify(body), { status }));
		const error = await host.create(request(), CTX).then(
			() => assert.fail("created"),
			(thrown) => thrown,
		);
		assert.equal(host.errorCode(error), code, `${status} ${JSON.stringify(body)}`);
		assert.match(error.message, new RegExp(`answered ${status}`));
	}
	const wrong = new Agent37Provider({ apiKey: BARE, sshKey: SSH_KEY, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL });
	const refused = await wrong.host.list({}, CTX).catch((error) => error);
	assert.equal(wrong.host.errorCode(refused), "denied");
	assert.doesNotMatch(refused.message, new RegExp(BARE));
	const timeout = Object.assign(new Error("slow"), { name: "TimeoutError" });
	assert.equal(host.errorCode(timeout), "timeout");
	assert.equal(host.errorCode(Object.assign(new Error("no"), { level: "client-authentication" })), "denied");
});

// --- SSH over the WebSocket ---

test("exec rides wss://{id}-22022.<domain>/ with the key in X-Agent37-Key, and runs argv as given: stdout, stderr and the exit code", async (t) => {
	const { fake, host } = await setup(t);
	const { value } = await host.create(request(), CTX);
	const result = await run(host, value.id, ["sh", "-c", 'echo "out $1"; echo err >&2; exit 3', "sh", "a b'c"]);
	assert.deepEqual(result, { code: 3, stdout: "out a b'c\n", stderr: "err\n" });
	assert.deepEqual(fake.ws.opened[0], { url: `wss://${value.id}-22022.${PROXY}/`, headers: { "X-Agent37-Key": KEY } });
	assert.equal((await run(host, value.id, ["true"])).code, 0);
	assert.deepEqual(await run(host, value.id, ["printf", "%s|", "$HOME", "*", ""]), { code: 0, stdout: "$HOME|*||", stderr: "" });
});

test("exec's stdin: written in order, then ended; a write after the end is refused", async (t) => {
	const { host } = await setup(t);
	const { value } = await host.create(request(), CTX);
	const big = Buffer.alloc(3 * 1024 * 1024, 7);
	assert.deepEqual(await run(host, value.id, ["wc", "-c"], big), { code: 0, stdout: `${big.length}\n`, stderr: "" });
	const made = await host.exec(value.id, ["cat"], { stdin: true }, CTX);
	const proc = made.value;
	const out = [];
	const reading = (async () => {
		for await (const chunk of proc.stdout) out.push(Buffer.from(chunk));
	})();
	await proc.write(Buffer.from("one "));
	await proc.write(Buffer.from("two"));
	await proc.end();
	await assert.rejects(proc.write(Buffer.from("three")), /ended/);
	assert.equal(await proc.wait(), 0);
	await reading;
	assert.equal(Buffer.concat(out).toString(), "one two");
});

test("kill ends the whole process group, with stdin ended or held open, and wait answers -1", async (t) => {
	const { host } = await setup(t);
	const { value } = await host.create(request(), CTX);
	for (const [stdin, script] of [
		[false, "sleep 300 & echo $!; sleep 301 & echo $!; wait"],
		[true, "sleep 302 & echo $!; cat; wait"],
	]) {
		const proc = (await host.exec(value.id, ["sh", "-c", script], { stdin }, CTX)).value;
		let text = "";
		const reading = (async () => {
			for await (const chunk of proc.stdout) text += chunk;
		})();
		(async () => {
			for await (const _ of proc.stderr);
		})();
		const want = stdin ? 1 : 2;
		assert.ok(await until(() => text.trim().split("\n").filter(Boolean).length === want), "the sleeps started");
		const pids = text.trim().split("\n").map(Number);
		assert.ok(pids.every(alive));
		await proc.kill();
		assert.equal(await proc.wait(), -1);
		await reading;
		assert.ok(await until(() => !pids.some(alive)), `every sleep is gone (stdin ${stdin})`);
	}
	// A kill after the process ended is nothing.
	const done = (await host.exec(value.id, ["true"], { stdin: false }, CTX)).value;
	(async () => {
		for await (const _ of done.stdout);
	})();
	(async () => {
		for await (const _ of done.stderr);
	})();
	assert.equal(await done.wait(), 0);
	await done.kill();
});

test("the pid file each command writes is gone once it ends, killed or not", async (t) => {
	const { fake, host } = await setup(t);
	const { value } = await host.create(request(), CTX);
	await run(host, value.id, ["true"]);
	const file = /\/tmp\/\.agentrun-exec-[0-9a-f]{16}/.exec(fake.sshd.commands[0])[0];
	assert.equal(existsSync(file), false);
});

test("an SSH key pasted onto one line (a password field drops line breaks) is wrapped again and still taken", async (t) => {
	const fake = await fakeAgent37();
	t.after(() => fake.sshd.close());
	for (const sshKey of [fake.sshKey.replace(/\n/g, ""), fake.sshKey.replace(/\n/g, "\r\n"), `  ${fake.sshKey.replace(/\n/g, " ")}  `]) {
		const provider = new Agent37Provider({ ...fake.options, sshKey });
		const { value } = await provider.host.create(request(), CTX);
		assert.equal((await run(provider.host, value.id, ["true"])).code, 0);
	}
	for (const bad of ["-----BEGIN OPENSSH PRIVATE KEY-----not base64!-----END OPENSSH PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY----------END OPENSSH PRIVATE KEY-----", "ssh-ed25519 AAAA..."]) {
		assert.throws(() => new Agent37Provider({ ...fake.options, sshKey: bad }), /contents of an SSH private key/);
	}
});

test("a key the edge refuses closes the tunnel before it opens: the exec fails in words, with no key in them", async (t) => {
	const { host } = await setup(t, { apiKey: BARE, fetch: fakeRest({ key: BARE }).fetch });
	const { value } = await host.create(request(), CTX);
	await assert.rejects(host.exec(value.id, ["true"], { stdin: false }, CTX), (error) => {
		assert.match(error.message, /tunnel .* was refused \(closed with 1008/);
		assert.doesNotMatch(error.message, new RegExp(BARE));
		return true;
	});
});

test("a tunnel that fails to open is opened again, within the call's bound; after the last try the failure is the call's", async (t) => {
	const { fake, host } = await setup(t);
	const { value } = await host.create(request(), CTX);
	fake.ws.failNext(2);
	assert.equal((await run(host, value.id, ["true"])).code, 0);
	assert.equal(fake.ws.opened.length, 3, "two failed, the third opened");
	fake.ws.failNext(4);
	await assert.rejects(host.exec(value.id, ["true"], { stdin: false }, CTX), /failed to open/);
	assert.equal(fake.ws.opened.length, 7, "four tries in all");
	fake.ws.failNext(10);
	const error = await host.exec(value.id, ["true"], { stdin: false }, { timeoutMs: 300 }).catch((thrown) => thrown);
	assert.equal(host.errorCode(error), "timeout", "the bound ends the retries");
	fake.ws.failNext(0);
});

test("an SSH key the instance's sshd does not take is denied", async (t) => {
	const { host } = await setup(t, { sshKey: keyPair().private });
	const { value } = await host.create(request(), CTX);
	const error = await host.exec(value.id, ["true"], { stdin: false }, CTX).catch((thrown) => thrown);
	assert.equal(host.errorCode(error), "denied");
});

// --- the registry and the conformance module ---

test("the registry builds Agent37 from its options alone, and its source reads no environment and writes nowhere", async () => {
	const rest = fakeRest();
	const provider = await registry.providerFor("agent37", { apiKey: KEY, sshKey: SSH_KEY, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL });
	assert.equal(provider.id, "agent37");
	assert.deepEqual(rest.calls, []);
	const source = readFileSync(new URL("../dist/agent37.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /process\.env/);
	assert.doesNotMatch(source, /COMPUTER_AGENT37_/);
	assert.doesNotMatch(source, /\bconsole\.|process\.(stdout|stderr)/);
	assert.doesNotMatch(source, /^\s*import\s[^(]*from\s+["']ssh2["']/m, "no static import of ssh2");
});

test("the conformance module reads COMPUTER_AGENT37_* alone, needs its live switch first, and its sweep's host and scope need none", async () => {
	const { live, ...names } = ENV;
	assert.equal(live, "AGENTRUN_COMPUTER_LIVE_AGENT37");
	for (const name of Object.values(names)) assert.match(name, /^COMPUTER_AGENT37_[A-Z0-9_]+$/);
	const env = { [ENV.key]: KEY, [ENV.sshKey]: SSH_KEY };
	assert.deepEqual(settingsFromEnv(env), { apiKey: KEY, sshKey: SSH_KEY });
	assert.deepEqual(
		settingsFromEnv({ ...env, [ENV.type]: "default", [ENV.region]: "us", [ENV.apiUrl]: API_URL, [ENV.daemon]: "/tmp/computerd", [ENV.maxLifetimeMs]: "3600000", [ENV.user]: "2510:2510", AGENT37_API_KEY: BARE }),
		{ apiKey: KEY, sshKey: SSH_KEY, type: "default", region: "us", apiUrl: API_URL, daemonPath: "/tmp/computerd", maxLifetimeMs: 3_600_000, daemonUser: "2510:2510" },
	);
	assert.throws(() => settingsFromEnv({ AGENT37_API_KEY: BARE, AGENT37_SSH_KEY: SSH_KEY }), (error) => /set COMPUTER_AGENT37_API_KEY/.test(error.message) && !error.message.includes(BARE));
	assert.throws(() => settingsFromEnv({ [ENV.key]: KEY }), /set COMPUTER_AGENT37_SSH_KEY/);
	assert.throws(() => settingsFromEnv({ ...env, [ENV.maxLifetimeMs]: "1h" }), /whole number of milliseconds/);
	const rest = fakeRest();
	const doubles = { ssh2: { Client: class {} }, fetch: rest.fetch };
	await assert.rejects(conformanceModule.createProvider({ env, ...doubles }), /set AGENTRUN_COMPUTER_LIVE_AGENT37=1/);
	await assert.rejects(conformanceModule.createDriftedProvider({ env, ...doubles }), /set AGENTRUN_COMPUTER_LIVE_AGENT37=1/);
	const provider = await conformanceModule.createProvider({ env: { ...env, [ENV.live]: "1" }, ...doubles });
	assert.equal(provider.capabilities().maxLifetimeMs, 30 * 60_000, "a conformance computer lives at most 30 minutes");
	assert.equal(conformanceModule.conformanceImage({ env: {} }), "agent37-base");
	assert.equal(conformanceModule.conformanceImage({ env: { [ENV.template]: "box@v1" } }), "box@v1");
	const host = await conformanceModule.createHost({ env, ...doubles });
	assert.equal(host.id, "agent37");
	assert.equal(sweepScope({ env }), workspaceOf(KEY));
	assert.doesNotMatch(sweepScope({ env }), new RegExp(KEY));
	assert.notEqual(sweepScope({ env: { ...env, [ENV.key]: BARE } }), sweepScope({ env }), "another key is another workspace");
	assert.deepEqual(rest.calls, []);
	assert.equal(await conformanceModule.mountFor("bind", { env }), undefined);
});

test("the conformance module's drifted twin uploads a daemon of another version", async () => {
	const built = [];
	const drifted = await conformanceModule.createDriftedProvider({
		env: { [ENV.key]: KEY, [ENV.sshKey]: SSH_KEY, [ENV.live]: "1" },
		ssh2: { Client: class {} },
		fetch: fakeRest().fetch,
		buildDaemon: async (version) => {
			built.push(version);
			return "/tmp/computerd-drift";
		},
	});
	assert.equal(built.length, 1);
	assert.match(built[0], /-drift$/);
	assert.equal(drifted.id, "agent37");
});
