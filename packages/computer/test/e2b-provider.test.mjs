// E2BProvider without a vendor fake: what E2B's own host decides (its capabilities, its check, the key and the domain
// on every SDK call, the environment it reads and refuses, the conformance module's names), each read from options or
// from what the SDK slice is handed. The adapter's lifecycle is tested once, against its one fake host
// (hosted-provider.test.mjs); E2B's own lifecycle is proven live (test/e2b). The Sandbox class here only records what
// it is given and throws: no sandbox exists, no SDK is loaded unless a test says so, and nothing reaches the network.
// The one exception is exec: the real SDK's envd client talks to a stand-in envd on 127.0.0.1 (fake-envd.mjs) that runs
// each command on this machine, so the exec pre-check shows E2B's exec passes every byte through.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLifetime, kindRefusals } from "../dist/index.js";
import * as registry from "../dist/providers.js";
import { fakeObjects } from "./fake-archil.mjs";
import { fakeEnvd } from "./fake-envd.mjs";

const e2b = await import("../dist/e2b.js");
const { E2BProvider, create } = e2b;
const { providerFor } = registry;
/** The conformance module's names: the only place E2B settings are read from an environment. */
const { E2B_ENV: ENV, settingsFromEnv, createHost } = await import("../dist/conformance/e2b.js");
const { checkExecStream, formatExecStream } = await import("../dist/conformance/exec-stream.js");

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const KEY = "e2b_fake_computer_key_0123456789";
const COMPUTER = "agentrun.computer";
const SPEC = { image: "desktop", lifetimeMs: 600_000, network: "none" };
const HOUR = 3_600_000;
const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys", "apps"];
const LINUX_GROUPS = ["exec", "files", "processes"];
const BARE = "e2b_bare_key_must_never_be_used";
const dir = mkdtempSync(join(tmpdir(), "computer-e2b-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, Buffer.from("a stand-in for computerd, linux/amd64\n"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Short bounds, so the waits in these tests take milliseconds. */
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500 };

class AuthenticationError extends Error {
	name = "AuthenticationError";
}

/**
 * The SDK's Sandbox slice as a recorder: every static records its name and arguments, then throws the SDK's
 * AuthenticationError, as the SDK does for a key E2B refuses. list hands back a paginator whose page throws the same.
 * Nothing is made or answered: it shows what the provider gives the SDK, never how E2B behaves.
 */
function recorder() {
	const calls = [];
	const refuse = (name) =>
		async (...args) => {
			calls.push([name, ...args]);
			throw new AuthenticationError("401: Invalid API key");
		};
	const Sandbox = {
		create: refuse("Sandbox.create"),
		connect: refuse("Sandbox.connect"),
		getInfo: refuse("Sandbox.getInfo"),
		setTimeout: refuse("Sandbox.setTimeout"),
		kill: refuse("Sandbox.kill"),
		list(opts) {
			calls.push(["Sandbox.list", opts]);
			return { hasNext: true, nextItems: refuse("paginator.nextItems") };
		},
	};
	return { calls, Sandbox };
}

function setup(options = {}) {
	const rec = recorder();
	const provider = new E2BProvider({ apiKey: KEY, Sandbox: rec.Sandbox, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...options });
	return { rec, provider };
}

async function withProcessEnv(values, fn) {
	const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("an E2B desktop is kind desktop with daemon child, the desktop groups, network none probed from inside, envd's port, and Hobby's 1 h cap", () => {
	const { provider } = setup();
	const caps = provider.capabilities();
	assert.deepEqual(
		{ kind: caps.kind, os: caps.os, daemon: caps.daemon, lifetime: caps.lifetime, isolation: caps.isolation, network: caps.network, networkReadBack: caps.networkReadBack, release: caps.release, vendorAgentPorts: caps.vendorAgentPorts },
		{ kind: "desktop", os: "linux", daemon: "child", lifetime: "vendor", isolation: "microvm", network: ["none"], networkReadBack: false, release: ["delete"], vendorAgentPorts: [49983] },
	);
	assert.deepEqual(caps.groups, DESKTOP_GROUPS);
	assert.equal(caps.maxLifetimeMs, HOUR, "E2B Hobby caps a sandbox at 1 h");
	assert.deepEqual(kindRefusals(caps), []);
	assert.equal(provider.id, "e2b");
	assert.equal(provider.version, VERSION);
	assert.equal(provider.stream, undefined, "no stream(): a screen is streamed through agentrun, never a vendor URL");
	assert.equal(typeof provider.extend, "function");
});

test("an E2B computer never takes public traffic: the provider takes no publicStream, has no stream(), and the conformance module reads no such setting", () => {
	// A screen is streamed through agentrun alone, never through a vendor's URL: publicStream let public traffic in,
	// which opened every port in the computer to anyone with its address. The option is gone, not refused for now.
	for (const publicStream of [true, false]) {
		assert.throws(() => setup({ publicStream }), (error) => /publicStream is no longer an option/.test(error.message) && !error.message.includes(KEY), `publicStream: ${publicStream}`);
	}
	for (const kind of ["desktop", "linux"]) {
		const { provider } = setup({ kind });
		assert.ok(!("stream" in provider), `${kind}: no stream()`);
	}
	assert.equal(ENV.publicStream, undefined, "no setting names a public stream");
	assert.ok(!Object.values(ENV).includes("COMPUTER_E2B_PUBLIC_STREAM"));
	// The conformance module reads only its ENV's names (providers.test.mjs), so the old setting is never read.
	assert.deepEqual(settingsFromEnv({ [ENV.key]: KEY, COMPUTER_E2B_PUBLIC_STREAM: "1" }), { apiKey: KEY }, "the old setting gives no option");
});

test("maxLifetimeMs is Hobby's 1 h by default, Pro's 24 h at most, and check() refuses past it by the shared rule, with no call", () => {
	const { provider, rec } = setup();
	assert.deepEqual(provider.check({ ...SPEC, lifetimeMs: HOUR }), []);
	const refused = provider.check({ ...SPEC, lifetimeMs: HOUR + 1 });
	assert.deepEqual(refused, checkLifetime(HOUR + 1, provider.capabilities()));
	assert.match(refused[0].message, /at most 1 h/);
	const pro = setup({ maxLifetimeMs: 24 * HOUR }).provider;
	assert.deepEqual(pro.check({ ...SPEC, lifetimeMs: 2 * HOUR }), []);
	assert.throws(() => setup({ maxLifetimeMs: 24 * HOUR + 1 }), /24 h/);
	assert.throws(() => setup({ maxLifetimeMs: 0 }), /maxLifetimeMs/);
	assert.deepEqual(rec.calls, []);
});

test("create refuses a lifetime past the cap in words before any E2B call", async () => {
	const { provider, rec } = setup();
	const made = await provider.create({ ...SPEC, lifetimeMs: 2 * HOUR }, { requestId: "r-cap" });
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, /lifetimeMs is at most 1 h/);
	assert.deepEqual(rec.calls, []);
});

test("check() refuses an image that is not an E2B template's name or id, with no call", () => {
	const { provider, rec } = setup();
	for (const image of ["desktop", "base", "my-team/desktop:v2", "tpl_0123"]) assert.deepEqual(provider.check({ ...SPEC, image }), [], image);
	for (const image of ["-rf", "a b", "x;y", "../up"]) assert.deepEqual(provider.check({ ...SPEC, image }).map((r) => r.field), ["image"], image);
	assert.deepEqual(rec.calls, []);
});

test("the daemon user is held to root's numbers, not its text: 00:00 is root as much as 0:0, from options or the conformance module's COMPUTER_E2B_USER", async () => {
	for (const daemonUser of ["00:00", "000:1000", "1000:00", "0:1000"]) assert.throws(() => setup({ daemonUser }), /root or in root's group/, daemonUser);
	assert.doesNotThrow(() => setup({ daemonUser: "01000:01000" }), "leading zeros on a user that is not root are its number");
	const rec = recorder();
	await assert.rejects(create({ apiKey: KEY, daemonUser: "00:00", daemonPath: DAEMON_PATH, Sandbox: rec.Sandbox }), /root or in root's group/);
	const conformance = await e2b.conformance();
	const env = { [ENV.live]: "1", [ENV.key]: KEY, [ENV.user]: "00:00", [ENV.daemon]: DAEMON_PATH };
	await assert.rejects(conformance.createProvider({ env, Sandbox: rec.Sandbox }), /root or in root's group/);
	assert.deepEqual(rec.calls, []);
});

// --- the key ---

test("create() takes the key as options.apiKey alone and reads no environment: E2B_API_KEY or COMPUTER_E2B_API_KEY in process.env is never a fallback", async () => {
	const rec = recorder();
	await withProcessEnv({ E2B_API_KEY: BARE, COMPUTER_E2B_API_KEY: BARE }, async () => {
		for (const options of [{}, { apiKey: "" }]) {
			await assert.rejects(create({ ...options, Sandbox: rec.Sandbox, daemonPath: DAEMON_PATH }), (error) => {
				assert.match(error.message, /options\.apiKey/);
				assert.doesNotMatch(error.message, /COMPUTER_E2B_API_KEY|E2B_API_KEY/, "the library names its option, never an environment variable");
				assert.doesNotMatch(error.message, new RegExp(BARE));
				return true;
			});
		}
	});
	assert.deepEqual(rec.calls, []);
});

test("kind linux is the plain template: no display, groups exec, files and processes", () => {
	const { provider } = setup({ kind: "linux" });
	const caps = provider.capabilities();
	assert.equal(caps.kind, "linux");
	assert.deepEqual(caps.groups, LINUX_GROUPS);
	assert.deepEqual(kindRefusals(caps), []);
	assert.throws(() => setup({ kind: "android" }), /desktop or linux/);
});

test("check() takes a template as the image, network none, and labels; it refuses open, an allowlist, sizes, a user and a workdir in words", () => {
	const { provider } = setup();
	assert.deepEqual(provider.check({ ...SPEC, labels: { run: "r1" } }), []);
	const fields = (spec) => provider.check(spec).map((r) => r.field);
	assert.deepEqual(fields({ ...SPEC, image: "" }), ["image"]);
	assert.deepEqual(fields({ ...SPEC, network: "open" }), ["network"]);
	assert.deepEqual(fields({ ...SPEC, network: { allow: ["example.com"] } }), ["network"]);
	assert.match(provider.check({ ...SPEC, network: { allow: ["example.com"] } })[0].message, /allowlists wait for a proxy/);
	assert.deepEqual(fields({ ...SPEC, cpus: 2 }), ["cpus"]);
	assert.deepEqual(fields({ ...SPEC, memoryMb: 1024 }), ["memoryMb"]);
	assert.deepEqual(fields({ ...SPEC, pids: 10 }), ["pids"]);
	assert.deepEqual(fields({ ...SPEC, user: "0" }), ["user"]);
	assert.deepEqual(fields({ ...SPEC, workdir: "/tmp" }), ["workdir"]);
	assert.deepEqual(fields({ ...SPEC, labels: { [COMPUTER]: "2" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, labels: { [`${COMPUTER}.x`]: "2" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, labels: { a: 1 } }), ["labels"]);
});

test("a timeout that is not a whole number of ms, or one past Node's longest timer, is refused before any sandbox is made", () => {
	const MAX_TIMER_MS = 2 ** 31 - 1;
	for (const [key, value] of [
		["probeMs", 30_000.5],
		["requestMs", 0.5],
		["helloMs", MAX_TIMER_MS],
		["goneMs", 2 ** 31],
		["listMs", Number.MAX_SAFE_INTEGER],
	]) {
		assert.throws(() => setup({ timeouts: { ...TIMEOUTS, [key]: value } }), new RegExp(`timeouts\\.${key} must be a whole number of ms above 0 and at most`), `${key}: ${value}`);
	}
	// The longest a call's own bound may be: Node's timer limit less the 5 s every SDK call's race adds to it.
	assert.doesNotThrow(() => setup({ timeouts: { ...TIMEOUTS, createMs: MAX_TIMER_MS - 5_000 } }));
});

// --- the key ---

test("the conformance module reads the key from COMPUTER_E2B_API_KEY alone: a bare E2B_API_KEY is refused in words, and nothing is called", async () => {
	const rec = recorder();
	const conformance = await e2b.conformance();
	await withProcessEnv({ E2B_API_KEY: BARE }, async () => {
		for (const env of [{ E2B_API_KEY: BARE }, {}, { [ENV.key]: "" }]) {
			await assert.rejects(conformance.createProvider({ env: { ...env, [ENV.live]: "1" }, Sandbox: rec.Sandbox, daemonPath: DAEMON_PATH }), (error) => {
				assert.match(error.message, /set COMPUTER_E2B_API_KEY to an E2B API key/);
				assert.match(error.message, /never from E2B_API_KEY/);
				assert.doesNotMatch(error.message, new RegExp(BARE));
				return true;
			});
		}
	});
	assert.deepEqual(rec.calls, []);
});

test("the conformance module reads every COMPUTER_E2B_ name the live script and the sweeps set, and passes each as its option", () => {
	assert.deepEqual(settingsFromEnv({ [ENV.key]: KEY }), { apiKey: KEY });
	const env = {
		[ENV.key]: KEY,
		[ENV.domain]: "e2b.example.com",
		[ENV.daemon]: DAEMON_PATH,
		[ENV.kind]: "linux",
		[ENV.maxLifetimeMs]: "86400000",
		[ENV.user]: "2000:2000",
		E2B_API_KEY: BARE,
	};
	assert.deepEqual(settingsFromEnv(env), { apiKey: KEY, domain: "e2b.example.com", daemonPath: DAEMON_PATH, kind: "linux", maxLifetimeMs: 86_400_000, daemonUser: "2000:2000" });
	assert.throws(() => settingsFromEnv({ [ENV.key]: KEY, [ENV.maxLifetimeMs]: "1h" }), /COMPUTER_E2B_MAX_LIFETIME_MS is a whole number of milliseconds/);
	assert.throws(() => settingsFromEnv({ [ENV.key]: KEY, E2B_SANDBOX_URL: "https://prod.example.invalid" }), /E2B_SANDBOX_URL is set/);
});

test("every SDK call is given the key passed in, the domain, the API URL and debug false explicitly, so an ambient E2B_* cannot win", async () => {
	const rec = recorder();
	await withProcessEnv({ E2B_API_KEY: BARE, COMPUTER_E2B_API_KEY: BARE, E2B_DOMAIN: "prod.example.invalid", COMPUTER_E2B_DOMAIN: "prod.example.invalid", E2B_API_URL: "https://prod.example.invalid", E2B_DEBUG: "true" }, async () => {
		const provider = await create({ apiKey: KEY, daemonPath: DAEMON_PATH, Sandbox: rec.Sandbox, timeouts: TIMEOUTS });
		const ref = { id: "i0000000000000000001", name: "computer-0123456789ab" };
		assert.equal((await provider.create(SPEC, { requestId: "r-key" })).error?.code, "denied", "the listing by name the create starts with");
		assert.equal((await provider.list({})).error?.code, "denied");
		assert.equal((await provider.testConnection()).error?.code, "unauthorized");
		assert.equal((await provider.release(ref, "delete")).error?.code, "denied");
		assert.equal((await provider.connect(ref)).error?.code, "denied");
		assert.equal((await provider.extend(ref, 60_000)).error?.code, "denied");
	});
	assert.deepEqual([...new Set(rec.calls.map(([name]) => name))].sort(), ["Sandbox.getInfo", "Sandbox.list", "paginator.nextItems"]);
	for (const call of rec.calls.filter(([name]) => name.startsWith("Sandbox."))) {
		const opts = call.findLast((arg) => typeof arg === "object" && arg !== null && "apiKey" in arg);
		assert.ok(opts, `${call[0]} was given its connection options`);
		assert.equal(opts.apiKey, KEY, `${call[0]}: the key passed in`);
		assert.equal(opts.domain, "e2b.app");
		assert.equal(opts.apiUrl, "https://api.e2b.app");
		assert.equal(opts.debug, false, `${call[0]}: debug false, else the SDK skips kill and fakes create (index.mjs:5402, 6022)`);
	}
	assert.doesNotMatch(JSON.stringify(rec.calls), new RegExp(BARE));
});

test("options.domain names the domain the key goes to, as COMPUTER_E2B_DOMAIN does through the conformance module; anything but a host name is refused", async () => {
	const rec = recorder();
	const provider = await create({ apiKey: KEY, domain: "e2b.example.com", daemonPath: DAEMON_PATH, Sandbox: rec.Sandbox, timeouts: TIMEOUTS });
	await provider.list({});
	const opts = rec.calls.find(([name]) => name === "Sandbox.list")[1];
	assert.equal(opts.domain, "e2b.example.com");
	assert.equal(opts.apiUrl, "https://api.e2b.example.com");
	const conformance = await e2b.conformance();
	for (const domain of ["https://e2b.app", "e2b.app/x", "localhost:3000", "E2B.app"]) {
		await assert.rejects(create({ apiKey: KEY, domain, Sandbox: rec.Sandbox }), /E2B domain must be a host name/);
		await assert.rejects(conformance.createProvider({ env: { [ENV.live]: "1", [ENV.key]: KEY, [ENV.domain]: domain }, Sandbox: rec.Sandbox }), /E2B domain must be a host name/);
	}
});

test("create() asks E2B for the lifetime as its timeout in whole seconds, the labels, no internet, no public traffic, and kill at the timeout", async () => {
	const calls = [];
	const Sandbox = {
		...recorder().Sandbox,
		list: () => ({ hasNext: true, nextItems: async () => ((Sandbox.listed = true), []), get hasNext() { return !Sandbox.listed; } }),
		create: async (template, opts) => {
			calls.push([template, opts]);
			throw Object.assign(new Error("400: template not found"), { name: "InvalidArgumentError" });
		},
	};
	const provider = new E2BProvider({ apiKey: KEY, Sandbox, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const made = await provider.create({ ...SPEC, lifetimeMs: 600_500, labels: { team: "a" } }, { requestId: "r-options" });
	assert.equal(made.error?.code, "invalid", "a create E2B refused made nothing");
	assert.equal(calls.length, 1);
	const [template, opts] = calls[0];
	assert.equal(template, "desktop");
	assert.equal(opts.timeoutMs, 601_000, "E2B takes whole seconds: up, never under the lifetime");
	assert.equal(opts.allowInternetAccess, false);
	assert.deepEqual(opts.network, { allowPublicTraffic: false });
	assert.deepEqual(opts.lifecycle, { onTimeout: "kill" });
	assert.deepEqual(opts.envs, {});
	assert.equal(opts.metadata.team, "a");
	assert.equal(opts.metadata[COMPUTER], "1");
	assert.match(opts.metadata[`${COMPUTER}.name`], /^computer-[0-9a-f]{12}$/);
	assert.equal(opts.metadata[`${COMPUTER}.timeout-ms`], "601000");
	assert.equal(opts.signal, undefined, "never cancelled: an aborted create could leave a sandbox whose id never came back");
});

test("the provider refuses to start while E2B_SANDBOX_URL is set in process.env: the SDK would send every sandbox call there", async () => {
	const rec = recorder();
	await withProcessEnv({ E2B_SANDBOX_URL: "https://prod.example.invalid" }, async () => {
		await assert.rejects(create({ apiKey: KEY, daemonPath: DAEMON_PATH, Sandbox: rec.Sandbox }), /E2B_SANDBOX_URL is set/);
		assert.throws(() => new E2BProvider({ apiKey: KEY, Sandbox: rec.Sandbox, daemonPath: DAEMON_PATH }), /E2B_SANDBOX_URL is set/);
	});
	assert.deepEqual(rec.calls, []);
});

test("the real SDK, given the provider's connection options, takes none of an ambient E2B_API_KEY, E2B_DOMAIN, E2B_API_URL or E2B_DEBUG", async (t) => {
	const sdk = await import("e2b").catch(() => undefined);
	if (sdk === undefined) return t.skip("the e2b package is not installed here; it is the host's, as Modal's SDK is");
	await withProcessEnv({ E2B_API_KEY: BARE, E2B_DOMAIN: "prod.example.invalid", E2B_API_URL: "https://prod.example.invalid", E2B_DEBUG: "true" }, async () => {
		const config = new sdk.ConnectionConfig(e2b.connectionOptions({ apiKey: KEY, domain: "e2b.app" }));
		assert.equal(config.apiKey, KEY);
		assert.equal(config.domain, "e2b.app");
		assert.equal(config.apiUrl, "https://api.e2b.app");
		assert.equal(config.debug, false);
		assert.equal(config.sandboxUrl, undefined);
	});
});

test("E2B's exec, through the real SDK's envd client, passes the exec pre-check: every byte comes back as sent, where commands.run's onStdout decodes UTF-8", async (t) => {
	const sdk = await import("e2b").catch(() => undefined);
	if (sdk === undefined) return t.skip("the e2b package is not installed here; it is the host's, as Modal's SDK is");
	const envd = await fakeEnvd();
	t.after(() => envd.close());
	const connected = (id) => new sdk.Sandbox({ ...e2b.connectionOptions({ apiKey: KEY, domain: "e2b.app" }), sandboxId: id, envdVersion: "0.5.7", sandboxUrl: envd.url });
	const unused = (name) => async () => assert.fail(`the pre-check calls exec alone, not ${name}`);
	const Sandbox = {
		create: unused("Sandbox.create"),
		setTimeout: unused("Sandbox.setTimeout"),
		kill: unused("Sandbox.kill"),
		list: unused("Sandbox.list"),
		// exec connects to a sandbox it did not create: getInfo for the time left, then connect.
		getInfo: async (id) => ({ sandboxId: id, templateId: "base", metadata: {}, startedAt: new Date(), endAt: new Date(Date.now() + HOUR), state: "running" }),
		connect: async (id) => connected(id),
	};
	const host = await createHost({ env: { [ENV.key]: KEY }, Sandbox });
	const report = await checkExecStream(host, "sbx-exec", { longMs: 2_000, stepMs: 5_000, largeBytes: 1024 * 1024, largeMs: 30_000 });
	assert.equal(report.pass, true, formatExecStream(report));
	const start = envd.requests.find((request) => request.method === "Start");
	assert.equal(start.headers.authorization, `Basic ${Buffer.from("root:").toString("base64")}`, "every process runs as root");
	assert.equal(start.headers["keepalive-ping-interval"], "50");
	assert.deepEqual([start.body.process.cmd, ...start.body.process.args.slice(0, 2)], ["/bin/bash", "-l", "-c"]);
	assert.ok(!("timeout" in start.headers) && !("connect-timeout-ms" in start.headers), "the stream has no deadline");

	// The SDK's own commands.run, the path exec took before: the byte 0x80 comes back as U+FFFD through onStdout.
	const decoded = [];
	const handle = await connected("sbx-exec").commands.run("printf '\\200'", { background: true, onStdout: (text) => decoded.push(Buffer.from(text, "utf8")) });
	await handle.wait();
	assert.deepEqual([...Buffer.concat(decoded)], [0xef, 0xbf, 0xbd]);
});

test("the module never reads E2B_API_KEY, never imports the SDK at load, and names no environment variable: the conformance module's names are COMPUTER_E2B_*", () => {
	const source = readFileSync(new URL("../dist/e2b.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /process\.env\.E2B_API_KEY|\["E2B_API_KEY"\]/);
	assert.doesNotMatch(source, /COMPUTER_E2B_/, "the provider names no COMPUTER_E2B_ variable: the conformance module reads those");
	assert.doesNotMatch(source, /^\s*import\s[^(]*from\s+["']e2b["']/m, "no static import of the SDK");
	assert.equal(e2b.ENV, undefined, "no ENV of names");
	assert.equal(e2b.fromEnv, undefined, "no fromEnv");
	const { live, ...names } = ENV;
	assert.equal(live, "AGENTRUN_COMPUTER_LIVE_E2B");
	for (const name of Object.values(names)) assert.match(name, /^COMPUTER_E2B_[A-Z0-9_]+$/);
});

test("probeTargets takes host:port over TCP and host:port/udp, and refuses any other suffix in words", () => {
	assert.doesNotThrow(() => setup({ probeTargets: ["1.1.1.1:53/udp", "[2606:4700:4700::1111]:53/udp", "example.com:443"] }));
	for (const bad of [[], ["example.com"], ["1.1.1.1:53/sctp"], ["1.1.1.1:53/"]]) {
		assert.throws(() => setup({ probeTargets: bad }), /host:port or host:port\/udp/, JSON.stringify(bad));
	}
});

test("the provider writes nowhere but its results: its source has no console or stdio", () => {
	for (const file of ["../dist/e2b.js", "../dist/hosted/provider.js", "../dist/hosted/process.js"]) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.doesNotMatch(source, /\bconsole\.|process\.(stdout|stderr)/, `${file} writes nowhere but its results`);
	}
});

// --- the registry and the conformance module ---

test("the registry builds E2B from its options alone, and the conformance module needs its live switch first; the sweep's host needs none", async () => {
	const rec = recorder();
	await withProcessEnv({ E2B_API_KEY: BARE, COMPUTER_E2B_API_KEY: BARE }, async () => {
		await assert.rejects(providerFor("e2b", { Sandbox: rec.Sandbox }), (error) => {
			assert.match(error.message, /options\.apiKey/);
			assert.doesNotMatch(error.message, new RegExp(BARE));
			return true;
		});
	});
	const fromRegistry = await providerFor("e2b", { apiKey: KEY, daemonPath: DAEMON_PATH, Sandbox: rec.Sandbox });
	assert.equal(fromRegistry.id, "e2b");
	const conformance = await e2b.conformance();
	await assert.rejects(conformance.createProvider({ env: { [ENV.key]: KEY }, Sandbox: rec.Sandbox }), /set AGENTRUN_COMPUTER_LIVE_E2B=1/);
	await assert.rejects(conformance.createDriftedProvider({ env: { [ENV.key]: KEY }, Sandbox: rec.Sandbox }), /set AGENTRUN_COMPUTER_LIVE_E2B=1/);
	const provider = await conformance.createProvider({ env: { [ENV.key]: KEY, AGENTRUN_COMPUTER_LIVE_E2B: "1", [ENV.daemon]: DAEMON_PATH }, Sandbox: rec.Sandbox });
	assert.equal(provider.capabilities().maxLifetimeMs, 30 * 60_000, "a conformance computer lives at most 30 minutes");
	assert.equal(conformance.conformanceImage({ env: {} }), "desktop");
	assert.equal(conformance.conformanceImage({ env: { COMPUTER_E2B_TEMPLATE: "my-desktop" } }), "my-desktop");
	assert.ok(conformance.conformanceNotes.some((note) => /Hobby/.test(note)));
	const host = await conformance.createHost({ env: { [ENV.key]: KEY }, Sandbox: rec.Sandbox });
	assert.equal(host.id, "e2b");
	await assert.rejects(conformance.createHost({ env: { E2B_API_KEY: BARE }, Sandbox: rec.Sandbox }), /set COMPUTER_E2B_API_KEY/);
	assert.deepEqual(rec.calls, []);
});

test("the conformance module's drifted twin uploads a daemon of another version", async () => {
	const conformance = await e2b.conformance();
	const rec = recorder();
	const built = [];
	const drifted = await conformance.createDriftedProvider({
		env: { [ENV.key]: KEY, AGENTRUN_COMPUTER_LIVE_E2B: "1" },
		Sandbox: rec.Sandbox,
		buildDaemon: async (version) => {
			built.push(version);
			return DAEMON_PATH;
		},
	});
	assert.deepEqual(built, [`${VERSION}-drift`]);
	assert.equal(drifted.id, "e2b");
});

test("the live E2B suite skips when only E2B_API_KEY is set", () => {
	const live = new URL("./e2b/conformance.e2b.test.mjs", import.meta.url).pathname;
	const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", live], {
		env: { PATH: process.env.PATH, AGENTRUN_COMPUTER_LIVE_E2B: "1", E2B_API_KEY: BARE },
		encoding: "utf8",
		timeout: 60_000,
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout, /# SKIP .*COMPUTER_E2B_API_KEY/);
	assert.match(run.stdout, /^# fail 0$/m);
	assert.doesNotMatch(run.stdout + run.stderr, new RegExp(BARE));
});

// The loopback block: E2B's envd runs as root in the sandbox and answers on 49983, so the daemon's programs get a network
// of their own (init --own-network) and run as 2510:2510.

test("the loopback block: network none only, envd's port declared, open refused in words", () => {
	const { provider, rec } = setup();
	assert.deepEqual(provider.capabilities().network, ["none"]);
	assert.deepEqual(provider.capabilities().vendorAgentPorts, [49983]);
	const refusals = provider.check({ ...SPEC, network: "open" });
	assert.deepEqual(refusals.map((r) => r.field), ["network"]);
	assert.match(refusals[0].message, /network "none" only: its programs run in a network of their own/);
	assert.deepEqual(rec.calls, []);
});

// --- the Archil run folder of the conformance module ---

const TOKEN = "tok-e2b-archil-0123456789abcdef";
/** A made-up Archil account key, for the object API outside. */
const ARCHIL_KEY = "key-archil-account-0123456789abcdef";
const MOUNT = { kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", folder: "agents/a1/runs/r1/work", token: TOKEN };
const noToken = (value, what) => assert.ok(!JSON.stringify(value ?? null).includes(TOKEN), `${what} holds the token`);

test("the E2B conformance module: mountFor(\"archil\") gives a fresh run folder on the disk COMPUTER_ARCHIL_* name, read and written outside through the disk's object API", async () => {
	const { ARCHIL_ENV, E2B_ENV, mountFor } = await import("../dist/conformance/e2b.js");
	assert.equal(ARCHIL_ENV.archilDisk, "COMPUTER_ARCHIL_DISK");
	assert.equal(ARCHIL_ENV.archilRegion, "COMPUTER_ARCHIL_REGION");
	assert.equal(ARCHIL_ENV.archilToken, "COMPUTER_ARCHIL_TOKEN");
	assert.equal(ARCHIL_ENV.archilKey, "COMPUTER_ARCHIL_API_KEY");
	assert.equal(ARCHIL_ENV.archilS3Url, "COMPUTER_ARCHIL_S3_URL");
	assert.equal(Object.values(E2B_ENV).some((name) => name.startsWith("COMPUTER_ARCHIL_")), false, "the provider's settings name no Archil setting");
	const settings = {
		COMPUTER_ARCHIL_DISK: MOUNT.disk,
		COMPUTER_ARCHIL_REGION: MOUNT.region,
		COMPUTER_ARCHIL_TOKEN: TOKEN,
		COMPUTER_ARCHIL_API_KEY: ARCHIL_KEY,
		COMPUTER_ARCHIL_S3_URL: "https://s3.green.us-east-1.aws.prod.archil.com",
	};
	const env = { AGENTRUN_COMPUTER_LIVE_E2B: "1", ...settings };
	await assert.rejects(mountFor("archil", { env: { COMPUTER_ARCHIL_TOKEN: TOKEN } }), (error) => /COMPUTER_ARCHIL_DISK/.test(error.message) && !error.message.includes(TOKEN));
	assert.equal(await mountFor("bind", { env }), undefined);
	assert.equal(await mountFor("archil", { env: {} }), undefined);
	await assert.rejects(mountFor("archil", { env: { ...env, AGENTRUN_COMPUTER_LIVE_E2B: undefined }, archil: { objects: fakeObjects() } }), /AGENTRUN_COMPUTER_LIVE_E2B/);
	// The shared run folder (src/conformance/archil.ts), on an object API given.
	const objects = fakeObjects();
	const folder = await mountFor("archil", { env, archil: { objects } });
	assert.deepEqual({ ...folder.mount, folder: undefined }, { ...MOUNT, folder: undefined });
	assert.match(folder.mount.folder, /^agents\/conformance\/runs\/[A-Za-z0-9][A-Za-z0-9_-]*\/work$/);
	await folder.write("b.txt", Buffer.from("outside\n"));
	assert.equal(Buffer.from(await folder.read("b.txt")).toString("utf8"), "outside\n");
	assert.equal(await folder.read("missing.txt"), undefined);
	await folder.close();
	assert.equal(objects.objects.size, 0);
	noToken(objects.calls, "the object API's calls");
});

