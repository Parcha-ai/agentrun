// InstaboxProvider's host on a fake InstaBox (fake-instabox.mjs): the REST API as a fetch in the OpenAPI's shapes, and
// the SSH gateway as ssh2's own Server on loopback, taking a minted token as the username with no key. What InstaBox's
// host decides is tested here: the create's body and headers, the labels packed into metadata, get's states, list's
// filter, delete's confirmation and read-back, the error codes, the SSH token and the host-key pin, an exec's frames,
// silence and kill through the gateway, check()'s refusals, the exec pre-check, and the provider's Core conformance
// cases. The adapter's lifecycle is tested once, against its fake host (hosted-provider.test.mjs); InstaBox's own is
// proven live.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as registry from "../dist/providers.js";
import { keyPair, fingerprintOf } from "./fake-agent37.mjs";
import { fakeHost } from "./fake-host.mjs";
import { API_URL, fakeInstabox, fakeRest, KEY } from "./fake-instabox.mjs";

const { InstaboxProvider, create, accountOf } = await import("../dist/instabox.js");
const { INSTABOX, INSTABOX_IMAGE } = await import("../dist/descriptors/index.js");
const { packLabels, unpackLabels } = await import("../dist/hosted/values.js");
const { checkExecStream, formatExecStream } = await import("../dist/conformance/exec-stream.js");
const conformanceModule = await import("../dist/conformance/instabox.js");
const { INSTABOX_ENV: ENV, settingsFromEnv, sweepScope } = conformanceModule;

const CTX = { timeoutMs: 10_000 };
const NAME = "computer-0123456789ab";
const LABELS = { "agentrun.computer": "1", "agentrun.computer.name": NAME };
const HAS_PROC = existsSync("/proc/self/stat");
const DAY_MS = 24 * 3_600_000;
const BARE = "not-a-secret-bare-instabox-key";
const backstop = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();
const request = (more = {}) => ({ name: NAME, image: "minimal", labels: { agentrun: NAME }, lifetimeMs: 600_000, backstopAt: backstop(), egress: false, ...more });
const dir = mkdtempSync(join(tmpdir(), "computer-instabox-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, Buffer.from("a stand-in for computerd, linux/amd64\n"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const TIMEOUTS = { requestMs: 5_000, createMs: 5_000, uploadMs: 5_000, execMs: 5_000, helloMs: 2_000, probeMs: 2_000, listMs: 5_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 5_000 };

/** A REST-only provider: no gateway, nothing over SSH. */
function restOnly(restOptions = {}, more = {}) {
	const rest = fakeRest(restOptions);
	const provider = new InstaboxProvider({ apiKey: KEY, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL, timeouts: { pollMs: 1 }, ...more });
	return { rest, provider, host: provider.host };
}

/** A provider on the fake REST API and gateway; the gateway is closed after the test. */
async function setup(t, fakeOptions = {}, more = {}) {
	const fake = await fakeInstabox(fakeOptions);
	t.after(() => fake.sshd.close());
	const provider = new InstaboxProvider({ ...fake.options, timeouts: { pollMs: 1 }, ...more });
	return { fake, rest: fake.rest, provider, host: provider.host };
}

/** A machine made and read once, so it runs: the adapter polls get the same way before its first exec. */
async function running(host, more = {}) {
	const { id } = await host.create(request(more), CTX);
	assert.equal((await host.get(id, CTX)).state, "starting");
	assert.equal((await host.get(id, CTX)).state, "running");
	return id;
}

/** Runs argv to its end: its exit code, stdout and stderr. */
async function run(host, id, argv, input) {
	const proc = await host.exec(id, argv, CTX);
	const out = [];
	const err = [];
	const reading = Promise.all([
		(async () => {
			for await (const chunk of proc.stdout) out.push(Buffer.from(chunk));
		})(),
		(async () => {
			for await (const chunk of proc.stderr) err.push(Buffer.from(chunk));
		})(),
	]);
	if (input !== undefined) await proc.write(Buffer.from(input));
	await proc.end();
	const code = await proc.wait();
	await reading;
	return { code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function until(check, ms = 5_000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// --- what it declares ---

test("the descriptor: a sandbox under INSTABOX_API_KEY, every network form through init, no mount, the minimal template as the default; the host a janitor's microVM with packed labels and sshd's port", () => {
	assert.equal(INSTABOX.id, "instabox");
	assert.equal(INSTABOX.label, "InstaBox");
	assert.deepEqual(INSTABOX.keys, [{ name: "INSTABOX_API_KEY", option: "apiKey", required: true }]);
	assert.deepEqual([INSTABOX.network, INSTABOX.mounts, INSTABOX.defaultImage, INSTABOX.prepareImage, INSTABOX.metered], [["none", "open", "allow"], [], { sandbox: "minimal" }, undefined, true]);
	assert.equal(INSTABOX_IMAGE, "minimal");
	const { host, provider } = restOnly();
	assert.deepEqual(host.facts, { daemon: "child", isolation: "microvm", lifetime: "janitor", maxLifetimeMs: DAY_MS - 300_000, arch: "amd64", vendorAgentPorts: [22], labels: { count: 32, bytes: 7_999, packed: { valueBytes: 512 } } });
	const caps = provider.capabilities();
	assert.deepEqual([caps.kind, caps.daemon, caps.lifetime, caps.isolation], ["linux", "child", "janitor", "microvm"]);
	assert.equal(typeof host.upload, "undefined", "no upload: InstaBox's file API writes as the machine's user, not root");
	assert.equal(typeof host.extend, "undefined", "no extend: the backstop is the delete timer set at create");
});

test("the provider takes the key as an option, checks ssh2, fetch, the API URL and the daemon user, and never echoes the key", async () => {
	const ssh2 = { Client: class {} };
	await assert.rejects(create({ ssh2 }), /options\.apiKey, the InstaBox API key, is required/);
	assert.throws(() => new InstaboxProvider({ apiKey: KEY, ssh2: {} }), /ssh2 package/);
	assert.throws(() => new InstaboxProvider({ apiKey: KEY, ssh2, fetch: "no" }), /options\.fetch/);
	assert.throws(() => new InstaboxProvider({ apiKey: KEY, ssh2, apiUrl: "http://api.instabox.sh" }), /must be https/);
	assert.throws(() => new InstaboxProvider({ apiKey: KEY, ssh2, daemonUser: "1000:1000" }), /uid of the machine's own user/);
	assert.ok(new InstaboxProvider({ apiKey: KEY, ssh2, daemonUser: "2510:2510" }));
	try {
		new InstaboxProvider({ apiKey: KEY, ssh2: {} });
	} catch (error) {
		assert.doesNotMatch(error.message, new RegExp(KEY));
	}
});

// --- create, labels, get, list, delete ---

test("create posts the name, the template, the packed labels as metadata, the delete timer at the backstop, no idle pause, no maximum run, no vault, under an Idempotency-Key of this request; it answers the machine id", async () => {
	const { rest, host } = restOnly();
	const at = backstop(3_600_000);
	const { id } = await host.create(request({ backstopAt: at }), CTX);
	assert.match(id, /^m_[a-z0-9]{26}$/);
	const [call] = rest.calls;
	assert.deepEqual([call.method, call.path], ["POST", "/v1/machines"]);
	assert.equal(call.headers["X-API-Key"], KEY);
	assert.equal(call.headers["Idempotency-Key"], `agentrun-${NAME}-${at}`);
	const { deleteAfterSeconds, ...body } = call.body;
	assert.deepEqual(body, { name: NAME, templateId: "minimal", metadata: { agentrun: NAME }, autoSuspendAfterSeconds: 0, maxRunMinutes: -1, vault: false, secrets: [] });
	assert.ok(deleteAfterSeconds >= 3_598 && deleteAfterSeconds <= 3_600, String(deleteAfterSeconds));
	// A size: the vCPUs and the memory; one alone takes the other's match.
	await host.create(request({ name: "computer-000000000001", cpus: 4, memoryMb: 8192 }), CTX);
	await host.create(request({ name: "computer-000000000002", cpus: 8 }), CTX);
	await host.create(request({ name: "computer-000000000003", memoryMb: 4096 }), CTX);
	assert.deepEqual(rest.calls.slice(1).map(({ body }) => [body.vcpus, body.memMiB]), [[4, 8192], [8, 16384], [2, 4096]]);
	// A snapshot's id is a snapshot; the delete timer stays within InstaBox's 60 s to a day.
	await host.create(request({ name: "computer-000000000004", image: "sn_abc123", backstopAt: backstop(2 * DAY_MS) }), CTX);
	await host.create(request({ name: "computer-000000000005", backstopAt: backstop(5_000) }), CTX);
	const [snapshot, short] = rest.calls.slice(-2).map(({ body }) => body);
	assert.deepEqual([snapshot.snapshotId, snapshot.templateId, snapshot.deleteAfterSeconds, short.deleteAfterSeconds], ["sn_abc123", undefined, 86_400, 60]);
});

test("a create sent again on no answer goes under the same Idempotency-Key, so InstaBox makes one machine", async () => {
	const { rest, host } = restOnly();
	rest.fail("POST", /^\/v1\/machines$/, () => json(503, { error: { code: "unavailable", message: "try again" } }));
	const { id } = await host.create(request(), CTX);
	const posts = rest.calls.filter((call) => call.method === "POST");
	assert.equal(posts.length, 2);
	assert.equal(posts[0].headers["Idempotency-Key"], posts[1].headers["Idempotency-Key"]);
	assert.deepEqual([...rest.machines.keys()], [id]);
});

test("labels: the adapter's and the caller's go packed into metadata InstaBox takes (keys of its form, values of 512 bytes at most, 8 KiB as JSON), and read back exactly through the provider's list", async () => {
	const { rest, provider, host } = restOnly();
	const noise = Array.from({ length: 1_200 }, (_, at) => ((at * 7_919) % 9_973).toString(36)).join("");
	const labels = { ...LABELS, "agentrun.run": "run-1", "agentrun.epoch": "2", "agentrun.computer.deadline": new Date(Date.now() + 600_000).toISOString(), "agentrun.computer.network": "none", "team/owner": "x".repeat(200), noise };
	const packed = packLabels(labels, NAME, host.facts.labels);
	assert.equal(packed.problem, undefined);
	assert.ok(Object.keys(packed.labels).length > 2, "the labels take more than one part");
	const { id } = await host.create(request({ labels: packed.labels }), CTX);
	const stored = rest.machines.get(id).machine.metadata;
	assert.ok(Object.keys(stored).every((key) => /^[A-Za-z0-9_.-]{1,64}$/.test(key)), Object.keys(stored).join(" "));
	assert.ok(Object.values(stored).every((value) => Buffer.byteLength(value) <= 512));
	assert.ok(JSON.stringify(stored).length <= 8_192);
	assert.deepEqual(unpackLabels(stored), labels);
	// Read once, so it runs: a computer still starting is not listed.
	await host.get(id, CTX);
	const listed = await provider.list({ "agentrun.run": "run-1" });
	assert.equal(listed.ok, true, JSON.stringify(listed.error));
	assert.deepEqual(listed.value.map((info) => [info.ref.id, info.labels]), [[id, labels]]);
	// The facts' room is InstaBox's: at the byte bound, compact JSON is 8 KiB at most.
	const most = Object.fromEntries(Array.from({ length: 31 }, (_, at) => [`p${at}`, "x".repeat(Math.floor((7_999 - "agentrun".length - NAME.length) / 31) - `p${at}`.length)]));
	assert.ok(JSON.stringify({ agentrun: NAME, ...most }).length <= 8_192);
});

test("a create of a name the account holds is exists (unverified until the live run: InstaBox's 409); a cap is a limit; a plan that refuses no idle pause is refused in words; a key InstaBox refuses is denied, never echoed", async () => {
	const { host } = restOnly();
	await host.create(request(), CTX);
	await assert.rejects(host.create(request({ backstopAt: backstop(7_200_000) }), CTX), (error) => error.code === "exists" && /409 conflict/.test(error.message));
	for (const [status, code] of [[429, "rate_limited"], [429, "concurrency_limit"], [402, "quota_exceeded"], [503, "no_capacity"], [409, "machine_cooldown"]]) {
		const { rest, host: one } = restOnly();
		for (let at = 0; at < 4; at++) rest.fail("POST", /^\/v1\/machines$/, () => json(status, { error: { code, message: "not now" } }));
		await assert.rejects(one.create(request(), CTX), (error) => error.code === "limit" && error.message.includes(code), code);
	}
	const free = restOnly({ plan: "free" }).host;
	await assert.rejects(free.create(request(), CTX), (error) => error.code === "refused" && /spec_not_allowed/.test(error.message) && /paid plan/.test(error.message));
	const scoped = restOnly();
	scoped.rest.fail("GET", /^\/v1\/machines$/, () => json(403, { error: { code: "missing_scope", message: "the key lacks machines:read" } }));
	await assert.rejects(scoped.host.list({}, CTX), (error) => error.code === "denied" && /missing_scope/.test(error.message));
	const rest = fakeRest();
	const denied = new InstaboxProvider({ apiKey: BARE, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL }).host;
	await assert.rejects(denied.list({}, CTX), (error) => error.code === "denied" && !error.message.includes(BARE));
});

test("get reads a machine by id: creating, starting and resuming are starting, running is running once ready, a paused one stopped, deleting and error gone in InstaBox's words; a 404 or a deleted record is none", async () => {
	const { rest, host } = restOnly();
	const { id } = await host.create(request(), CTX);
	const { machine } = rest.machines.get(id);
	const read = await host.get(id, CTX);
	assert.deepEqual(read, { id, labels: { agentrun: NAME }, state: "starting", createdAt: new Date(machine.createdAt), resources: { cpus: 4, memoryMb: 8192, diskGb: 20 } });
	const states = { creating: "starting", starting: "starting", resuming: "starting", running: "running", stopping: "stopped", stopped: "stopped", suspending: "stopped", suspended: "stopped", deleting: "gone", error: "gone", rebooting: "stopped" };
	for (const [state, want] of Object.entries(states)) {
		Object.assign(machine, { state, runtime: { ready: true }, lastError: state === "error" ? { code: "boot_failed", message: "the guest did not boot" } : null });
		const one = await host.get(id, CTX);
		assert.equal(one.state, want, state);
		if (state === "error") assert.match(one.why, /in error: boot_failed: the guest did not boot/);
		if (state === "rebooting") assert.match(one.why, /"rebooting", which this provider does not know/);
	}
	Object.assign(machine, { state: "running", runtime: { ready: false } });
	assert.equal((await host.get(id, CTX)).state, "starting", "running but not ready is starting");
	machine.state = "deleted";
	assert.equal(await host.get(id, CTX), undefined, "a kept record of a machine deleted is none");
	assert.equal(await host.get("m_ffffffffffffffffffffffffff", CTX), undefined);
	await assert.rejects(host.get("../v1/orgs", CTX), (error) => error.code === "not_found");
	await assert.rejects(host.exec("not-an-id", ["true"], CTX), (error) => error.code === "not_found");
});

test("list asks for each label as a metadata filter, every page, and keeps only the machines that carry the asked labels: a listing that answers more is filtered here, and a deleted record is left out", async () => {
	const { rest, host } = restOnly({ pageSize: 2, ignoreFilter: true });
	const ids = [];
	for (let i = 0; i < 4; i++) ids.push((await host.create(request({ name: `computer-00000000000${i}`, labels: { agentrun: `computer-00000000000${i}` } }), CTX)).id);
	rest.machines.get(ids[3]).machine.state = "deleted";
	const one = await host.list({ agentrun: "computer-000000000002" }, CTX);
	assert.deepEqual(one.map((machine) => machine.id), [ids[2]]);
	const pages = rest.calls.filter((call) => call.path === "/v1/machines" && call.method === "GET");
	assert.deepEqual(pages.map((call) => call.query.cursor), [undefined, "2"]);
	assert.deepEqual(pages.map((call) => call.metadata), [["agentrun:computer-000000000002"], ["agentrun:computer-000000000002"]]);
	assert.equal(pages[0].query.limit, "100");
	assert.deepEqual((await host.list({}, CTX)).map((machine) => machine.id), ids.slice(0, 3), "every machine when no label is asked, the deleted one left out");
});

test("delete confirms by the id under a fresh Idempotency-Key, waits out another operation (409 operation_conflict), and reads back as none; a machine InstaBox no longer has is done; release deletes and waits for the read-back", async () => {
	const { rest, host } = restOnly({ busyDeletes: 2, deletingReads: 0 });
	const { id } = await host.create(request({ labels: packLabels(LABELS, NAME, host.facts.labels).labels }), CTX);
	await host.delete(id, CTX);
	const deletes = rest.calls.filter((call) => call.method === "DELETE");
	assert.equal(deletes.length, 3, "two refused while the create's operation ran, then the delete");
	assert.ok(deletes.every((call) => call.path === `/v1/machines/${id}` && call.headers["X-Confirm-Delete"] === id));
	assert.equal(new Set(deletes.map((call) => call.headers["Idempotency-Key"])).size, 3, "each delete its own key");
	assert.equal((await host.get(id, CTX)).state, "gone", "deleting reads gone");
	assert.equal(await host.get(id, CTX), undefined);
	await host.delete(id, CTX);
	assert.equal(rest.calls.at(-1).method, "DELETE", "a delete of a machine gone is done");
	const kept = restOnly({ keepDeleted: true, deletingReads: 0 });
	const made = await kept.host.create(request({ labels: packLabels(LABELS, NAME, kept.host.facts.labels).labels }), CTX);
	const released = await kept.provider.release({ id: made.id, name: NAME }, "delete");
	assert.equal(released.ok, true, JSON.stringify(released.error));
	assert.equal(kept.rest.machines.get(made.id).machine.state, "deleted");
	assert.equal(kept.rest.calls.at(-1).method, "GET", "the last call is the read-back after the delete");
	// An operation that never ends is a timeout within the call's bound, in words.
	const stuck = restOnly({ busyDeletes: 100 });
	const other = await stuck.host.create(request(), CTX);
	await assert.rejects(stuck.host.delete(other.id, { timeoutMs: 1_500 }), (error) => error.code === "timeout" && /another operation runs on it/.test(error.message));
});

// --- exec over SSH ---

test("exec mints one SSH token for the machine, logs in as the token alone with no key, the gateway's host key pinned, and runs argv with stdin, stdout, stderr and the exit code", async (t) => {
	const { fake, rest, host } = await setup(t);
	const id = await running(host);
	const [a, b] = await Promise.all([run(host, id, ["sh", "-c", "cat; echo err >&2; exit 3"], "héllo"), run(host, id, ["echo", "two"])]);
	assert.deepEqual(a, { code: 3, stdout: "héllo", stderr: "err\n" });
	assert.deepEqual(b, { code: 0, stdout: "two\n", stderr: "" });
	const mints = rest.calls.filter((call) => call.path.endsWith("/ssh-tokens"));
	assert.equal(mints.length, 1, "two execs at once mint one token");
	assert.deepEqual([mints[0].path, mints[0].body], [`/v1/machines/${id}/ssh-tokens`, { name: "agentrun", ttlSeconds: 86_400 }]);
	const [token] = rest.tokens.keys();
	assert.ok(fake.gateway.logins.length > 0 && fake.gateway.logins.every((login) => login.username === token && login.method === "none"), JSON.stringify(fake.gateway.logins));
	assert.ok(!JSON.stringify(fake.gateway.logins).includes(KEY), "the API key never goes over SSH");
});

test("a gateway whose host key is not the one the token names is refused before any login: the token never reaches it", async (t) => {
	const { fake, rest, host } = await setup(t);
	const id = await running(host);
	rest.gateway.fingerprint = fingerprintOf(keyPair().public);
	await assert.rejects(host.exec(id, ["true"], CTX), (error) => /verification failed/.test(error.message));
	assert.deepEqual(fake.gateway.logins, []);
});

test("a token answer is held to its form before ssh2 or a socket sees it: no fingerprint, a host or port that is none, or another token form fail in words", async (t) => {
	const { rest, host } = await setup(t);
	const id = await running(host);
	const good = { id: "cn_x", name: "agentrun", machineId: id, host: "127.0.0.1", port: 2222, token: "ibssh_abc", command: "", hostKeyFingerprint: `SHA256:${"A".repeat(43)}` };
	for (const [bad, words] of [
		[{ hostKeyFingerprint: undefined }, /no host key fingerprint/],
		[{ hostKeyFingerprint: "MD5:aa:bb" }, /no host key fingerprint/],
		[{ host: "evil.example -oProxyCommand=x" }, /gateway that is no host name/],
		[{ port: 70_000 }, /no TCP port/],
		[{ token: "ibssh_ABC;rm" }, /no SSH token of InstaBox's form/],
	]) {
		rest.fail("POST", /\/ssh-tokens$/, () => json(201, { ...good, ...bad }));
		await assert.rejects(host.exec(id, ["true"], CTX), (error) => error.code === "vendor" && words.test(error.message), JSON.stringify(bad));
	}
	assert.deepEqual(await run(host, id, ["echo", "ok"]), { code: 0, stdout: "ok\n", stderr: "" }, "a good answer after them works");
});

test("a token the gateway refuses (revoked) is let go and another minted, and the exec runs on it", async (t) => {
	const { fake, rest, host } = await setup(t);
	const id = await running(host);
	assert.equal((await run(host, id, ["true"])).code, 0);
	const [old] = rest.tokens.keys();
	rest.tokens.clear();
	fake.sshd.dropAll();
	assert.deepEqual(await run(host, id, ["echo", "again"]), { code: 0, stdout: "again\n", stderr: "" });
	assert.equal(rest.calls.filter((call) => call.path.endsWith("/ssh-tokens")).length, 2);
	assert.ok(fake.gateway.logins.some((login) => login.username === old && login.method === "none"), "the old token was tried");
	assert.notEqual([...rest.tokens.keys()][0], old);
});

test("an exec on a machine InstaBox no longer has is not_found: its token mint answers 404", async (t) => {
	const { host } = await setup(t);
	await assert.rejects(host.exec("m_ffffffffffffffffffffffffff", ["true"], CTX), (error) => error.code === "not_found");
});

test("a character split across two SSH data frames arrives whole, on stdout and on stderr", async (t) => {
	const { fake, host } = await setup(t);
	const id = await running(host);
	const text = "é😀ü\r\nend";
	fake.gateway.script = (command, stream) => {
		if (!command.includes("split")) return false;
		void (async () => {
			// The pid wrapper's line first, as its sh writes it.
			stream.stderr.write("4242 4243\n");
			for (const byte of Buffer.from(text)) {
				stream.write(Buffer.from([byte]));
				await new Promise((resolve) => setImmediate(resolve));
			}
			for (const piece of [[0xf0], [0x9f, 0x98], [0x80]]) {
				stream.stderr.write(Buffer.from(piece));
				await new Promise((resolve) => setImmediate(resolve));
			}
			stream.exit(0);
			stream.end();
		})();
		return true;
	};
	const proc = await host.exec(id, ["split"], CTX);
	await proc.end();
	const [out, err] = await Promise.all([proc.stdout.toArray(), proc.stderr.toArray()]);
	assert.ok(out.length > 1, "the output came in more than one frame");
	assert.equal(await proc.wait(), 0);
	assert.equal(Buffer.concat(out).toString("utf8"), text);
	assert.equal(Buffer.concat(err).toString("utf8"), "😀", "the pid line is the adapter's; past it, the split character");
});

test("16 s of silence on an exec's channel is no end, past ssh2's keepalive bound (5 s × 3): the process still runs on the same connection, and its output after it comes, then the exit", { timeout: 60_000 }, async (t) => {
	const { fake, host } = await setup(t);
	const id = await running(host);
	const logins = fake.sshd.state.logins;
	assert.deepEqual(await run(host, id, ["sh", "-c", "sleep 16; echo late"]), { code: 0, stdout: "late\n", stderr: "" });
	assert.equal(fake.sshd.state.logins, logins + 1, "one connection, never opened again");
});

test("kill ends the process and every process under it, and wait answers -1; a kill after the end is nothing", async (t) => {
	const { host } = await setup(t);
	const id = await running(host);
	const proc = await host.exec(id, ["sh", "-c", "sleep 300 & echo $!; sleep 301 & echo $!; wait"], CTX);
	await proc.end();
	let text = "";
	const reading = (async () => {
		for await (const chunk of proc.stdout) text += chunk;
	})();
	(async () => {
		for await (const _ of proc.stderr);
	})();
	assert.ok(await until(() => text.trim().split("\n").filter(Boolean).length === 2), "the sleeps started");
	const pids = text.trim().split("\n").map(Number);
	assert.ok(pids.every(alive));
	await proc.kill();
	assert.equal(await proc.wait(), -1);
	await reading;
	assert.ok(await until(() => !pids.some(alive)), "every sleep is gone");
	const done = await host.exec(id, ["true"], CTX);
	await done.end();
	(async () => {
		for await (const _ of done.stdout);
	})();
	(async () => {
		for await (const _ of done.stderr);
	})();
	assert.equal(await done.wait(), 0);
	await done.kill();
});

test("delete ends the machine's SSH connections and lets its token go: a later exec mints anew, and InstaBox has no machine to mint for (not_found)", async (t) => {
	const { fake, rest, host } = await setup(t);
	const id = await running(host);
	assert.equal((await run(host, id, ["true"])).code, 0);
	assert.ok(fake.sshd.state.live > 0);
	await host.delete(id, CTX);
	assert.ok(await until(() => fake.sshd.state.live === 0), "the connection closed");
	await assert.rejects(host.exec(id, ["true"], CTX), (error) => error.code === "not_found");
	assert.equal(rest.calls.filter((call) => call.path.endsWith("/ssh-tokens")).length, 2);
});

// --- check, the pre-check, conformance ---

test("check takes a template id, a snapshot's name or id, and a size InstaBox offers; another image, a size not offered, or a memory not 2048 MB a vCPU is refused before any call", () => {
	const { rest, provider } = restOnly();
	const spec = { lifetimeMs: 600_000, network: "none" };
	for (const image of ["minimal", "agent-browser", "universal", "sn_01abc", "my-snapshot_2"]) assert.deepEqual(provider.check({ ...spec, image }), [], image);
	for (const image of ["ghcr.io/parcha-ai/agentrun-box:abc", "Minimal", "a b", "-x"]) assert.deepEqual(provider.check({ ...spec, image }).map((one) => one.field), ["image"], image);
	for (const [cpus, memoryMb] of [[2, 4096], [4, undefined], [undefined, 16384], [32, 65536]]) assert.deepEqual(provider.check({ ...spec, image: "minimal", cpus, memoryMb }), [], `${cpus}/${memoryMb}`);
	assert.deepEqual(provider.check({ ...spec, image: "minimal", cpus: 3 }).map((one) => one.field), ["cpus"]);
	assert.deepEqual(provider.check({ ...spec, image: "minimal", cpus: 64 }).map((one) => one.field), ["cpus"]);
	assert.deepEqual(provider.check({ ...spec, image: "minimal", cpus: 4, memoryMb: 4096 }).map((one) => one.field), ["memoryMb"]);
	assert.deepEqual(provider.check({ ...spec, image: "minimal", memoryMb: 3000 }).map((one) => one.field), ["memoryMb"]);
	assert.match(provider.check({ ...spec, image: "minimal", cpus: 3 })[0].message, /2 vCPUs with 4096 MB/);
	assert.equal(rest.calls.length, 0);
});

test("the exec passes every check of the exec pre-check, over real processes behind the gateway", { timeout: 120_000 }, async (t) => {
	if (!HAS_PROC) return t.skip("no /proc here");
	const { host } = await setup(t);
	const id = await running(host);
	const report = await checkExecStream(host, id, { longMs: 2_000, stepMs: 10_000, largeBytes: 1024 * 1024, largeMs: 30_000, unreadMs: 1_000 });
	assert.equal(report.pass, true, formatExecStream(report));
});

test("the provider's Core conformance cases pass through the InstaBox REST calls and the SSH gateway, the daemon uploaded through stdin, and leave nothing behind", { timeout: 120_000 }, async (t) => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const cases = conformanceCases.filter((one) => one.group === "provider" && one.level === "core" && one.id !== "provider.deadline");
	const machines = fakeHost();
	const { rest, provider } = await setup(t, { backend: machines.host, deletingReads: 0 }, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const report = await runConformance(provider, { image: "minimal", cases, caseTimeoutMs: 30_000, cleanupTimeoutMs: 10_000 });
	assert.ok(report.results.length >= 3, report.results.map(({ id }) => id).join(" "));
	assert.deepEqual(
		report.results.filter(({ status }) => status !== "pass").map(({ id, status, reason }) => `${id} ${status}: ${reason}`),
		[],
	);
	assert.deepEqual(report.cleanup.sweep.stillThere, []);
	assert.equal(rest.machines.size, 0, "every machine made was deleted");
	assert.ok(machines.uploads.length > 0 && machines.uploads.every(({ through }) => through === "exec"), "the daemon went through the exec's stdin");
});

// --- the registry and the conformance module ---

test("the registry builds InstaBox from its options alone, and its source reads no environment and writes nowhere", async () => {
	const rest = fakeRest();
	const provider = await registry.providerFor("instabox", { apiKey: KEY, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL });
	assert.equal(provider.id, "instabox");
	assert.deepEqual(rest.calls, []);
	const source = readFileSync(new URL("../dist/instabox.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /process\.env/);
	assert.doesNotMatch(source, /COMPUTER_INSTABOX_/);
	assert.doesNotMatch(source, /\bconsole\.|process\.(stdout|stderr)/);
	assert.doesNotMatch(source, /^\s*import\s[^(]*from\s+["']ssh2["']/m, "no static import of ssh2");
	assert.equal(accountOf(KEY), accountOf(KEY, "https://api.instabox.sh/"));
	assert.doesNotMatch(accountOf(KEY), new RegExp(KEY));
});

test("the conformance module reads COMPUTER_INSTABOX_* alone, needs its live switch first, and its sweep's host and scope need none", async () => {
	const { live, ...names } = ENV;
	assert.equal(live, "AGENTRUN_COMPUTER_LIVE_INSTABOX");
	for (const name of Object.values(names)) assert.match(name, /^COMPUTER_INSTABOX_[A-Z0-9_]+$/);
	const env = { [ENV.key]: KEY };
	assert.deepEqual(settingsFromEnv(env), { apiKey: KEY });
	assert.deepEqual(settingsFromEnv({ ...env, [ENV.apiUrl]: API_URL, [ENV.daemon]: "/tmp/computerd", INSTABOX_API_KEY: BARE }), { apiKey: KEY, apiUrl: API_URL, daemonPath: "/tmp/computerd" });
	assert.throws(
		() => settingsFromEnv({ INSTABOX_API_KEY: BARE }),
		(error) => /set COMPUTER_INSTABOX_API_KEY/.test(error.message) && !error.message.includes(BARE),
	);
	const rest = fakeRest();
	const doubles = { ssh2: { Client: class {} }, fetch: rest.fetch };
	await assert.rejects(conformanceModule.createProvider({ env, ...doubles }), /set AGENTRUN_COMPUTER_LIVE_INSTABOX=1/);
	await assert.rejects(conformanceModule.createDriftedProvider({ env, ...doubles }), /set AGENTRUN_COMPUTER_LIVE_INSTABOX=1/);
	const provider = await conformanceModule.createProvider({ env: { ...env, [ENV.live]: "1" }, ...doubles });
	assert.equal(provider.capabilities().maxLifetimeMs, 30 * 60_000, "a conformance computer lives at most 30 minutes");
	assert.equal(await conformanceModule.conformanceImage({ env: {} }), "minimal");
	assert.equal(await conformanceModule.conformanceImage({ env: { [ENV.image]: "sn_mine" } }), "sn_mine");
	const host = await conformanceModule.createHost({ env, ...doubles });
	assert.equal(host.descriptor.id, "instabox");
	assert.equal(sweepScope({ env }), accountOf(KEY));
	assert.doesNotMatch(sweepScope({ env }), new RegExp(KEY));
	assert.notEqual(sweepScope({ env: { ...env, [ENV.key]: BARE } }), sweepScope({ env }), "another key is another workspace");
	assert.deepEqual(rest.calls, []);
});
