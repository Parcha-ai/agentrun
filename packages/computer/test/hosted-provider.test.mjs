// The shared machine-host adapter (src/hosted/provider.ts) against its one fake host (test/fake-host.mjs): the lifecycle
// every vendor on it gets, tested once. Create by request id (races, retries, refusals), the read-back and the probe,
// the deadline and extend, delete-then-wait-gone, nothing left behind after any failed step, the Archil mount, and the
// pid1 branch. No vendor, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLifetime, computerNameFor as nameOf } from "../dist/index.js";
import { DAEMON, DESKTOP_GROUPS, deferred, fakeHost, LINUX_GROUPS, NotFound, VERSION } from "./fake-host.mjs";

const { hostedProvider } = await import("../dist/hosted/provider.js");
const { hostedCommands } = await import("../dist/hosted/scripts.js");
const { WINDOW_MANAGER } = await import("../dist/desktop.js");

const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DEADLINE = "agentrun.computer.deadline";
const MAX = "agentrun.computer.max-deadline";
const SPEC = { image: "img", lifetimeMs: 600_000, network: "none" };
/** A pid1 host that takes a spec's user. */
const USER_FACTS = { daemon: "pid1", specFields: ["user"], user: ["uid"], networkReadBack: false };
const HOUR = 3_600_000;
const ACCEPTED_NOTE = "network: none; accepted with no answer (no bytes came back): 1.1.1.1:443, 8.8.8.8:443";
const INSTALLER_NOTE = "the daemon was installed by root (uid 0), as root";
const dir = mkdtempSync(join(tmpdir(), "computer-hosted-"));
const DAEMON_PATH = join(dir, "computerd");
const DAEMON_BYTES = Buffer.from("a stand-in for computerd, linux/amd64\n");
writeFileSync(DAEMON_PATH, DAEMON_BYTES);
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Short bounds, so the waits in these tests take milliseconds. */
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 2_000 };

function setup(options = {}, fakeOptions = {}) {
	const fake = fakeHost(fakeOptions);
	const provider = hostedProvider(fake.host, { label: "Fakehost", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...options });
	return { fake, provider };
}
let requests = 0;
/** A create of a new request. */
const create = (provider, spec = SPEC, context = {}) => provider.create(spec, { requestId: `req-${++requests}`, ...context });
const made = (result) => {
	assert.equal(result.ok, true, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
	return result.value;
};
const runsOf = (fake, id) => fake.events.filter((event) => event.machine === id).map(({ what }) => what);
const only = (fake) => {
	assert.equal(fake.machines.size, 1, "one machine was made");
	return [...fake.machines.values()][0];
};
/** Nothing left behind: every machine the host made is deleted, and none lists. */
async function nothingLeft(fake, what) {
	assert.deepEqual(fake.live().map((m) => m.id), [], `${what}: every machine made was deleted`);
	const listed = await fake.host.list({ [COMPUTER]: "1" }, { timeoutMs: 1_000 });
	assert.deepEqual(listed.value, [], `${what}: none is listed`);
}

// --- capabilities and check ---

test("capabilities come from the host's facts and the adapter's options alone", () => {
	const { provider } = setup({ kind: "desktop" });
	assert.deepEqual(provider.capabilities(), {
		kind: "desktop",
		lifetime: "vendor",
		network: ["none"],
		networkReadBack: true,
		isolation: "microvm",
		os: "linux",
		daemon: "child",
		groups: DESKTOP_GROUPS,
		maxLifetimeMs: 24 * HOUR,
		release: ["delete"],
		mount: ["archil"],
		vendorAgentPorts: [7777],
	});
	assert.deepEqual(setup().provider.capabilities().groups, LINUX_GROUPS, "linux by default");
	assert.equal(provider.id, "fakehost");
	assert.equal(provider.version, VERSION);
	assert.equal(typeof provider.extend, "function", "extend with a vendor timer");
	assert.equal(setup({}, { facts: { lifetime: "janitor" } }).provider.extend, undefined, "no extend where the deadline cannot follow it");
	assert.throws(() => setup({ maxLifetimeMs: 25 * HOUR }), /at most 86400000 ms, the longest Fakehost keeps a computer/);
	assert.throws(() => setup({ daemonUser: "0:0" }), /root or in root's group/);
});

test("check() refuses, with no host call, what no hosted computer is: open, an allowlist, sizes, a user, a workdir, the adapter's own labels, a lifetime past the cap", () => {
	const { provider, fake } = setup({ maxLifetimeMs: HOUR });
	assert.deepEqual(provider.check({ ...SPEC, labels: { run: "r1" } }), []);
	const fields = (spec) => provider.check(spec).map((r) => r.field);
	assert.deepEqual(fields({ ...SPEC, image: "" }), ["image"]);
	assert.deepEqual(fields({ ...SPEC, network: "open" }), ["network"]);
	assert.deepEqual(fields({ ...SPEC, network: { allow: ["example.com"] } }), ["network"]);
	for (const field of ["cpus", "memoryMb", "pids", "workdir"]) assert.deepEqual(fields({ ...SPEC, [field]: field === "workdir" ? "/tmp" : 2 }), [field]);
	assert.deepEqual(fields({ ...SPEC, user: "0" }), ["user"]);
	assert.deepEqual(fields({ ...SPEC, labels: { [COMPUTER]: "2" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, labels: { [`${COMPUTER}.x`]: "2" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, gpu: { type: "H100", count: 1 } }), ["gpu"]);
	assert.deepEqual(provider.check({ ...SPEC, lifetimeMs: HOUR + 1 }), checkLifetime(HOUR + 1, provider.capabilities()));
	assert.deepEqual(fields({ ...SPEC, owner: { agent: "a1" } }), ["owner"], "no persistence: an owner is refused");
	assert.deepEqual(fake.calls, []);
});

test("a host's own rules (check), label budget and label names are held at check()", () => {
	const { provider } = setup({}, { facts: { labelRules: { max: 7, key: /^[a-z]+$/ } } });
	assert.deepEqual(provider.check({ ...SPEC, labels: { a: "1", b: "2" } }), []);
	assert.match(provider.check({ ...SPEC, labels: { a: "1", b: "2", c: "3" } })[0].message, /takes 7 labels, 5 of them the provider's own: 3 is 1 too many/);
	assert.match(provider.check({ ...SPEC, labels: { "A.b": "1" } })[0].message, /is not one the vendor takes/);
	const fake = fakeHost();
	const strict = hostedProvider({ ...fake.host, check: (spec) => (spec.image === "bad" ? [{ field: "image", message: "not a vendor image" }] : []) }, { label: "Fakehost", daemonPath: DAEMON_PATH });
	assert.deepEqual(strict.check({ ...SPEC, image: "bad" }), [{ field: "image", message: "not a vendor image" }]);
	// The host's check is given an object, whatever the caller gave: it reads the fields with no check of its own.
	for (const given of [null, undefined, "img", 7]) assert.deepEqual(strict.check(given).find(({ field }) => field === "image")?.message, "an image is required: the name of a Fakehost image", String(given));
});

// --- create ---

test("create needs a request id: none, an empty one or one with a NUL is invalid, with no host call", async () => {
	const { provider, fake } = setup();
	for (const context of [undefined, {}, { requestId: "" }, { requestId: 7 }, { requestId: "a\0b" }]) {
		const refused = await provider.create(SPEC, context);
		assert.equal(refused.ok, false);
		assert.equal(refused.error.code, "invalid", JSON.stringify(context));
		assert.match(refused.error.message, /requestId/);
	}
	assert.deepEqual(fake.calls, []);
});

test("create names the computer from its request id, makes the machine with the labels, the lifetime and network none, then upload, install, start and the read-back", async () => {
	const { provider, fake } = setup({ kind: "desktop" });
	const ref = made(await provider.create({ ...SPEC, labels: { team: "a" } }, { requestId: "claim-1#3" }));
	assert.equal(ref.name, `computer-${createHash("sha256").update("claim-1#3").digest("hex").slice(0, 12)}`);
	assert.equal(ref.name, nameOf("claim-1#3"));
	assert.deepEqual(ref.notes, [INSTALLER_NOTE, ACCEPTED_NOTE]);
	const m = only(fake);
	const { request } = m;
	assert.equal(request.name, ref.name);
	assert.equal(request.lifetimeMs, 600_000);
	assert.equal(request.network, "none");
	assert.equal(request.command, undefined, "a child host's machine runs the vendor's own first process");
	assert.equal(request.labels.team, "a");
	assert.equal(request.labels[COMPUTER], "1");
	assert.equal(request.labels[NAME], ref.name);
	assert.equal(request.labels["agentrun.computer.image"], "img");
	assert.ok(Date.parse(request.labels[DEADLINE]) > Date.now());
	assert.deepEqual(m.daemon.bytes, DAEMON_BYTES);
	assert.equal(m.daemon.atomic, false, "a child daemon is installed in place");
	assert.equal(m.init.user, "2510:2510");
	assert.equal(m.init.display, ":0");
	assert.equal(m.init.max, request.labels[MAX]);
	const runs = runsOf(fake, m.id);
	assert.deepEqual(runs.slice(0, 3), ["run install", "run start", "run stdio"], "the daemon installed, init started detached, then the bridge");
	assert.ok(runs.includes("daemon process.start"), "the X server started through the daemon");
	assert.ok(runs.includes("daemon exec.run"), "the probe ran");
	assert.deepEqual(fake.uploads.map(({ through }) => through), ["upload"], "the daemon went in through the host's file API");
});

test("a child host's own sockets (vendorSockets) are closed to the computer's user before init starts, and said in the notes; one that will not close refuses the computer", async () => {
	const sockets = ["/tmp/dbus-Y8OW6E3FDx", "/tmp/dbus-AAAAAAAAAA", "/tmp/.X11-unix/X0", "/tmp/sub/dbus-nested"];
	const { provider, fake } = setup({}, { facts: { vendorSockets: ["/tmp/dbus-*"] }, sockets });
	const ref = made(await create(provider));
	assert.deepEqual(ref.notes, [INSTALLER_NOTE, "Fakehost's own sockets closed to the computer's user: /tmp/dbus-AAAAAAAAAA, /tmp/dbus-Y8OW6E3FDx", ACCEPTED_NOTE]);
	const runs = runsOf(fake, only(fake).id);
	assert.deepEqual(runs.slice(0, 4), ["run install", "run sockets", "run start", "run stdio"], "closed after the install, before init starts");
	assert.deepEqual(hostedCommands({ vendorSockets: ["/tmp/dbus-*"] }).sockets?.slice(4), ["/tmp/dbus-*"], "each pattern one argument, as given");
	const none = setup({}, { facts: { vendorSockets: ["/tmp/dbus-*"] } });
	assert.equal(made(await create(none.provider)).notes[1], "Fakehost's own sockets closed to the computer's user: none found (/tmp/dbus-*)");
	const failing = setup({}, { facts: { vendorSockets: ["/tmp/dbus-*"] }, sockets, socketsFail: "/tmp/dbus-Y8OW6E3FDx" });
	const refused = await create(failing.provider);
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /closing Fakehost's own sockets to the computer's user failed \(exit 1\): closed \/tmp\/dbus-AAAAAAAAAA\nfailed \/tmp\/dbus-Y8OW6E3FDx/);
	assert.ok(!failing.fake.events.some(({ what }) => what === "run start"), "init never started");
	await nothingLeft(failing.fake, "a computer whose vendor sockets would not close");
	const plain = setup();
	made(await create(plain.provider));
	assert.ok(!runsOf(plain.fake, only(plain.fake).id).includes("run sockets"), "a host that names none runs no sockets script");
	assert.equal(hostedCommands().sockets, undefined);
	const pid1 = setup({}, { facts: { ...USER_FACTS, vendorSockets: ["/tmp/dbus-*"] }, sockets });
	made(await create(pid1.provider));
	assert.ok(!runsOf(pid1.fake, only(pid1.fake).id).includes("run sockets"), "a pid1 host's init is its main process: no sockets script");
});

test("the sockets script, run by sh: each socket a pattern names loses others' access (owner and group keep theirs), a link or a file is left alone, and it says each", () => {
	const root = mkdtempSync(join(tmpdir(), "computer-sockets-"));
	try {
		// Not root here: the script reaches root through sudo -n, which this stand-in runs as it is.
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "sudo"), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n', { mode: 0o755 });
		const bind = (path) => {
			execFileSync("python3", ["-I", "-c", "import socket, sys\ns = socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[1])", path]);
			chmodSync(path, 0o777);
		};
		const bus = join(root, "dbus-Y8OW6E3FDx");
		const other = join(root, "agentrun.sock");
		const target = join(root, "target.sock");
		for (const path of [bus, other, target]) bind(path);
		symlinkSync(target, join(root, "dbus-link"));
		writeFileSync(join(root, "dbus-file"), "");
		chmodSync(join(root, "dbus-file"), 0o666);
		const argv = hostedCommands({ vendorSockets: [`${root}/dbus-*`, `${root}/absent-*`] }).sockets;
		const out = execFileSync(argv[0], argv.slice(1), { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
		assert.equal(out, `closed ${bus}\n`);
		assert.equal(statSync(bus).mode & 0o777, 0o770, "others lose read, write and search; the owner and group keep theirs");
		assert.equal(statSync(other).mode & 0o777, 0o777, "a socket no pattern names is left alone");
		assert.equal(statSync(target).mode & 0o777, 0o777, "a link is never followed");
		assert.equal(statSync(join(root, "dbus-file")).mode & 0o777, 0o666, "a file that is not a socket is left alone");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a host with no file API gets the daemon through exec's stdin", async () => {
	const { provider, fake } = setup({}, { fileApi: false });
	made(await create(provider));
	assert.deepEqual(fake.uploads.map(({ through }) => through), ["exec"]);
	assert.deepEqual(only(fake).daemon.bytes, DAEMON_BYTES);
});

test("create waits while the machine starts, and until the listing shows it twice", async () => {
	const { provider, fake } = setup({}, { starting: 3, unlisted: 2 });
	made(await create(provider));
	const m = only(fake);
	assert.equal(m.state, "running");
	assert.ok(fake.calls.filter(([name]) => name === "list").length >= 4, "the listing by name first, then until it showed the machine twice");
});

test("create's listing wait needs two consecutive polls that show the machine: one shown, then not, starts over", async () => {
	// The first listing after the vendor's answer is the convergence read; the wait's own polls follow, shown or not in turn.
	const { provider, fake } = setup({}, { flaps: [true, true, false, true, false, true, true] });
	made(await create(provider));
	assert.deepEqual(only(fake).flaps, [], "the wait went on past a lone poll that showed it, until two in a row did");
});

test("create's listing wait holds a stability window: the polls that show the machine span at least listedStableMs", async () => {
	const { provider, fake } = setup({ timeouts: { ...TIMEOUTS, listedStableMs: 60 } });
	made(await create(provider));
	const lists = fake.calls.filter(([name]) => name === "list").length;
	// The name's listing, the convergence read before and after, and polls 5 ms apart until 60 ms passed: well over two.
	assert.ok(lists >= 6, `the wait polled on until the window passed (${lists} listings)`);
	assert.throws(() => setup({ timeouts: { ...TIMEOUTS, listedStableMs: -1 } }), /timeouts\.listedStableMs must be a whole number of ms 0 or more/);
});

test("idempotent create: a retry of one request returns the computer the first made, and never makes a second", async () => {
	const { provider, fake } = setup();
	const first = made(await provider.create(SPEC, { requestId: "run-a#1" }));
	const again = made(await provider.create(SPEC, { requestId: "run-a#1" }));
	assert.deepEqual({ id: again.id, name: again.name }, { id: first.id, name: first.name });
	assert.equal(fake.creates(), 1);
	const other = made(await provider.create(SPEC, { requestId: "run-a#2" }));
	assert.notEqual(other.id, first.id, "another request is another computer");
	assert.equal(fake.creates(), 2);
});

test("create races: two creates of one request at once make one machine, and both answer it", async () => {
	const { provider, fake } = setup();
	const [a, b] = await Promise.all([provider.create(SPEC, { requestId: "race" }), provider.create(SPEC, { requestId: "race" })]);
	assert.deepEqual(made(a), made(b));
	assert.equal(fake.creates(), 1);
	assert.equal(fake.machines.size, 1);
});

test("create races: a second create of a request in flight with another spec is refused as exists, whatever the timing; the same spec shares the first's answer", async () => {
	const { provider, fake } = setup({}, { facts: USER_FACTS });
	const requestId = "race-users";
	const [a, b, c] = await Promise.all([
		provider.create({ ...SPEC, user: "1000:1000" }, { requestId }),
		provider.create({ ...SPEC, user: "2000:2000" }, { requestId }),
		provider.create({ ...SPEC, user: "1000" }, { requestId }),
	]);
	const first = made(a);
	assert.equal(b.error?.code, "exists", "another user, while the first is in flight");
	assert.match(b.error.message, /is being made for this request with another spec, so it is not returned: user: asked 2000:2000, in flight 1000:1000; create with a new request id/);
	assert.deepEqual(made(c), first, "1000 is 1000:1000: the same spec shares the answer");
	assert.equal(fake.creates(), 1);
	// After it is made, the same refusal, as #again reads it back.
	const later = await provider.create({ ...SPEC, user: "2000:2000" }, { requestId });
	assert.equal(later.error?.code, "exists");
	// Labels too, as #again holds a listed computer to them.
	const plain = setup();
	const [x, y] = await Promise.all([plain.provider.create(SPEC, { requestId: "race-labels" }), plain.provider.create({ ...SPEC, labels: { team: "b" } }, { requestId: "race-labels" })]);
	made(x);
	assert.equal(y.error?.code, "exists");
	assert.match(y.error.message, /labels team: in flight, never asked for|label team: asked "b", in flight nothing/);
	assert.equal(plain.fake.creates(), 1);
});

test("a retry from another provider instance finds the machine still starting, waits until it is up, and returns it", async () => {
	const fake = fakeHost();
	const first = hostedProvider(fake.host, { label: "Fakehost", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const second = hostedProvider(fake.host, { label: "Fakehost", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const starting = fake.add({ labels: { [COMPUTER]: "1", [NAME]: nameOf("other-instance"), [DEADLINE]: new Date(Date.now() + 600_000).toISOString(), [MAX]: new Date(Date.now() + HOUR).toISOString(), "agentrun.computer.image": "img" }, state: "starting", startingReads: 2 });
	const pending = second.create(SPEC, { requestId: "other-instance" });
	// The first instance's create brings init up a moment later.
	setTimeout(() => {
		starting.daemon = { path: DAEMON, bytes: DAEMON_BYTES };
		starting.init = { deadline: starting.labels[DEADLINE], user: "2510:2510", display: "", max: starting.labels[MAX] };
	}, 30);
	const found = made(await pending);
	assert.equal(found.id, starting.id);
	assert.equal(fake.creates(), 0, "no second machine");
	void first;
});

test("two provider instances racing one request each make a machine; both converge on the oldest, the other is deleted and read back gone, and both answer the one kept", async () => {
	for (const [what, born, keptIndex] of [
		["by creation time: the machine made second is the older", (n) => new Date(Date.UTC(2026, 0, 1) - n * 1_000), 1],
		["with no creation time: the lowest id", () => undefined, 0],
	]) {
		const fake = fakeHost({ create: "hold", born, lingers: { reads: 1, lists: 1 } });
		const one = hostedProvider(fake.host, { label: "Fakehost", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
		const two = hostedProvider(fake.host, { label: "Fakehost", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
		// Both read the name's listing and find nothing, then both creates are in flight at the vendor.
		const pending = [one.create(SPEC, { requestId: "two-instances" }), two.create(SPEC, { requestId: "two-instances" })];
		for (let i = 0; i < 100 && fake.creates() < 2; i++) await new Promise((done) => setImmediate(done));
		assert.equal(fake.creates(), 2, `${what}: both instances called the vendor's create`);
		await fake.release();
		const [a, b] = await Promise.all(pending);
		const made2 = [...fake.machines.values()];
		assert.equal(made2.length, 2, `${what}: two machines were made`);
		const kept = made2[keptIndex];
		assert.equal(made(a).id, kept.id, `${what}: the first instance answers the one kept`);
		assert.equal(made(b).id, kept.id, `${what}: the second instance answers the one kept`);
		assert.deepEqual(fake.live().map((m) => m.id), [kept.id], `${what}: the other was deleted`);
		const listed = await fake.host.list({ [NAME]: nameOf("two-instances") }, { timeoutMs: 1_000 });
		assert.deepEqual(listed.value.map((m) => m.id), [kept.id], `${what}: and is no longer listed`);
		assert.ok(kept.init !== undefined, `${what}: the one kept was brought up`);
	}
});

test("a retry of a request whose computer ended, stopped or was deleted is refused as exists, in words; one made with other labels too", async () => {
	const { provider, fake } = setup();
	const ref = made(await provider.create(SPEC, { requestId: "ends" }));
	made(await provider.release(ref, "delete").then((r) => (r.ok ? { ok: true, value: r } : r)));
	const again = await provider.create(SPEC, { requestId: "ends" });
	assert.equal(again.error?.code, "exists");
	assert.match(again.error.message, new RegExp(`${ref.name} was made for this request and has ended: create with a new request id`));
	const labels = { [COMPUTER]: "1", [DEADLINE]: new Date(Date.now() + 600_000).toISOString(), [MAX]: new Date(Date.now() + HOUR).toISOString(), "agentrun.computer.image": "img" };
	fake.add({ labels: { ...labels, [NAME]: nameOf("stopped") }, state: "stopped" });
	assert.equal((await provider.create(SPEC, { requestId: "stopped" })).error?.code, "exists");
	fake.add({ labels: { ...labels, [NAME]: nameOf("past"), [DEADLINE]: new Date(Date.now() - 1_000).toISOString() } });
	assert.equal((await provider.create(SPEC, { requestId: "past" })).error?.code, "exists");
	fake.add({ labels: { ...labels, [NAME]: nameOf("other"), team: "b" } });
	const other = await provider.create({ ...SPEC, labels: { team: "a" } }, { requestId: "other" });
	assert.equal(other.error?.code, "exists");
	assert.match(other.error.message, /with another spec/);
	assert.equal(fake.creates(), 1, "never a second machine under one name");
});

test("a retry is held to the size its computer reads back where the vendor takes one in a spec: another is refused as exists", async () => {
	const { provider, fake } = setup({}, { facts: { specFields: ["cpus", "memoryMb"] }, size: { cpus: 2, memoryMb: 4096 } });
	const spec = { ...SPEC, cpus: 2, memoryMb: 4096 };
	const ref = made(await provider.create(spec, { requestId: "sized" }));
	const bigger = await provider.create({ ...spec, cpus: 4 }, { requestId: "sized" });
	assert.equal(bigger.error?.code, "exists");
	assert.match(bigger.error.message, new RegExp(`${ref.name} was made for this request with another spec, so it is not returned: cpus: asked 4, read back 2`));
	assert.equal(made(await provider.create(spec, { requestId: "sized" })).id, ref.id, "the same spec gets the same computer");
	assert.equal(made(await provider.create(SPEC, { requestId: "sized" })).id, ref.id, "a size the spec leaves out is the vendor's default");
	assert.equal(fake.creates(), 1, "never a second machine under one name");
});

test("a retry is held to the GPUs its computer reads back: a GPU request that finds its computer made without one, or the other way round, is refused as exists", async () => {
	const H100 = { type: "H100", count: 1 };
	const { provider, fake } = setup({}, { facts: { gpu: { types: ["H100"], max: 1 } } });
	const plain = made(await provider.create(SPEC, { requestId: "cpu-first" }));
	const gpu = await provider.create({ ...SPEC, gpu: H100 }, { requestId: "cpu-first" });
	assert.equal(gpu.error?.code, "exists", "a GPU request never gets the computer made without one");
	assert.match(gpu.error.message, new RegExp(`${plain.name} was made for this request with another spec, so it is not returned: gpu: asked \\{"type":"H100","count":1\\}, read back nothing`));
	const withGpu = made(await provider.create({ ...SPEC, gpu: H100 }, { requestId: "gpu-first" }));
	const none = await provider.create(SPEC, { requestId: "gpu-first" });
	assert.equal(none.error?.code, "exists", "a request without a GPU never gets the GPU computer");
	assert.match(none.error.message, /gpu: asked nothing, read back \{"type":"H100","count":1\}/);
	assert.equal(made(await provider.create({ ...SPEC, gpu: H100 }, { requestId: "gpu-first" })).id, withGpu.id, "the same spec gets the same computer");
	assert.equal(made(await provider.create(SPEC, { requestId: "cpu-first" })).id, plain.id);
	assert.equal(fake.creates(), 2, "never a second machine under one name");
});

test("a retry from a restarted provider, of a sized request on a host that takes sizes but reads none back (Modal), finds the computer the first made", async () => {
	const fake = fakeHost({ facts: { specFields: ["cpus", "memoryMb"] } });
	const spec = { ...SPEC, cpus: 4, memoryMb: 8192 };
	const before = hostedProvider(fake.host, { label: "Fakehost", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const ref = made(await before.create(spec, { requestId: "sized-unread" }));
	const after = hostedProvider(fake.host, { label: "Fakehost", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	assert.equal(made(await after.create(spec, { requestId: "sized-unread" })).id, ref.id, "a size read back as nothing is not a drift");
	assert.equal(fake.creates(), 1, "never a second machine under one name");
});

test("a retry from a restarted provider, of a GPU request on a host that reads no GPUs back (Modal), finds the computer the first made", async () => {
	const H100 = { type: "H100", count: 1 };
	const fake = fakeHost({ facts: { gpu: { types: ["H100"], max: 1 }, gpuReadBack: false } });
	const before = hostedProvider(fake.host, { label: "Fakehost", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const ref = made(await before.create(SPEC, { requestId: "gpu-unread" }));
	const after = hostedProvider(fake.host, { label: "Fakehost", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	assert.equal(made(await after.create({ ...SPEC, gpu: H100 }, { requestId: "gpu-unread" })).id, ref.id, "GPUs the vendor reads none of are not a drift");
	assert.equal(fake.creates(), 1, "never a second machine under one name");
});

test("a retry that finds a desktop running whose display is not up yet waits for it within createMs; one that never comes up as declared is exists after createMs", async () => {
	const labels = (request) => ({ [COMPUTER]: "1", [NAME]: nameOf(request), [DEADLINE]: new Date(Date.now() + 600_000).toISOString(), [MAX]: new Date(Date.now() + HOUR).toISOString(), "agentrun.computer.image": "img" });
	const up = (m) => {
		m.daemon = { path: DAEMON, bytes: DAEMON_BYTES };
		m.init = { deadline: m.labels[DEADLINE], user: "2510:2510", display: ":0", max: m.labels[MAX] };
	};
	const { provider, fake } = setup({ kind: "desktop", timeouts: { ...TIMEOUTS, createMs: 600 } });
	// The first create's init answers, and its X server is still starting: hello says linux, with no screen.
	const starting = fake.add({ labels: labels("desktop-retry") });
	up(starting);
	let reads = 0;
	const reading = fake.host.get;
	fake.host.get = async (id, ctx) => {
		if (id === starting.id && ++reads === 3) starting.displayUp = true;
		return reading(id, ctx);
	};
	const found = made(await provider.create(SPEC, { requestId: "desktop-retry" }));
	assert.equal(found.id, starting.id, "returned once the display was up");
	assert.ok(fake.requests.filter(({ machine, method }) => machine === starting.id && method === "hello").length >= 2, "hello was read again while it came up");
	fake.host.get = reading;
	// One whose daemon never reports the declared screen: refused as exists, after createMs, in words.
	const never = fake.add({ labels: labels("desktop-never") });
	up(never);
	const before = Date.now();
	const refused = await provider.create(SPEC, { requestId: "desktop-never" });
	assert.equal(refused.error?.code, "exists");
	assert.match(refused.error.message, /was made for this request, and after 0\.6 s still/);
	assert.ok(Date.now() - before >= 400, "it waited within createMs before it refused");
	assert.equal(fake.creates(), 0, "never a second machine");
});

test("a create the host refused makes nothing and deletes nothing", async () => {
	const { provider, fake } = setup({}, { create: "fail" });
	const refused = await create(provider);
	assert.equal(refused.error?.code, "invalid");
	assert.equal(fake.machines.size, 0);
	assert.deepEqual(fake.events.filter(({ what }) => what === "delete"), []);
});

test("a create whose answer is lost or broken is swept by its name: the machine it made is deleted and read back gone", async () => {
	// Broken (a 5xx whose machine was made anyway): swept before create answers.
	const broken = setup({}, { create: "broken" });
	const failed = await create(broken.provider);
	assert.equal(failed.error?.code, "vendor");
	assert.match(failed.error.message, /deleted and read back gone/);
	await nothingLeft(broken.fake, "a broken create");
	// Lost (the call timed out: its answer never comes): create answers at once, and the sweep by name goes on after.
	const lost = setup({}, { create: "lost" });
	const timedOut = await create(lost.provider);
	assert.equal(timedOut.error?.code, "timeout");
	assert.match(timedOut.error.message, /deleted as it lands/);
	for (let i = 0; i < 100 && lost.fake.live().length > 0; i++) await new Promise((done) => setTimeout(done, 10));
	await nothingLeft(lost.fake, "a lost create");
});

test("a create that lands after an abort is deleted as it lands", async () => {
	const { provider, fake } = setup({}, { create: "hold" });
	const controller = new AbortController();
	const pending = create(provider, SPEC, { signal: controller.signal });
	await new Promise((done) => setTimeout(done, 10));
	controller.abort();
	const aborted = await pending;
	assert.equal(aborted.error?.code, "aborted");
	assert.match(aborted.error.message, /deleted as it lands/);
	await fake.release();
	await new Promise((done) => setTimeout(done, 50));
	await nothingLeft(fake, "a late create");
});

test("nothing left behind: a failure or an abort at any step after the machine exists deletes it and waits until it is gone", async () => {
	const cases = [
		["an installed sha256 that does not match", { sha: "lie" }, /uploaded sha256/],
		["an install that fails", { install: 5 }, /installing the daemon failed/],
		["init that never listens", { initFails: "computerd: init: no such user" }, /init wrote: computerd: init: no such user/],
		["an X server that dies", { display: "dies" }, /X server/],
		["the vendor's own drift", { drift: ["lifecycle onTimeout: declared \"kill\", read back \"pause\""] }, /onTimeout/],
		["a network read back open", { network: "open" }, /network: declared none, read back open/],
		["a daemon's network holding more than its loopback", { box: { interfaces: ["lo", "eth0"] } }, /daemon network/],
		["a probe target that answers", { box: { reached: ["1.1.1.1:443"] } }, /1\.1\.1\.1:443/],
		["a daemon of another uid", { box: { status: { Uid: "0\t0\t0\t0" } } }, /daemon user/],
	];
	for (const [what, fakeOptions, words] of cases) {
		const { provider, fake } = setup({ kind: "desktop" }, { lingers: { reads: 1, lists: 1 }, ...fakeOptions });
		const failed = await create(provider);
		assert.equal(failed.ok, false, what);
		assert.match(failed.error.message, words, what);
		assert.match(failed.error.message, /was deleted/, what);
		await nothingLeft(fake, what);
	}
	for (const step of ["get", "upload", "exec install", "exec start", "exec stdio", "hello", "exec.run", "list"]) {
		const controller = new AbortController();
		let seen = 0;
		const { provider, fake } = setup({}, { onStep: (name) => (name === step && ++seen === (step === "list" ? 2 : 1) ? controller.abort() : undefined) });
		const aborted = await create(provider, SPEC, { signal: controller.signal });
		assert.equal(aborted.error?.code, "aborted", `an abort at ${step}: ${aborted.error?.message}`);
		await nothingLeft(fake, `an abort at ${step}`);
	}
});

test("a process whose kill never settles holds up nothing: an aborted install still reaches the machine's delete", { timeout: 20_000 }, async () => {
	const controller = new AbortController();
	const { provider, fake } = setup(
		{ timeouts: { ...TIMEOUTS, execMs: 200 } },
		// The install never ends, and its kill never answers (a vendor's remote kill that stalls); the abort comes once
		// the install is running.
		{ hang: "install", killHangs: true, onStep: (name) => (name === "exec install" ? setImmediate(() => controller.abort()) : undefined) },
	);
	const aborted = await create(provider, SPEC, { signal: controller.signal });
	assert.equal(aborted.error?.code, "aborted", aborted.error?.message);
	const m = only(fake);
	assert.ok(runsOf(fake, m.id).includes("kill install"), "the install was killed");
	assert.equal(m.deleted, true, "and the machine deleted all the same");
});

test("create tries the bridge again while init is not yet listening", async () => {
	const { provider, fake } = setup({}, { notListening: 2 });
	made(await create(provider));
	assert.ok(fake.bridges >= 3);
});

// --- the deadline ---

test("a lifetime past the cap is refused before any host call; extend moves the vendor's timer, then init's deadline, never earlier, never past the cap", async () => {
	const { provider, fake } = setup({ maxLifetimeMs: HOUR });
	const refused = await create(provider, { ...SPEC, lifetimeMs: HOUR + 1 });
	assert.equal(refused.error?.code, "refused");
	assert.deepEqual(fake.calls, []);
	const ref = made(await create(provider));
	const m = only(fake);
	const before = Date.parse(m.init.deadline);
	const longer = made(await provider.extend(ref, 20 * 60_000));
	assert.ok(longer.deadline.getTime() > before);
	assert.equal(m.init.deadline, longer.deadline.toISOString(), "init took the end the vendor read back");
	assert.equal(m.endsAt.toISOString(), longer.deadline.toISOString());
	const timers = () => fake.calls.filter(([name]) => name === "setTimer").length;
	const timersBefore = timers();
	const shorter = await provider.extend(ref, 60_000);
	assert.equal(shorter.error?.code, "refused", "an extend to an earlier deadline is refused");
	assert.match(shorter.error.message, /earlier/);
	assert.equal(timers(), timersBefore, "the vendor's timer was never called");
	assert.equal(m.init.deadline, longer.deadline.toISOString(), "the deadline did not move");
	const past = await provider.extend(ref, 2 * HOUR);
	assert.equal(past.error?.code, "limit");
	assert.match(past.error.message, /the most this computer may live/);
	assert.equal(m.init.deadline, longer.deadline.toISOString(), "nothing moved");
	const listed = made(await provider.list({}));
	assert.equal(listed[0].deadline.toISOString(), longer.deadline.toISOString(), "list reads the moved timer as the deadline");
});

test("two extends of one computer run one after the other; a timer the vendor refuses moves nothing", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	const order = [];
	const [a, b] = await Promise.all([provider.extend(ref, 30 * 60_000).then((r) => (order.push("a"), r)), provider.extend(ref, 20 * 60_000).then((r) => (order.push("b"), r))]);
	assert.deepEqual(order, ["a", "b"]);
	assert.equal(b.error?.code, "refused", "the shorter, after the longer, is refused");
	assert.ok(made(a).deadline.getTime() > Date.now() + 25 * 60_000, "the longer moved the deadline");
	const refusing = setup({}, { timer: "limit" });
	const ref2 = made(await create(refusing.provider));
	const m = only(refusing.fake);
	const at = m.init.deadline;
	const refused = await refusing.provider.extend(ref2, 30 * 60_000);
	assert.equal(refused.error?.code, "limit");
	assert.equal(m.init.deadline, at);
	void fake;
});

// --- release ---

test("release delete deletes the machine and waits until the host reads it gone and no longer lists it", async () => {
	const { provider, fake } = setup({}, { lingers: { reads: 2, lists: 2 } });
	const ref = made(await create(provider));
	made(await provider.release(ref, "delete").then((r) => (r.ok ? { ok: true, value: true } : r)));
	await nothingLeft(fake, "release");
	assert.equal((await provider.release(ref, "delete")).ok, true, "idempotent: a machine gone is ok");
});

test("release is bounded by goneMs and the caller's signal while it waits, saying what it last read", async () => {
	const { provider } = setup({}, { lingers: { reads: 10_000, lists: 0 } });
	const ref = made(await create(provider));
	const slow = await provider.release(ref, "delete");
	assert.equal(slow.error?.code, "timeout");
	assert.match(slow.error.message, /read it running/);
});

test("release never touches a machine that is not this provider's, and refuses stop and detach in words", async () => {
	const { provider, fake } = setup();
	const stranger = fake.add({ labels: { team: "x" } });
	const left = await provider.release({ id: stranger.id, name: "computer-0123456789ab" }, "delete");
	assert.equal(left.error?.code, "not_found");
	assert.equal(stranger.deleted, false, "left as it is");
	const ref = made(await create(provider));
	assert.equal((await provider.release(ref, "stop")).error?.code, "unsupported");
	assert.equal((await provider.release(ref, "detach")).error?.code, "unsupported");
	assert.equal(fake.live().length, 2);
	assert.equal((await provider.connect({ id: stranger.id, name: "computer-0123456789ab" })).error?.code, "not_found");
});

test("release stop, where the host declares it: the host only asks, and the adapter waits until get and the listing read it stopped, asking again while it reads running; it keeps the machine; never another's; no stop hook is unsupported", async () => {
	const { provider, fake } = setup({}, { facts: { release: ["stop", "delete"], stopDeletes: false } });
	const asks = [];
	let lost = 1;
	fake.host.stop = async (id, ctx) => {
		asks.push([id, ctx.timeoutMs]);
		// The first ask is lost: the machine reads running still, so the adapter asks again.
		if (lost-- <= 0) Object.assign(fake.machines.get(id), { state: "stopping", stoppingReads: 3 });
		return { ok: true, value: undefined };
	};
	const reading = fake.host.get;
	fake.host.get = async (id, ctx) => {
		const m = fake.machines.get(id);
		if (m?.state === "stopping" && --m.stoppingReads <= 0) m.state = "stopped";
		return reading(id, ctx);
	};
	assert.deepEqual(provider.capabilities().release, ["stop", "delete"]);
	const ref = made(await create(provider));
	assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
	assert.equal(fake.machines.get(ref.id).state, "stopped", "answered once the machine read stopped, not once the host took the ask");
	assert.deepEqual(asks, [[ref.id, TIMEOUTS.requestMs], [ref.id, TIMEOUTS.requestMs]], "asked again while it read running, each ask bounded by requestMs");
	assert.equal(fake.live().length, 1, "a stop keeps the machine");
	assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
	assert.equal(asks.length, 2, "a machine that reads stopped is not asked");
	const stranger = fake.add({ labels: { team: "x" } });
	assert.equal((await provider.release({ id: stranger.id, name: "computer-0123456789ab" }, "stop")).error?.code, "not_found");
	assert.equal(asks.length, 2, "another's machine is never stopped");
	// One that goes to failed ends the wait; one that never reads stopped is bounded by goneMs, saying what it last read.
	fake.host.stop = async (id) => ((fake.machines.get(id).state = "failed"), { ok: true, value: undefined });
	const failed = await provider.release(made(await create(provider)), "stop");
	assert.equal(failed.error?.code, "vendor");
	assert.match(failed.error.message, /went to failed/);
	fake.host.stop = async (id) => (Object.assign(fake.machines.get(id), { state: "stopping", stoppingReads: Number.POSITIVE_INFINITY }), { ok: true, value: undefined });
	const slow = await provider.release(made(await create(provider)), "stop");
	assert.equal(slow.error?.code, "timeout");
	assert.match(slow.error.message, /read it stopping/);
	fake.host.stop = async () => ({ ok: false, error: { code: "denied", message: "the key may not stop it" } });
	assert.equal((await provider.release(made(await create(provider)), "stop")).error?.code, "denied", "a stop the vendor refused is the answer");
	delete fake.host.stop;
	assert.equal((await provider.release(ref, "stop")).error?.code, "unsupported", "declared, but with no stop hook: unsupported");
});

test("release stop of a computer whose stop deletes it (stopDeletes, or a GPU's where gpu.stopDeletes) waits until it is gone", async () => {
	const { provider, fake } = setup({}, { facts: { release: ["stop", "delete"], stopDeletes: false, gpu: { types: ["H100"], max: 1, stopDeletes: true } } });
	fake.host.stop = async (id) => ((fake.machines.get(id).state = "stopped"), { ok: true, value: undefined });
	const reading = fake.host.get;
	fake.host.get = async (id, ctx) => {
		const m = fake.machines.get(id);
		// The vendor deletes a GPU machine a few reads after it stops.
		if (m?.request?.gpu !== undefined && m.state === "stopped" && !m.deleted && (m.reads = (m.reads ?? 0) + 1) >= 3) m.deleted = true;
		return reading(id, ctx);
	};
	const gpu = made(await create(provider, { ...SPEC, gpu: { type: "H100", count: 1 } }));
	assert.deepEqual(await provider.release(gpu, "stop"), { ok: true, value: undefined });
	assert.equal(fake.machines.get(gpu.id).deleted, true, "answered once the GPU computer was gone");
	const plain = made(await create(provider));
	assert.deepEqual(await provider.release(plain, "stop"), { ok: true, value: undefined });
	assert.equal(fake.machines.get(plain.id).deleted, false, "a computer with no GPU is kept, stopped");
	// A GPU computer that goes to failed on its stop ends the wait, as a kept one does, not at goneMs.
	fake.host.stop = async (id) => ((fake.machines.get(id).state = "failed"), { ok: true, value: undefined });
	const failed = await provider.release(made(await create(provider, { ...SPEC, gpu: { type: "H100", count: 1 } })), "stop");
	assert.equal(failed.error?.code, "vendor");
	assert.match(failed.error.message, /the stop of computer-[0-9a-f]{12}: it went to failed/);
});

// --- connect, list, attach, network ---

test("connect checks hello against the provider: one that drifted is refused; a stopped machine is refused without a bridge", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	const connected = made(await provider.connect(ref));
	assert.equal(connected.hello.version, VERSION);
	await connected.close();
	const m = only(fake);
	// Exact match: a daemon of another version, older or newer, and a daemon one protocol step ahead are each refused.
	m.box.helloPatch = { version: "0.0.0-other" };
	const older = await provider.connect(ref);
	assert.equal(older.error?.code, "refused");
	assert.match(older.error.message, new RegExp(`hello: the daemon reports version "?0\\.0\\.0-other"?, expected ${VERSION.replaceAll(".", "\\.")}`));
	m.box.helloPatch = { protocol: "0.3" };
	const ahead = await provider.connect(ref);
	assert.equal(ahead.error?.code, "refused");
	assert.match(ahead.error.message, /hello: the daemon speaks protocol 0\.3, expected exactly 0\.2/);
	m.state = "stopped";
	assert.equal((await provider.connect(ref)).error?.code, "refused");
});

test("connect to a machine the vendor reads as going (past its deadline or released, still being deleted) answers gone, not refused; releasing it again stays ok", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	only(fake).state = "going";
	const connected = await provider.connect(ref);
	assert.equal(connected.error?.code, "gone");
	assert.match(connected.error?.message ?? "", /going/);
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
});

test("list finds this provider's machines by labels; attach by id or labels reads the spec back; one that drifted is refused and left running", async () => {
	const { provider, fake } = setup();
	const a = made(await create(provider, { ...SPEC, labels: { team: "a" } }));
	made(await create(provider, { ...SPEC, labels: { team: "b" } }));
	fake.add({ labels: { team: "a" } });
	const listed = made(await provider.list({ team: "a" }));
	assert.deepEqual(listed.map((info) => info.ref), [{ id: a.id, name: a.name }]);
	assert.equal(listed[0].network, "none");
	assert.equal(listed[0].state, "running");
	const byId = made(await provider.attach({ id: a.id }));
	assert.deepEqual({ image: byId.spec.image, snapshot: byId.spec.snapshot, user: byId.spec.user, network: byId.spec.network, kind: byId.spec.kind }, { image: "img", snapshot: "img-id", user: "2510:2510", network: "none", kind: "linux" });
	assert.equal(made(await provider.attach({ labels: { team: "a" } })).id, a.id);
	assert.equal((await provider.attach({ labels: { team: "c" } })).error?.code, "not_found");
	fake.machines.get(a.id).box.interfaces = ["lo", "eth0"];
	const drifted = await provider.attach({ id: a.id });
	assert.equal(drifted.error?.code, "refused");
	assert.equal(fake.machines.get(a.id).deleted, false);
});

test("attach holds the vendor's own read-back drift as create does, and reports the size the vendor reads back", async () => {
	const sized = setup({}, { size: { cpus: 2, memoryMb: 4096 } });
	const ref = made(await create(sized.provider));
	const attached = made(await sized.provider.attach({ id: ref.id }));
	assert.deepEqual({ cpus: attached.spec.cpus, memoryMb: attached.spec.memoryMb }, { cpus: 2, memoryMb: 4096 });
	const { provider, fake } = setup();
	const other = made(await create(provider));
	assert.equal(made(await provider.attach({ id: other.id })).spec.cpus, undefined, "no size read back: none reported");
	// The vendor's own read-back goes wrong after create (the drift every read of it now gives): attach refuses it.
	const drifting = fakeHost({ drift: ['lifecycle onTimeout: declared "kill", read back "pause"'] });
	const reader = hostedProvider(drifting.host, { label: "Fakehost", daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const m = drifting.add({ labels: fake.machines.get(other.id).labels });
	Object.assign(m, { daemon: { path: DAEMON, bytes: DAEMON_BYTES }, init: { deadline: m.labels[DEADLINE], user: "2510:2510", display: "", max: m.labels[MAX] } });
	const refused = await reader.attach({ id: m.id });
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /lifecycle onTimeout: declared "kill", read back "pause"/);
	assert.equal(m.deleted, false, "left as it is");
});

test("create refuses a machine whose vendor timer already reads moved: no extend has run on it", async () => {
	const { provider, fake } = setup({}, { lingers: { reads: 0, lists: 0 } });
	const reading = fake.host.get;
	fake.host.get = async (id, ctx) => {
		const read = await reading(id, ctx);
		return read.ok && read.value ? { ok: true, value: { ...read.value, timerMoved: true } } : read;
	};
	const refused = await create(provider);
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /timer: declared the spec's lifetime, read back an end of .*later than create set it/);
	fake.host.get = reading;
	await nothingLeft(fake, "a moved timer at create");
});

test("network() reads the network back and refuses any change: it is fixed at create", async () => {
	const { provider } = setup();
	const ref = made(await create(provider));
	assert.equal(made(await provider.network(ref)), "none");
	assert.equal(made(await provider.network(ref, "none")), "none", "the network it already has answers ok");
	for (const policy of ["open", { allow: ["example.com"] }]) {
		const refused = await provider.network(ref, policy);
		assert.equal(refused.error?.code, "refused");
		assert.match(refused.error.message, /fixed at create/);
	}
});

test("testConnection lists by the adapter's label and counts this provider's machines, making nothing", async () => {
	const { provider, fake } = setup();
	made(await create(provider));
	fake.add({ labels: { [COMPUTER]: "1", [NAME]: "someone-else" } });
	assert.match(made(await provider.testConnection()).detail, /^Fakehost answered: 1 computer of this provider$/);
});

test("a listing as the vendor reads it (no network, more machines than carry the labels): list reads each one it keeps by get, attach and a retry find theirs, and testConnection counts with no get", async () => {
	const { provider, fake } = setup();
	const a = made(await provider.create({ ...SPEC, labels: { team: "a" } }, { requestId: "listing-a" }));
	made(await create(provider, { ...SPEC, labels: { team: "b" } }));
	// The listing filters by the adapter's label alone, and carries no network and none of the vendor's drift or timer.
	// stale: labels a listing older than get still shows.
	const listing = fake.host.list;
	const stale = new Map();
	fake.host.list = async (labels, ctx) => {
		const read = await listing({ [COMPUTER]: "1" }, ctx);
		return read.ok ? { ok: true, value: read.value.map(({ id, labels: carried, state, createdAt }) => ({ id, labels: stale.get(id) ?? carried, state, createdAt })) } : read;
	};
	const gets = () => fake.calls.filter(([name]) => name === "get").length;
	let before = gets();
	const listed = made(await provider.list({ team: "a" }));
	assert.deepEqual(listed.map((info) => [info.ref.id, info.network, info.state]), [[a.id, "none", "running"]]);
	assert.equal(gets() - before, 1, "one get: of the one computer kept");
	assert.equal(made(await provider.attach({ labels: { team: "a" } })).id, a.id);
	assert.equal(made(await provider.create({ ...SPEC, labels: { team: "a" } }, { requestId: "listing-a" })).id, a.id, "a retry reads its computer by get");
	before = gets();
	assert.match(made(await provider.testConnection()).detail, /^Fakehost answered: 2 computers of this provider$/);
	assert.equal(gets(), before, "Settings' test reads the listing alone");
	assert.equal(fake.creates(), 2);
	// A listing older than get: the labels get reads are the ones held to the filter.
	stale.set(a.id, { ...fake.machines.get(a.id).labels });
	fake.machines.get(a.id).labels.team = "c";
	assert.deepEqual(made(await provider.list({ team: "a" })), [], "relabelled since the listing: not team a");
	// A machine the vendor lost between the listing and the read (get is not_found) is left out, not a failed list.
	stale.delete(a.id);
	fake.machines.get(a.id).labels.team = "a";
	const read = fake.host.get;
	fake.host.get = async (id, ctx) => (id === a.id ? { ok: false, error: { code: "not_found", message: `${id} is gone` } } : read(id, ctx));
	assert.deepEqual(made(await provider.list({ team: "a" })), [], "gone since the listing: left out");
});

// --- Archil ---

const TOKEN = "tok-hosted-archil-0123456789abcdef";
const MOUNT = { kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", folder: "agents/a1/runs/r1/work", token: TOKEN };
const ARCHIL_SPEC = { image: "agentrun-archil", lifetimeMs: 600_000, network: "none", labels: { "agentrun.run": "r1", "agentrun.epoch": "3" }, mount: MOUNT };
const noToken = (value, what) => assert.ok(!JSON.stringify(value ?? null).includes(TOKEN), `${what} holds the token`);

test("Archil: install, then preflight, mount with the token on stdin alone, and serve, as root, before init starts; the mount read back; list reports it", async () => {
	const { provider, fake } = setup({}, { box: { reached: [] } });
	const ref = made(await create(provider, ARCHIL_SPEC));
	const m = only(fake);
	assert.equal(m.request.network, "open", "the vendor's network is root's, to reach Archil");
	const runs = runsOf(fake, m.id);
	const at = (what) => runs.indexOf(what);
	assert.ok(at("run install") < at("run preflight") && at("run preflight") < at("run mount") && at("run mount") < at("run serve") && at("run serve") < at("run start"), runs.join(", "));
	const mount = fake.rootRuns.find(({ verb }) => verb === "mount");
	assert.equal(mount.stdin.trim(), TOKEN, "the token on stdin");
	noToken(mount.argv, "the mount's argv");
	noToken(m.request, "the machine's request");
	noToken(ref, "the create's answer");
	const [info] = made(await provider.list({ "agentrun.run": "r1" }));
	assert.equal(info.network, "none", "the tools' network is init's own");
	assert.equal(info.mount.kind, "archil");
	noToken(info, "the listing");
});

test("Archil: a higher epoch fences the create: nothing mounted, init never starts, and the machine is deleted", async () => {
	const { provider, fake } = setup({}, { box: { reached: [] } });
	made(await create(provider, { ...ARCHIL_SPEC, labels: { "agentrun.run": "r1", "agentrun.epoch": "5" } }));
	const fenced = await create(provider, ARCHIL_SPEC);
	assert.equal(fenced.ok, false);
	noToken(fenced, "the refusal");
	const newest = [...fake.machines.values()].at(-1);
	assert.equal(newest.init, undefined, "init never started");
	assert.equal(newest.deleted, true);
});

test("Archil: a failed root step refuses in words that never hold the token, init never starts, and the machine is deleted", async () => {
	const { provider, fake } = setup({}, { box: { reached: [] }, archil: { mount: { exitCode: 3, output: `mount failed for ${TOKEN.slice(0, 4)}` } } });
	const failed = await create(provider, ARCHIL_SPEC);
	assert.equal(failed.ok, false);
	noToken(failed, "the refusal");
	await nothingLeft(fake, "a failed mount");
	assert.equal([...fake.machines.values()][0].init, undefined);
});

test("Archil: release lets the folder go (the final sync, then checkin as root), then deletes; a failed checkin still deletes, and says so through onNote", async () => {
	const notes = [];
	const { provider, fake } = setup({ onNote: (note) => notes.push(note) }, { box: { reached: [] }, archil: { checkin: { exitCode: 1, output: "checkin refused" } } });
	const ref = made(await create(provider, ARCHIL_SPEC));
	assert.equal((await provider.release(ref, "delete")).ok, true);
	const verbs = fake.rootRuns.map(({ verb }) => verb);
	assert.ok(verbs.indexOf("checkin") > verbs.indexOf("serve"));
	assert.ok(fake.syncs.length > 0, "the final sync through the daemon");
	await nothingLeft(fake, "an Archil release");
	assert.equal(notes.length, 1);
	assert.match(notes[0].note, /was deleted, and/);
});

test("Archil: release stop lets the folder go (the final sync, then checkin as root) before the host's stop, as delete does; a failed checkin still stops, and says so", async () => {
	const notes = [];
	const { provider, fake } = setup({ onNote: (note) => notes.push(note) }, { facts: { release: ["stop", "delete"], stopDeletes: false }, box: { reached: [] }, archil: { checkin: { exitCode: 1, output: "checkin refused" } } });
	const order = [];
	fake.host.stop = async (id) => {
		order.push(`stop ${fake.rootRuns.filter(({ verb }) => verb === "checkin").length} checkin`);
		fake.machines.get(id).state = "stopped";
		return { ok: true, value: undefined };
	};
	const ref = made(await create(provider, ARCHIL_SPEC));
	const syncs = fake.syncs.length;
	assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
	assert.deepEqual(order, ["stop 1 checkin"], "checkin ran before the stop");
	assert.ok(fake.syncs.length > syncs, "the final sync through the daemon");
	assert.equal(fake.live().length, 1, "a stop keeps the machine");
	assert.equal(notes.length, 1);
	assert.match(notes[0].note, /was stopped, and/);
});

test("Archil: archilEgress (a documentation address here, RFC 5737) goes to the helper's mount as its last word; unset, the mount names no gateway; a malformed one is refused at construction", async () => {
	const { provider, fake } = setup({ archilEgress: "192.0.2.40:18100:42050" }, { box: { reached: [] } });
	made(await create(provider, ARCHIL_SPEC));
	const mount = fake.rootRuns.find(({ verb }) => verb === "mount");
	assert.equal(mount.argv.at(-1), "egress=192.0.2.40:18100:42050");
	noToken(mount.argv, "the mount's argv");
	const plain = setup({}, { box: { reached: [] } });
	made(await create(plain.provider, ARCHIL_SPEC));
	assert.ok(!plain.fake.rootRuns.find(({ verb }) => verb === "mount").argv.some((word) => word.startsWith("egress=")));
	assert.throws(() => setup({ archilEgress: "192.0.2.40:8100:42050" }), /the Archil egress is <IPv4 gateway>:<mount lane>:<data lane>/);
});

test("Archil: connect gives a client that syncs after each call that may change the folder", async () => {
	const { provider, fake } = setup({}, { box: { reached: [] } });
	const ref = made(await create(provider, ARCHIL_SPEC));
	const before = fake.syncs.length;
	const connected = made(await provider.connect(ref));
	await connected.client.call("exec.run", { argv: ["true"] });
	await connected.close();
	assert.ok(fake.syncs.length > before);
});

// --- pid1 ---

test("pid1: the machine's command is the entrypoint; the daemon goes in beside its path and is moved into place, and init starts with no start step", async () => {
	const { provider, fake } = setup({}, { facts: { daemon: "pid1" } });
	made(await create(provider));
	const m = only(fake);
	assert.equal(m.request.command[0], "sh");
	assert.match(m.request.command[2], /^# agentrun-computer: entrypoint\n/);
	assert.ok(m.request.command.includes("--own-network"));
	assert.equal(m.daemon.atomic, true, "installed to .part, then moved");
	assert.equal(m.daemon.sha256, createHash("sha256").update(DAEMON_BYTES).digest("hex"), "and moved only once it reads the sha256 uploaded");
	assert.match(m.request.command[8], /^[0-9a-f]{32}$/, "the entrypoint waits for this create's nonce");
	assert.equal(m.daemon.marker, m.request.command[8], "which install writes to the marker beside the daemon");
	made(await create(provider));
	assert.notEqual([...fake.machines.values()][1].request.command[8], m.request.command[8], "each create its own");
	assert.ok(!runsOf(fake, m.id).includes("run start"));
	assert.equal(provider.capabilities().daemon, "pid1");
});

test("a desktop's window manager starts once the display answers, with DISPLAY, where the host's facts say so; one that cannot start or ends at once fails create, and nothing is left", async () => {
	const starts = (fake, id) => fake.requests.filter(({ machine, method }) => machine === id && method === "process.start").map(({ params }) => params);
	const managed = setup({ kind: "desktop" }, { facts: { windowManager: true } });
	made(await create(managed.provider));
	const m = only(managed.fake);
	const [server, manager, ...more] = starts(managed.fake, m.id);
	assert.equal(server.argv[0], "Xvfb", "the X server first");
	assert.deepEqual(manager, { argv: [...WINDOW_MANAGER], env: { DISPLAY: ":0", NO_AT_BRIDGE: "1" } }, "then the window manager, on the display, with no accessibility bus");
	assert.deepEqual(more, []);
	const order = managed.fake.requests.filter(({ machine }) => machine === m.id).map(({ method, params }) => (method === "process.start" ? params.argv[0] : method));
	const between = order.slice(order.indexOf("Xvfb") + 1, order.indexOf(WINDOW_MANAGER[0]));
	assert.ok(between.filter((method) => method === "hello").length >= 2, `the window manager starts after a hello saw the display, not before: ${order.join(", ")}`);

	const bare = setup({ kind: "desktop" });
	made(await create(bare.provider));
	assert.deepEqual(starts(bare.fake, only(bare.fake).id).map(({ argv }) => argv[0]), ["Xvfb"], "no window manager unless the host's facts say so");

	const missing = setup({ kind: "desktop" }, { facts: { windowManager: true }, display: "manager missing", lingers: { reads: 1, lists: 1 } });
	const failed = await create(missing.provider);
	assert.equal(failed.error?.code, "not_found");
	assert.match(failed.error.message, /the window manager \(dbus-run-session .*xfwm4.*\) did not start on :0: dbus-run-session: executable file not found/);
	await nothingLeft(missing.fake, "a window manager that cannot start");

	const ends = setup({ kind: "desktop" }, { facts: { windowManager: true }, display: "manager dies", lingers: { reads: 1, lists: 1 } });
	const ended = await create(ends.provider);
	assert.equal(ended.error?.code, "vendor");
	assert.match(ended.error.message, /the window manager \(dbus-run-session .*xfwm4.*\) ended with exit code 1 within 1 s of starting on :0: Xfconf could not be initialized/);
	await nothingLeft(ends.fake, "a window manager that ends at once");
	assert.ok(
		managed.fake.requests.some(({ machine, method, params }) => machine === m.id && method === "process.wait" && params.timeoutMs === 1000),
		"create watches the window manager for a second",
	);

	// The watch has its own bound: a display with a short timeoutMs that came up with less than a second of it left still
	// gets a healthy manager, whose process.wait computerd holds the whole second.
	let held;
	held = setup(
		{ kind: "desktop", desktop: { timeoutMs: 700 } },
		{ facts: { windowManager: true }, onStep: async (name) => (name === "process.wait" && held.fake.requests.at(-1).params.timeoutMs === 1000 ? new Promise((done) => setTimeout(done, 1000)) : undefined) },
	);
	made(await create(held.provider));
});

test("pid1 desktop: the entrypoint carries the display, and init starts with it", async () => {
	const { provider, fake } = setup({ kind: "desktop" }, { facts: { daemon: "pid1" } });
	made(await create(provider));
	const m = only(fake);
	assert.equal(m.request.command[7], ":0", "the display, after the daemon, the wait and the home");
	assert.equal(m.init.display, ":0");
});

test("the pid1 entrypoint, run by sh, starts init from its home with the display as DISPLAY, as start does a child's; none for no screen", () => {
	const root = mkdtempSync(join(tmpdir(), "computer-entrypoint-"));
	try {
		const home = join(root, "work");
		mkdirSync(home);
		const daemon = join(root, "computerd");
		// A stand-in for the daemon: it says where it runs, its HOME, its DISPLAY and its arguments.
		writeFileSync(daemon, '#!/bin/sh\necho "cwd=$(pwd) home=$HOME display=${DISPLAY-unset} args=$*"\n');
		chmodSync(daemon, 0o755);
		writeFileSync(`${daemon}.installed`, "n0nce\n");
		const run = (display) => {
			const argv = hostedCommands({ deadline: "2030-01-01T00:00:00.000Z", display, atomic: true, waitS: 5, nonce: "n0nce" }).entrypoint;
			// The daemon's path and init's home, here instead of /opt/agentrun and /work.
			const words = [...argv];
			words[4] = daemon;
			words[6] = home;
			return execFileSync(words[0], words.slice(1), { cwd: "/", env: { PATH: process.env.PATH, DISPLAY: ":99" }, encoding: "utf8" }).trim();
		};
		assert.equal(run(":0"), `cwd=${home} home=${home} display=:0 args=init --deadline 2030-01-01T00:00:00.000Z --user 2510:2510 --own-network`);
		assert.equal(run(""), `cwd=${home} home=${home} display=unset args=init --deadline 2030-01-01T00:00:00.000Z --user 2510:2510 --own-network`, "no screen: no DISPLAY, not even one inherited");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the pid1 entrypoint, run by sh, never starts a daemon already at the path without this create's marker: an image's older one, or an earlier install's", () => {
	const root = mkdtempSync(join(tmpdir(), "computer-entrypoint-"));
	try {
		const daemon = join(root, "computerd");
		const ran = join(root, "ran");
		// The image's own daemon: executable, in place before the entrypoint starts. Run, it leaves a trace.
		writeFileSync(daemon, `#!/bin/sh\necho started > '${ran}'\n`);
		chmodSync(daemon, 0o755);
		const run = () => {
			const words = [...hostedCommands({ deadline: "2030-01-01T00:00:00.000Z", atomic: true, waitS: 0, nonce: "this-create" }).entrypoint];
			words[4] = daemon;
			words[6] = root;
			try {
				execFileSync(words[0], words.slice(1), { cwd: "/", env: { PATH: process.env.PATH }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
				return { code: 0, err: "" };
			} catch (error) {
				return { code: error.status, err: String(error.stderr) };
			}
		};
		const none = run();
		assert.equal(none.code, 3, "no marker: the wait ends, and the computer with it");
		assert.match(none.err, /the daemon did not arrive at .*computerd within 0 s/);
		assert.throws(() => readFileSync(ran), /ENOENT/, "the old daemon never ran");
		writeFileSync(`${daemon}.installed`, "an-earlier-create\n");
		assert.equal(run().code, 3, "another create's marker: the same");
		assert.throws(() => readFileSync(ran), /ENOENT/);
		writeFileSync(`${daemon}.installed`, "this-create\n");
		assert.equal(run().code, 0, "this create's marker: it starts");
		assert.equal(readFileSync(ran, "utf8"), "started\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pid1 Archil: the entrypoint waits for the gate, which root makes once the folder is mounted", async () => {
	const { provider, fake } = setup({}, { facts: { daemon: "pid1" }, box: { reached: [] } });
	made(await create(provider, ARCHIL_SPEC));
	const m = only(fake);
	assert.ok(m.request.command.includes("--gate"));
	const runs = runsOf(fake, m.id);
	assert.ok(runs.indexOf("run serve") < runs.indexOf("run touch"), runs.join(", "));
	assert.ok(m.init !== undefined);
});

test("pid1: the gate is beside the daemon, in the directory install makes root's alone", async () => {
	const { ARCHIL_GATE } = await import("../dist/hosted/scripts.js");
	assert.equal(ARCHIL_GATE, "/opt/agentrun/archil-mounted");
	assert.equal(ARCHIL_GATE.slice(0, ARCHIL_GATE.lastIndexOf("/")), DAEMON.slice(0, DAEMON.lastIndexOf("/")));
	const { entrypoint } = hostedCommands({ deadline: "2026-11-06T12:00:00.000Z", user: "2510:2510", waitS: 9, gate: ARCHIL_GATE });
	assert.deepEqual(entrypoint.slice(3), ["sh", DAEMON, "9", "/work", "", "", "--gate", ARCHIL_GATE, "init", "--deadline", "2026-11-06T12:00:00.000Z", "--user", "2510:2510", "--own-network"]);
	const plain = hostedCommands({ deadline: "2026-11-06T12:00:00.000Z", user: "1000:1000", waitS: 9 });
	assert.deepEqual(plain.entrypoint.slice(3), ["sh", DAEMON, "9", "/work", "", "", "init", "--deadline", "2026-11-06T12:00:00.000Z", "--user", "1000:1000", "--own-network"], "no gate: the plain command");
});

test("the pid1 install, run by sh, moves the daemon into place only once it reads the sha256 given; one that reads another is removed, never moved", () => {
	const root = mkdtempSync(join(tmpdir(), "computer-install-"));
	try {
		// Stand-ins for what needs root here: id says root, ls says root's alone (0755, owner 0), install copies.
		const bin = join(root, "bin");
		mkdirSync(bin);
		const stub = (name, body) => {
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(bin, name), 0o755);
		};
		stub("id", 'case "$1" in -u) echo 0 ;; -un) echo root ;; *) echo "uid=0(root)" ;; esac');
		stub("ls", 'for x; do :; done; echo "drwxr-xr-x 2 0 0 4096 Jan 1 00:00 $x"');
		stub("chown", "exit 0");
		stub("install", 'for x; do s=$t; t=$x; done; cp "$s" "$t"');
		const env = { PATH: `${bin}:${process.env.PATH}` };
		const daemon = join(root, "opt", "agentrun", "computerd");
		const run = (sha256) => {
			const staging = join(root, "staged");
			writeFileSync(staging, DAEMON_BYTES);
			const words = [...hostedCommands({ staging, atomic: true, sha256, nonce: "this-create" }).install];
			// The daemon's path, its home and socket directory, here instead of /opt/agentrun, /work and /run/agentrun.
			words[5] = daemon;
			words[6] = join(root, "work");
			words[7] = join(root, "run");
			try {
				return { code: 0, out: execFileSync(words[0], words.slice(1), { env, encoding: "utf8" }) };
			} catch (error) {
				return { code: error.status, out: String(error.stdout) };
			}
		};
		const right = createHash("sha256").update(DAEMON_BYTES).digest("hex");
		// An earlier install's marker, left behind: removed before anything is written.
		mkdirSync(join(root, "opt", "agentrun"), { recursive: true });
		writeFileSync(`${daemon}.installed`, "an-earlier-create\n");
		const wrong = run("0".repeat(64));
		assert.equal(wrong.code, 7, wrong.out);
		assert.match(wrong.out, new RegExp(`reads sha256 ${right}, not ${"0".repeat(64)}, so it is not moved into place`));
		assert.throws(() => readFileSync(daemon), /ENOENT/, "nothing at the daemon's path");
		assert.throws(() => readFileSync(`${daemon}.part`), /ENOENT/, "and the written one removed");
		assert.throws(() => readFileSync(`${daemon}.installed`), /ENOENT/, "and no marker: the entrypoint waits on");
		// The sha256 survives held(), which assigns x as it walks the path: the right one is moved into place.
		const good = run(right);
		assert.equal(good.code, 0, good.out);
		assert.match(good.out, new RegExp(`^sha256 ${right}$`, "m"));
		assert.deepEqual(readFileSync(daemon), DAEMON_BYTES);
		assert.throws(() => readFileSync(`${daemon}.part`), /ENOENT/);
		assert.equal(readFileSync(`${daemon}.installed`, "utf8"), "this-create\n", "the marker, this create's nonce, written once it is in place");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pid1: a daemon that never answers reads no start log, which a pid1 machine has none of", async () => {
	const { provider, fake } = setup({}, { facts: { daemon: "pid1" }, initFails: "computerd: init refused" });
	const result = await create(provider);
	assert.equal(result.ok, false);
	const m = only(fake);
	assert.ok(!runsOf(fake, m.id).includes("run log"), runsOf(fake, m.id).join(", "));
	assert.equal(m.deleted, true, "the machine create gave up on is deleted");
});

// --- a host that takes a spec's user, and a host's runtime ---

test("a host that takes a spec's user: the daemon runs as the one the spec names (a uid alone is its own gid); root, a name and another user for an Archil computer are refused", async () => {
	const { provider, fake } = setup({}, { facts: USER_FACTS });
	const ref = made(await create(provider, { ...SPEC, user: "65534" }));
	const m = only(fake);
	assert.equal(m.init.user, "65534:65534", "init's --user");
	assert.equal(m.request.user, "65534:65534");
	assert.ok(ref.notes.includes(INSTALLER_NOTE));
	assert.deepEqual(provider.check({ ...SPEC, user: "1000:0" }), [], "root's group, without root, is not root");
	const refused = (spec) => provider.check(spec).map((r) => r.field);
	for (const user of ["0", "0:1000", "00", "root", "alice", "-1", "1000:", "4294967295"]) assert.deepEqual(refused({ ...SPEC, user }), ["user"], user);
	assert.match(provider.check({ ...SPEC, user: "0" })[0].message, /does not run as root: each connection is the vendor's exec of the daemon's stdio bridge/);
	assert.deepEqual(refused({ ...ARCHIL_SPEC, user: "1000:1000" }), ["user"]);
	assert.deepEqual(provider.check({ ...ARCHIL_SPEC, user: "2510" }), [], "the tool user, named");
	// A host that takes no user refuses the field in words, as before.
	assert.deepEqual(setup().provider.check({ ...SPEC, user: "65534" }).map((r) => r.field), ["user"]);
});

test("a host that takes a spec's user: attach reads the user back from inside, never root; a retry of the request with another user is refused", async () => {
	const { provider, fake } = setup({}, { facts: USER_FACTS });
	const requestId = "req-user-retry";
	const ref = made(await provider.create({ ...SPEC, user: "1000:1000" }, { requestId }));
	const attached = made(await provider.attach({ id: ref.id }));
	assert.equal(attached.spec.user, "1000:1000", "the user its programs run as, read back");
	const again = await provider.create({ ...SPEC, user: "1000:1000" }, { requestId });
	assert.equal(made(again).id, ref.id, "the same request finds the same computer");
	const other = await provider.create({ ...SPEC, user: "2000:2000" }, { requestId });
	assert.equal(other.error?.code, "exists");
	assert.match(other.error.message, /user: asked "2000:2000", read back "1000:1000"/);
	const m = only(fake);
	m.box.uid = 0;
	const root = await provider.attach({ id: ref.id });
	assert.equal(root.error?.code, "refused");
	assert.match(root.error.message, /daemon user: declared one uid that is not root, read back "0\\t0\\t0\\t0"/, "the four ids in words, as JSON gives a tab");
	assert.equal(m.deleted, false, "attach leaves a drifted computer as it is");
});

test("a host's runtime: the probe's kernel is held to it at create, gVisor exactly where the host runs one", async () => {
	const gvisor = setup({}, { facts: { ...USER_FACTS, runtime: () => "gvisor" } });
	const refused = await create(gvisor.provider);
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /runtime: declared gVisor \(a GPU computer\), read back another kernel \("6\.1\.102"\)/);
	await nothingLeft(gvisor.fake, "a computer of another runtime");
	const vm = setup({}, { facts: { ...USER_FACTS, runtime: () => "vm" }, box: { kernel: "4.19.0-gvisor" } });
	const other = await create(vm.provider);
	assert.match(other.error?.message ?? "", /runtime: declared vm, read back gVisor/);
	made(await create(setup({}, { facts: { ...USER_FACTS, runtime: () => "gvisor" }, box: { kernel: "4.19.0-gvisor" } }).provider));
});

test("a fence made inside a user namespace is said in create's notes", async () => {
	const { provider } = setup({}, { box: { helloPatch: { fence: "userns-netns" } } });
	const ref = made(await create(provider));
	assert.ok(ref.notes.some((note) => /^fence: userns-netns: init made its programs' network namespace inside a user namespace of its own/.test(note)), JSON.stringify(ref.notes));
	const plain = made(await create(setup().provider));
	assert.ok(!plain.notes.some((note) => note.startsWith("fence:")));
});

// --- the conformance runner's end-of-run sweep ---

test("a conformance run of a hosted provider sweeps its label through the host at the end: nothing left behind", async () => {
	const { runConformance } = await import("../dist/conformance/index.js");
	const { provider } = setup();
	const report = await runConformance(provider, {
		image: "img",
		cases: [{ id: "provider.fresh", group: "provider", level: "core", computer: "fresh", needs: [], run: async () => {} }],
		cleanupTimeoutMs: 2_000,
		caseTimeoutMs: 10_000,
	});
	assert.deepEqual(report.cleanup.sweep, { swept: 0, gone: 0, stillThere: [], leftAlone: 0 });
	assert.deepEqual(report.cleanup.errors, []);
	assert.deepEqual(report.cleanup.left, []);
});

test("a host's get that answers not_found, by a throw or by a result, is a machine that is gone", async () => {
	for (const style of ["throw", "result"]) {
		const { provider, fake } = setup({}, { starting: 2 });
		const made = fake.host.create;
		fake.host.create = async (...args) => {
			const result = await made(...args);
			fake.host.get = async () => {
				if (style === "throw") throw new NotFound("no such machine");
				return { ok: false, error: { code: "not_found", vendor: "fakehost", message: "no such machine" } };
			};
			return result;
		};
		const result = await create(provider);
		assert.equal(result.error?.code, "gone", style);
		assert.match(result.error.message, /was gone before it ran/, style);
	}
});

test("the adapter reads AbortError and TimeoutError by name; a host with no errorCode answers vendor for the rest", async () => {
	for (const [name, code] of [["TimeoutError", "timeout"], ["AbortError", "aborted"], ["Whatever", "vendor"]]) {
		const { provider, fake } = setup();
		const ref = made(await create(provider));
		delete fake.host.errorCode;
		fake.host.get = async () => {
			throw Object.assign(new Error("boom"), { name });
		};
		const result = await provider.connect(ref);
		assert.equal(result.error?.code, code, name);
	}
});
