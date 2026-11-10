// OrgoProvider's Archil mount, against the fake Orgo (test/fake-orgo.mjs): the run's folder at /workspace through the
// shared steps (src/mount-archil.ts), each root step through the OrgoChannel before init starts. The token reaches the
// helper's stdin alone, through the channel's stdio (Orgo's root terminal, made raw): never a bash call's command line,
// a label, the labels file, a read-back or an error. And Orgo's idle suspension: nothing here runs inside a computer
// Orgo does not read running, since any action wakes it. The parts the Daytona and Modal Archil tests prove on their
// fakes, held here on Orgo's. No Orgo, no archil.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { API, fakeOrgoApi, fakeOrgoChannel, KEY, WORKSPACE } from "./fake-orgo.mjs";
import { ARCHIL_HELPER, fakeObjects } from "./fake-modal.mjs";

const orgo = await import("../dist/orgo.js");
const { create, MOUNT: ORGO_MOUNT, orgoName } = orgo;

const TOKEN = "tok-orgo-archil-0123456789abcdef";
const RUN = "r1";
const EPOCH = 3;
const MOUNT = { kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", folder: `agents/a1/runs/${RUN}/work`, token: TOKEN };
const LABELS = { "agentrun.run": RUN, "agentrun.epoch": String(EPOCH), team: "a" };
const TEMPLATE = "agentrun/agentrun-archil@1.0.0";
const SPEC = { image: TEMPLATE, lifetimeMs: 30 * 60_000, network: "none", labels: LABELS, mount: MOUNT };
const HOUR = 3_600_000;
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 500, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, mountMs: 1_000 };
/** The Orgo states Orgo does not read running: any action in one of them wakes it, or it may not answer yet. */
const NOT_RUNNING = ["suspended", "suspending", "resuming", "frozen", "stopped", "creating"];
const readBack = (epoch = EPOCH) => ({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder, exclusive: true, epoch });
const mountLabel = JSON.stringify({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder });

const dir = mkdtempSync(join(tmpdir(), "computer-orgo-archil-"));
const DAEMON_PATH = join(dir, "computerd");
const DAEMON_BYTES = Buffer.from("a stand-in for computerd, linux/amd64\n");
writeFileSync(DAEMON_PATH, DAEMON_BYTES);
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** The provider on both fakes, with every REST call, root step and daemon call logged in order, by computer. */
function setup(options = {}, { api: apiOptions = {}, channel: channelOptions = {} } = {}) {
	const events = [];
	const api = fakeOrgoApi(apiOptions);
	const fetch = async (url, init = {}) => {
		const path = new URL(url).pathname.replace(/^\/api/, "");
		events.push({ computer: /^\/computers\/([^/]+)/.exec(path)?.[1], what: `${init.method ?? "GET"} ${path}` });
		return api.fetch(url, init);
	};
	const channel = fakeOrgoChannel({ events, ...channelOptions });
	const provider = create({ apiKey: KEY, workspaceId: WORKSPACE, apiUrl: API, fetch, channel, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...options });
	return { api, channel, provider, events };
}
const noToken = (value, what) => assert.ok(!JSON.stringify(value ?? null).includes(TOKEN), `${what} holds the token`);
const newest = (api) => [...api.computers.values()].at(-1);
/** What happened in one computer, in order: its root steps, its daemon's calls and its REST calls. */
const eventsOf = ({ events }, id) => events.filter((event) => event.computer === id).map(({ what }) => what);
const indexOf = (fakes, id, what) => eventsOf(fakes, id).indexOf(what);
const verbsOf = ({ channel }, id) => channel.rootRuns.filter((run) => run.computer === id).map(({ verb }) => verb);
const callsIn = ({ channel }, id) => channel.calls.filter((call) => call.computer === id);

/** An Archil computer as create leaves one, seeded into both fakes: its -ma name, its labels file, its mount, init. */
function seededArchil({ api, channel }, { labels = LABELS, epoch, status = "running", hex = "0123456789ab", mount = true, label = mountLabel, box = {} } = {}) {
	const own = { ...labels, ...(epoch === undefined ? {} : { "agentrun.epoch": String(epoch) }) };
	const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
	const record = api.add({ name: orgoName(own, hex, new Date(deadline), mount ? "archil" : undefined), status, ends_at: new Date(Date.now() + HOUR).toISOString() });
	const inside = channel.boxOf(record.id);
	const fileLabels = label === null ? own : { ...own, "agentrun.mount": label };
	inside.labels = JSON.stringify({ name: record.name, labels: fileLabels, deadline, maxDeadline: new Date(Date.now() + 720 * HOUR).toISOString(), image: TEMPLATE, cpus: 1, memoryMb: 4096 });
	inside.daemon = { path: "/opt/agentrun/computerd", bytes: DAEMON_BYTES };
	inside.init = { deadline, user: "2510:2510", uid: 2510, gid: 2510, display: ":99", max: "", ownNetwork: true };
	Object.assign(inside, { mounted: { disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder }, served: true }, box);
	return { record, box: inside, ref: { id: record.id, name: record.name } };
}

test("Orgo: MOUNT is [\"archil\"], what capabilities() declares", () => {
	const { provider } = setup();
	assert.deepEqual([...ORGO_MOUNT], ["archil"]);
	assert.deepEqual(provider.capabilities().mount, ["archil"]);
});

test("Orgo check(): an Archil spec takes a template, network none, the run and epoch labels, the helper's shapes and the tool user, with no call; no refusal holds the token", () => {
	const { provider, api } = setup();
	assert.deepEqual(provider.check(SPEC), []);
	for (const [change, field, words] of [
		[{ image: "linux" }, "image", /template box\/build-orgo\.mjs builds/],
		[{ network: "open" }, "network", /none/],
		[{ labels: { "agentrun.run": RUN } }, "labels", /agentrun\.epoch/],
		[{ labels: { "agentrun.epoch": "3" } }, "labels", /agentrun\.run/],
		[{ mount: { ...MOUNT, folder: "agents/a1/runs/r2/work" } }, "mount", /run r2/],
		[{ mount: { ...MOUNT, token: "short" } }, "mount", /mount\.token/],
		[{ mount: { ...MOUNT, extra: TOKEN } }, "mount", /mount\.extra/],
		[{ mount: { kind: "bind", path: "/" } }, "mount", /takes archil/],
		[{ labels: { ...LABELS, "agentrun.mount": mountLabel } }, "labels", /agentrun\.mount is the provider's own/],
	]) {
		const refusals = provider.check({ ...SPEC, ...change });
		assert.ok(refusals.some((r) => r.field === field && words.test(r.message)), `${JSON.stringify(change).replace(TOKEN, "[token]")}: ${JSON.stringify(refusals).replace(TOKEN, "[token]")}`);
		noToken(refusals, `the refusal of ${field}`);
	}
	noToken(provider.check({ ...SPEC, mount: { ...MOUNT, folder: TOKEN } }), "a token in the folder");
	// A caller's agentrun.mount is refused with no mount too: it would turn syncing on and list a mount that is not there.
	assert.ok(provider.check({ image: "linux", lifetimeMs: 60_000, network: "none", labels: { "agentrun.mount": mountLabel } }).some(({ field }) => field === "labels"));
	const other = setup({ user: "1000:1000" });
	assert.ok(other.provider.check(SPEC).some(({ field, message }) => field === "mount" && /2510:2510/.test(message) && /1000:1000/.test(message)));
	assert.deepEqual(other.provider.check({ ...SPEC, mount: undefined }), [], "without a mount, any tool user");
	assert.deepEqual(api.requests, [], "check calls nothing");
});

test("Orgo create of an Archil computer: preflight, the takeover, mount with the token on the stdio bridge's stdin, serve, as root, before root's ports, the lockdown and init; then the read-back", async () => {
	const fakes = setup();
	const created = await fakes.provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	noToken(created, "create's result");
	const record = newest(fakes.api);
	assert.equal(record.asked.template_ref, TEMPLATE, "the template the helper and the archil client are baked into");
	assert.match(record.name, /-e3-ma-d[0-9a-z]+$/, "the name marks the Archil mount, with nothing run inside");
	const file = JSON.parse(fakes.channel.boxOf(record.id).labels);
	assert.deepEqual(JSON.parse(file.labels["agentrun.mount"]), { kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder }, "the labels file records the mount, never the token");

	const steps = callsIn(fakes, record.id).map(({ op, kind }) => `${op} ${kind}`);
	const at = (step) => steps.indexOf(step);
	assert.deepEqual(verbsOf(fakes, record.id), ["preflight", "mount", "serve"]);
	assert.ok(at("run orgo-labels") < at("run archil-preflight"), `the labels file first, which the takeover lists by: ${steps}`);
	assert.ok(at("stdio orgo-archil-stdin") < at("run archil-serve"));
	assert.ok(at("run archil-serve") < at("run orgo-ports"), "the archil client's ports are among root's the probe tries");
	assert.ok(at("run archil-serve") < at("run orgo-lockdown"), "and its sockets among those locked");
	assert.ok(at("run orgo-lockdown") < at("start init"), "no tool program runs before the folder is mounted");
	const events = eventsOf(fakes, record.id);
	assert.ok(events.indexOf("daemon files.read") >= 0 && events.lastIndexOf("daemon mount.sync") > events.indexOf("daemon hello"), `the mount read back from inside: ${events}`);

	const runs = fakes.channel.rootRuns.filter((run) => run.computer === record.id);
	assert.deepEqual(runs[1].argv, [ARCHIL_HELPER, "mount", MOUNT.disk, MOUNT.region, MOUNT.folder]);
	assert.equal(runs[1].via, "stdio", "the step with stdin goes through the root terminal");
	assert.equal(runs[1].stdin, `${TOKEN}\n`, "the token, one line on the mount's stdin");
	for (const [n, run] of runs.entries()) if (n !== 1) assert.deepEqual([run.via, run.stdin], ["bash", undefined], `${run.verb}: a bash call, no stdin`);
	// Nowhere else: no command line, upload, labels file, name or REST call holds it.
	noToken(fakes.channel.calls, "the channel's calls");
	noToken(fakes.api.requests.map(({ method, path, body }) => ({ method, path, body })), "the REST calls");
	noToken(fakes.channel.boxOf(record.id).labels, "the labels file");
});

test("Orgo create of an Archil computer: the takeover releases the run's lower epoch (its final sync and checkin, then its delete) before it revokes", async () => {
	const fakes = setup();
	const old = seededArchil(fakes, { epoch: 2, hex: "00000000000a" });
	const created = await fakes.provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	const { id } = newest(fakes.api);
	assert.deepEqual(verbsOf(fakes, id), ["preflight", "revoke", "serve"]);
	assert.equal(fakes.channel.rootRuns.find((run) => run.computer === id && run.verb === "revoke").stdin, `${TOKEN}\n`);
	assert.deepEqual(verbsOf(fakes, old.ref.id), ["checkin"], "the old computer lets go of the folder");
	assert.equal(old.record.deleted, true, "and is gone");
	const sync = indexOf(fakes, old.ref.id, "daemon mount.sync");
	const checkin = indexOf(fakes, old.ref.id, "root checkin");
	const deleted = indexOf(fakes, old.ref.id, `DELETE /computers/${old.ref.id}`);
	assert.ok(sync >= 0 && sync < checkin && checkin < deleted, JSON.stringify(eventsOf(fakes, old.ref.id)));
	const order = fakes.events.map(({ computer, what }) => `${computer} ${what}`);
	assert.ok(order.indexOf(`${old.ref.id} DELETE /computers/${old.ref.id}`) < order.indexOf(`${id} root revoke`), "the old one is deleted before the revoke");
	assert.ok(order.indexOf(`${id} root preflight`) < order.indexOf(`${old.ref.id} root checkin`), "the new one is proven before the old one goes");
	noToken(fakes.channel.calls, "the channel's calls");
});

test("Orgo create of an Archil computer: a higher epoch fences it; nothing is mounted or revoked, init never starts, the newer computer is left and the new one deleted", async () => {
	const fakes = setup();
	const newer = seededArchil(fakes, { epoch: 4, hex: "00000000000b" });
	const created = await fakes.provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.match(created.error.message, /fenced/);
	noToken(created, "the refusal");
	const record = newest(fakes.api);
	assert.deepEqual(verbsOf(fakes, record.id), ["preflight"], "no mount, no revoke");
	assert.ok(!callsIn(fakes, record.id).some(({ op }) => op === "start"), "init never starts");
	assert.equal(record.deleted, true);
	assert.equal(newer.record.deleted, false, "the newer claim's computer is left");
	assert.deepEqual(verbsOf(fakes, newer.ref.id), []);
});

test("Orgo create of an Archil computer: a failed step refuses in words that never hold the token, init never starts, and the computer is deleted; an image not the recipe's is refused at the preflight", async () => {
	const fakes = setup({}, { channel: { archil: { mount: { exitCode: 1, output: `archil: mount refused for token ${TOKEN}` } } } });
	const created = await fakes.provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.match(created.error.message, /mount/);
	noToken(created, "the refusal");
	const record = newest(fakes.api);
	assert.deepEqual(verbsOf(fakes, record.id), ["preflight", "mount"]);
	assert.ok(!callsIn(fakes, record.id).some(({ op }) => op === "start"), "init never starts");
	assert.equal(record.deleted, true);

	const wrong = setup({}, { channel: { archil: { preflight: { exitCode: 0, output: "uid 0\nhelper 00 -rwxr-xr-x 0 0\narchil v0.10.0\ntool 2510:2510\nsudo /usr/bin/sudo" } } } });
	const refused = await wrong.provider.create(SPEC);
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /not as the Archil image makes it/);
	assert.match(refused.error.message, /sudo/, "Orgo's base desktop has sudo: a template that kept it is refused");
	assert.deepEqual(verbsOf(wrong, newest(wrong.api).id), ["preflight"]);
	assert.equal(newest(wrong.api).deleted, true);
});

test("Orgo create of an Archil computer: a mount that finds the folder held by a client no listing shows is revoked, then served", async () => {
	const fakes = setup({}, { channel: { archil: { mount: { exitCode: 1, output: "mount failed: has an outstanding delegation" } } } });
	const created = await fakes.provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	assert.deepEqual(verbsOf(fakes, newest(fakes.api).id), ["preflight", "mount", "revoke", "serve"]);
	assert.deepEqual(
		fakes.channel.rootRuns.filter(({ stdin }) => stdin !== undefined).map(({ verb, via, stdin }) => [verb, via, stdin]),
		[
			["mount", "stdio", `${TOKEN}\n`],
			["revoke", "stdio", `${TOKEN}\n`],
		],
	);
});

test("Orgo's stdin step is bounded: a helper that never ends is a timeout, a terminal that ends before its exit code is said in words; neither holds the token", async () => {
	const hung = setup({}, { channel: { archil: { mount: "hang" } } });
	const timed = await hung.provider.create(SPEC);
	assert.equal(timed.ok, false);
	assert.equal(timed.error.code, "timeout");
	assert.match(timed.error.message, /agentrun-archil mount .* did not end within 1 s/);
	noToken(timed, "the timeout");
	assert.equal(newest(hung.api).deleted, true);

	const died = setup({}, { channel: { stdinStep: "dies" } });
	const ended = await died.provider.create(SPEC);
	assert.equal(ended.ok, false);
	assert.match(ended.error.message, /ended before it said its exit code: the terminal closed/);
	noToken(ended, "the refusal");
	assert.ok(!callsIn(died, newest(died.api).id).some(({ op }) => op === "start"), "init never starts");
});

test("Orgo create of an Archil computer: a mount that does not read back as asked is refused, and the folder is let go before the delete", async () => {
	const fakes = setup(
		{},
		{
			channel: {
				archil: {
					mount: (argv, stdin, box) => {
						box.mountSource = `dsk-0000000000000bad:/${MOUNT.folder}`;
						return { exitCode: 0, output: "" };
					},
				},
			},
		},
	);
	const created = await fakes.provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.match(created.error.message, /mount/);
	assert.match(created.error.message, /dsk-0000000000000bad/);
	noToken(created, "the refusal");
	const { id } = newest(fakes.api);
	assert.deepEqual(verbsOf(fakes, id), ["preflight", "mount", "serve", "checkin"]);
	assert.ok(indexOf(fakes, id, "root checkin") < indexOf(fakes, id, `DELETE /computers/${id}`));
});

test("Orgo connect: an Archil computer's client syncs after each call that may change the folder, and a failed sync fails the call; another computer's never syncs", async () => {
	const fakes = setup();
	const { ref, box } = seededArchil(fakes);
	const connected = await fakes.provider.connect(ref);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	const { client } = connected.value;
	assert.equal((await client.call("ping", {})).ok, true);
	assert.equal(box.syncs, 0, "a ping changes nothing");
	assert.equal((await client.call("exec.run", { argv: ["true"], timeoutMs: 1000 })).ok, true);
	assert.equal(box.syncs, 1, "exec.run syncs before it answers");
	await client.call("files.read", { path: "/proc/self/status" });
	assert.equal(box.syncs, 1, "none after a read");
	box.syncExit = 1;
	const failed = await client.call("exec.run", { argv: ["true"], timeoutMs: 1000 });
	assert.equal(failed.ok, false);
	assert.match(failed.error.message, /durable/);
	await connected.value.close();
	assert.ok(!callsIn(fakes, ref.id).some(({ kind }) => kind === "orgo-labels-read"), "the name's mark says so, with nothing read inside");

	const plain = seededArchil(fakes, { hex: "00000000000c", mount: false, label: null });
	const other = await fakes.provider.connect(plain.ref);
	assert.equal(other.ok, true, JSON.stringify(other));
	assert.equal((await other.value.client.call("exec.run", { argv: ["true"], timeoutMs: 1000 })).ok, true);
	assert.equal(plain.box.syncs, 0, "no Archil mount, no sync");
	await other.value.close();
});

test("Orgo list: a running Archil computer's mount as its labels file records it, under its epoch label; another computer has none; nothing runs in a computer that is not running", async () => {
	const fakes = setup();
	const mine = seededArchil(fakes);
	const other = seededArchil(fakes, { hex: "00000000000d", labels: { "agentrun.run": "r9", "agentrun.epoch": "3" }, label: JSON.stringify({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: "agents/a1/runs/r9/work" }) });
	const plain = seededArchil(fakes, { hex: "00000000000e", labels: { "agentrun.run": "r8", "agentrun.epoch": "1" }, mount: false, label: null });
	for (const filter of [{ "agentrun.run": RUN }, { "agentrun.run": RUN, "agentrun.epoch": String(EPOCH) }, { team: "a" }]) {
		const listed = await fakes.provider.list(filter);
		assert.equal(listed.ok, true, JSON.stringify(listed));
		const info = listed.value.find((one) => one.ref.id === mine.ref.id);
		assert.deepEqual(info.mount, readBack(), JSON.stringify(filter));
		assert.equal(info.network, "none");
		noToken(listed, "list");
	}
	const before = fakes.channel.calls.length;
	const all = await fakes.provider.list({});
	assert.equal(all.value.find((one) => one.ref.id === other.ref.id).mount.folder, "agents/a1/runs/r9/work");
	assert.equal(all.value.find((one) => one.ref.id === plain.ref.id).mount, undefined, "no mark, no mount");
	assert.deepEqual(
		fakes.channel.calls.slice(before).map(({ computer }) => computer),
		[mine.ref.id, other.ref.id],
		"a list with no label to read reads the labels file of a marked computer alone",
	);

	const asleep = setup();
	const suspended = seededArchil(asleep, { status: "suspended" });
	const listed = await asleep.provider.list({ "agentrun.run": RUN });
	assert.equal(listed.value[0].state, "stopped");
	assert.ok("other" in listed.value[0].mount && /suspended, and a read would wake it/.test(listed.value[0].mount.other), JSON.stringify(listed.value[0].mount));
	assert.deepEqual(callsIn(asleep, suspended.ref.id), [], "never woken");
});

test("Orgo idle suspension: list, attach, connect, network, extend and release run nothing in a computer Orgo does not read running, whatever its state", async () => {
	for (const status of NOT_RUNNING) {
		for (const archil of [true, false]) {
			const notes = [];
			const fakes = setup({ onNote: (note) => notes.push(note) });
			const { ref } = seededArchil(fakes, { status, mount: archil, label: archil ? mountLabel : null });
			const what = `${status}${archil ? ", Archil" : ""}`;
			for (const filter of [{}, { "agentrun.run": RUN }, { "agentrun.run": RUN, "agentrun.epoch": String(EPOCH) }, { team: "a" }]) {
				const listed = await fakes.provider.list(filter);
				assert.equal(listed.ok, true, `${what}: ${JSON.stringify(listed)}`);
			}
			assert.equal((await fakes.provider.list({ team: "a" })).value.length, 0, `${what}: a label only its labels file proves is not proven`);
			assert.equal((await fakes.provider.attach({ id: ref.id })).error.code, "refused", what);
			assert.equal((await fakes.provider.connect(ref)).error.code, "refused", what);
			assert.equal((await fakes.provider.network(ref)).error.code, "refused", what);
			assert.equal((await fakes.provider.extend(ref, HOUR)).error.code, "refused", what);
			assert.deepEqual(await fakes.provider.release(ref, "delete"), { ok: true, value: undefined }, what);
			assert.deepEqual(callsIn(fakes, ref.id), [], `${what}: nothing ran inside`);
			assert.ok(!fakes.api.requests.some(({ path }) => path.endsWith("/bash")), `${what}: no bash call`);
			if (archil) {
				assert.equal(notes.length, 1, `${what}: ${JSON.stringify(notes)}`);
				assert.match(notes[0].note, new RegExp(`${status}, and a checkin would wake it; the run's next claim revokes its hold`));
			} else assert.deepEqual(notes, [], what);
		}
	}
});

test("Orgo attach: an Archil computer's mount is read back from inside, fuse.archil at /workspace, exclusive once serve answers, under its epoch; drift is refused and left as it is", async () => {
	const fakes = setup();
	const { ref } = seededArchil(fakes);
	const attached = await fakes.provider.attach({ id: ref.id });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual(attached.value.spec.mount, readBack());
	assert.equal(attached.value.spec.network, "none");
	assert.equal(attached.value.spec.image, TEMPLATE);
	noToken(attached, "attach");

	for (const [box, words] of [
		[{ mountSource: `dsk-0000000000000bad:/${MOUNT.folder}` }, /dsk-0000000000000bad/],
		[{ served: false }, /exclusive/],
		[{ syncExit: 1 }, /not exclusive/],
		[{ mounted: undefined }, /nothing is mounted/],
		[{ mountType: "tmpfs" }, /tmpfs/],
	]) {
		const drifted = setup();
		const one = seededArchil(drifted, { box });
		const result = await drifted.provider.attach({ id: one.ref.id });
		assert.equal(result.ok, false, JSON.stringify(box));
		assert.equal(result.error.code, "refused");
		assert.match(result.error.message, /mount/);
		assert.match(result.error.message, words);
		assert.equal(one.record.deleted, false, "left as it is");
	}

	const unmarked = setup();
	const forged = seededArchil(unmarked, { mount: false });
	const refused = await unmarked.provider.attach({ id: forged.ref.id });
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /mount: the name marks no Archil mount, and the labels file records one/);
	const unrecorded = setup();
	const bare = seededArchil(unrecorded, { label: null });
	assert.match((await unrecorded.provider.attach({ id: bare.ref.id })).error.message, /mount: the name marks an Archil mount, and the labels file records none/);
});

test("Orgo release of a running Archil computer: the final sync, then checkin as root, then the delete; a failed checkin still deletes, and says so", async () => {
	const fakes = setup();
	const { ref, record } = seededArchil(fakes);
	assert.deepEqual(await fakes.provider.release(ref, "delete"), { ok: true, value: undefined });
	const sync = indexOf(fakes, ref.id, "daemon mount.sync");
	const checkin = indexOf(fakes, ref.id, "root checkin");
	const deleted = indexOf(fakes, ref.id, `DELETE /computers/${ref.id}`);
	assert.ok(sync >= 0 && sync < checkin && checkin < deleted, JSON.stringify(eventsOf(fakes, ref.id)));
	assert.deepEqual(fakes.channel.rootRuns.find((run) => run.verb === "checkin").argv, [ARCHIL_HELPER, "checkin"]);
	assert.equal(record.deleted, true);

	// The ruling: release succeeds once the computer is gone, and a folder not let go cleanly is a note.
	const notes = [];
	const failing = setup({ onNote: (note) => notes.push(note) }, { channel: { archil: { checkin: { exitCode: 1, output: "archil: checkin failed: server unreachable" } } } });
	const one = seededArchil(failing);
	assert.deepEqual(await failing.provider.release(one.ref, "delete"), { ok: true, value: undefined });
	assert.equal(one.record.deleted, true, "deleted whatever checkin said");
	assert.equal(notes.length, 1, JSON.stringify(notes));
	assert.equal(notes[0].computer, one.ref.name);
	assert.match(notes[0].note, /was deleted, and the run's folder was not let go cleanly/);
	assert.match(notes[0].note, /server unreachable/);
});

test("the Orgo conformance module: mountFor(\"archil\") gives a fresh run folder on the disk COMPUTER_ARCHIL_* name, behind the live switch", async () => {
	const { ARCHIL_ENV, ENV, mountFor } = await import("../dist/conformance/orgo.js");
	assert.deepEqual(ARCHIL_ENV, (await import("../dist/conformance/archil.js")).ARCHIL_ENV);
	assert.equal(Object.values(ENV).some((name) => name.startsWith("COMPUTER_ARCHIL_")), false, "the provider's settings name no Archil setting");
	const settings = {
		COMPUTER_ARCHIL_DISK: MOUNT.disk,
		COMPUTER_ARCHIL_REGION: MOUNT.region,
		COMPUTER_ARCHIL_TOKEN: TOKEN,
		COMPUTER_ARCHIL_API_KEY: "key-archil-account-0123456789abcdef",
		COMPUTER_ARCHIL_S3_URL: "https://s3.green.us-east-1.aws.prod.archil.com",
	};
	const env = { AGENTRUN_COMPUTER_LIVE_ORGO: "1", ...settings };
	assert.equal(await mountFor("bind", { env }), undefined, "an Orgo computer takes no bind");
	assert.equal(await mountFor("archil", { env: {} }), undefined, "no disk named: the case is skipped");
	await assert.rejects(mountFor("archil", { env: settings, archil: { objects: fakeObjects() } }), /AGENTRUN_COMPUTER_LIVE_ORGO/);
	const objects = fakeObjects();
	const folder = await mountFor("archil", { env, archil: { objects } });
	assert.deepEqual({ ...folder.mount, folder: undefined }, { ...MOUNT, folder: undefined });
	await folder.write("a.txt", Buffer.from("outside\n"));
	assert.equal(Buffer.from(await folder.read("a.txt")).toString("utf8"), "outside\n");
	await folder.close();
});
