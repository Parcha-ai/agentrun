// The boat provider (src/boat.ts) against a fake of boat's REST API and each sandbox's sshd (fake-boat.mjs): the
// descriptor and facts, every host member's calls and readbacks, the exec over SSH as the sudo user `user` with the
// host key boat answers pinned, the exec pre-check over real processes, the provider's Core conformance cases, and the
// conformance module's environment.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import { API_URL, fakeBoat, KEY } from "./fake-boat.mjs";
import { fakeHost } from "./fake-host.mjs";
import { wordsOf } from "./fake-shell.mjs";

const { BoatProvider, create, DEFAULT_API_URL } = await import("../dist/boat.js");
const { BOAT, BOAT_IMAGE } = await import("../dist/descriptors/index.js");
const { DEADLINE_LABEL } = await import("../dist/drift.js");
const { MAX_LABEL } = await import("../dist/hosted/provider.js");
const { checkExecStream, formatExecStream } = await import("../dist/conformance/exec-stream.js");
const { BOAT_ENV: ENV, settingsFromEnv, createProvider, createHost, conformanceImage, sweepScope } = await import("../dist/conformance/boat.js");

const CTX = { timeoutMs: 5_000 };
const NAME = "computer-0123456789ab";
const LABELS = { "agentrun.computer": "1", "agentrun.computer.name": NAME };
const HAS_PROC = existsSync("/proc/self/stat");
const DAY_MS = 24 * 3_600_000;
const SANDBOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const request = (more = {}) => ({ name: NAME, image: BOAT_IMAGE, labels: { ...LABELS }, lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: false, ...more });
const dir = mkdtempSync(join(tmpdir(), "computer-boat-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, Buffer.from("a stand-in for computerd, linux/amd64\n"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 2_000 };

function boatOf(t, options, more = {}) {
	const vendor = fakeBoat(options);
	t?.after(() => vendor.close());
	const provider = new BoatProvider({ apiKey: KEY, apiUrl: API_URL, fetch: vendor.fetch, ssh2, timeouts: { pollMs: 1 }, ...more });
	return { vendor, provider, host: provider.host };
}

/** A sandbox made through the host and read until boat says it runs: its id. */
async function running(host, more = {}) {
	const { id } = await host.create(request(more), CTX);
	while ((await host.get(id, CTX))?.state !== "running") await new Promise((resolve) => setImmediate(resolve));
	return id;
}

/** A whole stream's text. */
const textOf = async (stream) => Buffer.concat(await stream.toArray()).toString("utf8");

test("the descriptor: a sandbox under BOAT_API_KEY, every network form through init, no mount, boat's Ubuntu as the default; the host a VM with a vendor timer and 20 labels", () => {
	assert.equal(BOAT.id, "boat");
	assert.equal(BOAT.label, "boat");
	assert.deepEqual(BOAT.keys, [{ name: "BOAT_API_KEY", option: "apiKey", required: true }]);
	assert.deepEqual([BOAT.network, BOAT.mounts, BOAT.defaultImage, BOAT.prepareImage], [["none", "open", "allow"], [], { sandbox: "ubuntu-24.04" }, undefined]);
	const { host } = boatOf();
	assert.deepEqual(host.facts, { daemon: "child", isolation: "vm", lifetime: "vendor", maxLifetimeMs: 30 * DAY_MS, arch: "amd64", vendorAgentPorts: [22, 8911], labels: { count: 20 } });
	assert.equal(DEFAULT_API_URL, "https://boat.dev/api/v1");
	assert.throws(() => new BoatProvider({ apiKey: "", ssh2 }), /options\.apiKey, the boat API key, is required/);
	assert.throws(() => new BoatProvider({ apiKey: KEY, ssh2, apiUrl: "http://boat.dev/api/v1" }), /the boat API URL must be https/);
});

test("create posts the name, the labels as boat's map, the lifetime as ttlSeconds, no account env and no snapshots, the request's name as the Idempotency-Key, and answers boat's id", async () => {
	const { vendor, host } = boatOf();
	const { id } = await host.create(request(), CTX);
	assert.match(id, SANDBOX_ID);
	const [call] = vendor.calls;
	assert.deepEqual([call.method, call.path, call.headers.authorization, call.headers["idempotency-key"]], ["POST", "/sandboxes", `Bearer ${KEY}`, NAME]);
	assert.deepEqual(call.body, { name: NAME, labels: LABELS, ttlSeconds: 600, type: "small", noEnv: true, snapshots: false });
	await host.create(request({ name: "computer-0123456789ac", cpus: 4 }), CTX);
	assert.equal(vendor.calls.at(-1).body.type, "default", "4 vCPUs is boat's default size");
	await host.create(request({ name: "computer-0123456789ad", memoryMb: 16_384 }), CTX);
	assert.equal(vendor.calls.at(-1).body.type, "large", "16 GiB is large");
	const vendor2 = fakeBoat({ snapshots: ["my-box"] });
	const host2 = new BoatProvider({ apiKey: KEY, apiUrl: API_URL, fetch: vendor2.fetch, ssh2 }).host;
	await host2.create(request({ image: "my-box" }), CTX);
	const fromSnapshot = vendor2.calls.at(-1).body;
	assert.deepEqual([fromSnapshot.from, "type" in fromSnapshot], ["my-box", false], "a saved snapshot keeps its own size unless one is asked");
	await host2.create(request({ name: "computer-0123456789ae", image: "bsh_fakeshare01" }), CTX);
	assert.equal(vendor2.calls.at(-1).body.from, "bsh_fakeshare01", "another account's share code");
});

test("labels: the adapter's and the caller's go as boat's map, and read back exactly through the provider's list, which boat filters by label=", async (t) => {
	const { vendor, provider, host } = boatOf(t, { readyAfter: 0 });
	const labels = { ...LABELS, "agentrun.run": "run-1", "agentrun.epoch": "2", [DEADLINE_LABEL]: new Date(Date.now() + 600_000).toISOString(), "agentrun.computer.network": "none", team: "x".repeat(200) };
	const { id } = await host.create(request({ labels }), CTX);
	assert.deepEqual(vendor.sandboxes.get(id).sandbox.labels, labels);
	const listed = await provider.list({ "agentrun.run": "run-1" });
	assert.equal(listed.ok, true, JSON.stringify(listed.error));
	assert.deepEqual(listed.value.map((info) => [info.ref.id, info.labels]), [[id, labels]]);
	const asked = vendor.calls.findLast((call) => call.method === "GET" && call.path === "/sandboxes");
	assert.deepEqual([asked.query.namePrefix, asked.query.limit], ["computer-", "200"]);
	assert.ok(asked.query.label.includes("agentrun.run=run-1"), JSON.stringify(asked.query));
});

test("a create whose Idempotency-Key boat holds for another body is exists; the same body again is the same sandbox; a rate cap is a limit; a key boat refuses is denied, never echoed", async () => {
	const { host } = boatOf();
	const first = await host.create(request(), CTX);
	assert.deepEqual(await host.create(request(), CTX), first, "a retried create answers the sandbox it made");
	await assert.rejects(host.create(request({ labels: { ...LABELS, team: "other" } }), CTX), (error) => error.code === "exists" && /409: idempotency_key_reused/.test(error.message));
	const limited = boatOf(undefined, { rateLimited: true }).host;
	await assert.rejects(limited.create(request(), CTX), (error) => error.code === "limit" && /rate_limited/.test(error.message));
	const vendor = fakeBoat();
	const denied = new BoatProvider({ apiKey: "not-a-secret", apiUrl: API_URL, fetch: vendor.fetch, ssh2 }).host;
	await assert.rejects(denied.list({}, CTX), (error) => error.code === "denied" && !error.message.includes("not-a-secret"));
});

test("get reads a sandbox: provisioning and its kin are starting, ready, idle and running are running, archived is stopped, error and cancelled are gone in boat's words; another state is stopped; an id boat lacks is none", async () => {
	const { vendor, host } = boatOf();
	const { id } = await host.create(request(), CTX);
	const { sandbox } = vendor.sandboxes.get(id);
	assert.deepEqual(await host.get(id, CTX), { id, labels: LABELS, state: "starting", createdAt: new Date(sandbox.createdAt), endsAt: new Date(sandbox.archiveAfter) });
	// The fake's own reads-until-ready are spent, so each state below reads back as set.
	vendor.sandboxes.get(id).reads = Number.POSITIVE_INFINITY;
	const states = { init: "starting", provisioning: "starting", provisioned: "starting", cloning: "starting", ready: "running", idle: "running", running: "running", archiving: "stopped", archived: "stopped", error: "gone", cancelled: "gone", sinking: "stopped" };
	for (const [state, expected] of Object.entries(states)) {
		Object.assign(sandbox, { state, error: state === "error" || state === "cancelled" ? "no machine of this type" : null });
		const read = await host.get(id, CTX);
		assert.equal(read.state, expected, state);
		if (state === "error" || state === "cancelled") assert.equal(read.why, `boat reads the sandbox ${state}: no machine of this type`);
		if (state === "sinking") assert.equal(read.why, 'boat reads the state "sinking", which this provider does not know');
	}
	assert.equal(await host.get("bx_zzzzzzzz", CTX), undefined);
	const before = vendor.calls.length;
	assert.equal(await host.get("computer-0123456789ab", CTX), undefined, "an id not of boat's form is none, with no call");
	assert.equal(vendor.calls.length, before);
});

test("list asks for the computers' name prefix and the labels, every page, and keeps only the sandboxes that carry the asked labels: a listing that answers more is filtered here", async () => {
	const { vendor, host } = boatOf(undefined, { pageSize: 2, ignoresLabels: true });
	const ids = [];
	for (let i = 0; i < 4; i++) ids.push((await host.create(request({ name: `computer-00000000000${i}`, labels: { agentrun: `computer-00000000000${i}` } }), CTX)).id);
	vendor.add("computer-other00000", { agentrun: "computer-other00000", team: "x" });
	vendor.add("computer-unlabeled0");
	vendor.add("my-app", { agentrun: "computer-000000000002" });
	const one = await host.list({ agentrun: "computer-000000000002" }, CTX);
	assert.deepEqual(one.map((machine) => machine.id), [ids[2]]);
	const pages = vendor.calls.filter((call) => call.path === "/sandboxes" && call.method === "GET");
	assert.deepEqual(pages.map((call) => call.query.cursor), [undefined, "2", "4"]);
	assert.deepEqual(pages[0].query, { namePrefix: "computer-", limit: "200", label: ["agentrun=computer-000000000002"] });
	assert.equal((await host.list({}, CTX)).length, 6, "every computer- sandbox when no label is asked");
});

test("delete sends boat's confirmation header and reads back as none; an id boat no longer has is done; release deletes and waits for the readback", async () => {
	const { vendor, provider, host } = boatOf();
	const { id } = await host.create(request(), CTX);
	await host.delete(id, CTX);
	const call = vendor.calls.at(-1);
	assert.deepEqual([call.method, call.path, call.headers["x-ascii-confirm-delete"]], ["DELETE", `/sandboxes/${id}`, id]);
	assert.equal(await host.get(id, CTX), undefined);
	await host.delete(id, CTX);
	await host.delete("computer-0123456789ab", CTX);
	const made = await host.create(request({ name: "computer-0123456789ac", labels: { ...LABELS, "agentrun.computer.name": "computer-0123456789ac" } }), CTX);
	const released = await provider.release({ id: made.id, name: "computer-0123456789ac" }, "delete");
	assert.equal(released.ok, true, JSON.stringify(released.error));
	assert.equal(vendor.sandboxes.has(made.id), false);
	assert.equal(vendor.calls.at(-1).method, "GET", "the last call is the read-back after the delete");
});

test("extend patches ttlSeconds to the new end and the deadline label with the rest kept, never past the max-deadline label; with no such label nothing moves", async () => {
	const { vendor, host } = boatOf();
	const most = new Date(Date.now() + 3_600_000);
	const { id } = await host.create(request({ labels: { ...LABELS, [MAX_LABEL]: most.toISOString(), [DEADLINE_LABEL]: new Date(Date.now() + 600_000).toISOString() } }), CTX);
	const endsAt = new Date(Date.now() + 1_200_000);
	await host.extend(id, endsAt, CTX);
	const patch = vendor.calls.at(-1);
	assert.deepEqual([patch.method, patch.path], ["PATCH", `/sandboxes/${id}`]);
	assert.ok(patch.body.ttlSeconds >= 1_199 && patch.body.ttlSeconds <= 1_200, String(patch.body.ttlSeconds));
	assert.deepEqual(patch.body.labels, { ...LABELS, [MAX_LABEL]: most.toISOString(), [DEADLINE_LABEL]: endsAt.toISOString() });
	await host.extend(id, new Date(Date.now() + 7_200_000), CTX);
	assert.ok(vendor.calls.at(-1).body.ttlSeconds <= 3_600, "capped at the max-deadline label");
	const bare = await host.create(request({ name: "computer-0123456789ac" }), CTX);
	const patches = () => vendor.calls.filter((one) => one.method === "PATCH").length;
	const before = patches();
	await assert.rejects(host.extend(bare.id, endsAt, CTX), (error) => error.code === "refused" && /most it may live is unknown/.test(error.message));
	assert.equal(patches(), before, "no PATCH");
});

/** The wall clock, plus what the test has moved it on by: what the fake's auto-stop reads. */
function movedClock() {
	let moved = 0;
	return { now: () => Date.now() + moved, sleep: async (ms) => void (moved += Math.max(0, ms)) };
}

test("boat's auto-stop on the fake's clock: a sandbox posted with no ttlSeconds stops at the docs' 3600 s, one with 900 s at 900 s, and one the provider makes for 2 h runs past both, then stops at its own end", async () => {
	const clock = movedClock();
	const { vendor, host } = boatOf(undefined, { readyAfter: 0, clock });
	const post = async (body) => (await (await vendor.fetch(`${API_URL}/sandboxes`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) })).json()).sandbox.id;
	const unset = await post({ name: "my-app" });
	const short = await post({ name: "my-app-2", ttlSeconds: 900 });
	const { id } = await host.create(request({ lifetimeMs: 2 * 3_600_000 }), CTX);
	assert.equal(vendor.calls.at(-1).body.ttlSeconds, 7_200, "create sends the whole lifetime: boat's default never applies");
	const states = async () => [(await host.get(id, CTX))?.state, ...[unset, short].map((one) => vendor.sandboxes.get(one).sandbox.ttlSeconds)];
	assert.deepEqual(await states(), ["running", 3_600, 900]);
	const read = (one) => vendor.fetch(`${API_URL}/sandboxes/${one}`, { headers: { Authorization: `Bearer ${KEY}` } }).then((answer) => answer.json()).then(({ sandbox }) => sandbox.state);
	await clock.sleep(901_000);
	assert.deepEqual([await read(short), await read(unset), (await host.get(id, CTX))?.state], ["archived", "ready", "running"], "901 s on");
	await clock.sleep(2_700_000);
	assert.deepEqual([await read(unset), (await host.get(id, CTX))?.state], ["archived", "running"], "3601 s on");
	await clock.sleep(3_600_000);
	assert.equal((await host.get(id, CTX))?.state, "stopped", "past the 2 h it was made with, boat has stopped it");
	const huge = await host.create(request({ name: "computer-0123456789ac", lifetimeMs: 60 * 24 * 3_600_000 }), CTX);
	assert.ok(huge.id);
	assert.equal(vendor.calls.at(-1).body.ttlSeconds, 2_592_000, "a lifetime past boat's 30 days asks for its most");
});

test("a held computer outlives boat's 900 s and its 3600 s default on the fake's clock: the provider makes it for 2 h, its daemon answers after 901 s and 3601 s quiet, an extend PATCHes ttlSeconds past the 2 h, and lifetime.idle passes on the same clock", async (t) => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const moved = movedClock();
	const machines = fakeHost();
	const { vendor, provider } = boatOf(t, { backend: machines.host, readyAfter: 0, clock: moved }, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const hold = {
		id: "boat.hold",
		level: "core",
		group: "lifetime",
		needs: [],
		computer: "none",
		timeoutMs: 30_000,
		async run(c) {
			const labels = { ...c.runLabels, "agentrun.conformance.case": "hold" };
			const ref = await c.create({ lifetimeMs: 2 * 3_600_000, labels });
			const listed = async () => c.ok(await c.provider.list(labels), "list").map((info) => info.state);
			for (const quiet of [901_000, 2_700_000]) {
				await c.clock.sleep(quiet);
				c.deepEqual(await listed(), ["running"], `after ${quiet / 1000} s more with no call`);
				const back = await c.connect(ref);
				c.deepEqual(c.ok(await back.client.call("ping", {}), "ping"), {}, `its daemon answers ping, ${quiet / 1000} s more on`);
				await back.close();
			}
			const extended = c.ok(await c.provider.extend(ref, 3 * 3_600_000, { signal: c.signal }), "extend to 3 h from now");
			const patch = vendor.calls.findLast((call) => call.method === "PATCH");
			c.assert(patch.body.ttlSeconds > 10_000, `extend PATCHes ttlSeconds to 3 h, not ${patch.body.ttlSeconds}`);
			c.assert(extended.deadline instanceof Date, "extend answers a deadline");
			await c.clock.sleep(3_600_000);
			c.deepEqual(await listed(), ["running"], "past the 2 h it was made with, after the extend");
		},
	};
	const cases = [hold, ...conformanceCases.filter((one) => one.id === "lifetime.idle")];
	const report = await runConformance(provider, { image: BOAT_IMAGE, cases, clock: moved, long: true, caseTimeoutMs: 30_000, cleanupTimeoutMs: 5_000 });
	assert.deepEqual(
		report.results.map(({ id, status, reason }) => `${id} ${status}${reason ? `: ${reason}` : ""}`),
		["boat.hold pass", "lifetime.idle pass"],
	);
	assert.equal(vendor.sandboxes.size, 0, "every sandbox made was deleted");
});

test("exec posts this provider's own SSH key once per sandbox, logs in as boat's user with it, and runs argv as root through sudo -n: stdin, stdout, stderr and the exit code", async (t) => {
	const { vendor, host } = boatOf(t);
	const id = await running(host);
	const proc = await host.exec(id, ["sh", "-c", "cat; echo err >&2; exit 3"], CTX);
	await proc.write(Buffer.from("héllo"));
	await proc.write(Buffer.from(" world"));
	await proc.end();
	assert.deepEqual([await textOf(proc.stdout), await textOf(proc.stderr), await proc.wait()], ["héllo world", "err\n", 3]);
	const keyCalls = vendor.calls.filter((call) => call.path === `/sandboxes/${id}/sshkey`);
	assert.equal(keyCalls.length, 1);
	assert.match(keyCalls[0].body.key, /^ssh-ed25519 [A-Za-z0-9+/]+=*$/, "a public key alone");
	const again = await host.exec(id, ["id", "-u"], CTX);
	assert.equal(await again.wait(), 0);
	assert.equal(vendor.calls.filter((call) => call.path === `/sandboxes/${id}/sshkey`).length, 1, "the key is posted once");
	const lines = vendor.commands(id);
	assert.ok(lines.length >= 2 && lines.every((line) => line.startsWith("sudo -n -- sh -c ")), lines.join("\n"));
	assert.equal(vendor.sshd(id).state.denied, 0);
});

test("a character split across two SSH packets arrives whole, on stdout and on stderr", async (t) => {
	const { host } = boatOf(t);
	const id = await running(host);
	const proc = await host.exec(id, ["sh", "-c", "printf '\\303'; sleep 0.3; printf '\\251\\360\\237'; sleep 0.3; printf '\\230\\200\\r\\nend'; printf '\\360\\237' >&2; sleep 0.3; printf '\\230\\200' >&2"], CTX);
	assert.deepEqual([await textOf(proc.stdout), await textOf(proc.stderr), await proc.wait()], ["é😀\r\nend", "😀", 0]);
});

test("16 s of silence, past the 15 s in which a dead connection is noticed, is no end: the keepalives are answered, and the output after it comes on the same connection", async (t) => {
	const { vendor, host } = boatOf(t);
	const id = await running(host);
	const proc = await host.exec(id, ["sh", "-c", "sleep 16; echo late"], { timeoutMs: 30_000 });
	assert.deepEqual([await textOf(proc.stdout), await proc.wait()], ["late\n", 0]);
	assert.equal(vendor.sshd(id).state.logins, 1, "one login, never made again");
});

test("kill runs the pid kill as root through sudo -n on a channel of its own: the process is gone in the sandbox and wait answers", async (t) => {
	if (!HAS_PROC) return t.skip("no /proc here");
	const { vendor, host } = boatOf(t);
	const id = await running(host);
	const proc = await host.exec(id, ["sleep", "600"], CTX);
	await new Promise((resolve) => setTimeout(resolve, 200));
	await proc.kill();
	await proc.wait();
	const kill = vendor.commands(id).map((line) => wordsOf(line)).find((words) => words[3] === "sh" && words[4] === "-c" && words[5].startsWith("pid=$1 start=$2"));
	assert.ok(kill, vendor.commands(id).join("\n"));
	assert.deepEqual(kill.slice(0, 3), ["sudo", "-n", "--"]);
	assert.throws(() => process.kill(Number(kill[7]), 0), { code: "ESRCH" }, "the sleep is gone");
});

test("the host key boat answers is pinned: an sshd with another is refused in words, and the next exec asks boat again; an answer with no host key is refused", async (t) => {
	const { vendor, host } = boatOf(t, { hostKey: "other" });
	const id = await running(host);
	await assert.rejects(host.exec(id, ["true"], CTX), (error) => error.code === "denied" && /host key/.test(error.message));
	assert.equal(vendor.sshd(id).state.logins, 0, "no login on an sshd whose key is not the pinned one");
	await assert.rejects(host.exec(id, ["true"], CTX), (error) => error.code === "denied");
	assert.equal(vendor.calls.filter((call) => call.path === `/sandboxes/${id}/sshkey`).length, 2, "a refused host key is asked for again");
	const bare = boatOf(t, { hostKey: "none" });
	const other = await running(bare.host);
	await assert.rejects(bare.host.exec(other, ["true"], CTX), (error) => error.code === "vendor" && /no host key/.test(error.message));
});

test("an sshkey answer with no sshUser, as boat's schema allows, logs in as the docs' user `user`", async (t) => {
	const { vendor, host } = boatOf(t, { sshUser: false });
	const id = await running(host);
	const proc = await host.exec(id, ["true"], CTX);
	assert.equal(await proc.wait(), 0);
	assert.deepEqual([vendor.sshd(id).state.logins > 0, vendor.sshd(id).state.denied], [true, 0]);
});

test("an exec on an id boat lacks is not_found, and so is one of another form, before any call", async () => {
	const { vendor, host } = boatOf();
	await assert.rejects(host.exec("bx_zzzzzzzz", ["true"], CTX), (error) => error.code === "not_found");
	const before = vendor.calls.length;
	await assert.rejects(host.exec("computer-0123456789ab", ["true"], CTX), (error) => error.code === "not_found" && /not a boat sandbox id/.test(error.message));
	assert.equal(vendor.calls.length, before);
});

test("check takes boat's Ubuntu, a saved snapshot's name or a share code, and a size boat has; another image, a size boat lacks, or a label boat refuses is refused before any call", () => {
	const { vendor, provider } = boatOf();
	const spec = { lifetimeMs: 600_000, network: "none" };
	for (const image of [BOAT_IMAGE, "my-box", "bsh_fakeshare01"]) assert.deepEqual(provider.check({ ...spec, image }), [], image);
	for (const size of [{ cpus: 2 }, { cpus: 16, memoryMb: 32_768 }, { memoryMb: 8_192 }]) assert.deepEqual(provider.check({ ...spec, image: BOAT_IMAGE, ...size }), [], JSON.stringify(size));
	assert.deepEqual(provider.check({ ...spec, image: "ghcr.io/parcha-ai/agentrun-box:abc" }).map((one) => one.field), ["image"]);
	assert.deepEqual(provider.check({ ...spec, image: BOAT_IMAGE, cpus: 3 }).map((one) => one.field), ["cpus"]);
	assert.deepEqual(provider.check({ ...spec, image: BOAT_IMAGE, cpus: 32 }).map((one) => one.field), ["cpus"]);
	assert.deepEqual(provider.check({ ...spec, image: BOAT_IMAGE, cpus: 4, memoryMb: 4_096 }).map((one) => one.field), ["memoryMb"]);
	assert.deepEqual(provider.check({ ...spec, image: BOAT_IMAGE, memoryMb: 6_000 }).map((one) => one.field), ["memoryMb"]);
	assert.deepEqual(provider.check({ ...spec, image: BOAT_IMAGE, labels: { "bad key": "x" } }).map((one) => one.field), ["labels"]);
	assert.deepEqual(provider.check({ ...spec, image: BOAT_IMAGE, labels: { team: "é".repeat(129) } }).map((one) => one.field), ["labels"]);
	assert.deepEqual(provider.check({ ...spec, image: BOAT_IMAGE, network: { allow: Array.from({ length: 30 }, (_, at) => `host-${at}.example.com`) } }).map((one) => one.field), ["network"]);
	assert.equal(vendor.calls.length, 0);
});

test("the exec passes every check of the exec pre-check, over real processes behind boat's sshd, as root through sudo", async (t) => {
	if (!HAS_PROC) return t.skip("no /proc here");
	const { host } = boatOf(t);
	const id = await running(host);
	const report = await checkExecStream(host, id, { longMs: 2_000, stepMs: 5_000, largeBytes: 1024 * 1024, largeMs: 30_000, unreadMs: 1_000 });
	assert.equal(report.pass, true, formatExecStream(report));
});

test("the provider's Core conformance cases pass through boat's REST calls and SSH, the daemon uploaded through stdin, and leave nothing behind", async (t) => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const cases = conformanceCases.filter((one) => one.group === "provider" && one.level === "core" && one.id !== "provider.deadline");
	const machines = fakeHost();
	const { vendor, provider } = boatOf(t, { backend: machines.host, readyAfter: 0 }, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const report = await runConformance(provider, { image: BOAT_IMAGE, cases, caseTimeoutMs: 20_000, cleanupTimeoutMs: 5_000 });
	assert.ok(report.results.length >= 3, report.results.map(({ id }) => id).join(" "));
	assert.deepEqual(
		report.results.filter(({ status }) => status !== "pass").map(({ id, status, reason }) => `${id} ${status}: ${reason}`),
		[],
	);
	assert.deepEqual(report.cleanup.sweep.stillThere, []);
	assert.equal(vendor.sandboxes.size, 0, "every sandbox made was deleted");
	assert.ok(machines.uploads.length > 0 && machines.uploads.every(({ through }) => through === "exec"), "the daemon went through the SSH channel's stdin");
});

test("the conformance module reads COMPUTER_BOAT_* alone, after its live switch; the sweep's host needs none and its scope never shows the key", async () => {
	assert.throws(() => settingsFromEnv({ BOAT_API_KEY: KEY }), (error) => /set COMPUTER_BOAT_API_KEY/.test(error.message) && !error.message.includes(KEY));
	const env = { [ENV.key]: KEY };
	assert.deepEqual(settingsFromEnv(env), { apiKey: KEY });
	assert.deepEqual(settingsFromEnv({ ...env, [ENV.apiUrl]: API_URL, [ENV.daemon]: DAEMON_PATH }), { apiKey: KEY, apiUrl: API_URL, daemonPath: DAEMON_PATH });
	await assert.rejects(createProvider({ env }), /set AGENTRUN_COMPUTER_LIVE_BOAT=1/);
	assert.equal((await createProvider({ env: { ...env, [ENV.live]: "1" } })).capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal((await createHost({ env })).descriptor.id, "boat");
	assert.equal(await conformanceImage({ env: {} }), BOAT_IMAGE);
	assert.match(sweepScope({ env }), /the boat account of the key sha256:[0-9a-f]{12} at https:\/\/boat\.dev\/api\/v1/);
	assert.doesNotMatch(sweepScope({ env }), new RegExp(KEY));
	assert.equal((await create({ apiKey: KEY })).host.descriptor.label, "boat");
});
