// The shared machine-host adapter (src/hosted/provider.ts) against its one fake host (test/fake-host.mjs): the lifecycle
// every vendor on it gets, tested once. Create by request id (races, retries, refusals), the read-back and the probe,
// the deadline and extend, delete-then-wait-gone, nothing left behind after any failed step, the Archil mount, and the
// pid1 branch. No vendor, no network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLifetime, computerNameFor as nameOf } from "../dist/index.js";
import { HostError } from "../dist/host.js";
import { DAEMON, DESKTOP_GROUPS, deferred, FAKE_DESCRIPTOR, fakeHost, gpuDescriptor, LINUX_GROUPS, NETWORK_DESCRIPTOR, NotFound, VERSION } from "./fake-host.mjs";

const { HostedProvider } = await import("../dist/hosted/provider.js");
const { hostedCommands } = await import("../dist/hosted/scripts.js");
const { WINDOW_MANAGER } = await import("../dist/desktop.js");
const VALUES = await import("../dist/hosted/values.js");

const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DEADLINE = "agentrun.computer.deadline";
const MAX = "agentrun.computer.max-deadline";
const SPEC = { image: "img", lifetimeMs: 600_000, network: "none" };
/** A pid1 host that takes a spec's user (its capabilities' user). */
const USER_FACTS = { daemon: "pid1", user: ["uid"] };
const GPU_LABEL = "agentrun.computer.gpu";
const H100 = { type: "H100", count: 1 };
/** The fake's descriptor with one H100, as Daytona's offers. */
const WITH_GPU = { descriptor: gpuDescriptor({ types: ["H100"], max: 1 }) };
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

/** The fake host and a provider over it; a descriptor given goes on the host, which carries it (src/host.ts). */
function setup({ descriptor, ...options } = {}, fakeOptions = {}) {
	const fake = fakeHost({ ...fakeOptions, ...(descriptor === undefined ? {} : { descriptor }) });
	const provider = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...options });
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
	// The listing finds; get answers: a listing may still show a deleted machine, and get reads each gone.
	for (const id of fake.machines.keys()) {
		const read = await fake.host.get(id, { timeoutMs: 1_000 });
		assert.ok(read === undefined || read.state === "gone", `${what}: get reads ${id} gone`);
	}
}

// --- capabilities and check ---

test("capabilities come from the host's descriptor (network, mounts, the kind's groups and GPUs), its facts and the adapter's options alone", () => {
	const { provider } = setup({ kind: "desktop" });
	assert.deepEqual(provider.capabilities(), {
		kind: "desktop",
		lifetime: "vendor",
		network: ["none"],
		// The probe from inside is the network's truth: no hosted vendor's read-back is held.
		networkReadBack: false,
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
	assert.equal(typeof setup({}, { facts: { lifetime: "janitor" } }).provider.extend, "function", "extend with the janitor's label: the host's extend either way");
	assert.equal(setup({}, { timer: "none" }).provider.extend, undefined, "no extend where the host has none");
	assert.throws(() => setup({ maxLifetimeMs: 25 * HOUR }), /at most 86400000 ms, the longest Fakehost keeps a computer/);
	assert.throws(() => setup({ daemonUser: "0:0" }), /root or in root's group/);
	// The descriptor is the network's and the mounts' one source: the host's facts name neither.
	const unmounted = setup({ descriptor: { ...FAKE_DESCRIPTOR, mounts: [], unmounted: { archil: "Archil mounts don't work on Fakehost" } } }).provider;
	assert.deepEqual(unmounted.capabilities().mount, []);
	assert.match(unmounted.check({ ...SPEC, mount: { kind: "archil", disk: "d", region: "r", folder: "f", token: "t" } })[0].message, /Archil mounts don't work on Fakehost/);
	assert.deepEqual(setup(WITH_GPU).provider.capabilities().gpu, { types: ["H100"], max: 1 }, "the kind's GPUs, from its configuration");
	assert.equal(setup({ ...WITH_GPU, kind: "desktop" }).provider.capabilities().gpu, undefined, "a desktop configuration offers none");
	assert.throws(() => setup({ descriptor: { ...FAKE_DESCRIPTOR, capabilities: [FAKE_DESCRIPTOR.capabilities[0]] }, kind: "desktop" }), /Fakehost offers no desktop computer/);
});

test("check() refuses, with no host call, what no hosted computer is: open, an allowlist, pids, a user, a workdir, the adapter's own labels, a lifetime past the cap; sizes are the host's to refuse", () => {
	const { provider, fake } = setup({ maxLifetimeMs: HOUR });
	assert.deepEqual(provider.check({ ...SPEC, labels: { run: "r1" } }), []);
	const fields = (spec) => provider.check(spec).map((r) => r.field);
	assert.deepEqual(fields({ ...SPEC, image: "" }), ["image"]);
	assert.deepEqual(fields({ ...SPEC, network: "open" }), ["network"]);
	assert.deepEqual(fields({ ...SPEC, network: { allow: ["example.com"] } }), ["network"]);
	for (const field of ["pids", "workdir"]) assert.deepEqual(fields({ ...SPEC, [field]: field === "workdir" ? "/tmp" : 2 }), [field]);
	assert.deepEqual(fields({ ...SPEC, cpus: 2, memoryMb: 1024 }), [], "the host's check refuses a size it does not take: this one has none");
	assert.deepEqual(fields({ ...SPEC, user: "0" }), ["user"]);
	assert.deepEqual(fields({ ...SPEC, labels: { [COMPUTER]: "2" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, labels: { [`${COMPUTER}.x`]: "2" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, gpu: { type: "H100", count: 1 } }), ["gpu"]);
	assert.deepEqual(provider.check({ ...SPEC, lifetimeMs: HOUR + 1 }), checkLifetime(HOUR + 1, provider.capabilities()));
	assert.deepEqual(fields({ ...SPEC, owner: { agent: "a1" } }), ["owner"], "no persistence: an owner is refused");
	assert.deepEqual(fake.calls, []);
});

test("a host's own rules (check) are held at check()", () => {
	const fake = fakeHost();
	const strict = new HostedProvider({ ...fake.host, check: (spec) => (spec.image === "bad" ? [{ field: "image", message: "not a vendor image" }] : []) }, { daemonPath: DAEMON_PATH });
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
	assert.equal(request.egress, false, "no way out: the vendor's network is none");
	assert.equal(request.network, undefined, "network none always: egress is the one word");
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
	assert.deepEqual(runs.slice(0, 4), ["run install", "run sockets", "run start", "run stdio"], "the daemon installed, /tmp's session buses closed, init started detached, then the bridge");
	assert.ok(runs.includes("daemon process.start"), "the X server started through the daemon");
	assert.ok(runs.includes("daemon exec.run"), "the probe ran");
	assert.deepEqual(fake.uploads.map(({ through }) => through), ["upload"], "the daemon went in through the host's file API");
});

test("every child host's session buses in /tmp (D-Bus, /tmp/dbus-*) are closed to the computer's user before init starts, with no fact naming them, and said in the notes; one that will not close refuses the computer", async () => {
	const sockets = ["/tmp/dbus-Y8OW6E3FDx", "/tmp/dbus-AAAAAAAAAA", "/tmp/.X11-unix/X0", "/tmp/sub/dbus-nested"];
	const { provider, fake } = setup({}, { sockets });
	assert.equal(fake.host.facts.vendorSockets, undefined, "no host fact names them");
	const ref = made(await create(provider));
	assert.deepEqual(ref.notes, [INSTALLER_NOTE, "session buses in /tmp closed to the computer's user: /tmp/dbus-AAAAAAAAAA, /tmp/dbus-Y8OW6E3FDx", ACCEPTED_NOTE]);
	const runs = runsOf(fake, only(fake).id);
	assert.deepEqual(runs.slice(0, 4), ["run install", "run sockets", "run start", "run stdio"], "closed after the install, before init starts");
	assert.deepEqual(hostedCommands().sockets?.slice(4), ["/tmp/dbus-*"], "each pattern one argument");
	const none = setup();
	assert.deepEqual(made(await create(none.provider)).notes, [INSTALLER_NOTE, ACCEPTED_NOTE], "none found: nothing said");
	assert.ok(runsOf(none.fake, only(none.fake).id).includes("run sockets"), "run all the same");
	const failing = setup({}, { sockets, socketsFail: "/tmp/dbus-Y8OW6E3FDx" });
	const refused = await create(failing.provider);
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /closing the session buses in \/tmp to the computer's user failed \(exit 1\): closed \/tmp\/dbus-AAAAAAAAAA\nfailed \/tmp\/dbus-Y8OW6E3FDx/);
	assert.ok(!failing.fake.events.some(({ what }) => what === "run start"), "init never started");
	await nothingLeft(failing.fake, "a computer whose session buses would not close");
	const pid1 = setup({}, { facts: USER_FACTS, sockets });
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
		const argv = hostedCommands({ sockets: [`${root}/dbus-*`, `${root}/absent-*`] }).sockets;
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

test("a host's rootOnly paths are made root's alone before anything of the create's is in the machine, on a child and a pid1 host alike; a host with none runs nothing; one that fails refuses the computer", async () => {
	const paths = ["/usr/local", "/usr/bin/envd"];
	const { provider, fake } = setup({}, { facts: { rootOnly: paths } });
	const ref = made(await create(provider));
	assert.deepEqual(runsOf(fake, only(fake).id).slice(0, 5), ["run root-only", "run install", "run sockets", "run start", "run stdio"], "first, before the install and init");
	assert.deepEqual(fake.uploads.map(({ rootOnly }) => rootOnly), [paths], "made root's alone before the daemon's upload");
	assert.deepEqual(ref.notes, [INSTALLER_NOTE, ACCEPTED_NOTE], "nothing said");
	assert.deepEqual(hostedCommands({ rootOnly: paths }).rootOnly.slice(4), paths, "each path one argument");
	const pid1 = setup({}, { facts: { ...USER_FACTS, rootOnly: paths } });
	made(await create(pid1.provider));
	assert.equal(runsOf(pid1.fake, only(pid1.fake).id)[0], "run root-only", "a pid1 host's too, before its install");
	assert.deepEqual(pid1.fake.uploads.map(({ rootOnly }) => rootOnly), [paths]);
	const none = setup();
	made(await create(none.provider));
	assert.ok(!runsOf(none.fake, only(none.fake).id).includes("run root-only"), "a host that names none runs no script");
	const failing = setup({}, { facts: { rootOnly: paths }, rootOnlyFail: "/usr/local/x is not root's alone" });
	const refused = await create(failing.provider);
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /making system paths root's alone failed \(exit 5\): \/usr\/local\/x is not root's alone/);
	assert.deepEqual(failing.fake.uploads, [], "no daemon went in");
	assert.ok(!failing.fake.events.some(({ what }) => what === "run install" || what === "run start"), "nothing installed or started");
	await nothingLeft(failing.fake, "a computer whose system paths would not close");
});

test("the root-only script, run by sh: group and other write go from each path and everything under it, an owner not root is made root or refused, a link inside is never followed, a missing path is skipped, a path that is a link refuses", { skip: process.getuid?.() === 0 ? "run as root, every file here is already root's" : false }, () => {
	const root = mkdtempSync(join(tmpdir(), "computer-root-only-"));
	try {
		// Not root here: the script reaches root through sudo -n, which this stand-in runs as it is.
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "sudo"), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n', { mode: 0o755 });
		const local = join(root, "local");
		mkdirSync(join(local, "sbin"), { recursive: true });
		writeFileSync(join(local, "sbin", "helper"), "#!/bin/sh\n");
		writeFileSync(join(root, "single"), "");
		const outside = join(root, "outside");
		writeFileSync(outside, "");
		symlinkSync(outside, join(local, "sbin", "link"));
		for (const path of [local, join(local, "sbin"), join(local, "sbin", "helper"), join(root, "single"), outside]) chmodSync(path, 0o777);
		// Root here is this test's user, whose files these are; chown is a stand-in that only records what it was asked.
		const chowned = join(root, "chowned");
		writeFileSync(join(bin, "chown"), `#!/bin/sh\necho "$*" >> '${chowned}'\n`, { mode: 0o755 });
		const run = (paths) => {
			const argv = hostedCommands({ rootOnly: paths }).rootOnly;
			return spawnSync(argv[0], argv.slice(1), { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
		};
		const ran = run([local, join(root, "single"), join(root, "absent")]);
		assert.equal(ran.status, 0, ran.stdout + ran.stderr);
		for (const path of [local, join(local, "sbin"), join(local, "sbin", "helper"), join(root, "single")]) assert.equal(statSync(path).mode & 0o777, 0o755, path);
		assert.equal(statSync(outside).mode & 0o777, 0o777, "a link inside is never followed");
		assert.equal(existsSync(chowned), false, "nothing already root's is chowned");
		const linked = join(root, "linked");
		symlinkSync(local, linked);
		const refused = run([linked]);
		assert.equal(refused.status, 6);
		assert.match(refused.stdout, /is a symbolic link/);
		// An entry another user owns: chown is asked to make root its owner (the link itself, -h), and one still not root's
		// (the stand-in changed nothing) fails the script, though its mode lets no other user write it.
		const owned = run(["/etc/passwd"]);
		assert.equal(owned.status, 5, owned.stdout + owned.stderr);
		assert.match(owned.stdout, /^\/etc\/passwd is not root's alone$/m);
		assert.equal(readFileSync(chowned, "utf8"), `-h ${process.getuid()} /etc/passwd\n`);
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

test("create's listing wait backs off from 150 ms to the host's pollMs: a vendor that lists a machine 10 s late costs a handful of listings", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const fake = fakeHost();
	const listedAt = Date.now() + 10_000;
	let lists = 0;
	// The vendor's listing leaves every machine out for its first 10 s.
	const host = { ...fake.host, list: async (labels, ctx) => (++lists, Date.now() < listedAt ? [] : fake.host.list(labels, ctx)) };
	const provider = new HostedProvider(host, { daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, pollMs: 2_000, listedMs: 30_000, listedStableMs: 1_000 } });
	let answer;
	create(provider).then((result) => (answer = result));
	while (answer === undefined && Date.now() < listedAt + 30_000) {
		for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
		t.mock.timers.tick(10);
	}
	const waited = Date.now() - listedAt + 10_000;
	t.mock.timers.reset();
	made(answer);
	// Two reads around the vendor's create, then the wait's, 150, 300, 600, 1200 and 2000 ms apart: eight to the 10 s
	// mark and two that show it, 13 in all. At 150 ms flat, 78.
	assert.ok(lists <= 14,`the wait backed off to pollMs (${lists} listings in ${waited / 1000} s)`);
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
	const first = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const second = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
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
		const one = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
		const two = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
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
		assert.deepEqual(listed.map((m) => m.id), [kept.id], `${what}: and is no longer listed`);
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

test("a retry is held to the GPUs its computer's label records, on a host that reads no GPU back: a GPU request that finds its computer made without one, or the other way round, is refused as exists", async () => {
	const { provider, fake } = setup(WITH_GPU);
	const plain = made(await provider.create(SPEC, { requestId: "cpu-first" }));
	const gpu = await provider.create({ ...SPEC, gpu: H100 }, { requestId: "cpu-first" });
	assert.equal(gpu.error?.code, "exists", "a GPU request never gets the computer made without one");
	assert.match(gpu.error.message, new RegExp(`${plain.name} was made for this request with another spec, so it is not returned: gpu: asked \\{"type":"H100","count":1\\}, read back nothing`));
	const withGpu = made(await provider.create({ ...SPEC, gpu: H100 }, { requestId: "gpu-first" }));
	assert.equal(fake.machines.get(withGpu.id).labels[GPU_LABEL], "H100:1", "create records the GPUs in the adapter's own label");
	assert.equal(fake.machines.get(plain.id).labels[GPU_LABEL], undefined, "and none for a computer with none");
	assert.deepEqual(made(await provider.attach({ id: withGpu.id })).spec.gpu, H100, "attach reads them from the label");
	const none = await provider.create(SPEC, { requestId: "gpu-first" });
	assert.equal(none.error?.code, "exists", "a request without a GPU never gets the GPU computer");
	assert.match(none.error.message, /gpu: asked nothing, read back \{"type":"H100","count":1\}/);
	assert.equal(made(await provider.create({ ...SPEC, gpu: H100 }, { requestId: "gpu-first" })).id, withGpu.id, "the same spec gets the same computer");
	assert.equal(made(await provider.create(SPEC, { requestId: "cpu-first" })).id, plain.id);
	assert.equal(fake.creates(), 2, "never a second machine under one name");
	// A restarted provider reads the same label: the GPUs need no vendor read-back.
	const after = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	assert.equal((await after.create({ ...SPEC, gpu: H100 }, { requestId: "cpu-first" })).error?.code, "exists");
	assert.equal(made(await after.create({ ...SPEC, gpu: H100 }, { requestId: "gpu-first" })).id, withGpu.id);
});

test("a retry from a restarted provider, of a sized request, finds the computer the first made: the request carries the spec's sizes, and none is read back", async () => {
	const fake = fakeHost();
	const spec = { ...SPEC, cpus: 4, memoryMb: 8192 };
	const before = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const ref = made(await before.create(spec, { requestId: "sized-unread" }));
	assert.deepEqual([only(fake).request.cpus, only(fake).request.memoryMb], [4, 8192], "the spec's sizes, as given");
	assert.equal(only(fake).request.workdir, undefined, "no workdir: no host takes one");
	const after = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	assert.equal(made(await after.create(spec, { requestId: "sized-unread" })).id, ref.id, "a size read back as nothing is not a drift");
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

test("a named create the vendor refuses as exists (a duplicate name, 409) adopts the machine the name's listing finds, as a retry does; with none listed, the refusal stands", async () => {
	const fake = fakeHost();
	const name = nameOf("taken");
	// Another instance's create of the request made it, and the first listing by the name lags it.
	const other = fake.add({ labels: { [COMPUTER]: "1", [NAME]: name, [DEADLINE]: new Date(Date.now() + 600_000).toISOString(), [MAX]: new Date(Date.now() + HOUR).toISOString(), "agentrun.computer.image": "img" } });
	other.daemon = { path: DAEMON, bytes: DAEMON_BYTES };
	other.init = { deadline: other.labels[DEADLINE], user: "2510:2510", display: "", max: other.labels[MAX] };
	other.hidden = 1;
	const taken = { ...fake.host, create: async () => Promise.reject(new HostError("exists", `POST /v1/machines: 409 the name ${name} is taken`)) };
	const provider = new HostedProvider(taken, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const adopted = made(await provider.create(SPEC, { requestId: "taken" }));
	assert.equal(adopted.id, other.id, "the name's machine, adopted");
	assert.equal(other.deleted, false);
	// No machine carries the name: the vendor's words stand, and nothing is swept.
	const lone = fakeHost();
	const refused = await new HostedProvider({ ...lone.host, create: taken.create }, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }).create(SPEC, { requestId: "taken-alone" });
	assert.equal(refused.error?.code, "exists");
	assert.match(refused.error.message, /409 the name computer-[0-9a-f]{12} is taken/);
	assert.deepEqual(lone.calls.filter(([what]) => what === "delete"), []);
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
	// Lost, answered as a Result: the host's own client timed out, so no answer comes later either. Swept by name the same.
	const answered = setup({}, { create: "lost-answered" });
	const gaveUp = await create(answered.provider);
	assert.equal(gaveUp.error?.code, "timeout");
	assert.match(gaveUp.error.message, /deleted as it lands/);
	for (let i = 0; i < 100 && answered.fake.live().length > 0; i++) await new Promise((done) => setTimeout(done, 10));
	await nothingLeft(answered.fake, "a create whose host answered a timeout");
});

test("an outage met after the machine was made (a 503 on the first readiness read, on the daemon's upload, a start that never ends) keeps its transient mark through the delete, so a caller may fail over", async () => {
	for (const call of ["get", "upload"]) {
		const { provider, fake } = setup();
		const real = fake.host[call].bind(fake.host);
		const realDelete = fake.host.delete.bind(fake.host);
		// The vendor answers 503 until the adapter deletes the machine (the readiness reads, or the one upload), then again.
		let down = true;
		fake.host.delete = async (...args) => {
			down = false;
			return realDelete(...args);
		};
		fake.host[call] = async (...args) => {
			if (!down) return real(...args);
			if (call === "upload") down = false;
			throw new HostError("vendor", `${call}: 503 upstream unavailable`, { transient: true });
		};
		const outage = await create(provider);
		assert.equal(outage.ok, false, call);
		assert.match(outage.error.message, /was deleted: .*503 upstream unavailable/, call);
		assert.equal(outage.error.transient, true, `a 503 on ${call} stays transient`);
		await nothingLeft(fake, `a 503 on ${call}`);
	}
	// A machine still starting when createMs ends is an outage too: transient, and deleted. One the vendor reads as failed is not.
	const stuck = setup({ timeouts: { ...TIMEOUTS, createMs: 200 } }, { starting: 1_000_000 });
	const slow = await create(stuck.provider);
	assert.equal(slow.error?.code, "timeout");
	assert.match(slow.error.message, /did not start within/);
	assert.equal(slow.error.transient, true, "a start that never ends stays transient");
	await nothingLeft(stuck.fake, "a machine that never started");
	// A refusal after the machine was made carries no mark.
	const refused = await create(setup({}, { install: 5 }).provider);
	assert.equal(refused.error.transient, undefined);
});

test("the daemon's bridge and a run to exit keep an outage's transient mark: an exec the vendor answers 503, and one that never ends", async () => {
	const { openBridge, runToExit } = await import("../dist/hosted/process.js");
	const host = { descriptor: FAKE_DESCRIPTOR, errorCode: () => "vendor", exec: async () => {
		throw new HostError("vendor", "exec: 503 upstream unavailable", { transient: true });
	} };
	const bridge = await openBridge(host, "m", { argv: ["computerd", "stdio"], name: "computer-x", version: VERSION, requestMs: 200, helloMs: 200 });
	assert.equal(bridge.ok, false);
	assert.match(bridge.error.message, /503 upstream unavailable/);
	assert.equal(bridge.error.transient, true, "the bridge's failed exec stays transient");
	const refused = await openBridge({ ...host, exec: async () => {
		throw new HostError("denied", "exec: 403");
	} }, "m", { argv: ["computerd", "stdio"], name: "computer-x", version: VERSION, requestMs: 200, helloMs: 200 });
	assert.equal(refused.error.transient, undefined, "a refusal carries no mark");
	// A process that never ends (its exec stream stalled) is a timeout, transient.
	const never = { stdout: (async function* () {})(), stderr: (async function* () {})(), write: async () => {}, end: async () => {}, wait: () => new Promise(() => {}), kill: async () => {} };
	const stalled = await runToExit({ ...host, exec: async () => never }, "m", ["true"], { ms: 50, what: "the install" });
	assert.equal(stalled.error?.code, "timeout");
	assert.match(stalled.error.message, /the install did not end within/);
	assert.equal(stalled.error.transient, true);
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

test("a create given up on that then fails sweeps its name only where it may have made a machine: a refusal, exists among them, leaves the name's machine alone", async () => {
	const cases = [
		// Refused: the vendor made nothing, so the machine under the name is another instance's (or caller's) for this request.
		["exists", new HostError("exists", "409: a machine with that name exists"), false],
		["limit", new HostError("limit", "429: too many machines"), false],
		// Failed otherwise, or the host's own client gave up: the create may have made it, so the name is swept, as today.
		["a vendor failure", new Error("502: Bad Gateway"), true],
		["the host's own timeout", new HostError("timeout", "POST /v1/instances did not answer within 300 s"), true],
	];
	for (const [what, error, swept] of cases) {
		const { provider, fake } = setup({}, { create: "hold" });
		const requestId = `late-${what}`;
		const controller = new AbortController();
		const pending = provider.create(SPEC, { requestId, signal: controller.signal });
		await new Promise((done) => setTimeout(done, 10));
		controller.abort();
		assert.equal((await pending).error?.code, "aborted", what);
		// Meanwhile a create of the same request on another instance made its machine under the name.
		const other = fake.add({ labels: { [COMPUTER]: "1", [NAME]: nameOf(requestId), [DEADLINE]: new Date(Date.now() + 600_000).toISOString(), [MAX]: new Date(Date.now() + HOUR).toISOString(), "agentrun.computer.image": "img" } });
		const before = fake.calls.length;
		await fake.release(error);
		if (swept) {
			for (let i = 0; i < 100 && !other.deleted; i++) await new Promise((done) => setTimeout(done, 10));
			assert.equal(other.deleted, true, `${what}: the machine under the name is swept`);
		} else {
			// The sweep's first step is the listing by the name, which the late failure reaches before release returns.
			assert.deepEqual(fake.calls.slice(before).filter(([name]) => name === "list" || name === "delete"), [], `${what}: no listing or delete by the name`);
			assert.equal(other.deleted, false, `${what}: the other instance's machine is left running`);
		}
	}
});

test("nothing left behind: a failure or an abort at any step after the machine exists deletes it and waits until it is gone", async () => {
	const cases = [
		["an installed sha256 that does not match", { sha: "lie" }, /uploaded sha256/],
		["an install that fails", { install: 5 }, /installing the daemon failed/],
		["init that never listens", { initFails: "computerd: init: no such user" }, /init wrote: computerd: init: no such user/],
		["an X server that dies", { display: "dies" }, /X server/],
		["a machine the vendor reads gone, failed in its words", { failed: "the image could not be pulled" }, /Fakehost could not start computer-[0-9a-f]{12}: the image could not be pulled/],
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

test("a lifetime past the cap is refused before any host call; extend asks the host's extend for the new end, reads the deadline back, then moves init's, never earlier, never past the cap", async () => {
	const { provider, fake } = setup({ maxLifetimeMs: HOUR });
	const refused = await create(provider, { ...SPEC, lifetimeMs: HOUR + 1 });
	assert.equal(refused.error?.code, "refused");
	assert.deepEqual(fake.calls, []);
	const ref = made(await create(provider));
	const m = only(fake);
	const before = Date.parse(m.init.deadline);
	const asked = Date.now() + 20 * 60_000;
	const longer = made(await provider.extend(ref, 20 * 60_000));
	assert.ok(longer.deadline.getTime() > before);
	assert.ok(Math.abs(longer.deadline.getTime() - asked) < 1_000, "the end asked: now plus the ttl");
	assert.equal(m.init.deadline, longer.deadline.toISOString(), "init took the deadline the host read back");
	assert.equal(m.endsAt.toISOString(), longer.deadline.toISOString());
	assert.equal(m.labels[DEADLINE], longer.deadline.toISOString(), "the one deadline label, as the host's extend wrote it");
	const timers = () => fake.calls.filter(([name]) => name === "extend").length;
	const timersBefore = timers();
	const shorter = await provider.extend(ref, 60_000);
	assert.equal(shorter.error?.code, "refused", "an extend to an earlier deadline is refused");
	assert.match(shorter.error.message, /earlier/);
	assert.equal(timers(), timersBefore, "the host's extend was never called");
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

test("a janitor host's extend moves its deadline label, and init takes the deadline the host reads back, not the one asked", async () => {
	const { provider, fake } = setup({}, { facts: { lifetime: "janitor" } });
	const ref = made(await create(provider));
	const m = only(fake);
	const asked = Date.now() + 20 * 60_000;
	const moved = made(await provider.extend(ref, 20 * 60_000));
	// The fake writes the label rounded up to a whole second, as a vendor may: the read-back is what counts.
	assert.equal(moved.deadline.getTime() % 1000, 0, "the deadline returned is the label read back, a whole second");
	assert.ok(moved.deadline.getTime() >= asked);
	assert.equal(m.labels[DEADLINE], moved.deadline.toISOString(), "the host moved its deadline label");
	assert.equal(m.init.deadline, moved.deadline.toISOString(), "init took the deadline read back");
	assert.deepEqual(
		fake.calls.filter(([name]) => name === "extend" || name === "get").slice(-2).map(([name]) => name),
		["extend", "get"],
		"the end is read back by get after the host's extend",
	);
	assert.equal(made(await provider.list({}))[0].deadline.toISOString(), moved.deadline.toISOString(), "list reads the label");
});

test("the listing finds and get answers: a listing that keeps a deleted machine and shows create's end after an extend changes nothing list, release or a create answers", async () => {
	const { provider, fake } = setup({}, { stale: true });
	const ref = made(await create(provider, SPEC, { requestId: "stale" }));
	const moved = made(await provider.extend(ref, 30 * 60_000));
	const listed = made(await provider.list({}));
	assert.deepEqual(listed.map((info) => info.ref.id), [ref.id]);
	assert.equal(listed[0].deadline.toISOString(), moved.deadline.toISOString(), "list reads the moved end by get, not create's from the listing");
	const gets = fake.calls.filter(([name]) => name === "get").length;
	made(await provider.list({}));
	assert.equal(fake.calls.filter(([name]) => name === "get").length, gets + 1, "one get per listed computer of ours");
	const released = await provider.release(ref, "delete");
	assert.equal(released.ok, true, `the wait after a delete reads get, not a listing that keeps the machine: ${released.error?.message}`);
	assert.deepEqual(made(await provider.list({})), [], "a deleted machine the listing still shows is not listed");
	// Another instance's create of the request: the listing still names the deleted machine, and get says it is gone.
	const other = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const again = made(await other.create(SPEC, { requestId: "stale" }));
	assert.notEqual(again.id, ref.id, "a machine get reads gone is not the request's: a new one is made");
	assert.deepEqual(made(await other.list({})).map((info) => info.ref.id), [again.id]);
});

test("a janitor host's extend writes its own deadline label: the adapter reads it back and moves init's deadline to it", async () => {
	const fake = fakeHost({ facts: { lifetime: "janitor" } });
	const written = [];
	fake.host.extend = async (id, endsAt) => {
		written.push(endsAt.toISOString());
		fake.machines.get(id).labels[DEADLINE] = endsAt.toISOString();
	};
	const provider = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	assert.equal(provider.capabilities().lifetime, "janitor");
	const ref = made(await create(provider));
	assert.equal(only(fake).request.lifetimeMs, 600_000, "every request carries the lifetime: a janitor's host may ignore it");
	const moved = made(await provider.extend(ref, 30 * 60_000));
	assert.deepEqual(written, [moved.deadline.toISOString()]);
	assert.equal(only(fake).init.deadline, moved.deadline.toISOString());
	// One whose label does not read back as an ISO time moved nothing it can say: init's deadline stays.
	fake.host.extend = async () => {};
	const before = only(fake).init.deadline;
	fake.machines.get(ref.id).labels[DEADLINE] = "soon";
	const unread = await provider.extend(ref, 40 * 60_000);
	assert.equal(unread.ok, false);
	assert.match(unread.error.message, /reads back no deadline/);
	assert.equal(only(fake).init.deadline, before);
});

// --- release ---

test("release delete deletes the machine and waits until get reads it gone; a listing that still shows it neither holds the wait nor shows in list", async () => {
	const { provider, fake } = setup({}, { lingers: { reads: 2, lists: 2 } });
	const ref = made(await create(provider));
	made(await provider.release(ref, "delete").then((r) => (r.ok ? { ok: true, value: true } : r)));
	assert.deepEqual((await fake.host.list({ [COMPUTER]: "1" }, { timeoutMs: 1_000 })).map((m) => m.id), [ref.id], "the vendor's listing still shows it");
	assert.deepEqual(made(await provider.list({})), [], "list reads it by get: gone");
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

test("release waits until get answers none: a machine the vendor still reads gone after its delete (being destroyed) holds the wait", async () => {
	const { provider, fake } = setup({}, { lingers: { reads: 3, lists: 0, state: "gone" } });
	const ref = made(await create(provider));
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
	assert.equal(only(fake).lingering.reads, 0, "release did not end while the vendor still read the machine gone");
	await nothingLeft(fake, "release");
	const slow = setup({}, { lingers: { reads: 10_000, lists: 0, state: "gone" } });
	const stuck = await slow.provider.release(made(await create(slow.provider)), "delete");
	assert.equal(stuck.error?.code, "timeout", "a machine read gone and never none is still there at goneMs");
	assert.match(stuck.error.message, /read it gone/);
});

test("a vendor's record of a deleted machine (a tombstone: Hyperbrowser's closed, Blaxel's TERMINATED) is undefined from get and left out of list, so release ends at once; read gone, it holds release to goneMs", async () => {
	// The vendor keeps the record for longer than goneMs. A host that reads it gone (lingers, state gone):
	const kept = setup({}, { lingers: { reads: 10_000, lists: 10_000, state: "gone" } });
	const waited = await kept.provider.release(made(await create(kept.provider)), "delete");
	assert.equal(waited.error?.code, "timeout", "a tombstone read gone waits out goneMs on every delete");
	// A host that reads it as the vendor no longer having the machine (the fake's get and list after a delete):
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
	const gets = fake.calls.slice(fake.calls.findIndex(([name]) => name === "delete")).filter(([name]) => name === "get");
	assert.equal(gets.length, 2, "two reads of none, twice running, end the wait");
	assert.deepEqual(made(await provider.list({})), []);
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

test("release stop is refused for every hosted computer, in words, and nothing is asked of the host: a computer here is deleted, never stopped and kept", async () => {
	const { provider, fake } = setup({ descriptor: gpuDescriptor({ types: ["H100"], max: 1, stopDeletes: true }) });
	assert.deepEqual(provider.capabilities().release, ["delete"]);
	assert.equal(provider.capabilities().stopDeletes, undefined, "no stop, so no stop that deletes");
	for (const spec of [SPEC, { ...SPEC, gpu: { type: "H100", count: 1 } }]) {
		const ref = made(await create(provider, spec));
		const before = fake.calls.length;
		const refused = await provider.release(ref, "stop");
		assert.equal(refused.error?.code, "unsupported");
		assert.match(refused.error.message, /computer is deleted, never stopped and kept: release it with delete/);
		assert.deepEqual(fake.calls.slice(before), [], "no host call");
		assert.equal(fake.machines.get(ref.id).deleted, false, "left running");
	}
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

test("connect to a machine the vendor reads as gone (past its deadline or released, still being deleted) answers gone, not refused; releasing it again stays ok", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	only(fake).state = "gone";
	const connected = await provider.connect(ref);
	assert.equal(connected.error?.code, "gone");
	assert.match(connected.error?.message ?? "", /going/);
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
});

// --- a computer deleted out from under a connection (by the vendor's own API, mid-run) ---

/** The client's slack for the daemon's answer to a call's own timeout (client.test.mjs holds it to 5 s). */
const ANSWER_SLACK_MS = (await import("../dist/client.js")).ANSWER_SLACK_MS ?? 5_000;
/** The adapter's words for a computer that was deleted, never the stream's. */
const DELETED = /^the computer computer-[0-9a-f]{12} \(m\d{8}\) was deleted/;
/** Every setImmediate turn up to n: the stream's end, the fake's replies and the read-back, without a clock. */
const turns = async (n = 50) => {
	for (let i = 0; i < n; i++) await new Promise((done) => setImmediate(done));
};

test("a computer deleted while its connection is idle: the next call answers not_found in the adapter's words, after one read of the machine", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	const connected = made(await provider.connect(ref));
	fake.vanish(ref.id, "end");
	await turns();
	const gets = () => fake.calls.filter(([name, id]) => name === "get" && id === ref.id).length;
	const before = gets();
	const shot = await connected.client.call("exec.run", { argv: ["true"], timeoutMs: 5_000 });
	assert.equal(shot.error?.code, "not_found", JSON.stringify(shot));
	assert.match(shot.error.message, DELETED);
	assert.doesNotMatch(shot.error.message, /stream/);
	// Every later call says the same, with no second read: the stream ended once.
	const again = await connected.client.call("files.stat", { path: "/proc/self/cwd" });
	assert.deepEqual(again, shot);
	assert.equal(gets() - before, 1, "the machine is read once");
	await connected.close();
});

test("a computer deleted during a call in flight: that call and every other in flight settle not_found in the adapter's words, before their timeouts", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	const connected = made(await provider.connect(ref));
	const running = [connected.client.call("exec.run", { argv: ["sleep", "600"], timeoutMs: 600_000 }), connected.client.call("exec.run", { argv: ["sleep", "60"], timeoutMs: 60_000 })];
	await turns();
	fake.vanish(ref.id, "end");
	const settled = await Promise.all(running);
	for (const one of settled) {
		assert.equal(one.error?.code, "not_found", JSON.stringify(one));
		assert.match(one.error.message, DELETED);
	}
	assert.deepEqual(settled[0], settled[1], "one answer for every call in flight");
	await connected.close();
});

test("a call in flight whose transport hangs ends at its own timeoutMs (and the answer's slack), not at the transport's death; a deleted computer then ends every other call waiting, and later ones, not_found", async (t) => {
	for (const deleted of [true, false]) {
		const { provider, fake } = setup();
		const ref = made(await create(provider));
		const connected = made(await provider.connect(ref));
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let answer;
		let other;
		connected.client.call("exec.run", { argv: ["sleep", "120"], timeoutMs: 70_000 }).then((result) => (answer = result));
		await turns();
		if (deleted) fake.vanish(ref.id, "hang");
		else only(fake).hung = true;
		// A call with no timeoutMs of its own, sent once the transport hangs: nothing bounds it but the connection.
		connected.client.call("files.stat", { path: "/proc/self/cwd" }).then((result) => (other = result));
		t.mock.timers.tick(70_000 + ANSWER_SLACK_MS - 1);
		await turns();
		assert.equal(answer, undefined, "still waiting just short of its bound");
		t.mock.timers.tick(1);
		await turns();
		assert.ok(answer, "settled at its bound, while the transport still hangs");
		assert.equal(answer.error?.code, "timeout", JSON.stringify(answer));
		assert.match(answer.error.message, /exec\.run had no answer within 75 s \(its own timeout of 70 s, and 5 s for the answer to come\)/);
		if (deleted) {
			assert.equal(other?.error?.code, "not_found", `the other call waiting: ${JSON.stringify(other)}`);
			assert.match(other.error.message, DELETED);
			const later = await connected.client.call("exec.run", { argv: ["true"], timeoutMs: 1_000 });
			assert.deepEqual(later, other, "a later call says the same");
		} else {
			assert.equal(other, undefined, "a computer still there: the other call waits on its connection");
		}
		t.mock.timers.reset();
		await connected.close();
		if (!deleted) assert.equal(other?.error?.code, "gone", "and the close ends it");
	}
});

test("a computer the vendor reads as going once its stream ended (Agent37 reads a deleted instance so) is deleted too: not_found in the adapter's words", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	const connected = made(await provider.connect(ref));
	const m = only(fake);
	m.state = "gone";
	for (const bridge of m.bridges) bridge.exit(255);
	await turns();
	const after = await connected.client.call("exec.run", { argv: ["true"], timeoutMs: 1_000 });
	assert.equal(after.error?.code, "not_found", JSON.stringify(after));
	assert.match(after.error.message, DELETED);
	await connected.close();
});

test("a computer the vendor reads failed once its stream ended (gone with a why) was not deleted: the stream's words", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	const connected = made(await provider.connect(ref));
	const m = only(fake);
	m.why = "out of memory";
	for (const bridge of m.bridges) bridge.exit(255);
	await turns();
	const after = await connected.client.call("exec.run", { argv: ["true"], timeoutMs: 1_000 });
	assert.equal(after.error?.code, "gone", JSON.stringify(after));
	assert.match(after.error.message, /the daemon's stream (ended|closed)/);
	await connected.close();
});

/** A request bound far past any test's own, so only an abort or a close can end a read the vendor holds. */
const SLOW_READS = { timeouts: { ...TIMEOUTS, requestMs: 3_600_000 } };

test("a caller that aborts while the machine is read back stops waiting on the read: the client's own words, at once", async () => {
	const held = deferred();
	let holdGets = false;
	const { provider, fake } = setup(SLOW_READS, { onStep: (step) => (holdGets && step === "get" ? held.promise : undefined) });
	const ref = made(await create(provider));
	const connected = made(await provider.connect(ref));
	const controller = new AbortController();
	holdGets = true;
	const running = connected.client.call("exec.run", { argv: ["sleep", "60"], timeoutMs: 60_000 }, { signal: controller.signal });
	await turns();
	const gets = () => fake.calls.filter(([name, id]) => name === "get" && id === ref.id).length;
	const before = gets();
	fake.vanish(ref.id, "end");
	await turns();
	assert.equal(gets(), before + 1, "the read-back started, and the vendor holds it");
	controller.abort();
	const answer = await running;
	assert.equal(answer.error?.code, "gone", JSON.stringify(answer));
	held.resolve();
	await connected.close();
});

test("a close while the machine is read back releases every call waiting on the read: the client's own words, at once", async () => {
	const held = deferred();
	let holdGets = false;
	const { provider, fake } = setup(SLOW_READS, { onStep: (step) => (holdGets && step === "get" ? held.promise : undefined) });
	const ref = made(await create(provider));
	const connected = made(await provider.connect(ref));
	holdGets = true;
	const running = connected.client.call("exec.run", { argv: ["sleep", "60"], timeoutMs: 60_000 });
	await turns();
	fake.vanish(ref.id, "end");
	await turns();
	await connected.close();
	const answer = await running;
	assert.equal(answer.error?.code, "gone", JSON.stringify(answer));
	assert.match(answer.error.message, /the daemon's stream (ended|closed)/);
	held.resolve();
});

test("a connection closed by its caller is not a deleted computer: no read-back, the client's own words", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	const connected = made(await provider.connect(ref));
	await connected.close();
	const gets = fake.calls.filter(([name]) => name === "get").length;
	const after = await connected.client.call("exec.run", { argv: ["true"], timeoutMs: 1_000 });
	assert.equal(after.error?.code, "gone");
	assert.match(after.error.message, /the connection was closed/);
	assert.equal(fake.calls.filter(([name]) => name === "get").length, gets, "no read of the machine");
});

test("a stream that ends on a computer still running keeps the stream's words: only a deleted computer is not_found", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	const connected = made(await provider.connect(ref));
	for (const bridge of only(fake).bridges) bridge.exit(255);
	await turns();
	const after = await connected.client.call("exec.run", { argv: ["true"], timeoutMs: 1_000 });
	assert.equal(after.error?.code, "gone");
	assert.match(after.error.message, /the daemon's stream (ended|closed)/);
	await connected.close();
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
	assert.deepEqual({ image: byId.spec.image, user: byId.spec.user, network: byId.spec.network, kind: byId.spec.kind }, { image: "img", user: "2510:2510", network: "none", kind: "linux" });
	assert.deepEqual([byId.spec.snapshot, byId.spec.cpus, byId.spec.memoryMb], [undefined, undefined, undefined], "the image is the one create asked for (its label); no vendor size or snapshot is read back");
	assert.equal(made(await provider.attach({ labels: { team: "a" } })).id, a.id);
	assert.equal((await provider.attach({ labels: { team: "c" } })).error?.code, "not_found");
	fake.machines.get(a.id).box.interfaces = ["lo", "eth0"];
	const drifted = await provider.attach({ id: a.id });
	assert.equal(drifted.error?.code, "refused");
	assert.equal(fake.machines.get(a.id).deleted, false);
});

test("network() reads the network from inside (the probe) and refuses any change: it is fixed at create", async () => {
	const { provider, fake } = setup();
	const ref = made(await create(provider));
	const probes = () => fake.requests.filter(({ method, params }) => method === "exec.run" && params.argv[1] === "probe").length;
	const before = probes();
	assert.equal(made(await provider.network(ref)), "none");
	assert.ok(probes() > before, "the probe from inside is the network's truth, with no vendor read-back");
	only(fake).box.reached = ["1.1.1.1:443"];
	assert.match(made(await provider.network(ref)).other, /created none, yet from inside: .*an answer from 1\.1\.1\.1:443/, "a probe that reaches out is no network none");
	only(fake).box.reached = [];
	assert.equal(made(await provider.network(ref, "none")), "none", "the network it already has answers ok");
	for (const policy of ["open", { allow: ["example.com"] }]) {
		const refused = await provider.network(ref, policy);
		assert.equal(refused.error?.code, "refused");
		assert.match(refused.error.message, /fixed at create/);
	}
});

// --- network open and a list: init's egress proxy ---

const NETWORK_LABEL = "agentrun.computer.network";
const POLICY = "/opt/agentrun/egress/policy";
const RELAY = "127.0.0.1:3128";
/** The fake with every network form declared, as Agent37, E2B, Modal and Daytona declare them. */
const OPEN = { descriptor: NETWORK_DESCRIPTOR };
const LIST = { allow: ["Example.com", "93.184.215.0/24"] };
const policyReads = (fake) => fake.requests.filter(({ method, params }) => method === "files.read" && params.path === POLICY).length;

test("a descriptor's network forms are what the adapter declares and takes; a form it does not declare is refused at check() in words naming the provider and the choices, never widened or narrowed", () => {
	const open = setup(OPEN).provider;
	assert.deepEqual(open.capabilities().network, ["none", "open", "allow"]);
	assert.deepEqual(open.capabilities().allow, { domains: { max: 256, ports: [80, 443] }, cidrs: { max: 256, ports: [80, 443] }, mixed: true }, "a list's bounds: Docker's, ports 80 and 443");
	for (const network of ["none", "open", LIST]) assert.deepEqual(open.check({ ...SPEC, network }), [], JSON.stringify(network));
	const bad = open.check({ ...SPEC, network: { allow: ["*.com.", "example.com"] } });
	assert.deepEqual(bad.map(({ field }) => field), ["network"], "a malformed list is refused, in the list's own words");
	assert.match(bad[0].message, /Fakehost's allowlist|not a name|wildcard|entry/i);
	const words = (descriptor, network) => setup({ descriptor }).provider.check({ ...SPEC, network }).map(({ field, message }) => `${field}: ${message}`);
	assert.deepEqual(words(FAKE_DESCRIPTOR, "open"), ["network: Fakehost can't open the network; choose none"]);
	assert.deepEqual(words(FAKE_DESCRIPTOR, LIST), ["network: Fakehost can't limit the network to a list; choose none"]);
	const noList = { ...FAKE_DESCRIPTOR, network: ["none", "open"] };
	assert.deepEqual(words(noList, LIST), ["network: Fakehost can't limit the network to a list; choose none or open"], "the lead's words");
	assert.equal(setup({ descriptor: noList }).provider.capabilities().allow, undefined, "no list's bounds where no list is declared");
	assert.deepEqual(words(noList, "open"), []);
	assert.deepEqual(words(NETWORK_DESCRIPTOR, "wide"), ["network: network is required: none, open or a list ({ allow: [names or CIDRs] })"]);
	// The proxy runs as nobody, so the programs' user may not be nobody where it runs: then they could signal it.
	const users = setup(OPEN, { facts: USER_FACTS }).provider;
	for (const user of ["65534", "1000:65534"]) {
		assert.deepEqual(users.check({ ...SPEC, network: "open", user }).map(({ field }) => field), ["user"], user);
		assert.deepEqual(users.check({ ...SPEC, user }), [], `${user} under none: no proxy`);
	}
});

test("create under open: the machine is asked for egress, carries the form in a label, init is given --network open; the read-back finds init's relay answering, nothing answering directly, and the proxy's policy; list, attach and network() read open back", async () => {
	const { provider, fake } = setup(OPEN);
	const ref = made(await create(provider, { ...SPEC, network: "open" }));
	const m = only(fake);
	assert.equal(m.request.egress, true, "the machine gets the vendor's egress, for the proxy");
	assert.equal(m.request.labels[NETWORK_LABEL], "open");
	assert.equal(m.init.network, "open", "init starts the proxy for open");
	const start = fake.events.find(({ machine, what }) => machine === m.id && what === "run start");
	assert.ok(start, "a child host's start");
	assert.ok(policyReads(fake) >= 1, "the policy beside the proxy's socket is read back");
	const probe = fake.requests.find(({ method, params }) => method === "exec.run" && params.argv[1] === "probe" && params.argv.includes("--connect"));
	assert.ok(probe.params.argv.includes(RELAY), "the probe tries init's relay too");
	assert.deepEqual(ref.notes, [INSTALLER_NOTE]);
	const [info] = made(await provider.list({}));
	assert.equal(info.network, "open");
	assert.equal(made(await provider.attach({ id: ref.id })).spec.network, "open");
	assert.equal(made(await provider.network(ref)), "open");
	assert.equal(made(await provider.network(ref, "open")), "open", "the network it has answers ok");
	for (const policy of ["none", LIST]) {
		const refused = await provider.network(ref, policy);
		assert.equal(refused.error?.code, "refused");
		assert.match(refused.error.message, /fixed at create/);
	}
	// From inside, against what the label records: each is drift, and network() says so.
	m.box.reached = ["1.1.1.1:443"];
	assert.match(made(await provider.network(ref)).other, /created open, yet from inside: .*direct answer from 1\.1\.1\.1:443/);
	m.box.reached = [];
	m.box.relay = "down";
	assert.match(made(await provider.network(ref)).other, /relay at 127\.0\.0\.1:3128 did not answer/);
	delete m.box.relay;
	m.box.policy = "allow:example.com";
	assert.match(made(await provider.network(ref)).other, /the egress proxy serves "allow:example\.com"/);
	delete m.box.policy;
	m.box.interfaces = ["lo", "eth0"];
	assert.match(made(await provider.network(ref)).other, /eth0/, "the netns is lo alone under open too");
});

test("create under a list: the form, normalized, goes to the label and to init; list, attach and network() read the list back; a retry with another list is refused as exists", async () => {
	const { provider, fake } = setup(OPEN);
	const spec = { ...SPEC, network: LIST };
	const ref = made(await provider.create(spec, { requestId: "listed" }));
	const m = only(fake);
	assert.equal(m.request.egress, true);
	assert.equal(m.request.labels[NETWORK_LABEL], "allow:example.com,93.184.215.0/24");
	assert.equal(m.init.network, "allow:example.com,93.184.215.0/24");
	const read = { allow: ["example.com", "93.184.215.0/24"] };
	assert.deepEqual(made(await provider.list({})).map((info) => info.network), [read]);
	assert.deepEqual(made(await provider.attach({ id: ref.id })).spec.network, read);
	assert.deepEqual(made(await provider.network(ref)), read);
	assert.deepEqual(made(await provider.network(ref, LIST)), read, "the same list, as given, answers ok");
	assert.equal((await provider.network(ref, { allow: ["example.org"] })).error?.code, "refused");
	assert.equal(made(await provider.create(spec, { requestId: "listed" })).id, ref.id, "a retry of the same list finds it");
	const other = await provider.create({ ...SPEC, network: { allow: ["example.org"] } }, { requestId: "listed" });
	assert.equal(other.error?.code, "exists", other.error?.message);
	assert.equal(fake.machines.size, 1);
});

test("a computer whose network does not read back as created is refused at create and deleted: a direct answer, init's relay down, the proxy serving another form", async () => {
	for (const [box, words] of [
		[{ reached: ["1.1.1.1:443"] }, /declared open through the egress proxy alone, read back a direct answer from 1\.1\.1\.1:443/],
		[{ relay: "down" }, /init's relay at 127\.0\.0\.1:3128 did not answer from inside/],
		[{ policy: "allow:example.com" }, /declared open, the egress proxy serves "allow:example\.com"/],
	]) {
		const { provider, fake } = setup(OPEN, { box });
		const refused = await create(provider, { ...SPEC, network: "open" });
		assert.equal(refused.error?.code, "refused", JSON.stringify(box));
		assert.match(refused.error.message, words);
		await nothingLeft(fake, JSON.stringify(box));
	}
});

test("create under none, with every form declared, is as before: no egress, no network label, no --network for init, no proxy policy read", async () => {
	const { provider, fake } = setup(OPEN);
	const ref = made(await create(provider));
	const m = only(fake);
	assert.equal(m.request.egress, false);
	assert.equal(m.request.labels[NETWORK_LABEL], undefined);
	assert.equal(m.init.network, "", "no proxy");
	assert.equal(policyReads(fake), 0);
	const probe = fake.requests.find(({ method, params }) => method === "exec.run" && params.argv[1] === "probe" && params.argv.includes("--connect"));
	assert.ok(!probe.params.argv.includes(RELAY), "the probe tries the configured targets alone");
	assert.deepEqual(ref.notes, [INSTALLER_NOTE, ACCEPTED_NOTE]);
	assert.equal(made(await provider.network(ref)), "none");
});

test("pid1 under open: the entrypoint gives init --network open after its other flags, and the read-back holds", async () => {
	const { provider, fake } = setup(OPEN, { facts: { daemon: "pid1" } });
	made(await create(provider, { ...SPEC, network: "open" }));
	const m = only(fake);
	assert.equal(m.request.egress, true);
	assert.deepEqual(m.request.command.slice(-2), ["--network", "open"]);
	assert.equal(m.init.network, "open");
	const plain = setup(OPEN, { facts: { daemon: "pid1" } });
	made(await create(plain.provider));
	assert.ok(!only(plain.fake).request.command.includes("--network"), "none: no --network");
});

test("Archil under open and under none: the root still gets egress and mounts before init starts, and init gets the network form alone under open", async () => {
	for (const network of ["none", "open"]) {
		const { provider, fake } = setup(OPEN, { box: { reached: [] } });
		const ref = made(await create(provider, { ...ARCHIL_SPEC, network }));
		const m = only(fake);
		assert.equal(m.request.egress, true, `${network}: the root reaches Archil`);
		const runs = runsOf(fake, m.id);
		assert.ok(runs.indexOf("run mount") < runs.indexOf("run serve") && runs.indexOf("run serve") < runs.indexOf("run start"), runs.join(", "));
		assert.equal(m.init.network, network === "open" ? "open" : "");
		const [info] = made(await provider.list({ "agentrun.run": "r1" }));
		assert.equal(info.network, network);
		assert.equal(info.mount.kind, "archil");
		assert.equal(made(await provider.network(ref)), network);
	}
});

test("the pid1 entrypoint, run by sh, gives init --network and the form where one is given, and nothing where none is", () => {
	const root = mkdtempSync(join(tmpdir(), "computer-entrypoint-"));
	try {
		const home = join(root, "work");
		mkdirSync(home);
		const daemon = join(root, "computerd");
		writeFileSync(daemon, '#!/bin/sh\necho "args=$*"\n');
		chmodSync(daemon, 0o755);
		writeFileSync(`${daemon}.installed`, "n0nce\n");
		const run = (network) => {
			const words = [...hostedCommands({ deadline: "2030-01-01T00:00:00.000Z", atomic: true, waitS: 5, nonce: "n0nce", network }).entrypoint];
			words[4] = daemon;
			words[6] = home;
			return execFileSync(words[0], words.slice(1), { cwd: "/", env: { PATH: process.env.PATH }, encoding: "utf8" }).trim();
		};
		const base = "args=init --deadline 2030-01-01T00:00:00.000Z --user 2510:2510 --own-network";
		assert.equal(run("open"), `${base} --network open`);
		assert.equal(run("allow:example.com,93.184.215.0/24"), `${base} --network allow:example.com,93.184.215.0/24`);
		assert.equal(run(""), base);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a child's start gives init the network form as its eighth word, after the display and the maximum, empty where not given", () => {
	const at = (options) => {
		const { start } = hostedCommands({ deadline: "2030-01-01T00:00:00.000Z", ...options });
		// start: [..., INIT, "sh", d, t, w, h, r, v?, m?, n?]: the words after the daemon's own, home and the socket's folder.
		return start.slice(start.indexOf(DAEMON) + 5);
	};
	assert.deepEqual(at({ network: "open" }), ["", "", "open"]);
	assert.deepEqual(at({ display: ":0", maxDeadline: "2030-01-02T00:00:00.000Z", network: "open" }), [":0", "2030-01-02T00:00:00.000Z", "open"]);
	assert.deepEqual(at({ display: ":0" }), [":0", ""], "no form, no eighth word");
	assert.deepEqual(at({}), []);
	const init = hostedCommands().start.find((word) => word.startsWith("# agentrun-computer: init"));
	assert.match(init, /n=\$\{8-\}/);
	assert.match(init, /\$\{n:\+--network "\$n"\}/, "init takes it as --network");
});

test("testConnection lists by the adapter's label and counts this provider's machines, making nothing", async () => {
	const { provider, fake } = setup();
	made(await create(provider));
	fake.add({ labels: { [COMPUTER]: "1", [NAME]: "someone-else" } });
	assert.match(made(await provider.testConnection()).detail, /^Fakehost answered: 1 computer of this provider$/);
});

test("a listing as the vendor reads it (more machines than carry the labels): list keeps those with the labels, each read by get; attach and a retry find theirs, and testConnection counts", async () => {
	const { provider, fake } = setup();
	const a = made(await provider.create({ ...SPEC, labels: { team: "a" } }, { requestId: "listing-a" }));
	const b = made(await create(provider, { ...SPEC, labels: { team: "b" } }));
	// The listing filters by the adapter's label alone: the adapter keeps those that carry the rest.
	const listing = fake.host.list;
	fake.host.list = async (labels, ctx) => listing({ [COMPUTER]: "1" }, ctx);
	const gets = () => fake.calls.filter(([name]) => name === "get").length;
	let before = gets();
	const listed = made(await provider.list({ team: "a" }));
	assert.deepEqual(listed.map((info) => [info.ref.id, info.network, info.state]), [[a.id, "none", "running"]]);
	assert.equal(gets(), before + 1, "one get, of the one listed machine that carries the labels: the listing finds, get answers");
	fake.machines.get(b.id).state = "stopped";
	assert.deepEqual(made(await provider.list({ team: "b" })).map((info) => [info.ref.id, info.state]), [[b.id, "stopped"]], "a stopped machine is listed, as the janitor needs");
	fake.machines.get(b.id).state = "gone";
	assert.deepEqual(made(await provider.list({ team: "b" })), [], "a gone one is not");
	fake.machines.get(b.id).state = "running";
	assert.equal(made(await provider.attach({ labels: { team: "a" } })).id, a.id);
	assert.equal(made(await provider.create({ ...SPEC, labels: { team: "a" } }, { requestId: "listing-a" })).id, a.id, "a retry reads its computer by get");
	before = gets();
	assert.match(made(await provider.testConnection()).detail, /^Fakehost answered: 2 computers of this provider$/);
	assert.equal(gets(), before, "Settings' test reads the listing alone");
	assert.equal(fake.creates(), 2);
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
	assert.equal(m.request.egress, true, "egress: the vendor's network is root's, to reach Archil");
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

test("Archil: the mount's label records the folder's agent alone, since agentrun.run holds its run; list and attach read the whole folder back", async () => {
	const { provider, fake } = setup({}, { box: { reached: [] } });
	const ref = made(await create(provider, ARCHIL_SPEC));
	const m = only(fake);
	assert.equal(m.labels["agentrun.mount"], JSON.stringify({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, agent: "a1" }));
	const [info] = made(await provider.list({ "agentrun.run": "r1" }));
	assert.deepEqual({ ...info.mount, exclusive: undefined, epoch: undefined }, { kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder, exclusive: undefined, epoch: undefined });
	const attached = made(await provider.attach({ id: ref.id }));
	assert.equal(attached.spec.mount.folder, MOUNT.folder);
	noToken(attached.spec.mount, "the attached spec's mount");
});

/** The adapter's own labels at their longest: a name of its making, and a deadline and its cap as ISO times. */
const ownLongest = (image, more = {}) => ({ [COMPUTER]: "1", [NAME]: "computer-000000000000", [DEADLINE]: new Date(0).toISOString(), "agentrun.computer.image": image, [MAX]: new Date(0).toISOString(), ...more });
const pairBytes = (labels) => Object.entries(labels).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);

test("facts.labels.count: the adapter counts the caller's labels with its own as create gives them, at check() with no host call, and create refuses the same words before any host call", async () => {
	const own = Object.keys(ownLongest(SPEC.image)).length;
	const { provider, fake } = setup({}, { facts: { labels: { count: own + 2 } } });
	assert.deepEqual(provider.check({ ...SPEC, labels: { a: "1", b: "2" } }), [], "at the bound");
	const spec = { ...SPEC, labels: { a: "1", b: "2", c: "3" } };
	const over = provider.check(spec);
	assert.deepEqual(over, [{ field: "labels", message: `a Fakehost computer carries at most ${own + 2} labels, the adapter's own among them, and this one's would carry ${own + 3}, ${own} of them the adapter's: give at most 2 labels` }]);
	assert.deepEqual(fake.calls, [], "check made no host call");
	const refused = await create(provider, spec);
	assert.equal(refused.error?.code, "refused");
	assert.equal(refused.error.message, `labels: ${over[0].message}`);
	assert.deepEqual(fake.calls, [], "create made no host call");
	// An Archil mount's label and a GPU's count as create gives them; a count past the bound is the labels' to fix, even on an Archil computer.
	const archil = setup({}, { facts: { labels: { count: own + 1 + Object.keys(ARCHIL_SPEC.labels).length } } });
	assert.deepEqual(archil.provider.check(ARCHIL_SPEC), []);
	const more = archil.provider.check({ ...ARCHIL_SPEC, labels: { ...ARCHIL_SPEC.labels, a: "1" } });
	assert.deepEqual(more.map(({ field }) => field), ["labels"]);
	assert.match(more[0].message, new RegExp(`, ${own + 1} of them the adapter's`));
	const gpu = setup({ ...WITH_GPU }, { facts: { labels: { count: own + 1 } } });
	assert.deepEqual(gpu.provider.check({ ...SPEC, gpu: H100 }), []);
	assert.match(gpu.provider.check({ ...SPEC, gpu: H100, labels: { a: "1" } })[0]?.message ?? "", new RegExp(`, ${own + 1} of them the adapter's: give at most 0 labels`));
});

test("facts.labels.bytes: the adapter prices the caller's labels with its own at their longest, names and values, at check() and at create, before any host call", async () => {
	const own = pairBytes(ownLongest(SPEC.image));
	const pairs = setup({}, { facts: { labels: { bytes: own + 10 } } });
	assert.deepEqual(pairs.provider.check({ ...SPEC, labels: { a: "123456789" } }), [], "10 bytes fit");
	const over = pairs.provider.check({ ...SPEC, labels: { a: "1234567890" } });
	assert.deepEqual(over.map(({ field }) => field), ["labels"]);
	assert.match(over[0].message, new RegExp(`a Fakehost computer's labels come to at most ${own + 10} bytes, names and values together, and this computer's would come to ${own + 11} \\(.*\\ba 11\\b.*\\): give a shorter image, mount folder or labels`));
	assert.deepEqual(pairs.provider.check({ ...SPEC, image: "img2", labels: { a: "123456789" } }).map(({ field }) => field), ["labels"], "the image is one of the adapter's own labels");
	const refused = await create(pairs.provider, { ...SPEC, labels: { a: "1234567890" } });
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /labels: .*come to at most/);
	assert.deepEqual(pairs.fake.calls, [], "no host call");
	// Archil: the mount's own label is priced too, and the mount is the field.
	const archilOwn = pairBytes(ownLongest(ARCHIL_SPEC.image, { "agentrun.mount": JSON.stringify({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, agent: "a1" }) })) + pairBytes(ARCHIL_SPEC.labels);
	const archil = setup({}, { facts: { labels: { bytes: archilOwn } } });
	assert.deepEqual(archil.provider.check(ARCHIL_SPEC), [], "an Archil computer's labels at the bound fit");
	const long = archil.provider.check({ ...ARCHIL_SPEC, mount: { ...MOUNT, folder: "agents/a12/runs/r1/work" } });
	assert.deepEqual(long.map(({ field }) => field), ["mount"]);
	assert.match(long[0].message, /agentrun\.mount \d+/);
	noToken(long, "the refusal of the labels' size");
	// A GPU computer's label is priced too.
	const gpuOwn = pairBytes(ownLongest(SPEC.image, { [GPU_LABEL]: "H100:1" }));
	const gpu = setup({ ...WITH_GPU }, { facts: { labels: { bytes: gpuOwn } } });
	assert.deepEqual(gpu.provider.check({ ...SPEC, gpu: H100 }), [], "at the bound");
	assert.match(gpu.provider.check({ ...SPEC, gpu: H100, labels: { a: "" } })[0].message, new RegExp(`${GPU_LABEL} 27`));
});

/**
 * A vendor whose labels are tight (a cap on their count, short values), its host declaring facts.labels.packed and
 * storing, reading and listing labels as the adapter gives them: it never packs. Its create refuses labels past the
 * room, as the vendor would.
 */
function packedHost(fake, room) {
	return {
		...fake.host,
		facts: { ...fake.host.facts, labels: room },
		/** Each create's request, as the adapter gave it. */
		requests: [],
		async create(req, ctx) {
			this.requests.push(req);
			const entries = Object.entries(req.labels);
			if (room.count !== undefined && entries.length > room.count) throw new Error(`400: a machine takes at most ${room.count} tags, not ${entries.length}`);
			const long = entries.find(([, value]) => Buffer.byteLength(value) > (room.packed.valueBytes ?? Number.POSITIVE_INFINITY));
			if (long) throw new Error(`400: the tag ${long[0]} is longer than ${room.packed.valueBytes} bytes`);
			return fake.host.create(req, ctx);
		},
	};
}

test("facts.labels.packed is the adapter's to keep: a host that declares it and never packs (it stores and lists labels as given) passes the provider's Core cases in 5 tags of 256 bytes, and leaves nothing behind", async () => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const cases = conformanceCases.filter((one) => one.group === "provider" && one.level === "core" && one.id !== "provider.deadline");
	const host = packedHost(fakeHost(), { count: 5, packed: { valueBytes: 256 } });
	const report = await runConformance(new HostedProvider(host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }), { image: "img", cases, caseTimeoutMs: 20_000, cleanupTimeoutMs: 5_000 });
	assert.ok(report.results.length >= 3, report.results.map(({ id }) => id).join(" "));
	assert.deepEqual(
		report.results.filter(({ status }) => status !== "pass").map(({ id, status, reason }) => `${id} ${status}: ${reason}`),
		[],
	);
	assert.ok(host.requests.length > 0 && host.requests.every((req) => Object.keys(req.labels).length <= 5), "every create gave the host labels that fit its 5 tags");
	assert.deepEqual(report.cleanup.sweep.stillThere, [], "the end-of-run sweep finds the run's label in the packed tags");
});

test("facts.labels.packed: the adapter's real labels (a deadline, an image ref, a list, an Archil mount) round-trip exactly under a 5-tag cap, Kubernetes' rules, Cloudflare's names and a string list; a map that can't fit is refused in words", async () => {
	const { packLabels, unpackLabels } = VALUES;
	const image = "ghcr.io/parcha-ai/agentrun-box@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	const spec = { ...ARCHIL_SPEC, image, network: { allow: ["api.github.com", "registry.npmjs.org", "93.184.215.0/24"] } };
	const { fake } = setup(OPEN, { box: { reached: [] } });
	const host = packedHost(fake, { count: 5, packed: { valueBytes: 256 } });
	// Made whole on a packed host: every label the adapter reads back by get came back exactly.
	made(await create(new HostedProvider(host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }), spec));
	assert.ok(Object.keys(only(fake).labels).length <= 5, "stored in 5 tags");
	const [{ name }] = host.requests;
	const labels = unpackLabels(host.requests[0].labels);
	assert.ok(labels[DEADLINE] && labels["agentrun.computer.image"] === image && labels[NETWORK_LABEL].startsWith("allow:") && labels["agentrun.mount"], JSON.stringify(labels));
	const DNS = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
	const K8S_VALUE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
	const shapes = [
		// Vercel: 5 tags, values of 256.
		["a 5-tag cap", { count: 5, packed: { valueBytes: 256 } }, (stored) => assert.ok(Object.keys(stored).length <= 5)],
		// Kubernetes: names and values of [A-Za-z0-9._-], letters or digits at both ends, at most 63.
		["Kubernetes", { packed: { valueBytes: 63 } }, (stored) => Object.entries(stored).forEach(([key, value]) => assert.ok(DNS.test(key) && key.length <= 63 && K8S_VALUE.test(value) && value.length <= 63, `${key}=${value}`))],
		// Cloudflare: 10 labels, names of 16 bytes, values of 64.
		["Cloudflare", { count: 10, packed: { valueBytes: 64 } }, (stored) => Object.entries(stored).forEach(([key, value]) => assert.ok(key.length <= 16 && value.length <= 64))],
	];
	for (const [what, room, holds] of shapes) {
		const packed = packLabels(labels, name, room);
		assert.equal(packed.problem, undefined, what);
		holds(packed.labels);
		assert.deepEqual(unpackLabels(packed.labels), labels, `${what}: read back exactly`);
	}
	// Fly: a list of strings of at most 64, each name=value; read back in any order.
	const list = Object.entries(packLabels(labels, name, { packed: { valueBytes: 52 } }).labels).map(([key, value]) => `${key}=${value}`);
	assert.ok(list.every((entry) => entry.length <= 64), list.join(" "));
	const fromList = Object.fromEntries(list.reverse().map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
	assert.deepEqual(unpackLabels(fromList), labels, "a string list: read back exactly");
	assert.equal(unpackLabels({ [NAME]: name, run: "r1" }), undefined, "labels not packed are no packed map");
	// Too little room: refused in words at check(), and at create before any host call; an Archil computer's mount is the field.
	const tight = packedHost(fakeHost(OPEN), { count: 3, packed: { valueBytes: 63 } });
	const refused = new HostedProvider(tight, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }).check(spec);
	assert.deepEqual(refused.map(({ field }) => field), ["mount"]);
	assert.match(refused[0].message, /^a Fakehost computer keeps its labels packed, and its labels pack into \d+ labels of \d+ bytes in all, past the 3 labels it keeps: give a shorter image, mount folder, network list or labels$/);
	assert.match(packLabels(labels, name, { packed: { valueBytes: 10 } }).problem, /values hold at most 10 bytes, too few for the name computer-[0-9a-f]{12}/);
	const small = setup({}, { facts: { labels: { bytes: 100, packed: {} } } });
	// A digest's hex, which deflate barely shrinks.
	const none = await create(small.provider, { ...SPEC, labels: { note: createHash("sha512").update("note").digest("hex") } });
	assert.equal(none.error?.code, "refused");
	assert.match(none.error.message, /^labels: a Fakehost computer keeps its labels packed, and its labels pack into 2 labels of \d+ bytes in all, past the 100 bytes it keeps/);
	assert.deepEqual(small.fake.calls, [], "no host call");
	// A map past what unpackLabels inflates (1 MiB of JSON) is refused, though it deflates to almost nothing.
	assert.match(packLabels({ a: "x".repeat(1 << 20) }, name).problem, /as JSON, past the 1048576 a packed map holds/);
	const most = { a: "x".repeat((1 << 20) - 8) };
	assert.deepEqual(unpackLabels(packLabels(most, name).labels), most, "at the bound: read back");
});

test("facts.labels.packed at the edge: check() answers a spec the same every time, a computer made attaches, and create never gives the host labels that don't fit; one whose own deadlines pack a part longer is refused before any host call", async () => {
	const spec = { ...SPEC, image: "ghcr.io/parcha-ai/agentrun-box@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" };
	// The real map's one part, from a create on a packed host with room.
	const roomy = packedHost(fakeHost(), { packed: {} });
	made(await create(new HostedProvider(roomy, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }), spec));
	const part = roomy.requests[0].labels["agentrun-0"].length;
	// One name and one part: the part's room steps across the map's length, so some creates land on the edge.
	const sizes = [];
	for (let valueBytes = part - 10; valueBytes <= part + 10; valueBytes++) {
		const fake = fakeHost();
		const host = packedHost(fake, { count: 2, packed: { valueBytes } });
		const provider = new HostedProvider(host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
		// check() answers a spec the same every time: attach and a retry check it again.
		assert.equal(new Set(Array.from({ length: 10 }, () => JSON.stringify(provider.check(spec)))).size, 1, `${valueBytes}: one answer`);
		const result = await create(provider, spec);
		if (result.ok) {
			sizes.push(["made", valueBytes]);
			made(await provider.attach({ id: result.value.id }));
		} else {
			assert.equal(result.error.code, "refused", result.error.message);
			assert.match(result.error.message, /keeps its labels packed, and its labels pack into 3 labels/);
			assert.equal(host.requests.length, 0, `${valueBytes}: no labels that don't fit reach the host`);
			sizes.push(["refused", valueBytes]);
		}
	}
	assert.ok(sizes.some(([what]) => what === "made") && sizes.some(([what]) => what === "refused"), JSON.stringify(sizes));
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
	assert.match(failed.error.message, /the window manager \(unshare .*dbus-run-session .*xfwm4 [^<]*\) did not start on :0: unshare: executable file not found/);
	await nothingLeft(missing.fake, "a window manager that cannot start");

	const ends = setup({ kind: "desktop" }, { facts: { windowManager: true }, display: "manager dies", lingers: { reads: 1, lists: 1 } });
	const ended = await create(ends.provider);
	assert.equal(ended.error?.code, "vendor");
	assert.match(ended.error.message, /the window manager \(unshare .*dbus-run-session .*xfwm4 [^<]*\) ended with exit code 1 within 1 s of starting on :0: Xfconf could not be initialized/);
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

test("the declared isolation: the probe's kernel is held to it at create, gVisor exactly where capabilities (or a GPU computer's) say gvisor, with no runtime hook", async () => {
	const gvisor = setup({}, { facts: { ...USER_FACTS, isolation: "gvisor" } });
	assert.equal(gvisor.fake.host.facts.runtime, undefined);
	const refused = await create(gvisor.provider);
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /runtime: declared gVisor, read back another kernel \("6\.1\.102"\)/);
	await nothingLeft(gvisor.fake, "a computer of another runtime");
	const vm = setup({}, { facts: { ...USER_FACTS, isolation: "vm" }, box: { kernel: "4.19.0-gvisor" } });
	const other = await create(vm.provider);
	assert.match(other.error?.message ?? "", /runtime: declared vm, read back gVisor/);
	made(await create(setup({}, { facts: { ...USER_FACTS, isolation: "gvisor" }, box: { kernel: "4.19.0-gvisor" } }).provider));
	made(await create(setup({}, { box: { kernel: "4.19.0-gvisor" } }).provider), "a microvm is held to no kernel");
	// A GPU computer on a vm host whose GPUs run on gVisor (Modal's): gVisor for it alone.
	const gpu = setup({ descriptor: gpuDescriptor({ types: ["H100"], max: 1, isolation: "gvisor" }) }, { facts: { ...USER_FACTS, isolation: "vm" } });
	assert.match((await create(gpu.provider, { ...SPEC, gpu: H100 })).error?.message ?? "", /runtime: declared gVisor \(a GPU computer\), read back another kernel/);
	made(await create(gpu.provider));
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

test("a host's get that answers no machine, or throws not_found (its errorCode's or a HostError's), is a machine that is gone", async () => {
	for (const style of ["throw", "HostError", "undefined"]) {
		const { provider, fake } = setup({}, { starting: 2 });
		const made = fake.host.create;
		fake.host.create = async (...args) => {
			const result = await made(...args);
			fake.host.get = async () => {
				if (style === "throw") throw new NotFound("no such machine");
				if (style === "HostError") throw new HostError("not_found", "no such machine");
				return undefined;
			};
			return result;
		};
		const result = await create(provider);
		assert.equal(result.error?.code, "gone", style);
		assert.match(result.error.message, /was gone before it ran/, style);
	}
});

test("a host's call answers its value or throws: a HostError is read as its own code, in its words, over the host's errorCode", async () => {
	const { provider, fake } = setup();
	fake.host.create = async () => {
		throw new HostError("limit", "the account's quota of 10 machines is reached");
	};
	const refused = await create(provider);
	assert.equal(refused.error?.code, "limit");
	assert.match(refused.error.message, /the account's quota of 10 machines is reached/);
	assert.equal(refused.error.vendor, undefined, "a code the host knows names no vendor");
	fake.host.create = async () => {
		throw new Error("502: Bad Gateway");
	};
	const broken = await create(provider);
	assert.equal(broken.error?.code, "vendor", "any other throw is the host's errorCode, vendor by default");
	assert.equal(broken.error.vendor, "fakehost");
});

test("exec takes no stdin flag: the adapter ends a process's stdin at once where it gives none, and after its bytes where it gives some", async () => {
	const { provider, fake } = setup({}, { fileApi: false });
	const ended = [];
	const exec = fake.host.exec;
	fake.host.exec = async (id, argv, ctx, ...rest) => {
		assert.deepEqual(rest, [], "three arguments: id, argv, ctx");
		assert.equal(typeof ctx?.timeoutMs, "number");
		const proc = await exec(id, argv, ctx);
		const kind = fake.events.at(-1).what;
		const written = [];
		return {
			...proc,
			write: async (bytes) => (written.push(bytes.length), proc.write(bytes)),
			end: async () => (ended.push([kind, written.length > 0]), proc.end()),
		};
	};
	made(await create(provider));
	assert.ok(ended.some(([kind, wrote]) => kind === "run upload" && wrote), "the upload's stdin ends after its bytes");
	assert.ok(ended.some(([kind, wrote]) => kind === "run install" && !wrote), "the install, given no stdin, has it ended at once");
	assert.ok(ended.some(([kind, wrote]) => kind === "run start" && !wrote), "so has init's start");
});

test("a command given no input never waits on its stdin's close: a vendor whose close never answers still creates", async () => {
	const { provider, fake } = setup();
	const exec = fake.host.exec;
	fake.host.exec = async (id, argv, ctx) => {
		const proc = await exec(id, argv, ctx);
		return { ...proc, end: () => new Promise(() => {}) };
	};
	made(await create(provider));
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
