// E2BProvider's Archil mount, against the fake E2B SDK (test/fake-e2b.mjs): the run's folder at /workspace through the
// shared steps (src/mount-archil.ts), each root step a background root command with stdin (sendStdin, then closeStdin),
// after the daemon's install and before init starts. The token reaches the helper's stdin alone: never a command line,
// metadata, a read-back or an error. No SDK, no archil, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DAEMON, fakeE2B, KEY } from "./fake-e2b.mjs";
import { ARCHIL_HELPER } from "./fake-modal.mjs";

const e2b = await import("../dist/e2b.js");
const { E2BProvider } = e2b;

const TOKEN = "tok-e2b-archil-0123456789abcdef";
const RUN = "r1";
const EPOCH = 3;
const MOUNT = { kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", folder: `agents/a1/runs/${RUN}/work`, token: TOKEN };
const LABELS = { "agentrun.run": RUN, "agentrun.epoch": String(EPOCH) };
const SPEC = { image: "agentrun-archil", lifetimeMs: 600_000, network: "none", labels: LABELS, mount: MOUNT };
const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DEADLINE = "agentrun.computer.deadline";
const IMAGE_LABEL = "agentrun.computer.image";
const MAX_LABEL = "agentrun.computer.max-deadline";
const TIMEOUT_LABEL = "agentrun.computer.timeout-ms";
const MOUNT_LABEL = "agentrun.mount";
const HOUR = 3_600_000;
const readBack = (epoch = EPOCH) => ({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder, exclusive: true, epoch });
const mountLabel = () => JSON.stringify({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder });

const dir = mkdtempSync(join(tmpdir(), "computer-e2b-archil-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, "a stand-in for computerd, linux/amd64\n");
test.after(() => rmSync(dir, { recursive: true, force: true }));

const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, mountMs: 1_000 };

/**
 * The provider on the fake, kind linux, its daemon user the tool user. E2B's internet access stays on for an Archil
 * computer (root reaches Archil), so the tools' network none is init's own namespace: the probe reaches nothing here,
 * as it does once init runs with it.
 */
function setup(options = {}, fakeOptions = {}) {
	const fake = fakeE2B({ ...fakeOptions, box: { reached: [], accepted: [], ...fakeOptions.box } });
	const provider = new E2BProvider({ apiKey: KEY, Sandbox: fake.Sandbox, daemonPath: DAEMON_PATH, kind: "linux", daemonUser: "2510:2510", timeouts: TIMEOUTS, ...options });
	return { fake, provider };
}
const noToken = (value, what) => assert.ok(!JSON.stringify(value ?? null).includes(TOKEN), `${what} holds the token`);
const createOpts = (fake) => fake.calls.find(([name]) => name === "Sandbox.create")?.[2];
const eventsOf = (fake, id) => fake.events.filter((event) => event.sandbox === id).map(({ what }) => what);
const indexOf = (fake, id, what) => fake.events.findIndex((event) => event.sandbox === id && event.what === what);
const verbsOf = (fake, id) => fake.rootRuns.filter((run) => run.sandbox === id).map(({ verb }) => verb);
const newest = (fake) => [...fake.sandboxes.values()].at(-1);

/** An Archil computer as create leaves one, seeded straight into the fake, with init running as the tool user. */
function seededArchil(fake, { name = "computer-0123456789ab", epoch = EPOCH, run = RUN, label = mountLabel(), box = {}, state = "running", allowInternetAccess = true } = {}) {
	const deadline = new Date(Date.now() + 600_000).toISOString();
	const sb = fake.add({
		template: "agentrun-archil",
		metadata: {
			"agentrun.run": run,
			"agentrun.epoch": String(epoch),
			...(label === undefined ? {} : { [MOUNT_LABEL]: label }),
			[COMPUTER]: "1",
			[NAME]: name,
			[DEADLINE]: deadline,
			[IMAGE_LABEL]: "agentrun-archil",
			[MAX_LABEL]: new Date(Date.now() + HOUR).toISOString(),
			[TIMEOUT_LABEL]: "600000",
		},
		timeoutMs: 600_000,
		allowInternetAccess,
		network: { allowPublicTraffic: false },
		lifecycle: { onTimeout: "kill" },
		state,
		box: { uid: 2510, gid: 2510, mounted: { disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder }, served: true, ...box },
	});
	sb.daemon = { path: DAEMON, bytes: Buffer.from("x") };
	sb.init = { deadline, user: "2510:2510", display: "", max: new Date(Date.now() + HOUR).toISOString() };
	return { sb, ref: { id: sb.id, name } };
}

test("E2B: MOUNT is [\"archil\"], what capabilities() declares", () => {
	const { provider } = setup();
	assert.deepEqual([...e2b.MOUNT], ["archil"]);
	assert.deepEqual(provider.capabilities().mount, ["archil"]);
});

test("E2B check(): an Archil spec takes network none, the run and epoch labels, the helper's shapes and a daemon user that is the tool user, with no SDK call; no refusal holds the token", () => {
	const { provider, fake } = setup();
	assert.deepEqual(provider.check(SPEC), []);
	const cases = [
		[{ network: "open" }, "network", /none/],
		[{ labels: { "agentrun.run": RUN } }, "labels", /agentrun\.epoch/],
		[{ labels: { ...LABELS, [MOUNT_LABEL]: "x" } }, "labels", /agentrun\.mount/],
		[{ mount: { ...MOUNT, folder: "agents/a1/runs/r2/work" } }, "mount", /run r2/],
		[{ mount: { ...MOUNT, token: "short" } }, "mount", /mount\.token/],
		[{ mount: { ...MOUNT, extra: TOKEN } }, "mount", /mount\.extra/],
	];
	for (const [change, field, words] of cases) {
		const refusals = provider.check({ ...SPEC, ...change });
		assert.ok(refusals.some((r) => r.field === field && words.test(r.message)), `${field}: ${JSON.stringify(refusals).replace(TOKEN, "[token]")}`);
		noToken(refusals, `the refusal of ${field}`);
	}
	const other = setup({ daemonUser: "1000:1000" });
	const refusals = other.provider.check(SPEC);
	assert.ok(refusals.some((r) => r.field === "mount" && /2510/.test(r.message) && /daemonUser/.test(r.message)), JSON.stringify(refusals).replace(TOKEN, "[token]"));
	assert.deepEqual(other.provider.check({ ...SPEC, mount: undefined }), [], "a computer with no mount is the daemon user's as before");
	assert.deepEqual(fake.calls, [], "no SDK call");
});

test("E2B create of an Archil computer: install, then preflight, netlock, the takeover, mount with the token on stdin, and serve, as root, before init starts; then the read-back", async () => {
	const { provider, fake } = setup();
	const created = await provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	noToken(created, "create's result");
	const options = createOpts(fake);
	assert.equal(options.allowInternetAccess, true, "the archil client reaches Archil as root: internet access stays on; the tools' network is init's");
	assert.deepEqual(options.network, { allowPublicTraffic: false });
	assert.equal(options.metadata[MOUNT_LABEL], mountLabel(), "the mount's label: kind and source");
	noToken(options, "the create options");

	const { id } = newest(fake);
	const events = eventsOf(fake, id).filter((what) => what.startsWith("run "));
	assert.deepEqual(events.slice(0, 7), ["run install", "run preflight", "run netlock", "run mount", "run serve", "run init", "run stdio"]);
	const after = eventsOf(fake, id).slice(eventsOf(fake, id).indexOf("run init"));
	assert.ok(after.includes("daemon mount.sync"), "the read-back asks serve for a sync");
	assert.ok(after.indexOf("daemon files.read") < after.indexOf("daemon mount.sync"));
	const runs = fake.rootRuns.filter((run) => run.sandbox === id);
	assert.deepEqual(runs[2].argv, [ARCHIL_HELPER, "mount", MOUNT.disk, MOUNT.region, MOUNT.folder]);
	assert.equal(runs[2].stdin, `${TOKEN}\n`, "the token, one line on the mount's stdin");
	for (const [n, run] of runs.entries()) if (n !== 2) assert.equal(run.stdin, undefined, `${run.verb} gets no stdin`);
	noToken(runs.map(({ argv }) => argv), "the root commands' command lines");
	noToken(fake.calls, "the SDK calls");
	const init = fake.calls.find(([name, , kind]) => name === "commands.run" && kind === "init");
	assert.ok(init, "init started");
	assert.equal(fake.sandboxes.get(id).init.user, "2510:2510", "init drops to the tool user");
});

test("E2B create of an Archil computer whose tools reach an address is refused: internet access is on, so the probe from inside holds network none", async () => {
	const { provider, fake } = setup({}, { box: { reached: undefined, accepted: undefined } });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.match(created.error.message, /network/);
	noToken(created, "the refusal");
	const { id } = newest(fake);
	assert.ok(fake.kills.includes(id));
	assert.equal(verbsOf(fake, id).at(-1), "checkin", "the folder is let go before the kill");
	assert.ok(indexOf(fake, id, "run checkin") < indexOf(fake, id, "kill"));
});

test("E2B create of an Archil computer: the takeover releases the run's lower epoch (its final sync and checkin, then its kill) before it revokes", async () => {
	const { provider, fake } = setup();
	const old = seededArchil(fake, { name: "computer-00000000000a", epoch: 2 });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	const { id } = newest(fake);
	assert.deepEqual(verbsOf(fake, id), ["preflight", "netlock", "revoke", "serve"]);
	assert.equal(fake.rootRuns.find((run) => run.sandbox === id && run.verb === "revoke").stdin, `${TOKEN}\n`);
	assert.deepEqual(verbsOf(fake, old.ref.id), ["checkin"]);
	assert.ok(fake.kills.includes(old.ref.id));
	assert.ok(indexOf(fake, old.ref.id, "daemon mount.sync") < indexOf(fake, old.ref.id, "run checkin"));
	const revoked = fake.events.findIndex((event) => event.sandbox === id && event.what === "run revoke");
	assert.ok(fake.events.findIndex((event) => event.sandbox === old.ref.id && event.what === "kill") < revoked, "the old one is killed before the revoke");
	noToken(fake.calls, "the SDK calls");
});

test("E2B create of an Archil computer: a higher epoch fences it; nothing is mounted or revoked, init never starts, and the new sandbox is killed", async () => {
	const { provider, fake } = setup();
	const newer = seededArchil(fake, { name: "computer-00000000000b", epoch: 4 });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.match(created.error.message, /fenced/);
	const { id } = newest(fake);
	assert.deepEqual(verbsOf(fake, id), ["preflight", "netlock"]);
	assert.equal(indexOf(fake, id, "run init"), -1);
	assert.ok(fake.kills.includes(id));
	assert.ok(!fake.kills.includes(newer.ref.id), "the newer claim's computer is left");
});

test("E2B create of an Archil computer: a failed step refuses in words that never hold the token, init never starts, and the sandbox is killed", async () => {
	const { provider, fake } = setup({}, { archil: { mount: { exitCode: 1, output: `archil: mount refused for token ${TOKEN}` } } });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.match(created.error.message, /mount/);
	noToken(created, "the refusal");
	const { id } = newest(fake);
	assert.deepEqual(verbsOf(fake, id), ["preflight", "netlock", "mount"]);
	assert.equal(indexOf(fake, id, "run init"), -1, "init never started");
	assert.ok(fake.kills.includes(id));
});

test("E2B create of an Archil computer: a mount that does not read back as asked is refused, and the folder is let go before the kill", async () => {
	const { provider, fake } = setup(
		{},
		{
			archil: {
				mount: (argv, stdin, box) => {
					box.mountSource = `dsk-0000000000000bad:/${MOUNT.folder}`;
					return { exitCode: 0, output: "" };
				},
			},
		},
	);
	const created = await provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.match(created.error.message, /mount: declared/);
	assert.match(created.error.message, /dsk-0000000000000bad/);
	const { id } = newest(fake);
	assert.deepEqual(verbsOf(fake, id), ["preflight", "netlock", "mount", "serve", "checkin"]);
	assert.ok(indexOf(fake, id, "run checkin") < indexOf(fake, id, "kill"));
});

test("E2B connect: an Archil computer's client syncs after each call that may change the folder; another computer's never does", async () => {
	const { provider, fake } = setup();
	const { ref } = seededArchil(fake);
	const connected = await provider.connect(ref);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	assert.equal((await connected.value.client.call("ping", {})).ok, true);
	assert.equal(fake.syncs.length, 0);
	assert.equal((await connected.value.client.call("files.write", { path: "/workspace/a.txt", data: "aGk=" })).ok, true);
	assert.equal(fake.syncs.length, 1, "files.write syncs before it answers");
	await connected.value.close();

	const plain = setup();
	const other = seededArchil(plain.fake, { label: undefined });
	const opened = await plain.provider.connect(other.ref);
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal((await opened.value.client.call("files.write", { path: "/work/a.txt", data: "aGk=" })).ok, true);
	assert.equal(plain.fake.syncs.length, 0, "no Archil mount, no sync");
	await opened.value.close();
});

test("E2B release of an Archil computer: the final sync, then checkin as root, then the kill; a failed checkin still kills, and says so", async () => {
	const { provider, fake } = setup();
	const { ref } = seededArchil(fake);
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
	const sync = indexOf(fake, ref.id, "daemon mount.sync");
	const checkin = indexOf(fake, ref.id, "run checkin");
	const kill = indexOf(fake, ref.id, "kill");
	assert.ok(sync >= 0 && sync < checkin && checkin < kill, JSON.stringify(eventsOf(fake, ref.id)));
	assert.deepEqual(fake.rootRuns.find((run) => run.verb === "checkin").argv, [ARCHIL_HELPER, "checkin"]);

	const failing = setup({}, { archil: { checkin: { exitCode: 1, output: "archil: checkin failed: server unreachable" } } });
	const seededOne = seededArchil(failing.fake);
	const released = await failing.provider.release(seededOne.ref, "delete");
	assert.equal(released.ok, false);
	assert.match(released.error.message, /not let go/);
	assert.match(released.error.message, /server unreachable/);
	assert.ok(failing.fake.kills.includes(seededOne.ref.id), "killed whatever checkin said");

	// A paused computer runs no command: there is nothing to let go, and release kills it as before.
	const paused = setup();
	const pausedOne = seededArchil(paused.fake, { state: "paused" });
	assert.deepEqual(await paused.provider.release(pausedOne.ref, "delete"), { ok: true, value: undefined });
	assert.deepEqual(paused.fake.rootRuns, []);
});

test("E2B list: an Archil computer's mount as its label records it, under its epoch label, and its tools' network none; another computer has none", async () => {
	const { provider, fake } = setup();
	seededArchil(fake);
	seededArchil(fake, { name: "computer-00000000000c", run: "r9", label: "{not json" });
	const listed = await provider.list({ "agentrun.run": RUN });
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.equal(listed.value.length, 1);
	assert.deepEqual(listed.value[0].mount, readBack());
	assert.equal(listed.value[0].network, "none", "the vendor's network is open for root; the tools' is none");
	noToken(listed, "list");
	const broken = await provider.list({ "agentrun.run": "r9" });
	assert.ok("other" in broken.value[0].mount, JSON.stringify(broken.value[0].mount));
	assert.equal(fake.rootRuns.length, 0, "list runs nothing in a computer");

	const plain = setup();
	seededArchil(plain.fake, { label: undefined, allowInternetAccess: false });
	const none = await plain.provider.list({});
	assert.equal(none.value[0].mount, undefined);
	assert.equal(none.value[0].network, "none");
});

test("E2B attach: an Archil computer's mount is read back from inside, exclusive once serve answers, under its epoch, its network none from the probe; drift is refused", async () => {
	const { provider, fake } = setup();
	const { ref } = seededArchil(fake);
	const attached = await provider.attach({ id: ref.id });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual(attached.value.spec.mount, readBack());
	assert.equal(attached.value.spec.network, "none");
	noToken(attached, "attach");

	for (const [box, words] of [
		[{ mountSource: `dsk-0000000000000bad:/${MOUNT.folder}` }, /dsk-0000000000000bad/],
		[{ served: false }, /exclusive/],
		[{ mounted: undefined }, /nothing is mounted/],
		[{ reached: ["1.1.1.1:443"] }, /1\.1\.1\.1/],
	]) {
		const drifted = setup();
		const one = seededArchil(drifted.fake, { box });
		const result = await drifted.provider.attach({ id: one.ref.id });
		assert.equal(result.ok, false, JSON.stringify(box));
		assert.equal(result.error.code, "refused");
		assert.match(result.error.message, words);
		assert.ok(!drifted.fake.kills.includes(one.ref.id), "left as it is");
	}
	const closed = setup();
	const vendorNone = seededArchil(closed.fake, { allowInternetAccess: false });
	const refused = await closed.provider.attach({ id: vendorNone.ref.id });
	assert.equal(refused.ok, false, "an Archil computer whose vendor network is not the one create makes is drift");
	assert.match(refused.error.message, /network/);
});

test("E2B network(): an Archil computer's network none is its tools', read from inside by the probe; an answer reads back another network", async () => {
	const { provider, fake } = setup();
	const { ref } = seededArchil(fake);
	assert.deepEqual(await provider.network(ref), { ok: true, value: "none" });
	assert.deepEqual(await provider.network(ref, "none"), { ok: true, value: "none" });
	const reaching = setup();
	const one = seededArchil(reaching.fake, { box: { reached: ["8.8.8.8:443"] } });
	const read = await reaching.provider.network(one.ref);
	assert.equal(read.ok, true, JSON.stringify(read));
	assert.ok(typeof read.value === "object" && /8\.8\.8\.8/.test(read.value.other), JSON.stringify(read.value));
});
