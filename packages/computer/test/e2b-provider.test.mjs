// E2BProvider against a fake of the E2B SDK slice it takes (test/fake-e2b.mjs): every call is recorded with its options
// and answered as e2b@2.63.0 answers it. No SDK is loaded unless a test says so, no key is read from the environment and
// nothing reaches the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLifetime, kindRefusals } from "../dist/index.js";
import * as registry from "../dist/providers.js";
import { DAEMON, DESKTOP_GROUPS, fakeE2B, KEY, LINUX_GROUPS, TimeoutError, VERSION } from "./fake-e2b.mjs";

const e2b = await import("../dist/e2b.js");
const { E2BProvider, create } = e2b;
const { providerFor } = registry;
/** The conformance module's names: the only place E2B settings are read from an environment. */
const { E2B_ENV: ENV, settingsFromEnv } = await import("../dist/conformance/e2b.js");

const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DEADLINE = "agentrun.computer.deadline";
const IMAGE_LABEL = "agentrun.computer.image";
const MAX_LABEL = "agentrun.computer.max-deadline";
const TIMEOUT_LABEL = "agentrun.computer.timeout-ms";
const SPEC = { image: "desktop", lifetimeMs: 600_000, network: "none" };
const HOUR = 3_600_000;
/** What create and attach record of a computer with network none whose IPv4 probe targets E2B's firewall accepted. */
const ACCEPTED_NOTE = "network: none; accepted with no answer (no bytes came back): 1.1.1.1:443, 8.8.8.8:443";
const BARE = "e2b_bare_key_must_never_be_used";
const dir = mkdtempSync(join(tmpdir(), "computer-e2b-"));
const DAEMON_PATH = join(dir, "computerd");
const DAEMON_BYTES = Buffer.from("a stand-in for computerd, linux/amd64\n");
writeFileSync(DAEMON_PATH, DAEMON_BYTES);
const SHA = createHash("sha256").update(DAEMON_BYTES).digest("hex");
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Short bounds, so the waits in these tests take milliseconds. */
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500 };

function setup(options = {}, fakeOptions = {}) {
	const fake = fakeE2B(fakeOptions);
	const provider = new E2BProvider({ apiKey: KEY, Sandbox: fake.Sandbox, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...options });
	return { fake, provider };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const only = (fake) => {
	assert.equal(fake.sandboxes.size, 1, "one sandbox was made");
	return [...fake.sandboxes.values()][0];
};
const createOpts = (fake) => fake.calls.find(([name]) => name === "Sandbox.create")?.[2];
const runsOf = (fake, kind) => fake.calls.filter(([name, , script]) => name === "commands.run" && script === kind);
/** A sandbox as create leaves one, seeded straight into the fake, with init running. */
function seeded(fake, { name = "computer-0123456789ab", labels = {}, network = "none", template = "desktop", lifetimeMs = 600_000, display = ":0", extra = {} } = {}) {
	const deadline = new Date(Date.now() + lifetimeMs).toISOString();
	const sb = fake.add({
		template,
		metadata: { ...labels, [COMPUTER]: "1", [NAME]: name, [DEADLINE]: deadline, [IMAGE_LABEL]: template, [MAX_LABEL]: new Date(Date.now() + HOUR).toISOString(), [TIMEOUT_LABEL]: String(lifetimeMs) },
		timeoutMs: lifetimeMs,
		allowInternetAccess: network === "open",
		network: { allowPublicTraffic: false },
		lifecycle: { onTimeout: "kill" },
		...extra,
	});
	sb.daemon = { path: DAEMON, bytes: DAEMON_BYTES };
	sb.init = { deadline, user: "2510:2510", display, max: new Date(Date.now() + HOUR).toISOString() };
	if (display) {
		sb.xvfb = { id: "p0", argv: ["Xvfb"], running: true };
		sb.displayUp = true;
	}
	return { sb, ref: { id: sb.id, name } };
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

/**
 * Everything written to the console and to stderr while fn runs, and fn's value. Not stdout: the test runner reports
 * through it.
 */
async function captured(fn) {
	const lines = [];
	const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug, err: process.stderr.write };
	for (const name of ["log", "error", "warn", "info", "debug"]) console[name] = (...args) => lines.push(args.map(String).join(" "));
	process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), saved.err.call(process.stderr, "", ...rest));
	try {
		return { value: await fn(), text: lines.join("\n") };
	} finally {
		Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn, info: saved.info, debug: saved.debug });
		process.stderr.write = saved.err;
	}
}

// --- capabilities and check ---

test("an E2B desktop is kind desktop with daemon child, the desktop groups, network none read back, envd's port, and Hobby's 1 h cap", () => {
	const { provider } = setup();
	const caps = provider.capabilities();
	assert.deepEqual(
		{ kind: caps.kind, os: caps.os, daemon: caps.daemon, lifetime: caps.lifetime, isolation: caps.isolation, network: caps.network, networkReadBack: caps.networkReadBack, release: caps.release, vendorAgentPorts: caps.vendorAgentPorts },
		{ kind: "desktop", os: "linux", daemon: "child", lifetime: "vendor", isolation: "microvm", network: ["none"], networkReadBack: true, release: ["delete"], vendorAgentPorts: [49983] },
	);
	assert.deepEqual(caps.groups, DESKTOP_GROUPS);
	assert.equal(caps.maxLifetimeMs, HOUR, "E2B Hobby caps a sandbox at 1 h");
	assert.deepEqual(kindRefusals(caps), []);
	assert.equal(provider.id, "e2b");
	assert.equal(provider.version, VERSION);
	assert.equal(provider.stream, undefined, "no stream without publicStream: a private sandbox's URL needs a header a browser cannot send");
	assert.equal(typeof provider.extend, "function");
});

test("kind linux is the plain template: no display, groups exec, files and processes", () => {
	const { provider } = setup({ kind: "linux" });
	const caps = provider.capabilities();
	assert.equal(caps.kind, "linux");
	assert.deepEqual(caps.groups, LINUX_GROUPS);
	assert.deepEqual(kindRefusals(caps), []);
	assert.throws(() => setup({ kind: "android" }), /desktop or linux/);
});

test("maxLifetimeMs is Hobby's 1 h by default, Pro's 24 h at most, and check() refuses past it by the shared rule, with no call", () => {
	const { provider, fake } = setup();
	assert.deepEqual(provider.check({ ...SPEC, lifetimeMs: HOUR }), []);
	const refused = provider.check({ ...SPEC, lifetimeMs: HOUR + 1 });
	assert.deepEqual(refused, checkLifetime(HOUR + 1, provider.capabilities()));
	assert.match(refused[0].message, /at most 1 h/);
	const pro = setup({ maxLifetimeMs: 24 * HOUR }).provider;
	assert.deepEqual(pro.check({ ...SPEC, lifetimeMs: 2 * HOUR }), []);
	assert.throws(() => setup({ maxLifetimeMs: 24 * HOUR + 1 }), /24 h/);
	assert.throws(() => setup({ maxLifetimeMs: 0 }), /maxLifetimeMs/);
	assert.deepEqual(fake.calls, []);
});

test("create refuses a lifetime past the cap in words before any E2B call", async () => {
	const { provider, fake } = setup();
	const made = await provider.create({ ...SPEC, lifetimeMs: 2 * HOUR });
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, /lifetimeMs is at most 1 h/);
	assert.deepEqual(fake.calls, []);
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

test("the daemon user is held to root's numbers, not its text: 00:00 is root as much as 0:0, from options or the conformance module's COMPUTER_E2B_USER", async () => {
	for (const daemonUser of ["00:00", "000:1000", "1000:00", "0:1000"]) assert.throws(() => setup({ daemonUser }), /root or in root's group/, daemonUser);
	assert.doesNotThrow(() => setup({ daemonUser: "01000:01000" }), "leading zeros on a user that is not root are its number");
	const fake = fakeE2B();
	await assert.rejects(create({ apiKey: KEY, daemonUser: "00:00", daemonPath: DAEMON_PATH, Sandbox: fake.Sandbox }), /root or in root's group/);
	const conformance = await e2b.conformance();
	const env = { [ENV.live]: "1", [ENV.key]: KEY, [ENV.user]: "00:00", [ENV.daemon]: DAEMON_PATH };
	await assert.rejects(conformance.createProvider({ env, Sandbox: fake.Sandbox }), /root or in root's group/);
	assert.deepEqual(fake.calls, []);
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

test("create() takes the key as options.apiKey alone and reads no environment: E2B_API_KEY or COMPUTER_E2B_API_KEY in process.env is never a fallback", async () => {
	const fake = fakeE2B();
	await withProcessEnv({ E2B_API_KEY: BARE, COMPUTER_E2B_API_KEY: BARE }, async () => {
		for (const options of [{}, { apiKey: "" }]) {
			await assert.rejects(create({ ...options, Sandbox: fake.Sandbox, daemonPath: DAEMON_PATH }), (error) => {
				assert.match(error.message, /options\.apiKey/);
				assert.doesNotMatch(error.message, /COMPUTER_E2B_API_KEY|E2B_API_KEY/, "the library names its option, never an environment variable");
				assert.doesNotMatch(error.message, new RegExp(BARE));
				return true;
			});
		}
	});
	assert.deepEqual(fake.calls, []);
});

test("the conformance module reads the key from COMPUTER_E2B_API_KEY alone: a bare E2B_API_KEY is refused in words, and nothing is called", async () => {
	const fake = fakeE2B();
	const conformance = await e2b.conformance();
	await withProcessEnv({ E2B_API_KEY: BARE }, async () => {
		for (const env of [{ E2B_API_KEY: BARE }, {}, { [ENV.key]: "" }]) {
			await assert.rejects(conformance.createProvider({ env: { ...env, [ENV.live]: "1" }, Sandbox: fake.Sandbox, daemonPath: DAEMON_PATH }), (error) => {
				assert.match(error.message, /set COMPUTER_E2B_API_KEY to an E2B API key/);
				assert.match(error.message, /never from E2B_API_KEY/);
				assert.doesNotMatch(error.message, new RegExp(BARE));
				return true;
			});
		}
	});
	assert.deepEqual(fake.calls, []);
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
		[ENV.publicStream]: "1",
		E2B_API_KEY: BARE,
	};
	assert.deepEqual(settingsFromEnv(env), { apiKey: KEY, domain: "e2b.example.com", daemonPath: DAEMON_PATH, kind: "linux", maxLifetimeMs: 86_400_000, daemonUser: "2000:2000", publicStream: true });
	assert.throws(() => settingsFromEnv({ [ENV.key]: KEY, [ENV.maxLifetimeMs]: "1h" }), /COMPUTER_E2B_MAX_LIFETIME_MS is a whole number of milliseconds/);
	assert.throws(() => settingsFromEnv({ [ENV.key]: KEY, [ENV.publicStream]: "yes" }), /COMPUTER_E2B_PUBLIC_STREAM is 1 or unset/);
	assert.throws(() => settingsFromEnv({ [ENV.key]: KEY, E2B_SANDBOX_URL: "https://prod.example.invalid" }), /E2B_SANDBOX_URL is set/);
});

test("every SDK call is given the key passed in, the domain, the API URL and debug false explicitly, so an ambient E2B_* cannot win", async () => {
	const fake = fakeE2B();
	await withProcessEnv({ E2B_API_KEY: BARE, COMPUTER_E2B_API_KEY: BARE, E2B_DOMAIN: "prod.example.invalid", COMPUTER_E2B_DOMAIN: "prod.example.invalid", E2B_API_URL: "https://prod.example.invalid", E2B_DEBUG: "true" }, async () => {
		const provider = await create({ apiKey: KEY, daemonPath: DAEMON_PATH, Sandbox: fake.Sandbox, timeouts: TIMEOUTS });
		const made = await provider.create(SPEC);
		assert.equal(made.ok, true, made.ok ? "" : made.error.message);
		assert.equal((await provider.list({})).ok, true);
		assert.equal((await provider.release(made.value, "delete")).ok, true);
	});
	const apiCalls = fake.calls.filter(([name]) => name.startsWith("Sandbox."));
	assert.ok(apiCalls.length >= 5);
	for (const call of apiCalls) {
		const opts = call.findLast((arg) => typeof arg === "object" && arg !== null && "apiKey" in arg);
		assert.ok(opts, `${call[0]} was given its connection options`);
		assert.equal(opts.apiKey, KEY, `${call[0]}: the key passed in`);
		assert.equal(opts.domain, "e2b.app");
		assert.equal(opts.apiUrl, "https://api.e2b.app");
		assert.equal(opts.debug, false, `${call[0]}: debug false, else the SDK skips kill and fakes create (index.mjs:5402, 6022)`);
	}
	assert.doesNotMatch(JSON.stringify(fake.calls), new RegExp(BARE));
});

test("options.domain names the domain the key goes to, as COMPUTER_E2B_DOMAIN does through the conformance module; anything but a host name is refused", async () => {
	const fake = fakeE2B();
	const provider = await create({ apiKey: KEY, domain: "e2b.example.com", daemonPath: DAEMON_PATH, Sandbox: fake.Sandbox, timeouts: TIMEOUTS });
	await provider.list({});
	const opts = fake.calls.find(([name]) => name === "Sandbox.list")[1];
	assert.equal(opts.domain, "e2b.example.com");
	assert.equal(opts.apiUrl, "https://api.e2b.example.com");
	const conformance = await e2b.conformance();
	for (const domain of ["https://e2b.app", "e2b.app/x", "localhost:3000", "E2B.app"]) {
		await assert.rejects(create({ apiKey: KEY, domain, Sandbox: fake.Sandbox }), /E2B domain must be a host name/);
		await assert.rejects(conformance.createProvider({ env: { [ENV.live]: "1", [ENV.key]: KEY, [ENV.domain]: domain }, Sandbox: fake.Sandbox }), /E2B domain must be a host name/);
	}
});

test("the provider refuses to start while E2B_SANDBOX_URL is set in process.env: the SDK would send every sandbox call there", async () => {
	const fake = fakeE2B();
	await withProcessEnv({ E2B_SANDBOX_URL: "https://prod.example.invalid" }, async () => {
		await assert.rejects(create({ apiKey: KEY, daemonPath: DAEMON_PATH, Sandbox: fake.Sandbox }), /E2B_SANDBOX_URL is set/);
		assert.throws(() => new E2BProvider({ apiKey: KEY, Sandbox: fake.Sandbox, daemonPath: DAEMON_PATH }), /E2B_SANDBOX_URL is set/);
	});
	assert.deepEqual(fake.calls, []);
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

// --- create ---

test("create() makes the sandbox from the template with the labels, the lifetime as its timeout, no internet, no public traffic, and kill at the timeout", async () => {
	const { provider, fake } = setup();
	const before = Date.now();
	const made = await provider.create({ ...SPEC, labels: { run: "r1", case: "c1" } });
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	const sb = only(fake);
	assert.deepEqual(made.value, { id: sb.id, name: sb.metadata[NAME], notes: [ACCEPTED_NOTE] }, "E2B's firewall accepts and sends nothing back: recorded in words, not refused");
	assert.match(made.value.name, /^computer-[0-9a-f]{12}$/);
	const [, template, opts] = fake.calls.find(([name]) => name === "Sandbox.create");
	assert.equal(template, "desktop");
	assert.equal(opts.timeoutMs, 600_000);
	assert.equal(opts.allowInternetAccess, false);
	assert.deepEqual(opts.network, { allowPublicTraffic: false });
	assert.deepEqual(opts.lifecycle, { onTimeout: "kill" });
	assert.deepEqual(opts.envs, {});
	assert.equal(opts.signal, undefined, "create is raced, never cancelled: a sandbox it makes is known by id");
	const deadline = Date.parse(opts.metadata[DEADLINE]);
	assert.ok(deadline >= before + 600_000 && deadline <= Date.now() + 600_000);
	assert.deepEqual(opts.metadata, { run: "r1", case: "c1", [COMPUTER]: "1", [NAME]: made.value.name, [DEADLINE]: opts.metadata[DEADLINE], [IMAGE_LABEL]: "desktop", [MAX_LABEL]: opts.metadata[MAX_LABEL], [TIMEOUT_LABEL]: "600000" });
	assert.ok(Math.abs(Date.parse(opts.metadata[MAX_LABEL]) - (before + HOUR)) < 5_000, "the most extend may reach: create's time plus the cap");
});

test("create() with network none asks for no internet access and no public traffic; open makes nothing", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	assert.equal(createOpts(fake).allowInternetAccess, false);
	assert.deepEqual(createOpts(fake).network, { allowPublicTraffic: false });
	const open = setup();
	const refused = await open.provider.create({ ...SPEC, network: "open" });
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /network "none" only/);
	assert.deepEqual(open.fake.calls, []);
});

test("create() uploads the daemon as root, installs it, checks its sha256, and starts init as root in the background with no command timeout, DISPLAY and --max-deadline", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	const sb = only(fake);
	assert.equal(fake.uploads.length, 1);
	assert.deepEqual(fake.uploads[0].bytes, DAEMON_BYTES);
	assert.equal(fake.uploads[0].user, "root");
	assert.match(fake.uploads[0].path, /^\/tmp\/agentrun-computerd-[0-9a-f]{16}$/);
	assert.deepEqual(sb.daemon, { path: DAEMON, bytes: DAEMON_BYTES });
	const [install] = runsOf(fake, "install");
	assert.equal(install[3].user, "root");
	const [init] = runsOf(fake, "init");
	assert.equal(init[3].user, "root");
	assert.equal(init[3].background, true);
	assert.equal(init[3].timeoutMs, 0, "envd kills a command at its timeout (envd start.go:39-44): init has none");
	assert.equal(sb.init.display, ":0");
	assert.equal(sb.init.max, createOpts(fake).metadata[MAX_LABEL]);
	assert.equal(sb.init.deadline, createOpts(fake).metadata[DEADLINE]);
	assert.equal(sb.init.user, "2510:2510");
	assert.match(sb.init.command, /--own-network/);
	assert.ok(sb.init.handle.disconnected, "create leaves init running, disconnected");
	const xvfb = sb.processes.find((p) => p.argv[0] === "Xvfb");
	assert.deepEqual(xvfb.argv, ["Xvfb", ":0", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], "the X server is started through the daemon");
	for (const bridge of fake.bridges) {
		assert.equal(bridge.opts.user, "root");
		assert.equal(bridge.opts.stdin, true);
		assert.equal(bridge.opts.timeoutMs, 0);
		assert.equal(bridge.opts.retainOutput, false);
		assert.ok(bridge.handle.killed, "every bridge create opened is ended");
	}
	const probe = fake.requests.find((r) => r.method === "exec.run" && r.params.argv[1] === "probe");
	assert.ok(probe, "the probe ran from inside");
});

test("create() of kind linux starts no X server and gives init no DISPLAY", async () => {
	const { provider, fake } = setup({ kind: "linux" });
	const made = await provider.create({ ...SPEC, image: "base" });
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	const sb = only(fake);
	assert.equal(sb.init.display, "");
	assert.equal(sb.processes.length, 0);
});

test("a daemon whose installed sha256 does not match the upload is refused, and the sandbox killed and read back gone", async () => {
	const { provider, fake } = setup({}, { sha: "lie" });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, new RegExp(`uploaded sha256 ${SHA}`));
	assert.match(made.error.message, /was deleted/);
	const sb = only(fake);
	assert.deepEqual(fake.kills, [sb.id]);
	assert.equal(runsOf(fake, "init").length, 0, "init never starts a daemon that does not match");
});

test("an install that fails, init that never listens, or an X server that dies each kill the sandbox, with the reason in words", async () => {
	for (const [options, pattern] of [
		[{ install: 5 }, /installing the daemon failed \(exit 5\)/],
		[{ initFails: "init refuses to start: dropping CapBnd: operation not permitted" }, /init refuses to start/],
		[{ display: "dies" }, /X server .* ended with exit code 1 .*Cannot establish any listening sockets/],
		[{ display: "never" }, /was not up within/],
	]) {
		const { provider, fake } = setup({ desktop: { timeoutMs: 200 } }, options);
		const made = await provider.create(SPEC);
		assert.equal(made.ok, false, JSON.stringify(options));
		assert.match(made.error.message, pattern);
		assert.deepEqual(fake.kills, [only(fake).id], JSON.stringify(options));
	}
});

test("create() tries the bridge again while init is not yet listening", async () => {
	const { provider, fake } = setup({}, { notListening: 2 });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	assert.ok(fake.bridges.length >= 3);
});

test("a create E2B refuses makes nothing and kills nothing; one that lands after an abort is killed as it lands", async () => {
	for (const create of ["fail", "auth"]) {
		const { provider, fake } = setup({}, { create });
		const made = await provider.create(SPEC);
		assert.equal(made.ok, false);
		assert.equal(made.error.code, create === "auth" ? "denied" : "invalid");
		assert.deepEqual(fake.kills, []);
	}
	const { provider, fake } = setup({}, { create: "hold" });
	const controller = new AbortController();
	const making = provider.create(SPEC, { signal: controller.signal });
	await new Promise((done) => setTimeout(done, 20));
	controller.abort();
	const made = await making;
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "aborted");
	assert.match(made.error.message, /killed as it lands/);
	await fake.release();
	assert.deepEqual(fake.kills, [only(fake).id]);
});

test("a create whose answer never comes is swept by its name label: the sandbox it made is killed", async () => {
	const { provider, fake } = setup({}, { create: "lost" });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "timeout");
	for (let i = 0; i < 50 && fake.kills.length === 0; i++) await new Promise((done) => setTimeout(done, 10));
	const sb = only(fake);
	assert.deepEqual(fake.kills, [sb.id]);
	const query = fake.calls.find(([name]) => name === "Sandbox.list")[1].query.metadata;
	assert.deepEqual(query, { [COMPUTER]: "1", [NAME]: sb.metadata[NAME] }, "found by the name create gave it, and nothing else");
});

test("a create whose answer is lost is swept by its name even when the listing shows the sandbox late, and it is read back gone", async () => {
	for (const create of ["lost", "broken"]) {
		const { provider, fake } = setup({}, { create, unlisted: 2 });
		const made = await provider.create(SPEC);
		assert.equal(made.ok, false, create);
		for (let i = 0; i < 100 && fake.kills.length === 0; i++) await sleep(10);
		const sb = only(fake);
		assert.deepEqual(fake.kills, [sb.id], `${create}: the sandbox was killed once the listing showed it`);
		assert.ok(fake.calls.filter(([name]) => name === "Sandbox.list").length >= 3, `${create}: the listing was read until it showed the name`);
		if (create === "broken") {
			assert.equal(made.error.code, "e2b");
			assert.match(made.error.message, new RegExp(`${sb.id} was killed and read back gone`));
			const lastKill = fake.calls.findLastIndex(([name]) => name === "Sandbox.kill");
			assert.ok(fake.calls.slice(lastKill).some(([name, id]) => name === "Sandbox.getInfo" && id === sb.id), "it was read back after the kill");
		}
	}
});

test("a create whose answer is lost and whose sandbox never lists says so, after polling within listedMs", async () => {
	const { provider, fake } = setup({}, { create: "broken", unlisted: 10_000 });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.match(made.error.message, /no sandbox named computer-[0-9a-f]{12} was listed within 0\.5 s/);
	assert.deepEqual(fake.kills, []);
});

test("an abort at each step of create kills the sandbox, and create returns aborted", async () => {
	const steps = ["Sandbox.getInfo", "files.write", "commands.run install", "commands.run init", "hello", "process.start", "files.read", "exec.run", "Sandbox.list"];
	for (const at of steps) {
		const controller = new AbortController();
		let hit = false;
		const { provider, fake } = setup(
			{},
			{
				onStep: (step) => {
					if (step === at && !hit) {
						hit = true;
						controller.abort();
					}
				},
			},
		);
		const made = await provider.create(SPEC, { signal: controller.signal });
		assert.ok(hit, `${at} was reached`);
		assert.equal(made.ok, false, at);
		assert.equal(made.error.code, "aborted", `${at}: ${made.error.message}`);
		assert.deepEqual(fake.kills, [only(fake).id], `${at}: the sandbox was killed`);
	}
});

test("drift at create is refused and the sandbox killed: hello, the daemon's credentials, the vendor's network and timeout action, the probe", async () => {
	for (const [fakeOptions, pattern] of [
		[{ box: { helloPatch: { version: "0.0.1" } } }, /version 0\.0\.1/],
		[{ box: { helloPatch: { arch: "arm64" } } }, /arch arm64/],
		[{ box: { status: { CapEff: "000001ffffffffff" } } }, /CapEff/],
		[{ box: { status: { NoNewPrivs: "0" } } }, /no_new_privs/],
		[{ info: { allowInternetAccess: true, network: { allowPublicTraffic: false } } }, /network: declared none, read back open/],
		[{ info: { network: { allowPublicTraffic: true } } }, /public traffic/],
		[{ info: { lifecycle: { onTimeout: "pause" } } }, /onTimeout/],
		[{ box: { reached: ["1.1.1.1:443"] } }, /network: declared none, read back an answer from 1\.1\.1\.1:443/],
		[{ box: { reached: ["8.8.8.8:443"], accepted: ["1.1.1.1:443"] } }, /network: declared none, read back an answer from 8\.8\.8\.8:443$/],
		[{ info: { templateId: "tpl-other", name: "other-desktop" } }, /template: declared "desktop", read back "tpl-other" \(other-desktop\)/],
		[{ info: { metadata: { [COMPUTER]: "1" } } }, /label agentrun\.computer\.name/],
	]) {
		const { provider, fake } = setup({}, fakeOptions);
		const made = await provider.create(SPEC);
		assert.equal(made.ok, false, JSON.stringify(fakeOptions));
		assert.equal(made.error.code, "refused", made.error.message);
		assert.match(made.error.message, pattern);
		assert.deepEqual(fake.kills, [only(fake).id]);
	}
});

// --- connect, attach, list, network ---

test("connect() checks hello per call: a desktop whose display is gone reads back linux and is refused", async () => {
	const { provider, fake } = setup();
	const { sb, ref } = seeded(fake);
	const connected = await provider.connect(ref);
	assert.equal(connected.ok, true, connected.ok ? "" : connected.error.message);
	assert.equal(connected.value.hello.kind, "desktop");
	await connected.value.close();
	sb.displayUp = false;
	const refused = await provider.connect(ref);
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "refused");
	assert.match(refused.error.message, /kind linux, expected desktop/);
	const opts = fake.calls.filter(([name]) => name === "Sandbox.connect").map(([, , o]) => o);
	for (const o of opts) assert.ok(o.timeoutMs <= Date.parse(sb.init.deadline) - Date.now() + 1000, "connect never moves the timer later");
});

test("connect() refuses a sandbox that is not this provider's, and one that is paused, without resuming it", async () => {
	const { provider, fake } = setup();
	const other = fake.add({ metadata: { other: "1" } });
	const theirs = await provider.connect({ id: other.id, name: "computer-0123456789ab" });
	assert.equal(theirs.ok, false);
	assert.equal(theirs.error.code, "not_found");
	const { sb, ref } = seeded(fake, { name: "computer-aaaaaaaaaaaa" });
	sb.state = "paused";
	const paused = await provider.connect(ref);
	assert.equal(paused.ok, false);
	assert.match(paused.error.message, /paused/);
	assert.equal(fake.calls.filter(([name]) => name === "Sandbox.connect").length, 0, "connect would resume it");
});

test("list() finds this provider's sandboxes by labels, reads each one's network back, and reports paused as stopped", async () => {
	const { provider, fake } = setup();
	const a = seeded(fake, { name: "computer-aaaaaaaaaaaa", labels: { run: "r1" } });
	const b = seeded(fake, { name: "computer-bbbbbbbbbbbb", labels: { run: "r1" }, network: "open" });
	seeded(fake, { name: "computer-cccccccccccc", labels: { run: "r2" } });
	fake.add({ metadata: { [COMPUTER]: "1", run: "r1" } });
	b.sb.state = "paused";
	const listed = await provider.list({ run: "r1" });
	assert.equal(listed.ok, true, listed.ok ? "" : listed.error.message);
	const byName = Object.fromEntries(listed.value.map((info) => [info.ref.name, info]));
	assert.deepEqual(Object.keys(byName).sort(), ["computer-aaaaaaaaaaaa", "computer-bbbbbbbbbbbb"]);
	assert.equal(byName["computer-aaaaaaaaaaaa"].network, "none");
	assert.equal(byName["computer-bbbbbbbbbbbb"].network, "open");
	assert.equal(byName["computer-bbbbbbbbbbbb"].state, "stopped");
	assert.equal(byName["computer-aaaaaaaaaaaa"].state, "running");
	assert.equal(byName["computer-aaaaaaaaaaaa"].deadline.toISOString(), a.sb.metadata[DEADLINE]);
	const query = fake.calls.find(([name]) => name === "Sandbox.list")[1].query;
	assert.deepEqual(query.metadata, { run: "r1", [COMPUTER]: "1" });
	assert.equal(byName["computer-aaaaaaaaaaaa"].ref.id, a.ref.id);
});

test("list() keeps every page and every read-back inside listMs, however slow each getInfo is", async () => {
	const onStep = async (step) => {
		if (step === "Sandbox.getInfo") await sleep(200);
	};
	const { provider, fake } = setup({ timeouts: { ...TIMEOUTS, listMs: 500 } }, { onStep });
	for (let i = 0; i < 6; i++) seeded(fake, { name: `computer-${String(i).padStart(12, "0")}` });
	const started = Date.now();
	const listed = await provider.list({});
	const took = Date.now() - started;
	assert.equal(listed.ok, false, "six reads of 200 ms each do not fit in 500 ms");
	assert.equal(listed.error.code, "timeout");
	assert.match(listed.error.message, /list did not finish within 0\.5 s/);
	assert.ok(took < 900, `list() took ${took} ms with a listMs of 500`);
	const reads = fake.calls.filter(([name]) => name === "Sandbox.getInfo").map(([, , opts]) => opts.requestTimeoutMs);
	assert.ok(reads.every((ms) => ms <= 500), `every read-back's own request bound fits the listing's: ${reads.join(", ")}`);
});

/**
 * Runs fn with Date.now reading lagMs behind the real clock from the first time hold(step) is reached: a timer then
 * fires while Date.now still reads short of the time it was set for, as a timer can, so the read's own bound always
 * ends before the list's deadline reads as passed.
 */
async function withLaggingClock(lagMs, hold, fn) {
	const real = Date.now;
	let lag = 0;
	Date.now = () => real() - lag;
	try {
		return await fn(async (step) => {
			if (!hold(step)) return;
			lag = lagMs;
			await sleep(2_000);
		});
	} finally {
		Date.now = real;
	}
}

test("a read-back or a page held past the remainder of listMs fails as the list's deadline, whichever timer reads first", async () => {
	for (const step of ["Sandbox.getInfo", "Sandbox.list"]) {
		const listed = await withLaggingClock(
			50,
			(at) => at === step,
			async (onStep) => {
				const { provider, fake } = setup({ timeouts: { ...TIMEOUTS, listMs: 300 } }, { onStep });
				seeded(fake);
				return provider.list({});
			},
		);
		assert.equal(listed.ok, false, step);
		assert.equal(listed.error.code, "timeout", step);
		assert.match(listed.error.message, /^list did not finish within 0\.3 s/, `${step}: ${listed.error.message}`);
	}
});

test("a read-back that times out on its own requestMs, with list time left, keeps its own words", async () => {
	const onStep = async (step) => {
		if (step !== "Sandbox.getInfo") return;
		await sleep(100);
		throw new TimeoutError("Request timed out");
	};
	const { provider, fake } = setup({ timeouts: { ...TIMEOUTS, requestMs: 100, listMs: 5_000 } }, { onStep });
	const { ref } = seeded(fake);
	const listed = await provider.list({});
	assert.equal(listed.ok, false);
	assert.equal(listed.error.code, "timeout");
	assert.match(listed.error.message, new RegExp(`^Sandbox\\.getInfo of ${ref.id} failed: TimeoutError`));
	assert.doesNotMatch(listed.error.message, /list did not finish/);
});

test("attach() by id or by labels reads the spec back and checks the daemon; one that drifted is refused and left running", async () => {
	const { provider, fake } = setup();
	const { ref, sb } = seeded(fake, { labels: { run: "r1" } });
	for (const by of [{ id: ref.id }, { labels: { run: "r1" } }]) {
		const attached = await provider.attach(by);
		assert.equal(attached.ok, true, attached.ok ? "" : attached.error.message);
		assert.deepEqual(
			{ ...attached.value, spec: { ...attached.value.spec, deadline: undefined } },
			{ ...ref, spec: { image: "desktop", snapshot: "tpl-desktop", user: "2510:2510", network: "none", workdir: "/work", deadline: undefined, kind: "desktop" }, notes: [ACCEPTED_NOTE] },
		);
	}
	sb.box.status = { CapEff: "000001ffffffffff" };
	const drifted = await provider.attach({ id: ref.id });
	assert.equal(drifted.ok, false);
	assert.match(drifted.error.message, /left as it is.*CapEff/);
	assert.deepEqual(fake.kills, []);
});

test("a bridge whose start lands after attach gave up on it is killed and disconnected as it lands", async () => {
	const controller = new AbortController();
	let held = false;
	const onStep = async (step) => {
		if (step !== "commands.run stdio" || held) return;
		held = true;
		// The caller gives up while E2B is still starting the bridge, which E2B then starts all the same.
		controller.abort();
		await sleep(50);
	};
	const { provider, fake } = setup({}, { onStep });
	const { ref } = seeded(fake);
	const attached = await provider.attach({ id: ref.id }, { signal: controller.signal });
	assert.equal(attached.ok, false);
	assert.equal(attached.error.code, "aborted");
	for (let i = 0; i < 100 && !(fake.bridges[0]?.handle.killed && fake.bridges[0]?.handle.disconnected); i++) await sleep(10);
	assert.equal(fake.bridges.length, 1, "E2B started the bridge after the abort");
	const [{ handle }] = fake.bridges;
	assert.ok(handle.killed, "the late bridge was killed");
	assert.ok(handle.disconnected, "and disconnected");
	assert.match(attached.error.message, /a bridge that starts after this is killed/);
});

test("network none: a probe whose targets only accepted keeps the computer, the accepts named; one answering target refuses it, whatever the others accepted", async () => {
	const quiet = setup({}, { box: { accepted: ["1.1.1.1:443", "8.8.8.8:443", "[2606:4700:4700::1111]:443"] } });
	const made = await quiet.provider.create(SPEC);
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	assert.deepEqual(made.value.notes, ["network: none; accepted with no answer (no bytes came back): 1.1.1.1:443, 8.8.8.8:443, [2606:4700:4700::1111]:443"]);
	assert.deepEqual(quiet.fake.kills, []);
	assert.deepEqual(await quiet.provider.network(made.value), { ok: true, value: "none" });

	const { provider, fake } = setup();
	const { ref, sb } = seeded(fake);
	sb.box.reached = ["1.1.1.1:443"];
	sb.box.accepted = ["8.8.8.8:443"];
	const attached = await provider.attach({ id: ref.id });
	assert.equal(attached.ok, false);
	assert.match(attached.error.message, /left as it is.*network: declared none, read back an answer from 1\.1\.1\.1:443/);
	assert.deepEqual(fake.kills, []);
});

/** E2B's default probe targets: TCP to 443 and DNS over UDP to 53, over IPv4 and IPv6, as Modal's. */
const PROBE_TARGETS = ["1.1.1.1:443", "8.8.8.8:443", "[2606:4700:4700::1111]:443", "1.1.1.1:53/udp", "[2606:4700:4700::1111]:53/udp"];
const probeRun = (fake) => fake.requests.find((r) => r.method === "exec.run" && r.params.argv[1] === "probe" && r.params.argv[2] !== "--diagnose");

test("network none: the probe tries TCP to 443 and DNS over UDP to 53, over IPv4 and IPv6, and E2B's firewall reads the UDP targets refused", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	assert.deepEqual(probeRun(fake).params.argv, [DAEMON, "probe", ...PROBE_TARGETS.flatMap((target) => ["--connect", target])]);
	// IPv4 TCP accepted with nothing back, IPv6 refused, UDP dropped (no reply: refused): only the IPv4 TCP targets are named.
	assert.deepEqual(made.value.notes, [ACCEPTED_NOTE]);
	assert.deepEqual(fake.kills, []);
});

test("network none: a UDP target that answers refuses the computer at create and at attach, whatever the TCP targets did", async () => {
	const { provider, fake } = setup({}, { box: { udpAnswers: true } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false, "a DNS answer over UDP is an answer");
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, /network: declared none, read back an answer from 1\.1\.1\.1:53\/udp, \[2606:4700:4700::1111\]:53\/udp/);
	assert.equal(fake.kills.length, 1, "the sandbox is killed");

	const second = setup();
	const { ref, sb } = seeded(second.fake);
	sb.box.udpAnswers = true;
	const attached = await second.provider.attach({ id: ref.id });
	assert.equal(attached.ok, false);
	assert.match(attached.error.message, /left as it is.*read back an answer from 1\.1\.1\.1:53\/udp/);
	assert.deepEqual(second.fake.kills, []);
});

test("probeTargets takes host:port over TCP and host:port/udp, and refuses any other suffix in words", () => {
	assert.doesNotThrow(() => setup({ probeTargets: ["1.1.1.1:53/udp", "[2606:4700:4700::1111]:53/udp", "example.com:443"] }));
	for (const bad of [[], ["example.com"], ["1.1.1.1:53/sctp"], ["1.1.1.1:53/"]]) {
		assert.throws(() => setup({ probeTargets: bad }), /host:port or host:port\/udp/, JSON.stringify(bad));
	}
});

test("network none: a probe report with no accepted list is refused in words, never read as nothing accepted", async () => {
	const { provider, fake } = setup({}, { box: { probe: "no-accepted" } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, /the probe in .* wrote a report with no accepted list/);
	assert.equal(fake.kills.length, 1);
});

test("the probe's exec.run bound covers its longest run: 10 s to connect and 10 s to answer", async () => {
	const { probeMs, ...rest } = TIMEOUTS;
	const { provider, fake } = setup({ timeouts: rest });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	assert.ok(probeRun(fake).params.timeoutMs >= 30_000, `exec.run gives the probe ${probeRun(fake).params.timeoutMs} ms; its longest run is 20 s`);
	assert.equal(probeMs, 1_000, "the other tests' short bound");
});

test("network() reads the policy back from E2B, and refuses a change: it is fixed at create", async () => {
	const { provider, fake } = setup();
	const { ref } = seeded(fake);
	assert.deepEqual(await provider.network(ref), { ok: true, value: "none" });
	assert.deepEqual(await provider.network(ref, "none"), { ok: true, value: "none" });
	const changed = await provider.network(ref, "open");
	assert.equal(changed.ok, false);
	assert.equal(changed.error.code, "refused");
	assert.match(changed.error.message, /fixed at create/);
	assert.equal(fake.calls.filter(([name]) => name.includes("Network")).length, 0);
});

// --- extend ---

test("extend() moves E2B's timer, then init's deadline, and returns the end read back; never earlier, never past the cap", async () => {
	const { provider, fake } = setup();
	const { ref, sb } = seeded(fake, { lifetimeMs: 45_000 });
	const asked = Date.now();
	const extended = await provider.extend(ref, 120_000);
	assert.equal(extended.ok, true, extended.ok ? "" : extended.error.message);
	assert.ok(Math.abs(extended.value.deadline.getTime() - (asked + 120_000)) < 2_000);
	const [, id, ms] = fake.calls.find(([name]) => name === "Sandbox.setTimeout");
	assert.equal(id, ref.id);
	assert.equal(ms, 120_000);
	assert.equal(sb.init.deadline, extended.value.deadline.toISOString(), "init's own deadline moved to the vendor's");
	const listed = await provider.list({});
	assert.equal(listed.value[0].deadline.getTime(), extended.value.deadline.getTime(), "list() shows the extended deadline");

	const before = sb.endAt.getTime();
	const past = await provider.extend(ref, HOUR + 1);
	assert.equal(past.ok, false);
	assert.equal(past.error.code, "limit");
	assert.match(past.error.message, /past .* the most this computer may live/);
	assert.equal(sb.endAt.getTime(), before, "a refused extend moves nothing");
	assert.equal(fake.calls.filter(([name]) => name === "Sandbox.setTimeout").length, 1);

	const earlier = await provider.extend(ref, 1_000);
	assert.equal(earlier.ok, true);
	assert.equal(earlier.value.deadline.getTime(), before, "never earlier");
	assert.equal(fake.calls.filter(([name]) => name === "Sandbox.setTimeout").length, 1);
});

test("two extends of one computer run one after the other: a slow, shorter one never pulls E2B's timer under the deadline the longer one returned", async () => {
	let first = true;
	const onStep = async (step) => {
		if (step !== "Sandbox.setTimeout" || !first) return;
		first = false;
		await sleep(150);
	};
	const { provider, fake } = setup({}, { onStep });
	const { ref, sb } = seeded(fake, { lifetimeMs: 45_000 });
	// Both read the same old deadline at once; the shorter one's setTimeout is the slow one.
	const [shorter, longer] = await Promise.all([provider.extend(ref, 300_000), provider.extend(ref, 900_000)]);
	assert.equal(longer.ok, true, longer.ok ? "" : longer.error.message);
	assert.ok(sb.endAt.getTime() >= longer.value.deadline.getTime(), `E2B ends it at ${sb.endAt.toISOString()}, before the deadline extend returned, ${longer.value.deadline.toISOString()}`);
	assert.equal(sb.init.deadline, longer.value.deadline.toISOString(), "init holds the deadline the longer extend returned");
	assert.equal(shorter.ok, true, shorter.ok ? "" : shorter.error.message);
	assert.ok(shorter.value.deadline.getTime() <= longer.value.deadline.getTime());
	const listed = await provider.list({});
	assert.equal(listed.value[0].deadline.getTime(), longer.value.deadline.getTime());
});

test("an extend near the cap returns the deadline the daemon took, never past the most, and asks E2B for no timer past it", async () => {
	let calledAt;
	const onStep = async (step) => {
		if (step !== "Sandbox.setTimeout") return;
		calledAt = Date.now();
		// The time spent sending setTimeout: E2B's end is its own now plus the timeout.
		await sleep(1_500);
	};
	const { provider, fake } = setup({}, { onStep });
	const { ref, sb } = seeded(fake, { lifetimeMs: 45_000 });
	const most = new Date(Date.now() + 700_000).toISOString();
	sb.metadata[MAX_LABEL] = most;
	sb.init.max = most;
	const extended = await provider.extend(ref, 699_000);
	assert.equal(extended.ok, true, extended.ok ? "" : extended.error.message);
	assert.ok(extended.value.deadline.getTime() <= Date.parse(most), `extend returned ${extended.value.deadline.toISOString()}, past the most, ${most}`);
	assert.equal(extended.value.deadline.toISOString(), sb.init.deadline, "the deadline init took");
	const [, , ms] = fake.calls.find(([name]) => name === "Sandbox.setTimeout");
	assert.ok(calledAt + ms <= Date.parse(most), `E2B was asked for ${ms} ms at ${new Date(calledAt).toISOString()}, past ${most}`);
	assert.equal(ms % 1000, 0, "E2B takes whole seconds");
	const listed = await provider.list({});
	assert.equal(listed.value[0].deadline.getTime(), extended.value.deadline.getTime(), "list() shows the deadline extend returned");
});

test("an extend that moves E2B's end by less than its rounding still shows in list() and attach(), as the deadline extend returned", async () => {
	const { provider, fake } = setup();
	const { ref, sb } = seeded(fake, { lifetimeMs: 600_000 });
	const asked = Date.now();
	const extended = await provider.extend(ref, 601_000);
	assert.equal(extended.ok, true, extended.ok ? "" : extended.error.message);
	assert.ok(extended.value.deadline.getTime() >= asked + 601_000, "at least what was asked");
	assert.equal(sb.init.deadline, extended.value.deadline.toISOString());
	assert.ok(sb.endAt.getTime() >= extended.value.deadline.getTime(), "E2B ends it no earlier than init");
	const listed = await provider.list({});
	assert.equal(listed.value[0].deadline.toISOString(), extended.value.deadline.toISOString(), "list() shows the extended deadline, not create's");
	const attached = await provider.attach({ id: ref.id });
	assert.equal(attached.ok, true, attached.ok ? "" : attached.error.message);
	assert.equal(attached.value.spec.deadline.toISOString(), extended.value.deadline.toISOString(), "attach() shows it too");
});

test("near the cap, an extend whose whole seconds cannot reach the current deadline is refused as limit and moves nothing", async () => {
	const { provider, fake } = setup();
	const { ref, sb } = seeded(fake, { lifetimeMs: 45_000 });
	// Already extended: 599.5 s left on E2B's end and init's deadline, the cap 599.8 s away, and 599.6 s asked for.
	// E2B takes whole seconds: 600 s passes the cap, and 599 s ends before the current deadline.
	const now = Date.now();
	const end = new Date(now + 599_500);
	const most = new Date(now + 599_800).toISOString();
	sb.endAt = end;
	sb.init.deadline = end.toISOString();
	sb.metadata[MAX_LABEL] = most;
	sb.init.max = most;
	const extended = await provider.extend(ref, 599_600);
	assert.deepEqual(
		fake.calls.filter(([name]) => name === "Sandbox.setTimeout").map(([, , ms]) => ms),
		[],
		"E2B's timer is never given an end before the current deadline",
	);
	assert.equal(sb.endAt.getTime(), end.getTime(), "E2B's end did not move");
	assert.equal(sb.init.deadline, end.toISOString(), "init's deadline did not move");
	assert.equal(extended.ok, false);
	assert.equal(extended.error.code, "limit");
	assert.match(extended.error.message, /no whole number of seconds/);
});

test("an extend whose init will not move says what moved", async () => {
	const { provider, fake } = setup();
	const { ref, sb } = seeded(fake);
	sb.init.max = "";
	const extended = await provider.extend(ref, 1_200_000);
	assert.equal(extended.ok, false);
	assert.match(extended.error.message, /E2B's timer moved to .*init's deadline did not/);
});

// --- release ---

test("release delete kills the sandbox and waits until E2B reads it gone and no longer lists it", async () => {
	const { provider, fake } = setup({}, { lingers: { reads: 2, lists: 2 } });
	const { ref } = seeded(fake);
	const released = await provider.release(ref, "delete");
	assert.equal(released.ok, true, released.ok ? "" : released.error.message);
	assert.deepEqual(fake.kills, [ref.id]);
	const reads = fake.calls.filter(([name]) => name === "Sandbox.getInfo").length;
	assert.ok(reads >= 3, `it read the sandbox back until gone (${reads} reads)`);
	const again = await provider.release(ref, "delete");
	assert.equal(again.ok, true, "a computer already gone is ok");
	assert.equal(fake.calls.filter(([name]) => name === "Sandbox.kill").length, 1);
});

test("release honours the caller's signal while it waits, and is bounded by goneMs, saying what it last read", async () => {
	const { provider, fake } = setup({}, { lingers: { reads: 10_000, lists: 10_000 } });
	const { ref } = seeded(fake);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 50);
	const started = Date.now();
	const aborted = await provider.release(ref, "delete", { signal: controller.signal });
	assert.equal(aborted.ok, false);
	assert.equal(aborted.error.code, "aborted");
	assert.ok(Date.now() - started < 400, "the abort ends the wait");
	assert.deepEqual(fake.kills, [ref.id], "the kill was sent all the same");
	const { provider: other, fake: otherFake } = setup({}, { lingers: { reads: 10_000, lists: 10_000 } });
	const seededOther = seeded(otherFake);
	const timedOut = await other.release(seededOther.ref, "delete");
	assert.equal(timedOut.ok, false);
	assert.equal(timedOut.error.code, "timeout");
	assert.match(timedOut.error.message, /running/);
});

test("release still reads and kills the computer when the caller's signal aborted before it or during the read: the signal ends only the wait", async () => {
	const before = setup();
	const one = seeded(before.fake);
	const already = await before.provider.release(one.ref, "delete", { signal: AbortSignal.abort() });
	assert.deepEqual(before.fake.kills, [one.ref.id], "a release after an abort still kills the computer");
	assert.equal(already.ok, false);
	assert.equal(already.error.code, "aborted");
	assert.match(already.error.message, /after its kill/);

	const controller = new AbortController();
	let first = true;
	const onStep = (step) => {
		if (step !== "Sandbox.getInfo" || !first) return;
		first = false;
		controller.abort();
	};
	const during = setup({}, { onStep });
	const two = seeded(during.fake);
	const aborted = await during.provider.release(two.ref, "delete", { signal: controller.signal });
	assert.deepEqual(during.fake.kills, [two.ref.id], "an abort during the ownership read still kills the computer");
	assert.equal(aborted.error.code, "aborted");

	const theirs = setup();
	const other = theirs.fake.add({ metadata: { other: "1" } });
	const left = await theirs.provider.release({ id: other.id, name: "computer-0123456789ab" }, "delete", { signal: AbortSignal.abort() });
	assert.equal(left.error.code, "not_found", "a sandbox not this provider's is left as it is, signal or not");
	assert.deepEqual(theirs.fake.kills, []);
});

test("release stop is refused in words, and a sandbox not this provider's is left as it is", async () => {
	const { provider, fake } = setup();
	const { ref } = seeded(fake);
	const stop = await provider.release(ref, "stop");
	assert.equal(stop.ok, false);
	assert.equal(stop.error.code, "unsupported");
	const other = fake.add({ metadata: { other: "1" } });
	const theirs = await provider.release({ id: other.id, name: "computer-0123456789ab" }, "delete");
	assert.equal(theirs.ok, false);
	assert.equal(theirs.error.code, "not_found");
	assert.deepEqual(fake.kills, []);
});

// --- stream ---

// publicStream is refused while the daemon's programs have a network of their own (the loopback block test below). The
// stream's code is kept for the inbound forward that lifts the refusal, and these tests with it, skipped until then.
const STREAM_REFUSED = "publicStream is refused while the daemon's programs have a network of their own (loop/PR-NOTES.md, known gaps)";

test("with publicStream the computers take public traffic and network open only, and stream() starts the VNC stream with a password", { skip: STREAM_REFUSED }, async () => {
	const { provider, fake } = setup({ publicStream: true });
	assert.deepEqual(provider.capabilities().network, ["open"]);
	assert.match(provider.check(SPEC)[0].message, /public stream/);
	const made = await provider.create({ ...SPEC, network: "open" });
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	assert.deepEqual(createOpts(fake).network, { allowPublicTraffic: true });
	const streamed = await provider.stream(made.value, {});
	assert.equal(streamed.ok, true, streamed.ok ? "" : streamed.error.message);
	const url = new URL(streamed.value.url);
	assert.equal(url.protocol, "https:");
	assert.equal(url.host, `6080-${made.value.id}.e2b.app`);
	assert.equal(url.pathname, "/vnc.html");
	assert.match(url.searchParams.get("password"), /^[A-Za-z0-9]{8}$/, "8 characters: VNC authentication reads no more");
	const sb = only(fake);
	const x11vnc = sb.processes.find((p) => p.argv[0] === "x11vnc");
	const listen = x11vnc.argv[x11vnc.argv.indexOf("-listen") + 1];
	assert.ok(["localhost", "127.0.0.1"].includes(listen) && x11vnc.argv.includes("-noipv6"), "the VNC server listens on loopback only, IPv4 alone; noVNC is its one way in");
	assert.ok(sb.processes.find((p) => p.argv[0] === "/opt/noVNC/utils/novnc_proxy").argv.includes(`${listen}:5900`));
	assert.ok(!x11vnc.argv.join(" ").includes(url.searchParams.get("password")), "the password is in a file, not on a command line");
	const view = await provider.stream(made.value, { viewOnly: true });
	assert.ok(sb.processes.filter((p) => p.argv[0] === "x11vnc").at(-1).argv.includes("-viewonly"));
	assert.notEqual(new URL(view.value.url).searchParams.get("password"), url.searchParams.get("password"), "each stream() makes a new password");
});

/** A process seeded straight into the fake's daemon, as an earlier call would have started it. */
function started(sb, argv, fields = {}) {
	const entry = { id: `p${sb.processes.length + 1}`, pid: 100 + sb.processes.length, argv, running: true, exitCode: null, signal: null, stderr: "", ...fields };
	sb.processes.push(entry);
	return entry;
}
const OLD_VNC = ["x11vnc", "-display", ":0", "-forever", "-rfbport", "5900"];
const OLD_NOVNC = ["/opt/noVNC/utils/novnc_proxy", "--vnc", "localhost:5900", "--listen", "6080"];
const newest = (sb, program) => sb.processes.filter((p) => p.argv[0] === program).at(-1);

test("stream() stops the old stream servers wherever they are in the process list, past its first page", { skip: STREAM_REFUSED }, async () => {
	const { provider, fake } = setup({ publicStream: true }, { processPage: 4 });
	const { ref, sb } = seeded(fake, { network: "open", extra: { network: { allowPublicTraffic: true } } });
	for (let i = 0; i < 9; i++) started(sb, ["sleep", "600"]);
	const oldVnc = started(sb, OLD_VNC, { port: 5900 });
	const oldNovnc = started(sb, OLD_NOVNC, { port: 6080 });
	const streamed = await provider.stream(ref, {});
	assert.equal(streamed.ok, true, streamed.ok ? "" : streamed.error.message);
	assert.equal(oldVnc.running, false, "the old x11vnc, on the third page, was stopped");
	assert.equal(oldNovnc.running, false, "the old noVNC, on the third page, was stopped");
	assert.ok(newest(sb, "x11vnc").running, "the new x11vnc runs");
	assert.ok(newest(sb, "/opt/noVNC/utils/novnc_proxy").running, "the new noVNC runs");
	assert.ok(fake.requests.filter((r) => r.method === "process.list").length >= 3, "every page was read");
});

test("stream() waits for the old servers to end before it starts the new ones, and returns a URL only when both new ones run and listen", { skip: STREAM_REFUSED }, async () => {
	const { provider, fake } = setup({ publicStream: true }, { killMs: 60 });
	const { ref, sb } = seeded(fake, { network: "open", extra: { network: { allowPublicTraffic: true } } });
	const oldVnc = started(sb, OLD_VNC, { port: 5900 });
	const oldNovnc = started(sb, OLD_NOVNC, { port: 6080 });
	const streamed = await provider.stream(ref, {});
	assert.equal(streamed.ok, true, streamed.ok ? "" : streamed.error.message);
	assert.equal(oldVnc.running, false);
	assert.equal(oldNovnc.running, false);
	const vnc = newest(sb, "x11vnc");
	const novnc = newest(sb, "/opt/noVNC/utils/novnc_proxy");
	assert.notEqual(vnc, oldVnc);
	assert.notEqual(novnc, oldNovnc);
	assert.ok(vnc.running, `the new x11vnc runs: ${vnc.stderr}`);
	assert.ok(novnc.running, `the new noVNC runs: ${novnc.stderr}`);
	const ended = fake.requests.findIndex((r) => r.method === "process.wait" && r.params.id === oldNovnc.id);
	const begun = fake.requests.findIndex((r) => r.method === "process.start" && r.params.argv[0] === "x11vnc");
	assert.ok(ended >= 0 && ended < begun, "the wait for the old servers' end comes before the new ones start");
});

test("stream() refuses in words when a new server cannot listen: another process holding noVNC's port is not its stream", { skip: STREAM_REFUSED }, async () => {
	const { provider, fake } = setup({ publicStream: true });
	const { ref, sb } = seeded(fake, { network: "open", extra: { network: { allowPublicTraffic: true } } });
	started(sb, ["python3", "-m", "http.server", "6080"], { port: 6080 });
	const streamed = await provider.stream(ref, {});
	assert.equal(streamed.ok, false, "the listener on 6080 is not the new noVNC, so no URL");
	assert.match(streamed.error.message, /novnc_proxy ended .*address already in use/);
	assert.equal(newest(sb, "/opt/noVNC/utils/novnc_proxy").running, false);
});

test("the stream URL and its password are never logged and never in an error", { skip: STREAM_REFUSED }, async () => {
	const { provider, fake } = setup({ publicStream: true });
	const { value: result, text } = await captured(async () => {
		const made = await provider.create({ ...SPEC, network: "open" });
		const streamed = await provider.stream(made.value, {});
		const sb = only(fake);
		const failures = [];
		// Fail each later step in turn: no error carries the URL or the password.
		sb.processes.length = 0;
		failures.push(await provider.stream({ ...made.value, name: "computer-ffffffffffff" }, {}));
		failures.push(await provider.release(made.value, "delete"));
		failures.push(await provider.stream(made.value, {}));
		return { streamed, failures };
	});
	const url = result.streamed.value.url;
	const password = new URL(url).searchParams.get("password");
	assert.ok(!text.includes(password) && !text.includes(url), "nothing logged the URL or its password");
	for (const failure of result.failures) assert.ok(!JSON.stringify(failure).includes(password), JSON.stringify(failure));
	assert.ok(!JSON.stringify(fake.calls).includes(password), "the password went to the computer as a file only");
	const source = readFileSync(new URL("../dist/e2b.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\bconsole\.|process\.(stdout|stderr)/, "the provider writes nowhere but its results");
});

// --- the registry and the conformance module ---

test("the registry builds E2B from its options alone, and the conformance module needs its live switch first", async () => {
	const fake = fakeE2B();
	await withProcessEnv({ E2B_API_KEY: BARE, COMPUTER_E2B_API_KEY: BARE }, async () => {
		await assert.rejects(providerFor("e2b", { Sandbox: fake.Sandbox }), (error) => {
			assert.match(error.message, /options\.apiKey/);
			assert.doesNotMatch(error.message, new RegExp(BARE));
			return true;
		});
	});
	const fromRegistry = await providerFor("e2b", { apiKey: KEY, daemonPath: DAEMON_PATH, Sandbox: fake.Sandbox });
	assert.equal(fromRegistry.id, "e2b");
	const conformance = await e2b.conformance();
	await assert.rejects(conformance.createProvider({ env: { [ENV.key]: KEY }, Sandbox: fake.Sandbox }), /set AGENTRUN_COMPUTER_LIVE_E2B=1/);
	await assert.rejects(conformance.createDriftedProvider({ env: { [ENV.key]: KEY }, Sandbox: fake.Sandbox }), /set AGENTRUN_COMPUTER_LIVE_E2B=1/);
	const provider = await conformance.createProvider({ env: { [ENV.key]: KEY, AGENTRUN_COMPUTER_LIVE_E2B: "1", [ENV.daemon]: DAEMON_PATH }, Sandbox: fake.Sandbox });
	assert.equal(provider.capabilities().maxLifetimeMs, 30 * 60_000, "a conformance computer lives at most 30 minutes");
	assert.equal(conformance.conformanceImage({ env: {} }), "desktop");
	assert.equal(conformance.conformanceImage({ env: { COMPUTER_E2B_TEMPLATE: "my-desktop" } }), "my-desktop");
	assert.ok(conformance.conformanceNotes.some((note) => /Hobby/.test(note)));
	assert.deepEqual(fake.calls, []);
});

test("the conformance module's drifted twin uploads a daemon of another version", async () => {
	const conformance = await e2b.conformance();
	const fake = fakeE2B();
	const built = [];
	const drifted = await conformance.createDriftedProvider({
		env: { [ENV.key]: KEY, AGENTRUN_COMPUTER_LIVE_E2B: "1" },
		Sandbox: fake.Sandbox,
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
	const { provider, fake } = setup();
	assert.deepEqual(provider.capabilities().network, ["none"]);
	assert.deepEqual(provider.capabilities().vendorAgentPorts, [49983]);
	const refusals = provider.check({ ...SPEC, network: "open" });
	assert.deepEqual(refusals.map((r) => r.field), ["network"]);
	assert.match(refusals[0].message, /network "none" only: its programs run in a network of their own/);
	assert.deepEqual(fake.calls, []);
});

test("the loopback block: publicStream is refused in words, from the options and from a conformance run's environment", async () => {
	assert.throws(() => setup({ publicStream: true }), /publicStream is refused: .*network of their own/);
	const settings = settingsFromEnv({ [ENV.key]: KEY, [ENV.daemon]: DAEMON_PATH, [ENV.publicStream]: "1" });
	await assert.rejects(async () => create({ ...settings, Sandbox: fakeE2B().Sandbox }), /publicStream is refused/);
});

test("the loopback block: init starts with --own-network as 2510:2510 by default", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	const sb = only(fake);
	assert.equal(sb.init.user, "2510:2510");
	assert.match(sb.init.command, / init --deadline "\$t" --user "\$w" --own-network /);
});

test("the loopback block: a daemon whose network holds more than its loopback is refused and deleted", async () => {
	const { provider, fake } = setup({}, { box: { interfaces: ["lo", "eth0"] } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, /daemon network: declared its own \(lo alone\), read back lo, eth0/);
	assert.ok([...fake.sandboxes.values()].every((sb) => sb.killed), "the sandbox was killed");
});

