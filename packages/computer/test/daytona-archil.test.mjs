// A Daytona computer with an Archil mount, against the fake Daytona (test/fake-daytona.mjs), whose sandboxes answer the
// Archil image's root commands as the image would: no Daytona, no Archil, no network. The provider runs the helper as
// root through its toolbox, in sessions, before init starts; the token goes only on the mount's stdin (the session
// command's input, never echoed); the computer is labelled with its mount, never the token; the takeover releases the
// run's lower epochs before any mount; connect's client syncs; release lets the folder go before the delete.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ARCHIL_MOUNT_LABEL, DaytonaProvider, EPOCH_LABEL, readBackOf, RUN_LABEL } from "../dist/index.js";
import { API, ARCHIL_HELPER, fakeDaytona, KEY, scriptOf, statusText } from "./fake-daytona.mjs";

const FAST = { requestMs: 2000, createMs: 2000, startMs: 300, deleteMs: 2000, stopMs: 500, goneMs: 500, uploadMs: 2000, execMs: 2000, helloMs: 1000, pollMs: 1, retryMs: 1, listedMs: 2000, listedStableMs: 0 };
const TOKEN = "tok-daytona-archil-0123456789abcdef";
const MOUNT = { kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", folder: "agents/a1/runs/r1/work", token: TOKEN };
const LABELS = { [RUN_LABEL]: "r1", [EPOCH_LABEL]: "3" };
const SPEC = { image: "agentrun-archil-snap", lifetimeMs: 600_000, network: "none", labels: LABELS, mount: MOUNT };

const dir = mkdtempSync(join(tmpdir(), "computer-daytona-archil-"));
const DAEMON = join(dir, "computerd");
writeFileSync(DAEMON, Buffer.from("a stand-in for computerd\n"));
const real = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
let keep;
before(() => {
	keep = setInterval(() => {}, 1000);
	globalThis.fetch = async () => {
		throw new Error("a test reached the global fetch");
	};
	globalThis.WebSocket = function WebSocket() {
		throw new Error("a test reached the global WebSocket");
	};
});
after(() => {
	clearInterval(keep);
	globalThis.fetch = real.fetch;
	globalThis.WebSocket = real.WebSocket;
	rmSync(dir, { recursive: true, force: true });
});

function setup(knobs = {}, options = {}) {
	const fake = fakeDaytona({ status: statusText({ uid: 2510 }), ...knobs });
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, daemonUser: "2510:2510", fetch: fake.fetch, webSocket: fake.webSocket, timeouts: FAST, ...options });
	return { fake, provider };
}

/** Every request the provider sent, but the one input that carries the token, holds no token anywhere. */
function tokenOnlyOnStdin(fake) {
	const carrying = fake.requests.filter((request) => JSON.stringify(request).includes(TOKEN));
	assert.equal(carrying.length, 1, `one request carries the token: ${carrying.map((r) => `${r.method} ${r.path}`).join(", ")}`);
	const [input] = carrying;
	assert.match(input.path, /\/process\/session\/[^/]+\/command\/[^/]+\/input$/);
	assert.deepEqual(input.body, { data: `${TOKEN}\n` });
}

test("capabilities declare the Archil mount; check takes an Archil spec of the rule, and refuses one the daemon user or the network does not fit, never with the token", () => {
	const { provider } = setup();
	assert.deepEqual(provider.capabilities().mount, ["archil"]);
	assert.deepEqual(provider.check(SPEC), []);
	const { provider: plain } = setup({}, { daemonUser: "1000:1000" });
	const refused = plain.check(SPEC);
	assert.ok(refused.some(({ field, message }) => field === "mount" && /2510:2510/.test(message)), JSON.stringify(refused));
	for (const spec of [{ ...SPEC, network: "open" }, { ...SPEC, labels: { [RUN_LABEL]: "r1" } }, { ...SPEC, mount: { ...MOUNT, folder: "agents/a1/runs/r2/work" } }, { ...SPEC, mount: { kind: "bind", path: "/" } }]) {
		const found = provider.check(spec);
		assert.ok(found.length > 0, JSON.stringify(spec.mount ?? spec.network));
		assert.ok(!JSON.stringify(found).includes(TOKEN));
	}
});

test("create: preflight, mount (the token on its stdin alone), serve, each as root in the toolbox, before init, never through computerd; Daytona's network open for root, the mount labelled without the token", async () => {
	const { fake, provider } = setup();
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	const sb = fake.sandboxes.get(made.value.id);
	const box = fake.inside(made.value.id);
	assert.deepEqual(box.order.filter((step) => step !== "stdio"), ["preflight", "mount", "serve", "init"]);
	const mount = box.archil.calls.find(({ verb }) => verb === "mount");
	assert.deepEqual(mount.argv, [ARCHIL_HELPER, "mount", MOUNT.disk, MOUNT.region, MOUNT.folder]);
	assert.deepEqual(mount.stdin, [`${TOKEN}\n`]);
	for (const call of box.archil.calls.filter(({ verb }) => verb !== "mount")) assert.deepEqual(call.stdin, [], `${call.verb} gets no stdin`);
	// Every request that names the helper is a root command of its own session (the toolbox, as root), never a line to
	// computerd through a bridge: the archil client and serve run outside init's namespace, with root's network.
	const naming = fake.requests.filter((request) => JSON.stringify(request.body ?? null).includes(ARCHIL_HELPER));
	assert.ok(naming.length >= 2, "mount and serve were asked for");
	for (const request of naming) {
		assert.match(request.path, /\/process\/session\/agentrun-archil-[0-9a-f]{16}\/exec$/, `${request.method} ${request.path}`);
		assert.equal(scriptOf(request.body.command).kind, "root");
	}
	assert.equal(sb.networkBlockAll, false, "root reaches Archil; init's own namespace holds the tools to lo alone");
	assert.deepEqual(JSON.parse(sb.labels[ARCHIL_MOUNT_LABEL]), { kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder });
	tokenOnlyOnStdin(fake);
	const exec = fake.requests.filter((r) => /\/exec$/.test(r.path));
	assert.ok(exec.every((r) => r.body.suppressInputEcho === true), "no command echoes its input");
});

test("attach and list read the mount back under the epoch label, exclusive; network() reads none from the daemon (lo alone), and refuses any policy but none", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	const attached = await provider.attach({ id: made.value.id });
	assert.equal(attached.ok, true, attached.ok ? "" : attached.error.message);
	assert.deepEqual(attached.value.spec.mount, readBackOf(MOUNT, 3));
	const listed = await provider.list(LABELS);
	assert.equal(listed.ok, true);
	assert.deepEqual(listed.value[0].mount, readBackOf(MOUNT, 3));
	assert.ok(!JSON.stringify([attached, listed]).includes(TOKEN));
	// Daytona's own network is open for root (the archil client reaches Archil); the tools' is init's own namespace,
	// read back from the daemon: "none" while it holds lo alone. It takes no policy but none.
	assert.deepEqual(await provider.network(made.value), { ok: true, value: "none" });
	assert.equal(attached.value.spec.network, "none");
	assert.equal(listed.value[0].network, "none");
	const opened = await provider.network(made.value, "open");
	assert.equal(opened.ok, false);
	// A daemon that reads back another interface is not "none", in words.
	fake.knobs.interfaces = ["lo", "eth0"];
	const wider = await provider.network(made.value);
	assert.equal(wider.ok, true);
	assert.match(wider.value.other, /eth0/);
});

test("the takeover: the run's lower epochs are deleted before any mount, then the folder is revoked; a release that fails mounts nothing", async () => {
	const { fake, provider } = setup();
	const old = await provider.create({ ...SPEC, labels: { ...LABELS, [EPOCH_LABEL]: "2" } });
	assert.equal(old.ok, true, old.ok ? "" : old.error.message);
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	assert.equal(fake.sandboxes.has(old.value.id), false, "the epoch 2 computer is gone");
	assert.deepEqual(fake.inside(made.value.id).order.filter((step) => step !== "stdio"), ["preflight", "revoke", "serve", "init"]);

	const again = setup();
	const older = await again.provider.create({ ...SPEC, labels: { ...LABELS, [EPOCH_LABEL]: "2" } });
	assert.equal(older.ok, true);
	again.fake.knobs.fail = [{ method: "DELETE", path: new RegExp(`/api/sandbox/${older.value.id}$`), status: 500, times: 1000 }];
	const refused = await again.provider.create(SPEC);
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /takeover/);
	const tried = [...again.fake.sandboxes.values()].find((sb) => sb.id !== older.value.id);
	const order = tried ? again.fake.inside(tried.id).order : [];
	assert.ok(!order.includes("mount") && !order.includes("revoke"), `nothing mounted: ${order}`);
});

test("a mount that finds the folder held by a client no listing shows is revoked, then served", async () => {
	const { fake, provider } = setup({ archil: { mount: { exitCode: 1, output: "mount failed: has an outstanding delegation" } } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	assert.deepEqual(fake.inside(made.value.id).order.filter((step) => step !== "stdio"), ["preflight", "mount", "revoke", "serve", "init"]);
});

test("an image that is not the recipe's is refused before the takeover, and the sandbox deleted", async () => {
	const { fake, provider } = setup({ archil: { preflight: { exitCode: 0, output: "uid 0\nhelper 00 -rwxr-xr-x 0 0\narchil v0.10.0\ntool 2510:2510\nsudo /usr/bin/sudo" } } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.match(made.error.message, /not as the Archil image makes it/);
	assert.match(made.error.message, /sudo/);
	assert.equal(fake.sandboxes.size, 0, "deleted");
});

test("connect's client syncs after a call that changes the folder, and a failed sync fails the call", async () => {
	const { fake, provider } = setup();
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true);
	const box = fake.inside(made.value.id);
	const connected = await provider.connect(made.value);
	assert.equal(connected.ok, true, connected.ok ? "" : connected.error.message);
	const before = box.syncs ?? 0;
	const ran = await connected.value.client.call("exec.run", { argv: ["echo", "x"], timeoutMs: 1000 });
	assert.equal(ran.ok, true);
	assert.equal((box.syncs ?? 0) - before, 1, "one sync after exec.run");
	await connected.value.client.call("files.read", { path: "/proc/self/status" });
	assert.equal((box.syncs ?? 0) - before, 1, "none after a read");
	fake.knobs.syncExit = 1;
	const failed = await connected.value.client.call("exec.run", { argv: ["echo", "y"], timeoutMs: 1000 });
	assert.equal(failed.ok, false);
	assert.match(failed.error.message, /durable/);
	await connected.value.close();
});

test("release: a final sync, then checkin as root, then the delete", async () => {
	const { fake, provider } = setup();
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true);
	const box = fake.inside(made.value.id);
	const syncs = box.syncs ?? 0;
	const released = await provider.release(made.value, "delete");
	assert.equal(released.ok, true, released.ok ? "" : released.error.message);
	assert.equal(box.order.filter((step) => step !== "stdio").at(-1), "checkin");
	assert.equal((box.syncs ?? 0) - syncs, 1, "the final sync");
	assert.equal(fake.sandboxes.has(made.value.id), false);
});

test("release: a checkin that fails is a note, never a failed release, and the takeover goes on (the ruling, as Modal and E2B)", async () => {
	const notes = [];
	const { fake, provider } = setup({}, { onNote: (note) => notes.push(note) });
	const old = await provider.create({ ...SPEC, labels: { ...LABELS, [EPOCH_LABEL]: "2" } });
	assert.equal(old.ok, true);
	fake.knobs.archil = { checkin: { exitCode: 1, output: "archil: checkin failed: server unreachable" } };
	assert.deepEqual(await provider.release(old.value, "delete"), { ok: true, value: undefined });
	assert.equal(fake.sandboxes.has(old.value.id), false, "deleted whatever checkin said");
	assert.equal(notes.length, 1, JSON.stringify(notes));
	assert.equal(notes[0].computer, old.value.name);
	assert.match(notes[0].note, /not let go/);
	assert.match(notes[0].note, /server unreachable/);
});
