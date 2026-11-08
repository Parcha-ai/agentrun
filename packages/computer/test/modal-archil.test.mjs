// ModalProvider's Archil mount, against the fake Modal SDK (test/fake-modal.mjs): the run's folder at /workspace through
// the shared steps (src/mount-archil.ts), each root step through Modal's own exec, before init starts. The token reaches
// the helper's stdin alone: never an argv, a tag, the spec tag, a read-back or an error. No Modal client, no archil.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ModalProvider } from "../dist/index.js";
import * as modal from "../dist/modal.js";
import { ARCHIL_GATE, ARCHIL_HELPER, DAEMON, DAEMON_IMAGE, ENTRYPOINT_MARK, fakeModal, fakeObjects } from "./fake-modal.mjs";

const TOKEN = "tok-modal-archil-0123456789abcdef";
const RUN = "r1";
const EPOCH = 3;
const MOUNT = { kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", folder: `agents/a1/runs/${RUN}/work`, token: TOKEN };
const LABELS = { "agentrun.run": RUN, "agentrun.epoch": String(EPOCH) };
const IMAGE = `registry.example/agentrun-archil@sha256:${"b".repeat(64)}`;
const SPEC = { image: IMAGE, lifetimeMs: 600_000, network: "none", labels: LABELS, mount: MOUNT };
const APP = "computers";
const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DEADLINE = "agentrun.computer.deadline";
const SPEC_TAG = "agentrun.computer.spec";
/** The Archil mount cases' settings, as a conformance module reads them. */
const ARCHIL_SETTINGS = {
	COMPUTER_ARCHIL_DISK: MOUNT.disk,
	COMPUTER_ARCHIL_REGION: MOUNT.region,
	COMPUTER_ARCHIL_TOKEN: TOKEN,
	COMPUTER_ARCHIL_API_KEY: "key-archil-account-0123456789abcdef",
	COMPUTER_ARCHIL_S3_URL: "https://s3.green.us-east-1.aws.prod.archil.com",
};
const readBack = (epoch = EPOCH) => ({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder, exclusive: true, epoch });

const dir = mkdtempSync(join(tmpdir(), "computer-modal-archil-"));
const BINARY_PATH = join(dir, "computerd");
writeFileSync(BINARY_PATH, "a stand-in for computerd\n");
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The provider on the fake. Modal's network stays on for an Archil computer (root reaches Archil), so the tools' network
 * none is init's own namespace: each new sandbox's probe reaches nothing here, as it does once init runs with it.
 */
function setup(options = {}, fakeOptions = {}) {
	const fake = fakeModal({ ...fakeOptions, box: { network: "none", ...fakeOptions.box } });
	const provider = new ModalProvider({ sdk: fake.sdk, app: APP, daemonImage: DAEMON_IMAGE, ...options });
	return { fake, provider };
}
const noToken = (value, what) => assert.ok(!JSON.stringify(value ?? null).includes(TOKEN), `${what} holds the token`);
const createdParams = (fake) => fake.calls.find(([name]) => name === "sandboxes.create")?.[3];
/** What happened in one sandbox, in order: its execs (by verb) and its daemon's methods, or every event when all. */
const eventsOf = (fake, id, all = false) => fake.events.filter((event) => event.sandbox === id && (all || /^(exec|daemon) /.test(event.what))).map(({ what }) => what);
const indexOf = (fake, id, what) => fake.events.findIndex((event) => event.sandbox === id && event.what === what);
const verbsOf = (fake, id) => fake.rootRuns.filter((run) => run.sandbox === id).map(({ verb }) => verb);
const newest = (fake) => [...fake.sandboxes.values()].at(-1);

/** An Archil computer as create leaves one, seeded straight into the fake. */
const seededArchil = ({ name = "computer-0123456789ab", epoch = EPOCH, mountEpoch = epoch, run = RUN, box = {}, running = true, network = "none" } = {}) => ({
	tags: {
		"agentrun.run": run,
		"agentrun.epoch": String(epoch),
		[COMPUTER]: "1",
		[NAME]: name,
		[DEADLINE]: new Date(Date.now() + 600_000).toISOString(),
		[SPEC_TAG]: JSON.stringify({ image: IMAGE, user: "2510:2510", network, cpus: 2, memoryMb: 4096, workdir: "/work", runtime: "vm", mount: readBack(mountEpoch) }),
	},
	running,
	box: { uid: 2510, gid: 2510, network: "none", mounted: { disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder }, served: true, ...box },
});
const refOf = (fake, name = "computer-0123456789ab") => {
	const found = [...fake.sandboxes.values()].find((one) => one.tags[NAME] === name);
	return { id: found.id, name };
};

test("Modal: MOUNT is [\"archil\"], what capabilities() declares", () => {
	const { provider } = setup();
	assert.deepEqual([...modal.MOUNT], ["archil"]);
	assert.deepEqual(provider.capabilities().mount, ["archil"]);
});

test("Modal check(): an Archil spec takes network none, the run and epoch labels, the helper's shapes and the tool user, with no SDK call; no refusal holds the token", () => {
	const { provider, fake } = setup();
	assert.deepEqual(provider.check(SPEC), []);
	assert.deepEqual(provider.check({ ...SPEC, user: "2510:2510" }), [], "the tool user, named");
	const cases = [
		[{ network: "open" }, "network", /none/],
		[{ labels: { "agentrun.run": RUN } }, "labels", /agentrun\.epoch/],
		[{ labels: { "agentrun.epoch": "3" } }, "labels", /agentrun\.run/],
		[{ mount: { ...MOUNT, folder: "agents/a1/runs/r2/work" } }, "mount", /run r2/],
		[{ mount: { ...MOUNT, token: "short" } }, "mount", /mount\.token/],
		[{ mount: { ...MOUNT, extra: TOKEN } }, "mount", /mount\.extra/],
		[{ user: "1000:1000" }, "user", /2510/],
	];
	for (const [change, field, words] of cases) {
		const refusals = provider.check({ ...SPEC, ...change });
		assert.ok(
			refusals.some((r) => r.field === field && words.test(r.message)),
			`${JSON.stringify(change).replace(TOKEN, "[token]")}: ${JSON.stringify(refusals).replace(TOKEN, "[token]")}`,
		);
		noToken(refusals, `the refusal of ${field}`);
	}
	noToken(provider.check({ ...SPEC, mount: { ...MOUNT, folder: TOKEN } }), "a token in the folder");
	assert.deepEqual(fake.calls, [], "no SDK call");
});

test("Modal create of an Archil computer: preflight, the takeover, mount with the token on stdin, serve and the gate, as root through exec, before init starts; then the read-back", async () => {
	const { provider, fake } = setup();
	const created = await provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	noToken(created, "create's result");
	const params = createdParams(fake);
	assert.equal(params.blockNetwork, undefined, "the archil client reaches Archil as root: Modal's network stays on; the tools' network is init's");
	// Init waits for the gate: the command is the entrypoint, with the gate and the tool user.
	assert.deepEqual(params.command.slice(0, 2), ["sh", "-c"]);
	assert.ok(params.command[2].startsWith(`${ENTRYPOINT_MARK}\n`));
	const at = params.command.indexOf("--gate");
	assert.ok(at > 0, `the entrypoint waits for the gate: ${JSON.stringify(params.command)}`);
	assert.equal(params.command[at + 1], ARCHIL_GATE);
	assert.deepEqual(params.command.slice(params.command.indexOf("init")), ["init", "--deadline", params.tags[DEADLINE], "--user", "2510:2510", "--own-network"]);
	// The spec tag records the mount as it reads back, never the token.
	const recorded = JSON.parse(params.tags[SPEC_TAG]);
	assert.deepEqual(recorded.mount, readBack());
	assert.equal(recorded.user, "2510:2510");
	assert.equal(recorded.network, "none");

	const { id } = newest(fake);
	assert.deepEqual(eventsOf(fake, id), [
		"exec preflight",
		"exec mount",
		"exec serve",
		"exec gate",
		"exec stdio",
		"daemon hello",
		"daemon exec.run",
		"daemon files.read",
		"daemon mount.sync",
	]);
	const runs = fake.rootRuns.filter((run) => run.sandbox === id);
	assert.deepEqual(runs[1].argv, [ARCHIL_HELPER, "mount", MOUNT.disk, MOUNT.region, MOUNT.folder]);
	assert.equal(runs[1].stdin, `${TOKEN}\n`, "the token, one line on the mount's stdin");
	for (const [n, run] of runs.entries()) if (n !== 1) assert.equal(run.stdin, undefined, `${run.verb} gets no stdin`);
	// Nowhere else: no argv, tag, image layer or other SDK call holds it.
	noToken(fake.calls, "the SDK calls");
	noToken(runs.map(({ argv }) => argv), "the root commands' argv");
});

test("Modal create of an Archil computer whose tools reach an address is refused: Modal's network is on, so the probe from inside holds network none", async () => {
	const { provider, fake } = setup({}, { box: { network: "open" } });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.match(created.error.message, /network: declared none, read back an answer/);
	noToken(created, "the refusal");
	const { id } = newest(fake);
	assert.equal(fake.sandboxes.get(id).running, false);
	assert.equal(verbsOf(fake, id).at(-1), "checkin", "the folder is let go before the terminate");
});

test("Modal create of an Archil computer without daemonImage: the daemon is uploaded first, since serve runs it", async () => {
	const { provider, fake } = setup({ daemonImage: undefined, daemonPath: BINARY_PATH });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	const { id } = newest(fake);
	const events = eventsOf(fake, id);
	assert.deepEqual(events.slice(0, 5), ["exec upload", "exec preflight", "exec mount", "exec serve", "exec gate"]);
	noToken(fake.calls, "the SDK calls");
	noToken(fake.uploads.map(({ argv }) => argv), "the upload's argv");
});

test("Modal create of an Archil computer: the takeover releases the run's lower epoch (its final sync and checkin, then its terminate) before it revokes", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seededArchil({ name: "computer-00000000000a", epoch: 2 })] });
	const old = refOf(fake, "computer-00000000000a");
	const created = await provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	const { id } = newest(fake);
	assert.deepEqual(verbsOf(fake, id), ["preflight", "revoke", "serve", "gate"]);
	assert.equal(fake.rootRuns.find((run) => run.sandbox === id && run.verb === "revoke").stdin, `${TOKEN}\n`);
	assert.deepEqual(verbsOf(fake, old.id), ["checkin"], "the old computer lets go of the folder");
	assert.equal(fake.sandboxes.get(old.id).running, false, "and is gone");
	const revoked = indexOf(fake, id, "exec revoke");
	assert.ok(indexOf(fake, old.id, "daemon mount.sync") < indexOf(fake, old.id, "exec checkin"), "the old one's final sync, then its checkin");
	assert.ok(indexOf(fake, old.id, "sandbox.terminate") < revoked, "the old one is terminated before the revoke");
	assert.ok(indexOf(fake, id, "exec preflight") < indexOf(fake, old.id, "exec checkin"), "the new one is proven before the old one goes");
	noToken(fake.calls, "the SDK calls");
});

test("Modal create of an Archil computer: a higher epoch fences it; nothing is mounted or revoked, the newer computer is left, and the new sandbox is terminated", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seededArchil({ name: "computer-00000000000b", epoch: 4 })] });
	const newer = refOf(fake, "computer-00000000000b");
	const created = await provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.match(created.error.message, /fenced/);
	noToken(created, "the refusal");
	const { id } = newest(fake);
	assert.deepEqual(verbsOf(fake, id), ["preflight"], "no mount, no revoke");
	assert.equal(fake.sandboxes.get(id).running, false, "the new sandbox is terminated");
	assert.equal(fake.sandboxes.get(newer.id).running, true, "the newer claim's computer is left");
	assert.deepEqual(verbsOf(fake, newer.id), []);
});

test("Modal create of an Archil computer: a failed step refuses in words that never hold the token, init never starts, and the sandbox is terminated", async () => {
	const { provider, fake } = setup({}, { archil: { mount: { exitCode: 1, output: `archil: mount refused for token ${TOKEN}` } } });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.match(created.error.message, /mount/);
	noToken(created, "the refusal");
	const { id } = newest(fake);
	assert.deepEqual(verbsOf(fake, id), ["preflight", "mount"]);
	assert.ok(!eventsOf(fake, id).includes("exec stdio"), "no bridge: init never started");
	assert.equal(fake.sandboxes.get(id).running, false);

	const wrong = setup({}, { archil: { preflight: { exitCode: 0, output: "uid 0\nhelper 00 -rwxr-xr-x 0 0\narchil none\ntool 1000:1000\nsudo none" } } });
	const refused = await wrong.provider.create(SPEC);
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /not as the Archil image makes it/);
	assert.deepEqual(verbsOf(wrong.fake, newest(wrong.fake).id), ["preflight"]);
});

test("Modal create of an Archil computer: a mount that does not read back as asked is refused, and the folder is let go before the terminate", async () => {
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
	assert.match(created.error.message, /mount/);
	assert.match(created.error.message, /dsk-0000000000000bad/);
	noToken(created, "the refusal");
	const { id } = newest(fake);
	assert.deepEqual(verbsOf(fake, id), ["preflight", "mount", "serve", "gate", "checkin"]);
	assert.ok(indexOf(fake, id, "exec checkin") < indexOf(fake, id, "sandbox.terminate"));
	assert.equal(fake.sandboxes.get(id).running, false);
});

test("Modal connect: an Archil computer's client syncs after each call that may change the folder; another computer's never does", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seededArchil()] });
	const connected = await provider.connect(refOf(fake));
	assert.equal(connected.ok, true, JSON.stringify(connected));
	const { client } = connected.value;
	assert.equal((await client.call("ping", {})).ok, true);
	assert.equal(fake.syncs.length, 0, "a ping changes nothing");
	assert.equal((await client.call("exec.run", { argv: ["true"], timeoutMs: 1000 })).ok, true);
	assert.equal(fake.syncs.length, 1, "exec.run syncs before it answers");
	await connected.value.close();

	const plain = setup(
		{},
		{
			sandboxes: [
				{
					tags: {
						[COMPUTER]: "1",
						[NAME]: "computer-0123456789ab",
						[DEADLINE]: new Date(Date.now() + 600_000).toISOString(),
						[SPEC_TAG]: JSON.stringify({ image: "debian:bookworm-slim", user: "1000:1000", network: "none", cpus: 2, memoryMb: 4096, workdir: "/work", runtime: "vm" }),
					},
					box: { network: "none" },
				},
			],
		},
	);
	const other = await plain.provider.connect(refOf(plain.fake));
	assert.equal(other.ok, true, JSON.stringify(other));
	assert.equal((await other.value.client.call("exec.run", { argv: ["true"], timeoutMs: 1000 })).ok, true);
	assert.equal(plain.fake.syncs.length, 0, "no Archil mount, no sync");
	await other.value.close();
});

test("Modal release of an Archil computer: the final sync, then checkin as root, then the terminate; a failed checkin still terminates, and says so", async (t) => {
	const { provider, fake } = setup({}, { sandboxes: [seededArchil()] });
	const ref = refOf(fake);
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
	const sync = indexOf(fake, ref.id, "daemon mount.sync");
	const checkin = indexOf(fake, ref.id, "exec checkin");
	const terminate = indexOf(fake, ref.id, "sandbox.terminate");
	assert.ok(sync >= 0 && sync < checkin && checkin < terminate, JSON.stringify(eventsOf(fake, ref.id, true)));
	assert.deepEqual(fake.rootRuns.find((run) => run.verb === "checkin").argv, [ARCHIL_HELPER, "checkin"]);
	assert.equal(fake.sandboxes.get(ref.id).running, false);

	// The ruling: release succeeds once the computer is gone. A folder not let go cleanly loses nothing (every call that
	// changed it synced, and the next claim revokes a hold left behind), so it is said as a note, never a failed release.
	const notes = [];
	const failing = setup({ onNote: (note) => notes.push(note) }, { sandboxes: [seededArchil()], archil: { checkin: { exitCode: 1, output: "archil: checkin failed: server unreachable" } } });
	const failingRef = refOf(failing.fake);
	assert.deepEqual(await failing.provider.release(failingRef, "delete"), { ok: true, value: undefined });
	assert.equal(failing.fake.sandboxes.get(failingRef.id).running, false, "terminated whatever checkin said");
	assert.equal(notes.length, 1, JSON.stringify(notes));
	assert.equal(notes[0].computer, failingRef.name);
	assert.match(notes[0].note, /not let go/);
	assert.match(notes[0].note, /server unreachable/);

	// A sandbox that has finished runs nothing more: there is nothing to let go, and release is done.
	const done = setup({}, { sandboxes: [seededArchil({ running: false })] });
	assert.deepEqual(await done.provider.release(refOf(done.fake), "delete"), { ok: true, value: undefined });
	assert.deepEqual(done.fake.rootRuns, []);
});

test("Modal list: an Archil computer's mount as its spec tag records it, under its epoch label; another computer has none", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seededArchil(), seededArchil({ name: "computer-00000000000c", run: "r9", mountEpoch: 2 })] });
	const listed = await provider.list({ "agentrun.run": RUN });
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.equal(listed.value.length, 1);
	assert.deepEqual(listed.value[0].mount, readBack());
	assert.equal(listed.value[0].network, "none");
	noToken(listed, "list");
	const drifted = await provider.list({ "agentrun.run": "r9" });
	assert.ok("other" in drifted.value[0].mount, `a recorded epoch that is not the label's is a mount in words: ${JSON.stringify(drifted.value[0].mount)}`);
	assert.equal(fake.rootRuns.length, 0, "list execs nothing");

	const plain = setup({}, { sandboxes: [{ tags: { [COMPUTER]: "1", [NAME]: "computer-0123456789ab", [SPEC_TAG]: JSON.stringify({ image: "x", user: "1000:1000", network: "none", cpus: 2, memoryMb: 4096, workdir: "/work", runtime: "vm" }) } }] });
	const none = await plain.provider.list({});
	assert.equal(none.value[0].mount, undefined);
});

test("Modal attach: an Archil computer's mount is read back from inside, fuse.archil at /workspace, exclusive once serve answers, under its epoch; drift is refused", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seededArchil()] });
	const attached = await provider.attach({ id: refOf(fake).id });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual(attached.value.spec.mount, readBack());
	assert.equal(attached.value.spec.network, "none");
	noToken(attached, "attach");

	for (const [box, words] of [
		[{ mountSource: `dsk-0000000000000bad:/${MOUNT.folder}` }, /dsk-0000000000000bad/],
		[{ served: false }, /exclusive/],
		[{ mounted: undefined }, /nothing is mounted/],
		[{ mountType: "tmpfs" }, /tmpfs/],
	]) {
		const drifted = setup({}, { sandboxes: [seededArchil({ box })] });
		const result = await drifted.provider.attach({ id: refOf(drifted.fake).id });
		assert.equal(result.ok, false, JSON.stringify(box));
		assert.equal(result.error.code, "refused");
		assert.match(result.error.message, /mount/);
		assert.match(result.error.message, words);
		assert.equal(drifted.fake.sandboxes.get(refOf(drifted.fake).id).running, true, "left as it is");
	}

	const relabelled = setup({}, { sandboxes: [seededArchil({ mountEpoch: 2 })] });
	const epochDrift = await relabelled.provider.attach({ id: refOf(relabelled.fake).id });
	assert.equal(epochDrift.ok, false);
	assert.match(epochDrift.error.message, /epoch/);
});

test("the Modal conformance module: mountFor(\"archil\") gives a fresh run folder on the disk COMPUTER_ARCHIL_* name, read and written outside through the disk's object API", async () => {
	const { MODAL_ENV, mountFor, settingsFromEnv } = await import("../dist/conformance/modal.js");
	assert.equal(MODAL_ENV.archilDisk, "COMPUTER_ARCHIL_DISK");
	assert.equal(MODAL_ENV.archilRegion, "COMPUTER_ARCHIL_REGION");
	assert.equal(MODAL_ENV.archilToken, "COMPUTER_ARCHIL_TOKEN");
	assert.equal(MODAL_ENV.archilApiKey, "COMPUTER_ARCHIL_API_KEY");
	assert.equal(MODAL_ENV.archilS3Url, "COMPUTER_ARCHIL_S3_URL");
	const env = { AGENTRUN_COMPUTER_LIVE_MODAL: "1", ...ARCHIL_SETTINGS };
	assert.equal(settingsFromEnv({}), undefined, "no disk named: no Archil run folder");
	assert.deepEqual(settingsFromEnv(env), { disk: MOUNT.disk, region: MOUNT.region, token: TOKEN, apiKey: ARCHIL_SETTINGS.COMPUTER_ARCHIL_API_KEY, s3BaseUrl: ARCHIL_SETTINGS.COMPUTER_ARCHIL_S3_URL });
	assert.throws(() => settingsFromEnv({ COMPUTER_ARCHIL_DISK: MOUNT.disk }), (error) => /COMPUTER_ARCHIL_REGION/.test(error.message) && /COMPUTER_ARCHIL_TOKEN/.test(error.message));

	assert.equal(await mountFor("bind", { env }), undefined, "a Modal computer takes no bind");
	assert.equal(await mountFor("archil", { env: {} }), undefined, "no disk named: the case is skipped");
	await assert.rejects(mountFor("archil", { env: { ...env, AGENTRUN_COMPUTER_LIVE_MODAL: undefined }, archil: { objects: fakeObjects() } }), /AGENTRUN_COMPUTER_LIVE_MODAL/);

	// The shared run folder (src/conformance/archil.ts), on the SDK's client made from the settings.
	const objects = fakeObjects();
	const made = [];
	class Archil {
		constructor(options) {
			made.push(options);
			this.disks = { get: async () => objects };
		}
	}
	const folder = await mountFor("archil", { env, archil: { Archil } });
	assert.deepEqual(made, [{ apiKey: ARCHIL_SETTINGS.COMPUTER_ARCHIL_API_KEY, region: MOUNT.region, s3BaseUrl: ARCHIL_SETTINGS.COMPUTER_ARCHIL_S3_URL }]);
	assert.deepEqual({ ...folder.mount, folder: undefined }, { ...MOUNT, folder: undefined });
	assert.match(folder.mount.folder, /^agents\/conformance\/runs\/[A-Za-z0-9][A-Za-z0-9_-]*\/work$/);
	await folder.write("a.txt", Buffer.from("outside\n"));
	assert.equal(Buffer.from(await folder.read("a.txt")).toString("utf8"), "outside\n");
	await folder.close();
	assert.equal(objects.objects.size, 0);
	noToken(objects.calls, "the object API's calls");
});

/** Runs argv here, as Modal would run the sandbox's command, and answers its exit code and what it printed. */
function runLocally(argv, { onSpawn } = {}) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		onSpawn?.();
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

test("the entrypoint with a gate becomes init only once the gate is there, bounded; a gate there before it starts is not one", async () => {
	const local = mkdtempSync(join(dir, "entry-"));
	const daemon = join(local, "computerd");
	const gate = join(local, "archil-mounted");
	writeFileSync(daemon, '#!/bin/sh\necho "args $*"\n', { mode: 0o755 });
	// A gate left there before the command starts (an image that baked one) is taken away: init still waits.
	writeFileSync(gate, "");
	const none = await runLocally(modal.modalCommands({ waitSeconds: 1, daemon, home: local, gate }).entrypoint);
	assert.equal(none.code, 3, JSON.stringify(none));
	assert.match(none.stderr, /the Archil mount .* within 1 s/);
	const ran = await runLocally(modal.modalCommands({ deadline: "2026-11-06T12:00:00.000Z", user: "2510:2510", waitSeconds: 20, daemon, home: local, gate }).entrypoint, {
		onSpawn: () => setTimeout(() => writeFileSync(gate, ""), 400),
	});
	assert.equal(ran.code, 0, JSON.stringify(ran));
	assert.equal(ran.stdout, "args init --deadline 2026-11-06T12:00:00.000Z --user 2510:2510 --own-network\n");
});

test("Modal: the daemon path stays the daemon's, and the gate is beside it, root's alone", () => {
	assert.equal(ARCHIL_GATE.slice(0, ARCHIL_GATE.lastIndexOf("/")), DAEMON.slice(0, DAEMON.lastIndexOf("/")));
	const { entrypoint } = modal.modalCommands({ deadline: "2026-11-06T12:00:00.000Z", user: "2510:2510", waitSeconds: 9, gate: ARCHIL_GATE });
	assert.deepEqual(entrypoint.slice(3), ["sh", DAEMON, "9", "/work", "--gate", ARCHIL_GATE, "init", "--deadline", "2026-11-06T12:00:00.000Z", "--user", "2510:2510", "--own-network"]);
	const plain = modal.modalCommands({ deadline: "2026-11-06T12:00:00.000Z", user: "1000:1000", waitSeconds: 9 });
	assert.deepEqual(plain.entrypoint.slice(3), ["sh", DAEMON, "9", "/work", "init", "--deadline", "2026-11-06T12:00:00.000Z", "--user", "1000:1000", "--own-network"], "no gate: the same command as before");
});
