// A synced folder (mount kind "sync"): which providers take one (derived from a configuration with exec and files, no
// bind and no unmounted.sync), check()'s rules for it (the run's claim epoch), and a hosted create of one over the fake
// host: install makes /workspace the computer user's before init, the mount label records it, and the read-back is
// {kind: "sync", epoch} from inside, or the words of what is there instead.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DaytonaProvider } from "../dist/daytona.js";
import { DAYTONA, DOCKER, MODAL, mountsOf, ORGO, PHONE_HARNESS } from "../dist/index.js";
import { HostedProvider } from "../dist/hosted/provider.js";
import { fakeDialHost } from "./fake-dial-host.mjs";
import { fakeHost } from "./fake-host.mjs";

const dir = mkdtempSync(join(tmpdir(), "computer-sync-mount-"));
const DAEMON = join(dir, "computerd");
const DAEMON_BYTES = Buffer.from("a stand-in for computerd, linux/amd64\n");
writeFileSync(DAEMON, DAEMON_BYTES);
after(() => rmSync(dir, { recursive: true, force: true }));

const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 2_000, retryMs: 1 };
const SPEC = { image: "agentrun-debian", lifetimeMs: 600_000, network: "none" };
const SYNC = { kind: "sync" };
const SYNC_SPEC = { ...SPEC, labels: { "agentrun.run": "r1", "agentrun.epoch": "3" }, mount: SYNC };
const GPU = { type: "H100", count: 1 };
let requests = 0;
const create = (provider, spec = SYNC_SPEC) => provider.create(spec, { requestId: `sync-${++requests}` });
const made = (result) => {
	assert.equal(result.ok, true, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
	return result.value;
};
const fields = (refusals) => refusals.map(({ field }) => field);

/** A Daytona provider whose every request is refused: check() and capabilities() ask Daytona nothing. */
function daytona(options = {}) {
	const requests = [];
	const fetch = async (url) => {
		requests.push(String(url));
		return new Response(JSON.stringify({ statusCode: 401, message: "Invalid credentials" }), { status: 401, headers: { "content-type": "application/json" } });
	};
	return { requests, provider: new DaytonaProvider({ apiKey: "fake-test-key", apiUrl: "https://api.daytona.test/api", daemonPath: DAEMON, fetch, timeouts: TIMEOUTS, ...options }) };
}

test("Daytona takes a synced folder, its GPU computers too, under the run's claim epoch; no request is made", () => {
	const { provider, requests } = daytona();
	assert.deepEqual(provider.capabilities().mount, ["sync"]);
	assert.deepEqual(provider.capabilities().gpu.mounts, ["sync"]);
	assert.deepEqual(provider.check(SYNC_SPEC), []);
	assert.deepEqual(provider.check({ ...SYNC_SPEC, image: "daytona-gpu", gpu: GPU }), [], "a GPU computer takes a synced folder alone");
	const unlabelled = provider.check({ ...SPEC, mount: SYNC });
	assert.deepEqual(fields(unlabelled), ["labels"]);
	assert.match(unlabelled[0].message, /^a synced folder is made under the run's claim epoch: the label agentrun\.epoch is required/);
	assert.deepEqual(fields(provider.check({ ...SYNC_SPEC, mount: { kind: "sync", folder: "x" } })), ["mount"], "a synced folder has no fields");
	assert.deepEqual(requests, []);
});

test("with an Archil egress, Daytona takes both kinds; its GPU computers still take a synced folder alone", () => {
	const { provider } = daytona({ archilEgress: "192.0.2.40:18100:42050" });
	assert.deepEqual(provider.capabilities().mount, ["archil", "sync"]);
	assert.deepEqual(provider.check(SYNC_SPEC), []);
	assert.deepEqual(provider.capabilities().gpu.mounts, ["sync"]);
});

test("which descriptors take a synced folder: derived where a configuration has exec and files, never where a bind is taken or unmounted.sync says why", () => {
	const set = () => false;
	assert.deepEqual(mountsOf(DAYTONA, set).mounts, ["sync"]);
	assert.deepEqual(mountsOf(MODAL, set).mounts, ["archil", "sync"]);
	assert.deepEqual(mountsOf(DOCKER, set).mounts, ["bind"], "Docker binds the run's folder");
	assert.equal(mountsOf(ORGO, set).mounts.includes("sync"), false);
	assert.match(mountsOf(ORGO, set).unmounted.sync, /^Orgo's provider makes no \/workspace for a synced folder yet$/);
	assert.equal(mountsOf(PHONE_HARNESS, set).mounts.includes("sync"), false, "a phone has no files group");
	assert.deepEqual(DAYTONA.mounts, [], "sync is derived, never listed");
});

test("a hosted create of a synced folder: install makes /workspace the computer user's, 0700, before init; the label records it; list and attach read it back from inside", async () => {
	const fake = fakeHost({ box: { reached: [] } });
	const provider = new HostedProvider(fake.host, { daemonPath: DAEMON, timeouts: TIMEOUTS });
	assert.deepEqual(provider.capabilities().mount, ["archil", "sync"]);
	const ref = made(await create(provider));
	const [m] = fake.machines.values();
	assert.deepEqual(m.box.workspace, { path: "/workspace", type: "dir", owner: "2510:2510", mode: 0o700 }, "install made it the computer user's");
	const runs = fake.events.filter((event) => event.machine === m.id).map(({ what }) => what);
	assert.ok(runs.indexOf("run install") < runs.indexOf("run start"), runs.join(", "));
	assert.equal(m.labels["agentrun.mount"], JSON.stringify(SYNC));
	assert.equal(m.request.egress, false, "no egress: nothing in the computer reaches a disk");
	assert.deepEqual(fake.rootRuns, [], "no Archil step");
	const [info] = made(await provider.list({ "agentrun.run": "r1" }));
	assert.deepEqual(info.mount, { kind: "sync", epoch: 3 }, "list reads the label");
	const attached = made(await provider.attach({ id: ref.id }));
	assert.deepEqual(attached.spec.mount, { kind: "sync", epoch: 3 }, "attach reads it from inside");
	const connection = made(await provider.connect(ref));
	assert.deepEqual(made(await connection.client.call("ping", {})), {});
	await connection.close();
	assert.deepEqual(fake.syncs, [], "a synced folder's client asks no mount.sync");
	made(await provider.release(ref, "delete"));
});

test("a synced folder's /workspace that is not the computer user's directory fails the create, saying what is there, and leaves nothing", async () => {
	for (const [workspace, words] of [
		[{ path: "/workspace", type: "dir", owner: "0:0", mode: 0o755 }, "/workspace owned by 0:0, not by the computer's user 2510:2510"],
		[{ path: "/workspace", type: "symlink", owner: "2510:2510", mode: 0o777 }, "a symlink at /workspace, where a synced folder is a directory"],
	]) {
		const fake = fakeHost({ box: { reached: [], workspace } });
		const provider = new HostedProvider(fake.host, { daemonPath: DAEMON, timeouts: TIMEOUTS });
		const failed = await create(provider);
		assert.equal(failed.ok, false);
		assert.ok(failed.error.message.includes(`mount: declared a synced folder, epoch 3, read back ${words}`), failed.error.message);
		assert.deepEqual(fake.live(), [], "the machine is deleted");
	}
});

test("a dial machine takes a synced folder (agentrun-dial makes /workspace) and still no Archil mount", async () => {
	const dial = fakeDialHost({ daemon: DAEMON_BYTES, box: { workspace: { path: "/workspace", type: "dir", owner: "2510:2510", mode: 0o700 } } });
	const provider = dial.provider({ daemonPath: DAEMON, timeouts: TIMEOUTS });
	assert.deepEqual(provider.capabilities().mount, ["sync"]);
	assert.deepEqual(provider.check(SYNC_SPEC), []);
	made(await create(provider));
	const [info] = made(await provider.list({ "agentrun.run": "r1" }));
	assert.deepEqual(info.mount, { kind: "sync", epoch: 3 });
});
