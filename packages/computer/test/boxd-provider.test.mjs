// BoxdProvider against a fake of the boxd SDK slice it takes (test/fake-boxd.mjs): every call is recorded with what it
// was given and answered as @boxd-sh/sdk@0.3.1 answers it. No SDK is loaded, no key is read from the environment and
// nothing reaches the network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BOXD, kindRefusals } from "../dist/index.js";
import { providerFor } from "../dist/providers.js";
import { DESKTOP_GROUPS, fakeBoxd, KEY, LINUX_GROUPS, VERSION } from "./fake-boxd.mjs";

const { BoxdProvider, create, CAPABILITIES, MOUNT } = await import("../dist/boxd.js");
const { BOXD_ENV, settingsFromEnv, conformanceImage, createProvider } = await import("../dist/conformance/boxd.js");

const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DEADLINE = "agentrun.computer.deadline";
const IMAGE_LABEL = "agentrun.computer.image";
const MAX_LABEL = "agentrun.computer.max-deadline";
const SPEC = { image: "default", lifetimeMs: 600_000, network: "none" };
const dir = mkdtempSync(join(tmpdir(), "computer-boxd-"));
const DAEMON_PATH = join(dir, "computerd");
const DAEMON_BYTES = Buffer.from("a stand-in for computerd, linux/amd64\n");
writeFileSync(DAEMON_PATH, DAEMON_BYTES);
const SHA = createHash("sha256").update(DAEMON_BYTES).digest("hex");
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Short bounds, so the waits in these tests take milliseconds. */
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, readyMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 1_000 };

function setup(options = {}, fakeOptions = {}) {
	const fake = fakeBoxd(fakeOptions);
	const provider = new BoxdProvider({ apiKey: KEY, Boxd: fake.Boxd, org: "acme", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...options });
	return { fake, provider };
}
const only = (fake) => {
	assert.equal(fake.machines.size, 1, "one machine was made");
	return [...fake.machines.values()][0];
};
const createParams = (fake) => fake.calls.find(([name]) => name === "machines.create")?.[1];

test("the client is given the key, the API's address and the region explicitly, so the SDK reads none from the environment", () => {
	const { fake } = setup({ region: "nyc" });
	assert.deepEqual(fake.clients, [
		{ apiKey: KEY, baseURL: "https://boxd.sh:9443", region: "nyc", timeout: TIMEOUTS.requestMs },
		// create's own: the SDK bounds a call by its client's timeout, so create gets createMs, and is never sent twice.
		{ apiKey: KEY, baseURL: "https://boxd.sh:9443", region: "nyc", timeout: TIMEOUTS.createMs, maxRetries: 0 },
	]);
	const bare = setup({ org: undefined });
	assert.equal(bare.fake.clients[0].region, "", "no region given is the API's home region, never left out");
});

test("create() needs the key, refuses in words without it, and never echoes one", async () => {
	await assert.rejects(create({}), /options\.apiKey, the boxd API key, is required/);
	await assert.rejects(providerFor("boxd", {}), (error) => {
		assert.doesNotMatch(error.message, /BOXD_API_KEY=|bxd_/);
		return true;
	});
	const fake = fakeBoxd();
	const provider = await create({ apiKey: KEY, Boxd: fake.Boxd, daemonPath: DAEMON_PATH });
	assert.equal(provider.id, "boxd");
	assert.equal(provider.version, VERSION);
});

test("the constructor refuses a size that is not boxd's, a root or machine-user daemon, and a bad region, in words", () => {
	const fake = fakeBoxd();
	const make = (options) => () => new BoxdProvider({ apiKey: KEY, Boxd: fake.Boxd, ...options });
	assert.throws(make({ vcpu: 2 }), /vcpu and memory go together/);
	assert.throws(make({ vcpu: 2, memory: "16G" }), /not one of boxd's sizes/);
	assert.doesNotThrow(make({ vcpu: 4, memory: "16G" }));
	assert.throws(make({ daemonUser: "0:0" }), /root/);
	assert.throws(make({ daemonUser: "1000:1000" }), /machine's own user/);
	assert.throws(make({ region: "Frankfurt!" }), /region/);
	assert.throws(make({ baseUrl: "http://boxd.sh" }), /https/);
	assert.throws(make({ kind: "windows" }), /kind is desktop or linux/);
	assert.throws(make({ maxLifetimeMs: 31 * 24 * 3_600_000 }), /30 days/);
});

test("capabilities: a child daemon in a microVM, network none, janitor lifetime, delete only, boxd's agent port declared", () => {
	const { provider } = setup();
	const caps = provider.capabilities();
	assert.deepEqual(caps, {
		kind: "linux",
		lifetime: "janitor",
		network: ["none"],
		networkReadBack: true,
		isolation: "microvm",
		os: "linux",
		daemon: "child",
		groups: LINUX_GROUPS,
		maxLifetimeMs: 24 * 3_600_000,
		release: ["delete"],
		mount: [],
		vendorAgentPorts: [57073],
	});
	assert.deepEqual(kindRefusals(caps), []);
	assert.deepEqual(setup({ kind: "desktop" }).provider.capabilities().groups, DESKTOP_GROUPS);
	assert.deepEqual(MOUNT, []);
	assert.deepEqual(CAPABILITIES, BOXD.capabilities);
	assert.deepEqual(
		BOXD.capabilities.map(({ kind, options }) => [kind, options.kind]),
		[
			["linux", "linux"],
			["desktop", "desktop"],
		],
	);
});

test("check refuses in words, with no call: open and allowlists, a size, a user, a workdir, a mount, the provider's labels, a lifetime past the cap", () => {
	const { fake, provider } = setup();
	const fields = (spec) => provider.check(spec).map(({ field }) => field);
	assert.deepEqual(provider.check(SPEC), []);
	assert.deepEqual(fields({ ...SPEC, image: "my-snapshot" }), []);
	assert.deepEqual(fields({ ...SPEC, network: "open" }), ["network"]);
	assert.deepEqual(fields({ ...SPEC, network: { allow: ["example.com"] } }), ["network"]);
	assert.deepEqual(fields({ ...SPEC, cpus: 4 }), ["cpus"]);
	assert.deepEqual(fields({ ...SPEC, user: "0" }), ["user"]);
	assert.deepEqual(fields({ ...SPEC, workdir: "/srv" }), ["workdir"]);
	assert.deepEqual(fields({ ...SPEC, mount: { kind: "bind", source: "/tmp" } }), ["mount"]);
	assert.deepEqual(fields({ ...SPEC, labels: { [DEADLINE]: "x" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, image: "" }), ["image"]);
	assert.ok(fields({ ...SPEC, lifetimeMs: 24 * 3_600_000 + 1 }).includes("lifetimeMs"));
	assert.deepEqual(fake.calls, []);
});

test("create makes an isolated machine with no standby, closes its egress and hibernation, installs the daemon and starts init detached as root", async () => {
	const { fake, provider } = setup({ vcpu: 4, memory: "16G" });
	const made = await provider.create({ ...SPEC, labels: { "agentrun.run": "r1" } });
	assert.ok(made.ok, made.ok ? "" : made.error.message);
	const m = only(fake);
	assert.equal(made.value.id, m.id);
	assert.match(made.value.name, /^computer-[0-9a-f]{12}$/);
	const params = createParams(fake);
	assert.equal(params.name, made.value.name);
	assert.equal(params.org, "acme");
	assert.equal(params.isolated, true);
	assert.deepEqual(params.config, { autoSuspendTimeout: 0, vcpu: 4, memory: "16G" });
	assert.equal(params.fromSnapshot, undefined, "image default starts from boxd's own image");
	assert.equal(params.labels[COMPUTER], "1");
	assert.equal(params.labels[NAME], made.value.name);
	assert.equal(params.labels[IMAGE_LABEL], "default");
	assert.equal(params.labels["agentrun.run"], "r1");
	assert.ok(Math.abs(Date.parse(params.labels[DEADLINE]) - (Date.now() + 600_000)) < 5_000);
	assert.ok(!("deleteAfter" in params), "boxd is given no delete timer: the janitor ends a computer by its label");
	assert.deepEqual(m.egressAllow, ["none"]);
	assert.equal(m.idle.hibernateAfter, 0);
	// The order: ready, egress and hibernation, read back, then the daemon.
	const order = fake.names().filter((name) => name !== "machines.get");
	assert.deepEqual(order.slice(0, 6), ["machines.create", "machines.waitUntilReady", "machines.setEgressAllow", "machines.setAutoHibernateTimeout", "files.upload", "machines.exec"]);
	const upload = fake.uploads[0];
	assert.match(upload.path, /^\/tmp\/agentrun-computerd-[0-9a-f]{16}$/);
	assert.deepEqual(upload.bytes, DAEMON_BYTES);
	assert.deepEqual(m.daemon, { path: "/opt/agentrun/computerd", bytes: DAEMON_BYTES });
	// init's command goes through the start script, detached, its words to a file only root writes.
	assert.match(m.startedWith.init, /# agentrun-computer: init/);
	assert.equal(m.startedWith.log, "/run/agentrun-computerd.log");
	const start = fake.calls.find(([name, , kind]) => name === "machines.exec" && kind === "start")[3].command;
	assert.match(start, /setsid -f/);
	assert.match(start, /sudo -n/);
	assert.match(m.startedWith.init, /--own-network/);
	assert.equal(m.init.user, "2510:2510");
	// The first connection checked the daemon, then closed: hello, credentials, network, home, binary, probe.
	const methods = fake.requests.map(({ method }) => method);
	assert.deepEqual(methods.slice(0, 2), ["hello", "files.read"]);
	assert.ok(methods.includes("exec.run"), "the probe ran");
	assert.ok(fake.bridges.every((bridge) => bridge.closed), "every bridge was closed");
	assert.deepEqual(fake.deletes, []);
});

test("a snapshot image restores the machine from it, and the read-back is held to it", async () => {
	const { fake, provider } = setup();
	const made = await provider.create({ ...SPEC, image: "agentrun-base" });
	assert.ok(made.ok, made.ok ? "" : made.error.message);
	assert.equal(createParams(fake).fromSnapshot, "agentrun-base");
	const drifted = setup({}, { machine: { source: null } });
	const refused = await drifted.provider.create({ ...SPEC, image: "agentrun-base" });
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /image: declared the snapshot "agentrun-base", read back no snapshot/);
	assert.deepEqual(drifted.fake.deletes.length, 1, "the drifted machine was deleted");
});

test("a machine that reads back drifted from what create asked is refused and deleted: egress open, not isolated, a delete timer", async () => {
	for (const [patch, words] of [
		[{ egressAllow: [] }, /network: declared none, read back open/],
		[{ egressAllow: ["example.com"] }, /egress allowlist of 1 entries/],
		[{ networking: { isolated: false } }, /isolated: declared true, read back false/],
		[{ deleteAt: new Date(Date.now() + 60_000) }, /delete-after/],
		[{ idle: { suspendAfter: 900, hibernateAfter: 0, destroyAfter: 0 } }, /auto-suspend: declared 0, read back 900/],
	]) {
		const { fake, provider } = setup({}, { machine: patch });
		const made = await provider.create(SPEC);
		assert.equal(made.ok, false);
		assert.equal(made.error.code, "refused");
		assert.match(made.error.message, words);
		assert.equal(fake.deletes.length, 1);
		assert.deepEqual(fake.uploads, [], "no daemon goes into a machine that drifted");
	}
});

test("an installed daemon whose sha256 is not the upload's is refused and the machine deleted", async () => {
	const { fake, provider } = setup({}, { sha: "lie" });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.match(made.error.message, new RegExp(`uploaded sha256 ${SHA}, the installed binary reads back "0{64}"`));
	assert.equal(fake.deletes.length, 1);
});

test("init that does not come up: the error carries init's own words, and the machine is deleted", async () => {
	const { fake, provider } = setup({}, { initFails: "computerd: init: refusing: another process holds uid 2510" });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.match(made.error.message, /the daemon did not answer/);
	assert.match(made.error.message, /init wrote: computerd: init: refusing: another process holds uid 2510/);
	assert.equal(fake.deletes.length, 1);
});

test("a bridge that finds no daemon listening yet is tried again until init's socket answers", async () => {
	const { fake, provider } = setup({}, { notListening: 2 });
	const made = await provider.create(SPEC);
	assert.ok(made.ok, made.ok ? "" : made.error.message);
	assert.ok(fake.bridges.length >= 3);
});

test("a daemon of another version is refused at create, and the machine deleted", async () => {
	const { fake, provider } = setup({}, { box: { helloPatch: { version: "0.0.0-drift" } } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.match(made.error.message, /version/);
	assert.equal(fake.deletes.length, 1);
});

test("a daemon that reaches an address from inside is refused: network none is held from inside too", async () => {
	const { provider } = setup({}, { box: { reached: ["1.1.1.1:443"] } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.match(made.error.message, /1\.1\.1\.1:443/);
});

test("a create boxd refused made nothing, and nothing is deleted; one whose answer was lost is found by its name and deleted", async () => {
	const refused = setup({}, { create: "invalid" });
	const made = await refused.provider.create({ ...SPEC, image: "no-such-snapshot" });
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "invalid");
	assert.deepEqual(refused.fake.deletes, []);
	const denied = await setup({}, { create: "auth" }).provider.create(SPEC);
	assert.equal(denied.error.code, "denied");
	const lost = setup({}, { create: "lost" });
	const gone = await lost.provider.create(SPEC);
	assert.equal(gone.ok, false);
	assert.match(gone.error.message, /was deleted and read back gone/);
	assert.equal(lost.fake.deletes.length, 1);
});

test("a create the SDK gave up on at its deadline is looked for by its name, and the machine that lands is deleted", async () => {
	const { fake, provider } = setup({}, { create: "deadline", landMs: 60 });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "timeout");
	assert.match(made.error.message, /was deleted and read back gone/);
	assert.equal(fake.deletes.length, 1);
	assert.deepEqual((await provider.list({})).value, [], "nothing is left");
});

test("a create aborted while boxd still answers: the machine that lands later is deleted by its id", async () => {
	const { fake, provider } = setup({}, { create: "hold" });
	const controller = new AbortController();
	const pending = provider.create(SPEC, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	const made = await pending;
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "aborted");
	assert.match(made.error.message, /deleted as it lands/);
	await fake.release();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(fake.deletes.length, 1, "the machine that landed was deleted");
	assert.equal([...fake.machines.values()].every((m) => m.deleted), true);
});

test("a create whose answer never comes within createMs is given up on, and the machine that lands later is deleted", async () => {
	const { fake, provider } = setup({ timeouts: { ...TIMEOUTS, createMs: 50 } }, { create: "hold" });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "timeout");
	await fake.release();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(fake.deletes.length, 1);
});

test("a machine that landed late and cannot be deleted is tried three times, then told to onCleanupFailed with its id", async () => {
	const left = [];
	let deletes = 0;
	const { fake, provider } = setup(
		{ onCleanupFailed: (one) => left.push(one) },
		{
			create: "hold",
			onStep: (step) => {
				if (step !== "machines.delete") return;
				deletes++;
				throw new Error("boxd is unavailable");
			},
		},
	);
	const controller = new AbortController();
	const pending = provider.create(SPEC, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	const made = await pending;
	assert.equal(made.error.code, "aborted");
	assert.match(made.error.message, /deleted as it lands, and one that cannot be is the janitor's by its deadline label/);
	assert.deepEqual(left, [], "nothing is told before the machine lands");
	await fake.release();
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(deletes, 3, "the delete was tried three times");
	const machine = only(fake);
	assert.equal(machine.deleted, false);
	assert.equal(left.length, 1);
	assert.equal(left[0].id, machine.id);
	assert.equal(left[0].name, machine.name);
	assert.match(left[0].message, /could not be deleted \(.*boxd is unavailable.*\); the janitor deletes it by its deadline label/);
	assert.ok(isFinite(Date.parse(machine.labels[DEADLINE])), "the machine left carries the deadline label the janitor reads");
});

test("a late delete that fails once is tried again, and a cleanup that works tells onCleanupFailed nothing; a handler that throws is dropped", async () => {
	const left = [];
	let deletes = 0;
	const { fake, provider } = setup(
		{ timeouts: { ...TIMEOUTS, createMs: 50 }, onCleanupFailed: (one) => left.push(one) },
		{
			create: "hold",
			onStep: (step) => {
				if (step === "machines.delete" && ++deletes === 1) throw new Error("boxd is unavailable");
			},
		},
	);
	assert.equal((await provider.create(SPEC)).error.code, "timeout");
	await fake.release();
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(deletes, 2);
	assert.equal(only(fake).deleted, true);
	assert.deepEqual(left, []);

	const throwing = setup(
		{
			timeouts: { ...TIMEOUTS, createMs: 50 },
			onCleanupFailed: () => {
				throw new Error("the host's handler failed");
			},
		},
		{
			create: "hold",
			onStep: (step) => {
				if (step === "machines.delete") throw new Error("boxd is unavailable");
			},
		},
	);
	const unhandled = [];
	const note = (error) => unhandled.push(error);
	process.on("unhandledRejection", note);
	try {
		assert.equal((await throwing.provider.create(SPEC)).error.code, "timeout");
		await throwing.fake.release();
		await new Promise((resolve) => setTimeout(resolve, 150));
	} finally {
		process.off("unhandledRejection", note);
	}
	assert.deepEqual(unhandled, []);
	assert.throws(() => new BoxdProvider({ apiKey: KEY, Boxd: fakeBoxd().Boxd, onCleanupFailed: "log" }), /onCleanupFailed is a function/);
});

test("attach refuses a computer whose timers changed since create: standby, hibernation, auto-destroy, or a delete before the most it may live", async () => {
	const { fake, provider } = setup();
	const made = await provider.create(SPEC);
	assert.ok(made.ok, made.ok ? "" : made.error.message);
	const machine = only(fake);
	assert.ok((await provider.attach({ id: made.value.id })).ok, "as create left it, it attaches");
	const refused = async (change, words) => {
		const before = structuredClone({ idle: machine.idle, deleteAt: machine.deleteAt });
		change();
		for (const ref of [{ id: made.value.id }, { labels: { [NAME]: machine.name } }]) {
			const attached = await provider.attach(ref);
			assert.equal(attached.ok, false, words.source);
			assert.equal(attached.error.code, "refused");
			assert.match(attached.error.message, words);
			assert.match(attached.error.message, /left as it is/);
		}
		Object.assign(machine, before);
	};
	await refused(() => (machine.idle.hibernateAfter = 14_400), /auto-hibernate: declared 0, read back 14400/);
	await refused(() => (machine.idle.suspendAfter = 900), /auto-suspend: declared 0, read back 900/);
	await refused(() => (machine.idle.destroyAfter = 3_600), /auto-destroy: declared 0, read back 3600/);
	const most = Date.parse(machine.labels[MAX_LABEL]);
	await refused(() => (machine.deleteAt = new Date(most - 1_000)), /delete-after: boxd deletes it at .*before the most it may live/);
	await refused(() => (machine.deleteAt = new Date(Date.now() + 60_000)), /delete-after: boxd deletes it at /);
	assert.equal(fake.deletes.length, 0, "a refused attach deletes nothing");
	// A delete timer at or past the most it may live is the deleteTimer backstop: it ends nothing early.
	machine.deleteAt = new Date(most + 300_000);
	const kept = await provider.attach({ id: made.value.id });
	assert.ok(kept.ok, kept.ok ? "" : kept.error.message);
	machine.deleteAt = null;
	assert.ok((await provider.attach({ id: made.value.id })).ok);
});

test("deleteTimer writes boxd's delete timer with the machine, past the most it may live, and holds the read-back to it", async () => {
	const { fake, provider } = setup({ deleteTimer: true, maxLifetimeMs: 3_600_000 });
	const made = await provider.create(SPEC);
	assert.ok(made.ok, made.ok ? "" : made.error.message);
	assert.equal(createParams(fake).deleteAfter, 3_600 + 300);
	const off = setup();
	assert.ok((await off.provider.create(SPEC)).ok);
	assert.ok(!("deleteAfter" in createParams(off.fake)), "without the option boxd is given no timer");
	const missing = setup({ deleteTimer: true }, { machine: { deleteAt: null } });
	const refused = await missing.provider.create(SPEC);
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /delete-after: declared between/);
});

test("deleteTimer's read-back takes boxd's timer from the most a computer may live to 5 minutes and 2 of clock skew past it", async () => {
	const hour = 3_600_000;
	// boxd's timer as get reads it, offset from now plus the most the computer may live (create's time plus maxLifetimeMs).
	const at = async (offsetS) => {
		const { provider } = setup({ deleteTimer: true, maxLifetimeMs: hour }, { machine: { get deleteAt() { return new Date(Date.now() + hour + offsetS * 1000); } } });
		return provider.create(SPEC);
	};
	for (const offsetS of [10, 300, 400]) {
		const made = await at(offsetS);
		assert.ok(made.ok, `${offsetS} s past the most: ${made.ok ? "" : made.error.message}`);
	}
	for (const offsetS of [-60, 480]) {
		const made = await at(offsetS);
		assert.equal(made.ok, false, `${offsetS} s past the most is refused`);
		assert.match(made.error.message, /delete-after: declared between/);
	}
});

test("a restore that carries agentrun's labels from its snapshot is refused and deleted; a size with a snapshot is refused in check", async () => {
	const { fake, provider } = setup({}, { snapshotLabels: { "agentrun.run": "old-run" } });
	const made = await provider.create({ ...SPEC, image: "agentrun-base" });
	assert.equal(made.ok, false);
	assert.match(made.error.message, /label agentrun\.run: create wrote none, read back "old-run"/);
	assert.equal(fake.deletes.length, 1);
	const sized = setup({ vcpu: 4, memory: "16G" });
	assert.deepEqual(sized.provider.check({ ...SPEC, image: "agentrun-base" }).map(({ field }) => field), ["image"]);
	assert.deepEqual(sized.provider.check(SPEC), []);
});

test("check refuses a label name boxd does not take", () => {
	const { provider } = setup();
	for (const key of ["Team", "boxd/x", "a".repeat(64), "has space"]) assert.deepEqual(provider.check({ ...SPEC, labels: { [key]: "v" } }).map(({ field }) => field), ["labels"], key);
	assert.deepEqual(provider.check({ ...SPEC, labels: { "agentrun.run": "r1", team: "a" } }), []);
});

test("a desktop: init is given the display, Xvfb starts through the daemon, and hello declares the screen", async () => {
	const { fake, provider } = setup({ kind: "desktop" });
	const made = await provider.create(SPEC);
	assert.ok(made.ok, made.ok ? "" : made.error.message);
	const m = only(fake);
	assert.equal(m.init.display, ":0");
	assert.equal(m.xvfb.argv[0], "Xvfb");
	const dies = await setup({ kind: "desktop" }, { display: "dies" }).provider.create(SPEC);
	assert.equal(dies.ok, false);
	assert.match(dies.error.message, /X server/);
});

test("list, attach, network and connect read the computer back; release deletes it and waits until boxd reads it gone", async () => {
	const { fake, provider } = setup({}, { lingers: 2 });
	const made = await provider.create({ ...SPEC, labels: { "agentrun.run": "r1" } });
	assert.ok(made.ok);
	const ref = made.value;
	const listed = await provider.list({ "agentrun.run": "r1" });
	assert.ok(listed.ok);
	assert.equal(listed.value.length, 1);
	assert.deepEqual(listed.value[0].ref, { id: ref.id, name: ref.name });
	assert.equal(listed.value[0].state, "running");
	assert.equal(listed.value[0].network, "none");
	assert.ok(listed.value[0].deadline instanceof Date);
	assert.deepEqual((await provider.list({ "agentrun.run": "r2" })).value, []);

	const byId = await provider.attach({ id: ref.id });
	assert.ok(byId.ok, byId.ok ? "" : byId.error.message);
	assert.equal(byId.value.spec.image, "default");
	assert.equal(byId.value.spec.user, "2510:2510");
	assert.equal(byId.value.spec.network, "none");
	assert.equal(byId.value.spec.workdir, "/work");
	const byLabels = await provider.attach({ labels: { "agentrun.run": "r1" } });
	assert.ok(byLabels.ok);
	assert.equal(byLabels.value.id, ref.id);

	assert.deepEqual(await provider.network(ref), { ok: true, value: "none" });
	const wider = await provider.network(ref, "open");
	assert.equal(wider.error.code, "refused");

	const connected = await provider.connect(ref);
	assert.ok(connected.ok);
	assert.deepEqual((await connected.value.client.call("ping", {})).value, {});
	await connected.value.close();

	assert.equal((await provider.release(ref, "stop")).error.code, "unsupported");
	const released = await provider.release(ref, "delete");
	assert.ok(released.ok, released.ok ? "" : released.error.message);
	assert.deepEqual(fake.deletes, [ref.id]);
	assert.ok(fake.calls.filter(([name]) => name === "machines.get").length >= 3, "release read the machine back until it was gone");
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined }, "a second release is ok");
	assert.equal((await provider.connect(ref)).error.code, "not_found");
});

test("namePrefix names every machine, and a provider of another prefix never finds it", async () => {
	const { fake, provider } = setup({ namePrefix: "t-agentrun-" });
	const made = await provider.create(SPEC);
	assert.ok(made.ok);
	assert.match(made.value.name, /^t-agentrun-[0-9a-f]{12}$/);
	assert.equal(only(fake).name, made.value.name);
	const other = new BoxdProvider({ apiKey: KEY, Boxd: fake.Boxd, org: "acme", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	assert.equal((await other.attach({ id: made.value.id })).error.code, "not_found");
	assert.deepEqual((await other.list({})).value, []);
	assert.throws(() => new BoxdProvider({ apiKey: KEY, Boxd: fake.Boxd, namePrefix: "Bad" }), /namePrefix/);
});

test("a machine this provider did not make is never attached, connected or released", async () => {
	const { fake, provider } = setup();
	const other = fake.add({ name: "someone-else", labels: { team: "x" } });
	assert.equal((await provider.attach({ id: other.id })).error.code, "not_found");
	const ref = { id: other.id, name: "computer-0123456789ab" };
	assert.equal((await provider.connect(ref)).error.code, "not_found");
	assert.equal((await provider.release(ref, "delete")).error.code, "not_found");
	assert.deepEqual(fake.deletes, []);
	// A machine wearing the label but named otherwise is not ours either.
	const lookalike = fake.add({ name: "someone-else", labels: { [COMPUTER]: "1", [NAME]: "computer-0123456789ab" } });
	assert.equal((await provider.attach({ id: lookalike.id })).error.code, "not_found");
});

test("extend moves init's deadline and the label the janitor reads, never earlier and never past the cap", async () => {
	const { fake, provider } = setup({ maxLifetimeMs: 3_600_000 });
	const made = await provider.create({ ...SPEC, lifetimeMs: 60_000 });
	assert.ok(made.ok);
	const m = only(fake);
	const extended = await provider.extend(made.value, 120_000);
	assert.ok(extended.ok, extended.ok ? "" : extended.error.message);
	assert.equal(m.init.deadline, extended.value.deadline.toISOString());
	assert.equal(m.labels[DEADLINE], extended.value.deadline.toISOString());
	const earlier = await provider.extend(made.value, 30_000);
	assert.equal(earlier.ok, false);
	assert.equal(m.labels[DEADLINE], extended.value.deadline.toISOString(), "a refused extend moves nothing");
	const past = await provider.extend(made.value, 3_600_000 + 60_000);
	assert.equal(past.error.code, "limit");
	assert.ok(Date.parse(m.labels[MAX_LABEL]) > Date.now());
});

test("testConnection lists by the provider's label and makes nothing", async () => {
	const { fake, provider } = setup();
	const tested = await provider.testConnection();
	assert.deepEqual(tested, { ok: true, value: { detail: "boxd answered: 0 computers of this provider" } });
	assert.deepEqual(fake.names(), ["machines.list"]);
});

test("the conformance module reads only its COMPUTER_BOXD_* names, after the live switch", async () => {
	assert.throws(() => settingsFromEnv({ BOXD_API_KEY: "fake" }), /COMPUTER_BOXD_API_KEY/);
	assert.deepEqual(settingsFromEnv({ [BOXD_ENV.key]: KEY, [BOXD_ENV.org]: "acme", [BOXD_ENV.region]: "fra", [BOXD_ENV.kind]: "desktop" }), { apiKey: KEY, org: "acme", region: "fra", kind: "desktop" });
	assert.equal(conformanceImage({ env: {} }), "default");
	assert.equal(conformanceImage({ env: { [BOXD_ENV.image]: "snap" } }), "snap");
	await assert.rejects(createProvider({ env: { [BOXD_ENV.key]: KEY } }), /AGENTRUN_COMPUTER_LIVE_BOXD=1/);
	const fake = fakeBoxd();
	const provider = await createProvider({ env: { [BOXD_ENV.live]: "1", [BOXD_ENV.key]: KEY }, Boxd: fake.Boxd });
	assert.equal(provider.capabilities().maxLifetimeMs, 30 * 60_000);
});
