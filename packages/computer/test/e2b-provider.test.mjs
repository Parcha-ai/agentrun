// E2BProvider without a vendor fake: what E2B's own host decides (its capabilities, its check, the key and the domain
// on every SDK call, the environment it reads and refuses, the conformance module's names), each read from options or
// from what the SDK slice is handed. The adapter's lifecycle is tested once, against its one fake host
// (hosted-provider.test.mjs); E2B's own lifecycle is proven live (test/e2b). The Sandbox class here only records what
// it is given and throws: no sandbox exists, no SDK is loaded unless a test says so, and nothing reaches the network.
// The one exception is exec: the real SDK's envd client talks to a stand-in envd on 127.0.0.1 (fake-envd.mjs) that runs
// each command on this machine, so the exec pre-check shows E2B's exec passes every byte through.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachHub, checkLifetime, kindRefusals, MACHINE_TOKEN_SOURCE, MemoryMachineTokens } from "../dist/index.js";
import * as registry from "../dist/providers.js";
import { fakeObjects } from "./fake-archil.mjs";
import { bootDial, desktopOverDial, dialServer } from "./fake-dial-host.mjs";
import { fakeEnvd } from "./fake-envd.mjs";

const e2b = await import("../dist/e2b.js");
const { E2BProvider, create } = e2b;
const { providerFor } = registry;
/** The conformance module's names: the only place E2B settings are read from an environment. */
const { E2B_ENV: ENV, settingsFromEnv, createHost, dialKit } = await import("../dist/conformance/e2b.js");
const { checkExecStream, formatExecStream } = await import("../dist/conformance/exec-stream.js");

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const KEY = "e2b_fake_computer_key_0123456789";
const COMPUTER = "agentrun.computer";
const SPEC = { image: "desktop", lifetimeMs: 600_000, network: "none" };
const HOUR = 3_600_000;
const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys", "apps"];
const LINUX_GROUPS = ["exec", "files", "processes"];
const BARE = "e2b_bare_key_must_never_be_used";
/** The public box template release.yml's box job publishes: its E2B team's slug, then agentrun-archil-<box/recipe.mjs's hash>. */
const BOX_TEMPLATE = `agentrun-oss/agentrun-archil-${createHash("sha256")
	.update(Buffer.concat(["Dockerfile", "install.sh", "agentrun-archil"].map((name) => readFileSync(new URL(`../box/${name}`, import.meta.url)))))
	.digest("hex")
	.slice(0, 12)}`;
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

test("an E2B desktop is kind desktop with daemon child, the desktop groups, network none, open and a list probed from inside, envd's port, and Hobby's 1 h cap", () => {
	const { provider } = setup();
	const caps = provider.capabilities();
	assert.deepEqual(
		{ kind: caps.kind, os: caps.os, daemon: caps.daemon, lifetime: caps.lifetime, isolation: caps.isolation, network: caps.network, networkReadBack: caps.networkReadBack, release: caps.release, vendorAgentPorts: caps.vendorAgentPorts },
		{ kind: "desktop", os: "linux", daemon: "child", lifetime: "vendor", isolation: "microvm", network: ["none", "open", "allow"], networkReadBack: false, release: ["delete"], vendorAgentPorts: [49983] },
	);
	assert.deepEqual(caps.groups, DESKTOP_GROUPS);
	assert.equal(caps.maxLifetimeMs, HOUR, "E2B Hobby caps a sandbox at 1 h");
	assert.deepEqual(kindRefusals(caps), []);
	assert.equal(provider.id, "e2b");
	assert.equal(provider.version, VERSION);
	assert.equal(provider.stream, undefined, "no stream(): a screen is streamed through agentrun, never a vendor URL");
	assert.equal(typeof provider.extend, "function");
});

test("every E2B computer has its system paths made root's alone at create, before the daemon's upload (the adapter's root-only step)", () => {
	for (const kind of ["desktop", "linux"]) {
		const { provider } = setup({ kind });
		assert.deepEqual(provider.host.facts.rootOnly, ["/usr/local", "/usr/bin/envd", "/etc/inittab"], kind);
	}
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
	assert.throws(() => setup({ maxLifetimeMs: 24 * HOUR + 1 }), /at most 86400000 ms, the longest E2B keeps a computer/);
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

test("check() takes a template as the image, network none, open or a list, and labels; it refuses a malformed list, sizes, a user and a workdir in words", () => {
	const { provider } = setup();
	assert.deepEqual(provider.check({ ...SPEC, labels: { run: "r1" } }), []);
	const fields = (spec) => provider.check(spec).map((r) => r.field);
	assert.deepEqual(fields({ ...SPEC, image: "" }), ["image"]);
	assert.deepEqual(fields({ ...SPEC, network: "open" }), []);
	assert.deepEqual(fields({ ...SPEC, network: { allow: ["example.com"] } }), []);
	assert.deepEqual(fields({ ...SPEC, network: { allow: ["192.168.0.0/16"] } }), ["network"], "a list the proxy would refuse is refused at check");
	assert.deepEqual(fields({ ...SPEC, network: "wifi" }), ["network"]);
	assert.deepEqual(fields({ ...SPEC, cpus: 2 }), ["cpus"]);
	assert.deepEqual(fields({ ...SPEC, memoryMb: 1024 }), ["memoryMb"]);
	assert.match(provider.check({ ...SPEC, cpus: 2 })[0].message, /an E2B computer has the size of its template: name a template of the size you need, not cpus/, "E2B's own check: the adapter passes sizes on");
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
		await assert.rejects(create({ apiKey: KEY, domain, Sandbox: rec.Sandbox }), /E2B domain \(AGENTRUN_E2B_DOMAIN\) must be a host name/);
		await assert.rejects(conformance.createProvider({ env: { [ENV.live]: "1", [ENV.key]: KEY, [ENV.domain]: domain }, Sandbox: rec.Sandbox }), /E2B domain \(AGENTRUN_E2B_DOMAIN\) must be a host name/);
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
	assert.equal(opts.metadata[`${COMPUTER}.network`], undefined, "none carries no network label");
});

test("create() under open or a list asks E2B for internet access, for init's egress proxy, still no public traffic, and records the form in a label", async () => {
	for (const [network, form] of [
		["open", "open"],
		[{ allow: ["Example.com"] }, "allow:example.com"],
	]) {
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
		await provider.create({ ...SPEC, network }, { requestId: `r-net-${form}` });
		const [, opts] = calls[0];
		assert.equal(opts.allowInternetAccess, true, form);
		assert.deepEqual(opts.network, { allowPublicTraffic: false });
		assert.equal(opts.metadata[`${COMPUTER}.network`], form);
	}
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

test("every SDK call is given httpVersion 1.1, create, getInfo, connect, list, setTimeout and kill alike: the SDK never opens HTTP/2", async () => {
	const calls = [];
	const startedAt = new Date();
	const info = (id) => ({ sandboxId: id, templateId: "base", metadata: { "agentrun.computer.max-deadline": new Date(startedAt.getTime() + HOUR).toISOString() }, startedAt, endAt: new Date(startedAt.getTime() + 600_000), state: "running" });
	const sandbox = (id) => ({ sandboxId: id, files: { write: async () => {} } });
	const record = (name, answer) => async (...args) => (calls.push([name, ...args]), answer(...args));
	const Sandbox = {
		create: record("Sandbox.create", () => sandbox("sbx-made")),
		connect: record("Sandbox.connect", (id) => sandbox(id)),
		getInfo: record("Sandbox.getInfo", (id) => info(id)),
		setTimeout: record("Sandbox.setTimeout", () => {}),
		kill: record("Sandbox.kill", () => true),
		list(opts) {
			calls.push(["Sandbox.list", opts]);
			let done = false;
			return { get hasNext() { return !done; }, nextItems: async () => ((done = true), []) };
		},
	};
	const { host } = new E2BProvider({ apiKey: KEY, Sandbox, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const ctx = { timeoutMs: 2_000 };
	await host.create({ image: "desktop", lifetimeMs: 600_000, labels: {}, egress: false }, ctx);
	await host.get("sbx-other", ctx);
	await host.list({ [COMPUTER]: "1" }, ctx);
	await host.upload("sbx-other", "/tmp/x", new Uint8Array([1]), ctx);
	await host.extend("sbx-other", new Date(startedAt.getTime() + 1_200_000), ctx);
	await host.delete("sbx-made", ctx);
	assert.deepEqual([...new Set(calls.map(([name]) => name))].sort(), ["Sandbox.connect", "Sandbox.create", "Sandbox.getInfo", "Sandbox.kill", "Sandbox.list", "Sandbox.setTimeout"]);
	for (const [name, ...args] of calls) assert.equal(args.at(-1).httpVersion, "1.1", `${name} is given httpVersion "1.1"`);
});

test("the real SDK, given the provider's connection options, speaks HTTP/1.1 to a server that offers HTTP/2", async (t) => {
	const sdk = await import("e2b").catch(() => undefined);
	if (sdk === undefined) return t.skip("the e2b package is not installed here; it is the host's, as Modal's SDK is");
	const tls = mkdtempSync(join(tmpdir(), "computer-e2b-tls-"));
	t.after(() => rmSync(tls, { recursive: true, force: true }));
	const [key, cert] = [join(tls, "key.pem"), join(tls, "cert.pem")];
	const openssl = ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", cert];
	if (spawnSync("openssl", openssl, { stdio: "ignore" }).status !== 0) return t.skip("openssl made no self-signed certificate here");
	// A server that takes both and prefers HTTP/2, as E2B's does: an h2 client gets h2 by ALPN.
	const seen = [];
	const sockets = new Set();
	const server = createSecureServer({ key: readFileSync(key), cert: readFileSync(cert), allowHTTP1: true }, (req, res) => {
		// Only the SDK's call: something else on this machine may probe a new loopback listener.
		if (req.url.startsWith("/sandboxes/sbx-h1")) seen.push(req.httpVersion);
		res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ code: 404, message: "no such sandbox" }));
	});
	server.on("secureConnection", (socket) => sockets.add(socket));
	await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
	t.after(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
	});
	const options = { ...e2b.connectionOptions({ apiKey: KEY, domain: "e2b.app" }, {}), apiUrl: `https://127.0.0.1:${server.address().port}` };
	// The certificate is this test's own, so the call checks none: the TLS check is read at each connect, this one alone.
	await withProcessEnv({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, () => assert.rejects(sdk.Sandbox.getInfo("sbx-h1", options)));
	assert.deepEqual(seen, ["1.1"]);
});

test("get reads what E2B gave the sandbox (getInfo's cpuCount and memoryMB) as its resources, and none where getInfo says none", async () => {
	const info = (fields) => ({ sandboxId: "sbx-1", templateId: "base", metadata: {}, startedAt: new Date(), endAt: new Date(Date.now() + HOUR), state: "running", ...fields });
	const hostWith = (fields) => createHost({ env: { [ENV.key]: KEY }, Sandbox: { ...recorder().Sandbox, getInfo: async () => info(fields) } });
	assert.deepEqual((await (await hostWith({ cpuCount: 2, memoryMB: 512 })).get("sbx-1", { timeoutMs: 1_000 })).resources, { cpus: 2, memoryMb: 512 });
	assert.equal(Object.hasOwn(await (await hostWith({})).get("sbx-1", { timeoutMs: 1_000 }), "resources"), false);
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
	// Root's command: /bin/sh by its path, no login shell, the argv as its own words, PATH the system's directories alone.
	const starts = envd.requests.filter((request) => request.method === "Start");
	for (const { body } of starts) {
		assert.equal(body.process.cmd, "/bin/sh");
		assert.deepEqual(body.process.args.slice(0, 3), ["-c", 'exec "$@"', "sh"]);
		assert.ok(!body.process.args.includes("-l") && !body.process.args.includes("--login"), "no login shell");
		assert.deepEqual(body.process.envs, { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" });
	}
	assert.deepEqual(start.body.process.args.slice(3, 5), ["sh", "-c"], "the argv as given, word for word");
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
	assert.equal(host.descriptor.id, "e2b");
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

test("the loopback block: envd's port declared, open and a list taken through init's egress proxy alone (it refuses envd's port)", () => {
	const { provider, rec } = setup();
	assert.deepEqual(provider.capabilities().network, ["none", "open", "allow"]);
	assert.deepEqual(provider.capabilities().vendorAgentPorts, [49983]);
	assert.deepEqual(provider.check({ ...SPEC, network: "open" }), []);
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

// --- the box template: every E2B computer a server makes starts from it ---

/** A Sandbox slice whose create records the template and options it is given, then refuses as E2B does a missing one. */
function createRecorder() {
	const calls = [];
	const Sandbox = {
		...recorder().Sandbox,
		list: () => ({ hasNext: true, nextItems: async () => ((Sandbox.listed = true), []), get hasNext() { return !Sandbox.listed; } }),
		create: async (template, opts) => {
			calls.push([template, opts]);
			throw Object.assign(new Error("400: template not found"), { name: "InvalidArgumentError" });
		},
	};
	return { calls, Sandbox };
}

test("E2B's descriptor says it prepares its image and names no default image: every E2B sandbox and desktop starts from the box template", async () => {
	const { E2B } = await import("../dist/descriptors/index.js");
	assert.equal(E2B.prepareImage, true);
	assert.equal(E2B.defaultImage, undefined, "every E2B computer starts from the template prepareImage answers");
	for (const name of ["E2B_BASE_TEMPLATE", "E2B_DESKTOP_TEMPLATE"]) {
		assert.equal(name in (await import("../dist/descriptors/index.js")), false, name);
		assert.equal(name in (await import("../dist/index.js")), false, name);
	}
	const { BOX_E2B_PUBLISHER, boxE2bTemplate } = await import("../dist/box-image.js");
	assert.equal(BOX_E2B_PUBLISHER, "agentrun-oss","the E2B team release.yml's box job publishes from");
	assert.equal(boxE2bTemplate(), BOX_TEMPLATE);
});

test("prepareImage answers the public box template with no SDK call and no wait told, the same for a desktop and a sandbox, and create starts from it", async () => {
	for (const kind of ["desktop", "linux"]) {
		const { provider, rec } = setup({ kind });
		const waits = [];
		assert.deepEqual(await provider.prepareImage({ onWait: (...said) => waits.push(said) }), { ok: true, value: BOX_TEMPLATE }, kind);
		assert.deepEqual(await provider.prepareImage(), { ok: true, value: BOX_TEMPLATE }, `${kind}, no context: the same template`);
		assert.deepEqual(rec.calls, [], "no E2B call: a public template has nothing to pull ahead of create");
		assert.deepEqual(waits, [], "never told a pull: the claim waits on create alone");
		assert.deepEqual(provider.check({ ...SPEC, image: BOX_TEMPLATE }), [], "check takes the team/template name");
		const { calls, Sandbox } = createRecorder();
		const made = await new E2BProvider({ apiKey: KEY, Sandbox, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, kind }).create({ ...SPEC, image: BOX_TEMPLATE }, { requestId: `r-box-${kind}` });
		assert.equal(made.ok, false);
		assert.deepEqual(calls.map(([template]) => template), [BOX_TEMPLATE], `${kind}: Sandbox.create is given the box template`);
	}
});

// --- the operator's settings: the clouds that speak E2B's API, and a template of their own ---

const { E2B: E2B_DESCRIPTOR } = await import("../dist/descriptors/e2b.js");
const PROXY = "http://proxy.example:3128/";

/** E2B's create() options from a server's keys, by its descriptor's names, as serve maps them (computer-keys.ts
 *  providerOptions): a name the descriptor doesn't declare is never passed on. */
const optionsOfKeys = (keys) => Object.fromEntries(E2B_DESCRIPTOR.keys.flatMap(({ name, option }) => (typeof keys[name] === "string" && keys[name] !== "" ? [[option, keys[name]]] : [])));

/** createRecorder, its listing recorded too, as ["Sandbox.list", opts]. */
function callRecorder() {
	const { calls, Sandbox } = createRecorder();
	const list = Sandbox.list;
	Sandbox.list = (opts) => (calls.push(["Sandbox.list", opts]), list(opts));
	return { calls, Sandbox };
}

/** `make()` with Node's https global agent holding `proxyEnv`, as a process that installed a proxy has it (env-proxy.ts
 *  installedProxy reads it there when the provider is made). */
function withInstalledProxy(proxyEnv, make) {
	const before = https.globalAgent;
	https.globalAgent = new https.Agent({ proxyEnv });
	try {
		return make();
	} finally {
		https.globalAgent = before;
	}
}

/** A provider from the server's keys, its create and its listing recorded, under the process's proxy `proxyEnv`. */
async function fromKeys(keys, proxyEnv = {}, kind) {
	const { calls, Sandbox } = callRecorder();
	const provider = withInstalledProxy(proxyEnv, () => new E2BProvider({ ...optionsOfKeys(keys), Sandbox, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...(kind ? { kind } : {}) }));
	return { calls, provider };
}

/** Each SDK call's connection options, by the call: the create's template, or "Sandbox.list". */
const connectionsOf = (calls) => calls.map(([call, opts]) => [call, { domain: opts.domain, apiUrl: opts.apiUrl, proxy: opts.proxy }]);

test("E2B's keys: E2B_API_KEY, required, then AGENTRUN_E2B_DOMAIN, AGENTRUN_E2B_API_URL and AGENTRUN_E2B_TEMPLATE, optional; the template is its imageEnv too", () => {
	assert.deepEqual(E2B_DESCRIPTOR.keys, [
		{ name: "E2B_API_KEY", option: "apiKey", required: true },
		{ name: "AGENTRUN_E2B_DOMAIN", option: "domain", required: false },
		{ name: "AGENTRUN_E2B_API_URL", option: "apiUrl", required: false },
		{ name: "AGENTRUN_E2B_TEMPLATE", option: "template", required: false },
	]);
	assert.equal(E2B_DESCRIPTOR.imageEnv, "AGENTRUN_E2B_TEMPLATE", "serve reads it as the image every E2B computer starts from, as Daytona's AGENTRUN_DAYTONA_SNAPSHOT");
});

test("none of the three set: E2B's domain, its API and the box template, as before", async () => {
	const { calls, provider } = await fromKeys({ E2B_API_KEY: KEY }, { HTTPS_PROXY: PROXY, NO_PROXY: ".e2b.app" });
	const ready = await provider.prepareImage();
	assert.deepEqual(ready, { ok: true, value: BOX_TEMPLATE });
	assert.equal((await provider.create({ ...SPEC, image: ready.value }, { requestId: "r-settings-none" })).ok, false);
	assert.deepEqual(connectionsOf(calls), [
		["Sandbox.list", { domain: "e2b.app", apiUrl: "https://api.e2b.app", proxy: undefined }],
		[BOX_TEMPLATE, { domain: "e2b.app", apiUrl: "https://api.e2b.app", proxy: undefined }],
	]);
});

test("AGENTRUN_E2B_DOMAIN: create and list go to that domain's API, and the proxy is decided by that domain", async () => {
	const keys = { E2B_API_KEY: KEY, AGENTRUN_E2B_DOMAIN: "sb.mtm.sh" };
	const at = { domain: "sb.mtm.sh", apiUrl: "https://api.sb.mtm.sh" };
	// NO_PROXY exempting E2B's own domain leaves this one's calls on the proxy; exempting this one, none of them.
	for (const [noProxy, proxy] of [[".e2b.app", PROXY], [".sb.mtm.sh", undefined]]) {
		const { calls, provider } = await fromKeys(keys, { HTTPS_PROXY: PROXY, NO_PROXY: noProxy });
		assert.equal((await provider.create({ ...SPEC, image: BOX_TEMPLATE }, { requestId: "r-settings-domain" })).ok, false);
		assert.deepEqual(connectionsOf(calls), [["Sandbox.list", { ...at, proxy }], [BOX_TEMPLATE, { ...at, proxy }]], noProxy);
	}
	const { calls, provider } = await fromKeys(keys);
	assert.deepEqual(await provider.list({}), { ok: true, value: [] }, "the listing goes there too, and finds none");
	assert.deepEqual(connectionsOf(calls), [["Sandbox.list", { ...at, proxy: undefined }]]);
	await assert.rejects(create({ apiKey: KEY, domain: "https://sb.mtm.sh", Sandbox: recorder().Sandbox }), /the E2B domain \(AGENTRUN_E2B_DOMAIN\) must be a host name such as e2b\.app/);
});

test("AGENTRUN_E2B_API_URL: create and list go to that API, beside the domain, and the proxy covers its host too", async () => {
	// SUFY names its API alone; Alibaba Cloud names a regional domain and an API URL (fixtures: nothing is called).
	const sufy = { E2B_API_KEY: KEY, AGENTRUN_E2B_API_URL: "https://us-south-1-sandbox.sufyapi.com" };
	const { calls, provider } = await fromKeys(sufy);
	assert.equal((await provider.create({ ...SPEC, image: BOX_TEMPLATE }, { requestId: "r-settings-api" })).ok, false);
	const at = { domain: "e2b.app", apiUrl: "https://us-south-1-sandbox.sufyapi.com", proxy: undefined };
	assert.deepEqual(connectionsOf(calls), [["Sandbox.list", at], [BOX_TEMPLATE, at]]);
	const alibaba = { E2B_API_KEY: KEY, AGENTRUN_E2B_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com", AGENTRUN_E2B_API_URL: "https://api.cn-hangzhou.example.test/e2b/" };
	for (const [noProxy, proxy] of [[".aliyuncs.com", PROXY], [".aliyuncs.com,api.cn-hangzhou.example.test", undefined]]) {
		const made = await fromKeys(alibaba, { HTTPS_PROXY: PROXY, NO_PROXY: noProxy });
		await made.provider.list({});
		assert.deepEqual(connectionsOf(made.calls), [["Sandbox.list", { domain: "cn-hangzhou.sandbox.aliyuncs.com", apiUrl: "https://api.cn-hangzhou.example.test/e2b", proxy }]], noProxy);
	}
});

test("AGENTRUN_E2B_API_URL that is not https, or carries a login, a query or a fragment, is refused naming the setting, never echoing a login, and nothing is called", async () => {
	for (const bad of ["http://api.sb.mtm.sh", "https://user:hunter2-not-a-secret@api.sb.mtm.sh", "https://api.sb.mtm.sh/?team=hunter2-not-a-secret", "https://api.sb.mtm.sh/#hunter2-not-a-secret", "api.sb.mtm.sh", "wss://api.sb.mtm.sh"]) {
		const { calls, Sandbox } = callRecorder();
		await assert.rejects(create({ ...optionsOfKeys({ E2B_API_KEY: KEY, AGENTRUN_E2B_API_URL: bad }), Sandbox, daemonPath: DAEMON_PATH }), (error) => /^the E2B API URL \(AGENTRUN_E2B_API_URL\) /.test(error.message) && !error.message.includes("hunter2") && !error.message.includes(KEY), bad);
		assert.deepEqual(calls, [], bad);
	}
});

test("AGENTRUN_E2B_TEMPLATE: prepareImage answers it in place of the box template, for a desktop and a sandbox, and create starts it; a name that is no E2B template is refused naming the setting", async () => {
	for (const kind of ["desktop", "linux"]) {
		const { calls, provider } = await fromKeys({ E2B_API_KEY: KEY, AGENTRUN_E2B_TEMPLATE: "agentrun-oss/osworld-ubuntu" }, {}, kind);
		const ready = await provider.prepareImage();
		assert.deepEqual(ready, { ok: true, value: "agentrun-oss/osworld-ubuntu" }, kind);
		assert.equal((await provider.create({ ...SPEC, image: ready.value }, { requestId: `r-settings-template-${kind}` })).ok, false);
		assert.deepEqual(calls.filter(([call]) => call !== "Sandbox.list").map(([template]) => template), ["agentrun-oss/osworld-ubuntu"], kind);
	}
	for (const bad of ["../x", "two words", "-flag"]) {
		await assert.rejects(create({ apiKey: KEY, template: bad, Sandbox: recorder().Sandbox }), /the E2B template \(AGENTRUN_E2B_TEMPLATE\) is the name or id of an E2B template/, bad);
	}
});

test("E2B's metadata on an Archil computer of the longest agent id, on the box template: what create gives E2B, counted", async () => {
	const RUN = "01a1d0b9-3e8b-7352-9497-a407e2909f53";
	const { calls, Sandbox } = createRecorder();
	const provider = new E2BProvider({ apiKey: KEY, Sandbox, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, kind: "linux" });
	const spec = { ...SPEC, image: BOX_TEMPLATE, labels: { "agentrun.run": RUN, "agentrun.epoch": "1" }, mount: { ...MOUNT, folder: `agents/${"a".repeat(128)}/runs/${RUN}/work` } };
	assert.deepEqual(provider.check(spec), []);
	await provider.create(spec, { requestId: "r-box-labels" });
	assert.equal(calls.length, 1);
	const { metadata } = calls[0][1];
	noToken(metadata, "E2B's metadata");
	const pairs = Object.entries(metadata);
	const bytes = pairs.reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);
	// 9 pairs, 559 bytes of keys and values. E2B documents no cap on a sandbox's metadata, and has no 512-byte one like
	// Modal's tags: live (11-15) it took and read back 257 pairs, and one value of 64 KiB (65,570 bytes in all), each whole.
	assert.ok(pairs.length <= 257, `${pairs.length} pairs`);
	assert.ok(bytes <= 65_570, `${bytes} bytes of keys and values: ${JSON.stringify(metadata)}`);
	assert.equal(metadata["agentrun.computer.image"], BOX_TEMPLATE);
});

/** The public address a dial provider is given in tests: http on 127.0.0.1, which it takes in tests alone. */
const DIAL_URL = "http://127.0.0.1:8080";
const BOOT_NAMES = ["AGENTRUN_ATTACH_TOKEN", "AGENTRUN_ATTACH_URL", "AGENTRUN_DAEMON_SHA256", "AGENTRUN_DAEMON_URL", "AGENTRUN_INIT_ARGS"];

/**
 * E2B's SDK slice for a dial create: Sandbox.create answers a sandbox whose envd process stream (commands.rpc.start)
 * records each start, answers its start event, and then holds until the client lets go of it; getInfo and list read the
 * sandbox back running with create's metadata; files.write and Sandbox.connect fail the test. Nothing reaches a network.
 */
function dialSandbox() {
	const calls = [];
	let made;
	let startedAt;
	let killed = false;
	const info = () => {
		if (killed) throw Object.assign(new Error("sandbox not found"), { name: "SandboxNotFoundError" });
		return { sandboxId: "sbx-dial", templateId: "box", metadata: made.metadata, startedAt, endAt: new Date(startedAt.getTime() + made.timeoutMs), state: "running" };
	};
	const sandbox = {
		sandboxId: "sbx-dial",
		files: { write: async () => assert.fail("a dial create uploads nothing") },
		commands: {
			rpc: {
				start(request, options) {
					const started = { request, options };
					calls.push(["rpc.start", started]);
					return (async function* () {
						yield { event: { event: { case: "start", value: { pid: 7 } } } };
						await new Promise((done) => options.signal.addEventListener("abort", done, { once: true }));
					})();
				},
			},
		},
	};
	const Sandbox = {
		create: async (template, opts) => {
			calls.push(["Sandbox.create", template, opts]);
			made = opts;
			startedAt = new Date();
			return sandbox;
		},
		connect: async () => assert.fail("a dial create connects to no sandbox's envd"),
		getInfo: async () => info(),
		setTimeout: async () => {},
		kill: async (id) => {
			calls.push(["Sandbox.kill", id]);
			killed = true;
		},
		list: () => {
			let done = false;
			return { get hasNext() { return !done; }, nextItems: async () => ((done = true), made && !killed ? [info()] : []) };
		},
	};
	return { calls, Sandbox };
}

const dialOf = () => ({ url: DIAL_URL, tokens: new MemoryMachineTokens(), hub: new AttachHub({ helloMs: 1_000 }) });

test("connect dial: create starts agentrun-dial once as root with the boot env, after the root-only and socket steps; the sandbox's envs hold none of it, and nothing is uploaded or bridged", async () => {
	const { calls, Sandbox } = dialSandbox();
	const dial = dialOf();
	const provider = new E2BProvider({ apiKey: KEY, Sandbox, kind: "linux", connect: "dial", dial, daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, createMs: 300 } });
	assert.equal(provider.host.facts.connect, "dial");
	assert.equal(provider.host.exec, undefined, "no exec");
	assert.equal(provider.host.upload, undefined, "no upload");
	const made = await provider.create({ ...SPEC, image: BOX_TEMPLATE }, { requestId: "r-dial" });
	// Nothing here dials back, so the create waits for the socket and gives up, naming the address.
	assert.equal(made.error?.code, "timeout", JSON.stringify(made));
	assert.match(made.error.message, /did not dial ws:\/\/127\.0\.0\.1:8080\/v2\/computers\/attach/);
	const [, template, opts] = calls.find(([what]) => what === "Sandbox.create");
	assert.equal(template, BOX_TEMPLATE);
	assert.deepEqual(opts.envs, {}, "the token never goes in the sandbox's envs, which envd gives every process");
	assert.equal(opts.allowInternetAccess, true, "its root reaches the server");
	const starts = calls.filter(([what]) => what === "rpc.start").map(([, started]) => started);
	assert.equal(starts.length, 1, "one process: the launch");
	const [{ request, options }] = starts;
	assert.equal(request.process.cmd, "/bin/sh");
	assert.equal(request.process.args[0], "-c");
	assert.equal(request.process.args.length, 2);
	const script = request.process.args[1];
	assert.match(script, /exec >>\/run\/agentrun-dial\.log 2>&1 <\/dev\/null/);
	assert.match(script, /# agentrun-computer: root-only[\s\S]*' sh \/usr\/local \/usr\/bin\/envd \/etc\/inittab && sh -c '# agentrun-computer: sockets[\s\S]*' sh '\/tmp\/dbus-\*' && exec \/usr\/local\/bin\/agentrun-dial$/);
	assert.deepEqual(Object.keys(request.process.envs).sort(), [...BOOT_NAMES, "PATH"].sort());
	assert.equal(request.process.envs.PATH, "/usr/sbin:/usr/bin:/sbin:/bin");
	assert.match(request.process.envs.AGENTRUN_ATTACH_TOKEN, new RegExp(`^${MACHINE_TOKEN_SOURCE}$`));
	assert.equal(request.process.envs.AGENTRUN_ATTACH_URL, "ws://127.0.0.1:8080/v2/computers/attach");
	assert.equal(request.stdin, false);
	assert.equal(options.headers.Authorization, `Basic ${Buffer.from("root:").toString("base64")}`);
	assert.equal(options.timeoutMs, 0, "no deadline on the process");
	assert.equal(options.signal.aborted, true, "the stream was let go of once envd started it");
	assert.equal(dial.tokens.check(request.process.envs.AGENTRUN_ATTACH_TOKEN), undefined, "a machine that never dialed has its token revoked");
	assert.ok(calls.some(([what, id]) => what === "Sandbox.kill" && id === "sbx-dial"), "and is deleted");
});

test("connect dial: a desktop's launch gives agentrun-dial DISPLAY beside the boot env, for init", async () => {
	const { calls, Sandbox } = dialSandbox();
	const provider = new E2BProvider({ apiKey: KEY, Sandbox, connect: "dial", dial: dialOf(), daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, createMs: 300 } });
	const made = await provider.create({ ...SPEC, image: BOX_TEMPLATE }, { requestId: "r-dial-desktop" });
	assert.equal(made.error?.code, "timeout", JSON.stringify(made));
	const [[, { request }]] = calls.filter(([what]) => what === "rpc.start");
	assert.deepEqual(Object.keys(request.process.envs).sort(), [...BOOT_NAMES, "DISPLAY", "PATH"].sort());
	assert.equal(request.process.envs.DISPLAY, ":0");
});

test("E2B's desktop configuration, as serve builds it on connect dial, makes a desktop over dial: agentrun-dial boots from the envs envd started it with, dials, and its X server and xfwm4 start over that socket", async () => {
	const { calls, Sandbox } = dialSandbox();
	const dial = dialServer();
	let booted;
	// The sandbox's envd starts agentrun-dial with the boot env (rpc.start's envs): that machine boots and dials (bootDial).
	const make = Sandbox.create;
	Sandbox.create = async (...args) => {
		const sandbox = await make(...args);
		const start = sandbox.commands.rpc.start;
		sandbox.commands.rpc.start = (request, options) => {
			const { envs } = request.process;
			if (envs.AGENTRUN_ATTACH_TOKEN !== undefined) booted = bootDial(envs, dial, { daemon: readFileSync(DAEMON_PATH) });
			return start(request, options);
		};
		return sandbox;
	};
	const { options } = registry.descriptorOf("e2b").capabilities.find(({ kind }) => kind === "desktop");
	// serve's options for this provider: the keys' and the settings' (e2bConnect dial), then the configuration's (none).
	const provider = new E2BProvider({ apiKey: KEY, Sandbox, daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, listedStableMs: 0 }, dial, connect: "dial", ...options });
	assert.equal(provider.capabilities().kind, "desktop");
	await desktopOverDial(provider, dial, () => booted, { ...SPEC, image: BOX_TEMPLATE });
	assert.equal(calls.find(([what]) => what === "Sandbox.create")[1], BOX_TEMPLATE, "made from the box template");
	assert.ok(calls.some(([what, id]) => what === "Sandbox.kill" && id === "sbx-dial"), "release killed the sandbox");
});

test("connect dial takes a desktop, its default as on exec, or kind linux, no Archil mount and no value but exec or dial, in words; exec stays the default", () => {
	const { Sandbox } = dialSandbox();
	const options = { apiKey: KEY, Sandbox, daemonPath: DAEMON_PATH, dial: dialOf() };
	// A server passes connect alone (its e2bConnect setting): the box template has the desktop, so dial's kind is exec's.
	assert.equal(new E2BProvider({ ...options, connect: "dial" }).capabilities().kind, "desktop");
	assert.equal(new E2BProvider({ ...options, kind: "linux", connect: "dial" }).capabilities().kind, "linux");
	assert.equal(new E2BProvider(options).capabilities().kind, "desktop");
	assert.throws(() => new E2BProvider({ ...options, connect: "ssh" }), /connect is how E2B reaches its machines, "exec" \(the default\) or "dial", not "ssh"/);
	const provider = new E2BProvider({ ...options, kind: "linux", connect: "dial" });
	assert.deepEqual(provider.capabilities().mount, ["sync"], "a synced folder alone: agentrun-dial makes /workspace");
	assert.deepEqual(provider.check({ ...SPEC, mount: { ...MOUNT } }).map(({ field, message }) => [field, message.includes("dial")]), [["mount", true]]);
	const plain = new E2BProvider(options);
	assert.equal(plain.host.facts.connect, undefined);
	assert.equal(typeof plain.host.exec, "function");
	assert.equal(typeof plain.host.upload, "function");
});

test("E2B's descriptor declares the connect setting, with no default of its own: a server's settings pass it to create() as connect, else the provider's exec holds", async () => {
	const { E2B } = await import("../dist/descriptors/e2b.js");
	assert.deepEqual(E2B.settings, [{ name: "e2bConnect", option: "connect" }]);
});

test("the conformance module reads COMPUTER_E2B_CONNECT as connect, and its dialKit refuses in words: this process is no public server", () => {
	assert.deepEqual(settingsFromEnv({ [ENV.key]: KEY, [ENV.connect]: "dial" }), { apiKey: KEY, connect: "dial" });
	assert.equal(ENV.connect, "COMPUTER_E2B_CONNECT");
	assert.throws(() => dialKit(), /E2B's machines dial the server that minted their tokens, and this run has no public server: run its Core with packages\/serve\/scripts\/dial-conformance\.mjs --provider e2b with COMPUTER_E2B_CONNECT=dial inside a server the internet reaches at AGENTRUN_PUBLIC_URL/);
});

test("the conformance module's run image on dial is the box template, the one that holds agentrun-dial; a template named still wins", async () => {
	const { conformanceImage } = await import("../dist/conformance/e2b.js");
	const { boxE2bTemplate } = await import("../dist/box-image.js");
	assert.equal(conformanceImage({ env: { [ENV.connect]: "dial" } }), boxE2bTemplate());
	assert.equal(conformanceImage({ env: { [ENV.connect]: "dial", [ENV.kind]: "linux" } }), boxE2bTemplate());
	assert.equal(conformanceImage({ env: { [ENV.connect]: "dial", [ENV.template]: "mine" } }), "mine");
	assert.equal(conformanceImage({ env: { [ENV.kind]: "linux" } }), "base");
	assert.equal(conformanceImage({ env: {} }), "desktop");
});

/** A dial whose token store is down: no public address, and a revoke that throws, which release says through onNote. */
const downDial = () => ({
	tokens: {
		revoke: async () => {
			throw new Error("the token store is down");
		},
	},
	hub: { revoke() {}, connection: () => undefined, online: () => false },
});

test("the conformance module hands onNote and dial to the drifted twin as to the run's provider: the same refusal on create, the same note on release", async () => {
	const conformance = await e2b.conformance();
	for (const make of [conformance.createProvider, conformance.createDriftedProvider]) {
		const rec = recorder();
		rec.Sandbox.getInfo = async () => {
			throw Object.assign(new Error("sandbox not found"), { name: "SandboxNotFoundError" });
		};
		const notes = [];
		const provider = await make({
			env: { [ENV.key]: KEY, [ENV.live]: "1", [ENV.connect]: "dial" },
			Sandbox: rec.Sandbox,
			daemonPath: DAEMON_PATH,
			buildDaemon: async () => DAEMON_PATH,
			timeouts: TIMEOUTS,
			onNote: (note) => notes.push(note),
			dial: downDial(),
		});
		const made = await provider.create(SPEC, { requestId: `r-untangle-dial-${make.name}` });
		assert.equal(made.ok, false, make.name);
		assert.match(made.error.message, /has no public https address/, make.name);
		const released = await provider.release({ id: "i0000000000000000001", name: "computer-0123456789ab" }, "delete");
		assert.equal(released.ok, true, `${make.name}: ${JSON.stringify(released)}`);
		assert.equal(notes.length, 1, `${make.name}: ${JSON.stringify(notes)}`);
		assert.match(notes[0].note, /could not be revoked \(the token store is down\)/, make.name);
	}
});

test("the conformance module keeps a COMPUTER_E2B_MAX_LIFETIME_MS under 30 minutes, and cuts a longer one to 30, on the run's provider and its drifted twin", async () => {
	const conformance = await e2b.conformance();
	for (const make of [conformance.createProvider, conformance.createDriftedProvider]) {
		const env = { [ENV.key]: KEY, [ENV.live]: "1" };
		const options = { Sandbox: recorder().Sandbox, daemonPath: DAEMON_PATH, buildDaemon: async () => DAEMON_PATH };
		assert.equal((await make({ ...options, env: { ...env, [ENV.maxLifetimeMs]: "600000" } })).capabilities().maxLifetimeMs, 600_000, `${make.name}: a shorter cap is kept`);
		assert.equal((await make({ ...options, env: { ...env, [ENV.maxLifetimeMs]: "3600000" } })).capabilities().maxLifetimeMs, 30 * 60_000, `${make.name}: a longer one is cut to 30 minutes`);
		assert.equal((await make({ ...options, env })).capabilities().maxLifetimeMs, 30 * 60_000, `${make.name}: none is 30 minutes`);
	}
});

test("the conformance module refuses COMPUTER_E2B_MAX_LIFETIME_MS=0 in words, on the run's provider and its drifted twin, before any E2B call", async () => {
	const conformance = await e2b.conformance();
	for (const make of [conformance.createProvider, conformance.createDriftedProvider]) {
		const rec = recorder();
		const env = { [ENV.key]: KEY, [ENV.live]: "1", [ENV.maxLifetimeMs]: "0" };
		await assert.rejects(
			make({ Sandbox: rec.Sandbox, daemonPath: DAEMON_PATH, buildDaemon: async () => DAEMON_PATH, env }),
			/maxLifetimeMs must be a whole number of ms above 0 and at most \d+ ms, the longest E2B keeps a computer/,
			`${make.name}: 0 is refused, never taken as 30 minutes`,
		);
		assert.deepEqual(rec.calls, [], `${make.name}: no E2B call`);
	}
});

test("the conformance module's daemon: an option's path over COMPUTER_E2B_DAEMON, and the drifted twin uploads the one it built", async () => {
	const conformance = await e2b.conformance();
	const empty = () => {
		const rec = recorder();
		rec.Sandbox.list = () => ({ hasNext: false, nextItems: async () => [] });
		return rec.Sandbox;
	};
	const env = { [ENV.key]: KEY, [ENV.live]: "1", [ENV.daemon]: "/nonexistent/untangle-env/computerd" };
	const options = { env, timeouts: TIMEOUTS, daemonPath: "/nonexistent/untangle-option/computerd", buildDaemon: async () => "/nonexistent/untangle-drift/computerd" };
	const made = await (await conformance.createProvider({ ...options, Sandbox: empty() })).create(SPEC, { requestId: "r-untangle-e2b-1" });
	assert.equal(made.ok, false);
	assert.match(made.error.message, /no daemon binary at \/nonexistent\/untangle-option\/computerd/);
	const drifted = await (await conformance.createDriftedProvider({ ...options, Sandbox: empty() })).create(SPEC, { requestId: "r-untangle-e2b-2" });
	assert.equal(drifted.ok, false);
	assert.match(drifted.error.message, /no daemon binary at \/nonexistent\/untangle-drift\/computerd/);
});
