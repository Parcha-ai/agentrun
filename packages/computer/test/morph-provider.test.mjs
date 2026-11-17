// MorphProvider's host on a fake Morph (fake-morph.mjs): the REST API as a fetch in the OpenAPI's shapes, and the SSH
// gateway as ssh2's own Server on loopback taking "<instance id>:<key>". What Morph's host decides is tested here: the
// create's body, get, list and delete, the status read-back, extend's TTL then metadata, the error codes, check()'s
// refusals, an exec through the gateway, and the box snapshot prepareImage finds or builds. The adapter's lifecycle is
// tested once, against its fake host (hosted-provider.test.mjs); Morph's own is proven live (d7/morph-live-1).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { boxRecipeHash } from "../dist/box-image.js";
import { codeOfError } from "../dist/hosted/process.js";
import * as registry from "../dist/providers.js";
import { API_URL, fakeMorph, fakeRest, KEY } from "./fake-morph.mjs";

const { MorphProvider, create, accountOf } = await import("../dist/morph.js");
const conformanceModule = await import("../dist/conformance/morph.js");
const { MORPH_ENV: ENV, settingsFromEnv, sweepScope } = conformanceModule;

const CTX = { timeoutMs: 10_000 };
const COMPUTER = "agentrun.computer";
const MAX_LABEL = "agentrun.computer.max-deadline";
const DEADLINE_LABEL = "agentrun.computer.deadline";
const BARE = "not-a-secret-bare-morph-key";
const BOX = `agentrun-box-${boxRecipeHash()}`;
/** The label of a build's base snapshot and instance. */
const BUILD = "agentrun-box-build";

/** A REST-only provider: no gateway. The account holds one snapshot, SNAPSHOT, to start from. */
function restOnly(options = {}, restOptions = {}) {
	const rest = fakeRest(restOptions);
	const snapshot = rest.snapshot({}).id;
	const provider = new MorphProvider({ apiKey: KEY, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL, ...options });
	return { rest, snapshot, provider, host: provider.host };
}

/** A provider on the fake REST API and gateway; the gateway is closed after the test. */
async function setup(t, options = {}, fakeOptions = {}) {
	const fake = await fakeMorph(fakeOptions);
	t.after(() => fake.sshd.close());
	const snapshot = fake.rest.snapshot({}).id;
	const provider = new MorphProvider({ ...fake.options, ...options });
	return { fake, snapshot, provider, host: provider.host };
}

const request = (image, labels = {}) => ({ name: "computer-0123456789ab", image, labels: { [COMPUTER]: "1", "agentrun.computer.name": "computer-0123456789ab", ...labels }, lifetimeMs: 600_500, egress: false });

const thrown = (call) =>
	call.then(
		() => assert.fail("it answered"),
		(error) => error,
	);

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

async function until(check, ms = 5_000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

// --- what it declares ---

test("a Morph computer is kind linux in a VM, daemon child over SSH, a vendor TTL, network none, open and a list from inside, the guest's sshd port, and no mount", async () => {
	const { provider } = restOnly();
	const caps = provider.capabilities();
	assert.equal(caps.kind, "linux");
	assert.deepEqual(caps.groups, ["exec", "files", "processes"]);
	assert.equal(caps.daemon, "child");
	assert.equal(caps.lifetime, "vendor");
	assert.equal(caps.maxLifetimeMs, 24 * 3_600_000);
	assert.equal(caps.isolation, "vm");
	assert.deepEqual(caps.network, ["none", "open", "allow"]);
	assert.deepEqual(caps.vendorAgentPorts, [22]);
	assert.deepEqual(caps.mount ?? [], []);
	const { PROVIDERS } = await import("../dist/index.js");
	const entry = PROVIDERS.find((one) => one.id === "morph");
	assert.equal(entry.prepareImage, true, "serve starts every computer from the box snapshot prepareImage answers");
	assert.deepEqual(
		entry.capabilities.map((one) => one.kind),
		["linux"],
	);
});

test("the provider takes the key as an option, checks ssh2, fetch, the API URL and the gateway, and never echoes the key", async () => {
	const ssh2 = { Client: class {} };
	await assert.rejects(create({ ssh2 }), /options\.apiKey/);
	assert.throws(() => new MorphProvider({ apiKey: KEY, ssh2: {} }), /ssh2 package/);
	assert.throws(() => new MorphProvider({ apiKey: KEY, ssh2, fetch: "no" }), /options\.fetch/);
	for (const apiUrl of ["http://cloud.morph.so/api", "not a url", "https://cloud.morph.so/api?x=1"]) {
		assert.throws(
			() => new MorphProvider({ apiKey: KEY, ssh2, apiUrl }),
			(error) => /https URL/.test(error.message) && !error.message.includes(KEY),
			apiUrl,
		);
	}
	assert.throws(() => new MorphProvider({ apiKey: KEY, ssh2, sshHost: "not a host" }), /sshHost/);
	assert.throws(() => new MorphProvider({ apiKey: KEY, ssh2, sshPort: 70_000 }), /sshPort/);
	assert.equal(new MorphProvider({ apiKey: KEY, ssh2, sshHost: "127.0.0.1", sshPort: 2222 }).id, "morph");
	// ssh2 is the host's package when not given.
	assert.equal((await create({ apiKey: KEY })).id, "morph");
});

test("check() refuses a size (a Morph computer has its snapshot's) and an image that is no snapshot id", () => {
	const { provider } = restOnly();
	const spec = { image: "snapshot_abc123", lifetimeMs: 600_000, network: "none" };
	const fields = (more) => provider.check({ ...spec, ...more }).map((one) => one.field);
	assert.deepEqual(fields({}), []);
	assert.deepEqual(fields({ network: "open" }), []);
	assert.deepEqual(fields({ network: { allow: ["example.com"] } }), []);
	assert.deepEqual(fields({ cpus: 2 }), ["cpus"]);
	assert.deepEqual(fields({ memoryMb: 4096 }), ["memoryMb"]);
	assert.match(provider.check({ ...spec, cpus: 2 })[0].message, /size of its snapshot/);
	assert.deepEqual(fields({ image: "morphvm-minimal" }), ["image"], "an image id is not a snapshot: prepareImage makes one");
	assert.deepEqual(fields({ image: "snapshot_../x" }), ["image"]);
	assert.match(provider.check({ ...spec, image: "ubuntu" })[0].message, /Morph snapshot/);
});

// --- REST ---

test("create posts the snapshot, the labels as metadata and the lifetime as a TTL whose action is stop, with the key as a Bearer token", async () => {
	const { rest, snapshot, host } = restOnly();
	const made = await host.create({ ...request(snapshot), egress: true }, CTX);
	assert.match(made.id, /^morphvm_\d{8}$/);
	const [call] = rest.calls;
	assert.deepEqual([call.method, call.path, call.auth], ["POST", "/api/instance", `Bearer ${KEY}`]);
	assert.deepEqual(call.body, { snapshot_id: snapshot, metadata: request(snapshot).labels, ttl_seconds: 601, ttl_action: "stop" }, "the TTL rounded up to the second; egress sends nothing, Morph has no egress control");
	rest.fail("POST", /^\/api\/instance$/, new Response(JSON.stringify({ id: "not an id" }), { status: 200 }));
	assert.match((await thrown(host.create(request(snapshot), CTX))).message, /no instance id/);
	assert.equal(host.errorCode(await thrown(host.create(request("snapshot_missing"), CTX))), "not_found");
});

test("get reads an instance back as a machine with its TTL's end; list answers the whole account, which the adapter matches by labels; delete twice is done", async () => {
	const { rest, snapshot, host, provider } = restOnly();
	const value = await host.create(request(snapshot, { "agentrun.conformance": "run-1" }), CTX);
	await host.create(request(snapshot, { "agentrun.conformance": "run-2" }), CTX);
	const first = await host.get(value.id, CTX);
	assert.equal(first.state, "starting", "pending is starting");
	const machine = await host.get(value.id, CTX);
	assert.deepEqual(Object.keys(machine).sort(), ["createdAt", "endsAt", "id", "labels", "state"]);
	assert.equal(machine.state, "running");
	const instance = rest.instances.get(value.id);
	assert.deepEqual(machine.createdAt, new Date(instance.created * 1000));
	assert.deepEqual(machine.endsAt, new Date(instance.ttl.ttl_expire_at * 1000));
	assert.equal(machine.labels["agentrun.conformance"], "run-1");
	assert.equal(host.errorCode(await thrown(host.get("morphvm_99999999", CTX))), "not_found");
	const notAnId = await thrown(host.get("not an id", CTX));
	assert.equal(host.errorCode(notAnId), "not_found", "an id that is not Morph's is not found, never a URL");
	assert.doesNotMatch(notAnId.message, /https?:|morph\.test/);
	assert.equal(host.errorCode(await thrown(host.get("morphvm_1:x", CTX))), "not_found", "a ':' would end the SSH username early");
	assert.equal(host.errorCode(await thrown(host.exec("a/b", ["true"], CTX))), "not_found", "nor reached over SSH");
	// GET /instance is unfiltered: the adapter keeps the machines that carry the labels.
	const listed = await host.list({ "agentrun.conformance": "run-1" }, CTX);
	assert.equal(listed.length, 2);
	assert.deepEqual(rest.calls.at(-1).query, {}, "no metadata filter on the query");
	assert.deepEqual((await provider.list({ "agentrun.conformance": "run-1" })).value.map((info) => info.ref.id), [value.id]);
	assert.equal(await host.delete(value.id, CTX), undefined);
	assert.equal(rest.calls.at(-1).method, "DELETE");
	assert.equal(host.errorCode(await thrown(host.delete(value.id, CTX))), "not_found", "a repeat's 404 is not_found, which the adapter's delete reads as done");
	assert.equal(rest.instances.has(value.id), false);
	rest.fail("GET", /^\/api\/instance$/, new Response(JSON.stringify({ object: "list" }), { status: 200 }));
	await assert.rejects(host.list({}, CTX), /no data list/);
});

test("the status mapping: every Morph status is one of the adapter's states, and one it does not know is gone with why", async () => {
	const { rest, snapshot, host } = restOnly();
	const value = await host.create(request(snapshot), CTX);
	const states = { ready: "running", pending: "starting", saving: "starting", paused: "stopped", error: "gone" };
	for (const [status, state] of Object.entries(states)) {
		rest.instances.get(value.id).status = status;
		assert.equal((await host.get(value.id, CTX)).state, state, status);
	}
	rest.instances.get(value.id).status = "error";
	assert.match((await host.get(value.id, CTX)).why, /in error/);
	rest.instances.get(value.id).status = "melting";
	const odd = await host.get(value.id, CTX);
	assert.equal(odd.state, "gone");
	assert.match(odd.why, /melting/);
	rest.instances.get(value.id).ttl = { ttl_seconds: null, ttl_expire_at: null, ttl_action: null };
	rest.instances.get(value.id).status = "ready";
	assert.equal((await host.get(value.id, CTX)).endsAt, undefined, "no TTL, no end");
});

test("extend moves the TTL (POST /ttl, action stop), checks its end counts from the call, then posts the metadata with the deadline label moved", async () => {
	const { rest, snapshot, host } = restOnly();
	const most = new Date(Date.now() + 3 * 3_600_000).toISOString();
	const value = await host.create(request(snapshot, { keep: "me", [MAX_LABEL]: most }), CTX);
	rest.calls.length = 0;
	const endsAt = new Date(Date.now() + 1_800_000);
	assert.equal(await host.extend(value.id, endsAt, CTX), undefined);
	assert.deepEqual(
		rest.calls.map((one) => [one.method, one.path]),
		[
			["GET", `/api/instance/${value.id}`],
			["POST", `/api/instance/${value.id}/ttl`],
			["POST", `/api/instance/${value.id}/metadata`],
		],
	);
	assert.ok([1800, 1799].includes(rest.calls[1].body.ttl_seconds), String(rest.calls[1].body.ttl_seconds));
	assert.equal(rest.calls[1].body.ttl_action, "stop");
	assert.deepEqual(rest.calls[2].body, { ...request(snapshot, { keep: "me", [MAX_LABEL]: most }).labels, [DEADLINE_LABEL]: endsAt.toISOString() }, "the whole map, the deadline moved");
	assert.equal(rest.instances.get(value.id).metadata[DEADLINE_LABEL], endsAt.toISOString());
	assert.ok(Math.abs(rest.instances.get(value.id).ttl.ttl_expire_at * 1000 - endsAt.getTime()) <= 2_000);
});

test("extend never passes the max-deadline label, refuses with no label or no second left, and throws when Morph's TTL does not count from the call", async () => {
	const { rest, snapshot, host } = restOnly();
	const soon = new Date(Date.now() + 900_500);
	const value = await host.create(request(snapshot, { [MAX_LABEL]: soon.toISOString() }), CTX);
	rest.calls.length = 0;
	await host.extend(value.id, new Date(Date.now() + 7_200_000), CTX);
	assert.ok([900, 899].includes(rest.calls[1].body.ttl_seconds), "cut to the label");
	const bare = await host.create(request(snapshot), CTX);
	const refused = await thrown(host.extend(bare.id, new Date(Date.now() + 60_000), CTX));
	assert.equal(host.errorCode(refused), "refused");
	assert.match(refused.message, /max-deadline/);
	const past = await host.create(request(snapshot, { [MAX_LABEL]: new Date(Date.now() - 1_000).toISOString() }), CTX);
	assert.equal(host.errorCode(await thrown(host.extend(past.id, new Date(Date.now() + 60_000), CTX))), "limit");
	assert.equal(host.errorCode(await thrown(host.extend("not an id", new Date(), CTX))), "not_found");
	// A TTL Morph adds to the old end, not from now: the end read back is elsewhere, so the label is not moved.
	const added = restOnly({}, { ttl: "added" });
	const one = await added.host.create(request(added.snapshot, { [MAX_LABEL]: new Date(Date.now() + 7_200_000).toISOString() }), CTX);
	added.rest.calls.length = 0;
	const error = await thrown(added.host.extend(one.id, new Date(Date.now() + 1_800_000), CTX));
	assert.equal(added.host.errorCode(error), "vendor");
	assert.match(error.message, /does not count from the call/);
	assert.deepEqual(
		added.rest.calls.map((call) => call.path.split("/").at(-1)),
		[one.id, "ttl"],
		"no metadata posted",
	);
});

test("the error codes: the status, 503 as Morph's admission refusal, FastAPI's detail in words, and a refused key never echoed", async () => {
	const { rest, snapshot, host } = restOnly();
	const cases = [
		[401, { detail: "Invalid API key" }, "denied"],
		[403, { detail: "Forbidden" }, "denied"],
		[404, { detail: "Snapshot not found" }, "not_found"],
		[422, { detail: [{ loc: ["body", "snapshot_id"], msg: "field required", type: "missing" }] }, "invalid"],
		[402, { detail: "Payment required" }, "limit"],
		[429, { detail: "Too many requests" }, "limit"],
		[503, { detail: "Snapshot admission busy", error_code: "admission_busy" }, "limit"],
		[502, { detail: "bad gateway" }, "vendor"],
		[500, null, "vendor"],
	];
	for (const [status, body, code] of cases) {
		rest.fail("POST", /^\/api\/instance$/, new Response(body === null ? "oops" : JSON.stringify(body), { status }));
		const error = await thrown(host.create(request(snapshot), CTX));
		assert.equal(host.errorCode(error), code, `${status} ${JSON.stringify(body)}`);
		assert.match(error.message, new RegExp(`answered ${status}`));
	}
	rest.fail("POST", /^\/api\/instance$/, new Response(JSON.stringify({ detail: [{ msg: "field required" }, { msg: "bad ttl" }] }), { status: 422 }));
	assert.match((await thrown(host.create(request(snapshot), CTX))).message, /field required; bad ttl/);
	rest.fail("POST", /^\/api\/instance$/, new Response(JSON.stringify({ detail: "busy", error_code: "admission_busy" }), { status: 503 }));
	assert.match((await thrown(host.create(request(snapshot), CTX))).message, /admission_busy: busy/);
	const wrong = new MorphProvider({ apiKey: BARE, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL });
	const refused = await thrown(wrong.host.list({}, CTX));
	assert.equal(wrong.host.errorCode(refused), "denied");
	assert.doesNotMatch(refused.message, new RegExp(BARE));
	assert.equal(codeOfError(host, Object.assign(new Error("slow"), { name: "TimeoutError" })), "timeout");
	assert.equal(host.errorCode(Object.assign(new Error("no"), { level: "client-authentication" })), "denied");
	assert.equal(host.errorCode(Object.assign(new Error("slow"), { level: "client-timeout" })), "timeout");
});

// --- SSH through the gateway ---

test("exec logs in to the gateway as the instance id with the instance's own key, read once over REST, and runs argv as given: stdout, stderr and the exit code", async (t) => {
	const { fake, snapshot, host } = await setup(t);
	const value = await host.create(request(snapshot), CTX);
	fake.rest.calls.length = 0;
	const result = await run(host, value.id, ["sh", "-c", 'echo "out $1"; echo err >&2; exit 3', "sh", "a b'c"]);
	assert.deepEqual(result, { code: 3, stdout: "out a b'c\n", stderr: "err\n" }, "the pid wrapper's line never reaches stderr");
	assert.ok(fake.logins.some((login) => login.method === "publickey"), "ssh2 asks none first, then logs in with the key");
	for (const login of fake.logins) assert.equal(login.username, value.id, "the user is the instance id alone: the account's key never goes over SSH");
	assert.deepEqual(await run(host, value.id, ["printf", "%s|", "$HOME", "*", ""]), { code: 0, stdout: "$HOME|*||", stderr: "" });
	assert.deepEqual(await run(host, value.id, ["cat"], "line one\nline two\n"), { code: 0, stdout: "line one\nline two\n", stderr: "" }, "stdin written, then ended");
	fake.sshd.dropAll();
	assert.equal((await run(host, value.id, ["true"])).code, 0, "a new connection logs in with the key held");
	assert.deepEqual(
		fake.rest.calls.map((call) => [call.method, call.path, call.auth]),
		[["GET", `/api/instance/${value.id}/ssh/key`, `Bearer ${KEY}`]],
		"the key is read once, over REST",
	);
});

test("Morph answers the instance's key in PKCS#8, which ssh2 does not read: an RSA, EC or Ed25519 one is converted and the gateway takes the login", async (t) => {
	for (const keyType of ["rsa", "ec", "ed25519"]) {
		const { fake, snapshot, host } = await setup(t, {}, { keyType });
		const value = await host.create(request(snapshot), CTX);
		assert.ok(fake.rest.sshKeys.get(value.id).private.startsWith(`-----BEGIN ${"PRIVATE KEY"}-----\n`), "the fake hands out PKCS#8");
		assert.deepEqual(await run(host, value.id, ["echo", keyType]), { code: 0, stdout: `${keyType}\n`, stderr: "" }, keyType);
		assert.ok(fake.logins.some((login) => login.method === "publickey"), keyType);
	}
});

test("a login the gateway refuses (a key rotated in the account) is denied with no key in the error, and the next exec reads the key again", async (t) => {
	const { fake, snapshot, host } = await setup(t);
	const value = await host.create(request(snapshot), CTX);
	assert.equal((await run(host, value.id, ["true"])).code, 0);
	const held = fake.rest.sshKeys.get(value.id).private;
	await fake.rest.fetch(`${API_URL}/instance/${value.id}/ssh/key`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` } });
	fake.sshd.dropAll();
	const error = await thrown(host.exec(value.id, ["true"], CTX));
	assert.equal(host.errorCode(error), "denied");
	for (const secret of [KEY, held, fake.rest.sshKeys.get(value.id).private]) assert.equal(error.message.includes(secret) || String(error.stack).includes(secret), false);
	assert.equal((await run(host, value.id, ["true"])).code, 0, "the rotated key is read and taken");
	assert.equal(fake.rest.calls.filter((call) => call.path.endsWith("/ssh/key") && call.method === "GET").length, 2);
	assert.equal(host.errorCode(await thrown(host.exec("morphvm_99999999", ["true"], CTX))), "not_found", "no instance, no key, no login");
	fake.rest.fail("GET", /\/ssh\/key$/, new Response(JSON.stringify({ private_key: "not a key" }), { status: 200 }));
	const other = await host.create(request(snapshot), CTX);
	assert.match((await thrown(host.exec(other.id, ["true"], CTX))).message, /no private key ssh2 can read/);
	assert.ok(fake.logins.every((login) => !login.username.includes(KEY)));
});

test("a gateway that does not answer fails the exec in words; delete ends the instance's SSH connections at once", async (t) => {
	const { fake, snapshot, host } = await setup(t);
	const value = await host.create(request(snapshot), CTX);
	const closed = new MorphProvider({ ...fake.options, sshPort: 1 });
	const error = await thrown(closed.host.exec(value.id, ["true"], CTX));
	assert.match(error.message, /127\.0\.0\.1:1/);
	assert.doesNotMatch(error.message, new RegExp(KEY));
	const proc = await host.exec(value.id, ["sh", "-c", "sleep 300 & wait"], CTX);
	await proc.end();
	assert.equal(fake.sshd.state.live, 1);
	assert.equal(await host.delete(value.id, CTX), undefined);
	assert.equal(await proc.wait(), -1, "the channel closed with its connection");
	assert.ok(await until(() => fake.sshd.state.live === 0, 1_000), "ended at once");
});

// --- the box snapshot ---

test("prepareImage answers the box snapshot the account has, by its digest, with no build and no wait told", async () => {
	const { rest, provider } = restOnly();
	const box = rest.snapshot({ digest: BOX, metadata: { "agentrun-box": BOX } }).id;
	rest.snapshot({ digest: "agentrun-box-other" });
	rest.calls.length = 0;
	const waits = [];
	const ready = await provider.prepareImage({ onWait: (...args) => waits.push(args) });
	assert.deepEqual(ready, { ok: true, value: box });
	assert.deepEqual(waits, []);
	assert.deepEqual(
		rest.calls.map((one) => [one.method, one.path, one.query]),
		[
			["GET", "/api/snapshot", { digest: BOX }],
			["GET", `/api/snapshot/${box}`, {}],
		],
	);
});

test("prepareImage waits for a box snapshot still pending, and refuses one that failed with none other", async () => {
	const { rest, provider } = restOnly();
	const pending = rest.snapshot({ digest: BOX, status: "pending" }).id;
	assert.deepEqual(await provider.prepareImage(), { ok: true, value: pending });
	const other = restOnly();
	const failed = other.rest.snapshot({ digest: BOX, status: "failed" }).id;
	const refused = await other.provider.prepareImage();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "vendor");
	assert.match(refused.error.message, new RegExp(`${failed} of ${BOX} failed: delete it in the account`));
	assert.equal(other.rest.instances.size, 0, "nothing built");
});

test("prepareImage builds the box snapshot once: a base of morphvm-minimal, an instance, install.sh as root over SSH, a snapshot by digest, and the instance deleted", async (t) => {
	const { fake, provider } = await setup(t);
	const { rest, build } = fake;
	rest.calls.length = 0;
	const waits = [];
	const ready = await provider.prepareImage({ onWait: (...args) => waits.push(args) });
	assert.equal(ready.ok, true, ready.error?.message);
	assert.deepEqual(waits, [["build", BOX]]);
	const made = rest.snapshots.get(ready.value);
	assert.equal(made.digest, BOX);
	assert.deepEqual(made.metadata, { "agentrun-box": BOX });
	assert.deepEqual(
		rest.calls.filter((one) => one.path.endsWith("/ssh/key")).map((one) => one.method),
		["GET"],
		"the build instance's key, read once",
	);
	const posts = rest.calls.filter((one) => one.method !== "GET");
	assert.deepEqual(
		posts.map((one) => [one.method, one.path.replace(/morphvm_\d+/, "{vm}")]),
		[
			["POST", "/api/snapshot"],
			["POST", "/api/instance"],
			["POST", "/api/instance/{vm}/snapshot"],
			["DELETE", "/api/instance/{vm}"],
		],
	);
	const [base, vm, snap] = posts;
	assert.deepEqual(base.body, { image_id: "morphvm-minimal", vcpus: 2, memory: 4096, disk_size: 16_384, metadata: { "agentrun-box-build": BOX } });
	const baseId = [...rest.snapshots.values()].find((one) => one.metadata["agentrun-box-build"] === BOX).id;
	assert.deepEqual(vm.body, { snapshot_id: baseId, metadata: { "agentrun-box-build": BOX }, ttl_seconds: 7200, ttl_action: "stop" }, "the build's instance ends by its own TTL if the build is cut");
	assert.deepEqual(snap.body, { digest: BOX, metadata: { "agentrun-box": BOX } });
	assert.equal(rest.instances.size, 0, "the build's instance is deleted");
	assert.equal(rest.snapshots.has(baseId), true, "the base is kept");
	assert.equal(build.commands.length, 4, "mkdir, two uploads, install.sh");
	assert.match(build.commands[0], /mkdir.*\/tmp\/agentrun-box/);
	assert.match(build.commands[3], /sh \/tmp\/agentrun-box\/install\.sh && rm -rf \/tmp\/agentrun-box/);
	const box = (file) => readFileSync(new URL(`../box/${file}`, import.meta.url));
	assert.deepEqual(
		build.uploads.map((text) => Buffer.from(text, "base64")),
		[box("install.sh"), box("agentrun-archil")],
	);
	assert.ok(fake.logins.length > 0 && fake.logins.every((login) => /^morphvm_\d+$/.test(login.username)), "the build logs in as its instance");
	// A second call finds it.
	rest.calls.length = 0;
	waits.length = 0;
	assert.deepEqual(await provider.prepareImage({ onWait: (...args) => waits.push(args) }), { ok: true, value: ready.value });
	assert.deepEqual(waits, []);
	assert.equal(rest.calls.filter((one) => one.method !== "GET").length, 0);
});

test("a build whose install.sh fails answers vendor in words, makes no box snapshot, and deletes its instance and its base, so a failing build leaves nothing", async (t) => {
	const { fake, snapshot, provider } = await setup(t);
	fake.build.exit = 7;
	for (const attempt of [1, 2]) {
		const failed = await provider.prepareImage();
		assert.equal(failed.ok, false);
		assert.equal(failed.error.code, "vendor");
		assert.match(failed.error.message, new RegExp(`${BOX} as a Morph snapshot: box/install\\.sh exited with 7`));
		assert.equal(fake.rest.instances.size, 0, `attempt ${attempt}: the build instance is deleted`);
		assert.deepEqual([...fake.rest.snapshots.keys()], [snapshot], `attempt ${attempt}: the base is deleted too; the account's own snapshot stays`);
	}
	// One whose base never gets ready deletes it the same way, and makes no instance.
	fake.rest.fail("GET", /^\/api\/snapshot\/snapshot_/, new Response(JSON.stringify({ id: "x", status: "failed" }), { status: 200 }));
	const unready = await provider.prepareImage();
	assert.match(unready.error.message, /is "failed", not ready/);
	assert.equal(fake.rest.instances.size, 0);
	assert.deepEqual([...fake.rest.snapshots.keys()], [snapshot]);
});

test("a build cancelled while Morph makes its base or its instance holds the id all the same, answers aborted, and deletes both", async (t) => {
	for (const during of [/^\/api\/snapshot$/, /^\/api\/instance$/]) {
		const controller = new AbortController();
		const fake = await fakeMorph();
		t.after(() => fake.sshd.close());
		const own = fake.rest.snapshot({}).id;
		// Morph makes it, then the caller cancels before the answer is read: a call that took the signal never reads the id.
		const fetch = async (url, init = {}) => {
			const answer = await fake.rest.fetch(url, init);
			if (init.method === "POST" && during.test(new URL(url).pathname)) {
				controller.abort();
				await new Promise((resolve) => setImmediate(resolve));
				if (init.signal?.aborted) throw init.signal.reason;
			}
			return answer;
		};
		const provider = new MorphProvider({ ...fake.options, fetch });
		const cancelled = await provider.prepareImage({ signal: controller.signal });
		assert.equal(cancelled.ok, false, String(during));
		assert.equal(cancelled.error.code, "aborted", cancelled.error.message);
		assert.equal(fake.rest.instances.size, 0, `${during}: no build instance left`);
		assert.deepEqual([...fake.rest.snapshots.keys()], [own], `${during}: the base is deleted; the account's own snapshot stays`);
	}
});

test("a base snapshot Morph takes longer than 60 s to make is waited for: its create has the build's remaining time", async (t) => {
	const fake = await fakeMorph();
	t.after(() => fake.sshd.close());
	let posting = false;
	// POST /snapshot answers once the snapshot is made: 78 s of fake time (d7/morph-branch-3), cut by the call's bound.
	const fetch = async (url, init = {}) => {
		if (init.method === "POST" && new URL(url).pathname === "/api/snapshot") {
			posting = true;
			await new Promise((resolve, reject) => {
				const timer = setTimeout(resolve, 78_000);
				init.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(init.signal.reason)), { once: true });
			});
		}
		return fake.rest.fetch(url, init);
	};
	const provider = new MorphProvider({ ...fake.options, fetch });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const building = provider.prepareImage();
	while (!posting) await new Promise((resolve) => setImmediate(resolve));
	t.mock.timers.tick(78_000);
	t.mock.timers.reset();
	const ready = await building;
	assert.equal(ready.ok, true, ready.error?.message);
	assert.equal(fake.rest.snapshots.get(ready.value).digest, BOX);
});

test("a base create whose answer is lost adopts the base Morph made, found by its label, and makes no second one", async (t) => {
	const { fake, provider } = await setup(t);
	let made;
	// Morph makes the base, then the connection drops before its answer is read.
	fake.rest.fail("POST", /^\/api\/snapshot$/, () => {
		made = fake.rest.snapshot({ status: "pending", metadata: { [BUILD]: BOX }, refs: { image_id: "morphvm-minimal" } }).id;
		throw new TypeError("fetch failed");
	});
	fake.rest.calls.length = 0;
	const ready = await provider.prepareImage();
	assert.equal(ready.ok, true, ready.error?.message);
	assert.equal(fake.rest.calls.filter((one) => one.method === "POST" && one.path === "/api/snapshot").length, 1, "one base create");
	assert.equal(fake.rest.calls.find((one) => one.method === "POST" && one.path === "/api/instance").body.snapshot_id, made, "the build starts from the base Morph made");
	assert.deepEqual(
		[...fake.rest.snapshots.values()].filter((one) => one.metadata?.[BUILD] === BOX).map((one) => one.id),
		[made],
		"one base, kept",
	);
	// One lost with nothing made is the create's failure, in words.
	const other = await setup(t);
	other.fake.rest.fail("POST", /^\/api\/snapshot$/, () => {
		throw new TypeError("fetch failed");
	});
	const lost = await other.provider.prepareImage();
	assert.equal(lost.ok, false);
	assert.match(lost.error.message, /POST \/api\/snapshot: fetch failed/);
	assert.equal(other.fake.rest.instances.size, 0, "nothing built");
	// One cancelled while Morph makes it, its answer lost: the look again takes no cancel, so the base is held, then deleted.
	const cancelled = await setup(t);
	const own = [...cancelled.fake.rest.snapshots.keys()];
	const controller = new AbortController();
	cancelled.fake.rest.fail("POST", /^\/api\/snapshot$/, () => {
		cancelled.fake.rest.snapshot({ status: "pending", metadata: { [BUILD]: BOX } });
		controller.abort();
		throw new TypeError("fetch failed");
	});
	const aborted = await cancelled.provider.prepareImage({ signal: controller.signal });
	assert.equal(aborted.error?.code, "aborted", aborted.error?.message);
	assert.deepEqual([...cancelled.fake.rest.snapshots.keys()], own, "the base Morph made is deleted; the account's own snapshot stays");
});

test("a ready labelled base an earlier build left is used, not made again", async (t) => {
	const { fake, provider } = await setup(t);
	const left = fake.rest.snapshot({ metadata: { [BUILD]: BOX } }).id;
	fake.rest.snapshot({ metadata: { [BUILD]: "agentrun-box-other" } });
	fake.rest.calls.length = 0;
	const ready = await provider.prepareImage();
	assert.equal(ready.ok, true, ready.error?.message);
	assert.equal(fake.rest.calls.filter((one) => one.method === "POST" && one.path === "/api/snapshot").length, 0, "no base made");
	assert.equal(fake.rest.calls.find((one) => one.method === "POST" && one.path === "/api/instance").body.snapshot_id, left);
	assert.deepEqual(
		fake.rest.calls.find((one) => one.method === "GET" && one.path === "/api/snapshot" && one.query.digest === undefined).query,
		{ [`metadata[${BUILD}]`]: BOX },
		"the base is looked for by its label",
	);
});

test("a failed labelled base is deleted, and the build makes a new one", async (t) => {
	const { fake, provider } = await setup(t);
	const failed = fake.rest.snapshot({ status: "failed", metadata: { [BUILD]: BOX } }).id;
	const ready = await provider.prepareImage();
	assert.equal(ready.ok, true, ready.error?.message);
	assert.equal(fake.rest.snapshots.has(failed), false, "the failed base is deleted");
	assert.equal(fake.rest.calls.filter((one) => one.method === "POST" && one.path === "/api/snapshot").length, 1, "a new base");
	// Another build deleted it first: its delete's 404 is done, and the build goes on.
	const raced = await setup(t);
	const gone = raced.fake.rest.snapshot({ status: "failed", metadata: { [BUILD]: BOX } }).id;
	raced.fake.rest.fail("DELETE", new RegExp(`^/api/snapshot/${gone}$`), () => {
		raced.fake.rest.snapshots.delete(gone);
		return new Response(JSON.stringify({ detail: "Snapshot not found" }), { status: 404 });
	});
	const after = await raced.provider.prepareImage();
	assert.equal(after.ok, true, after.error?.message);
});

// --- the registry and the conformance module ---

test("the registry builds Morph from its options alone, and its source reads no environment and writes nowhere", async () => {
	const rest = fakeRest();
	const provider = await registry.providerFor("morph", { apiKey: KEY, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL });
	assert.equal(provider.id, "morph");
	assert.deepEqual(rest.calls, []);
	const source = readFileSync(new URL("../dist/morph.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /process\.env/);
	assert.doesNotMatch(source, /COMPUTER_MORPH_/);
	assert.doesNotMatch(source, /\bconsole\.|process\.(stdout|stderr)/);
	assert.doesNotMatch(source, /^\s*import\s[^(]*from\s+["']ssh2["']/m, "no static import of ssh2");
	assert.equal(accountOf(KEY), accountOf(KEY, "https://cloud.morph.so/api/"));
	assert.doesNotMatch(accountOf(KEY), new RegExp(KEY));
});

test("the conformance module reads COMPUTER_MORPH_* alone, needs its live switch first, and its sweep's host and scope need none", async () => {
	const { live, ...names } = ENV;
	assert.equal(live, "AGENTRUN_COMPUTER_LIVE_MORPH");
	for (const name of Object.values(names)) assert.match(name, /^COMPUTER_MORPH_[A-Z0-9_]+$/);
	const env = { [ENV.key]: KEY };
	assert.deepEqual(settingsFromEnv(env), { apiKey: KEY });
	assert.deepEqual(settingsFromEnv({ ...env, [ENV.apiUrl]: API_URL, [ENV.daemon]: "/tmp/computerd", [ENV.maxLifetimeMs]: "3600000", MORPH_API_KEY: BARE }), { apiKey: KEY, apiUrl: API_URL, daemonPath: "/tmp/computerd", maxLifetimeMs: 3_600_000 });
	assert.throws(
		() => settingsFromEnv({ MORPH_API_KEY: BARE }),
		(error) => /set COMPUTER_MORPH_API_KEY/.test(error.message) && !error.message.includes(BARE),
	);
	assert.throws(() => settingsFromEnv({ ...env, [ENV.maxLifetimeMs]: "1h" }), /whole number of milliseconds/);
	const rest = fakeRest();
	const doubles = { ssh2: { Client: class {} }, fetch: rest.fetch };
	await assert.rejects(conformanceModule.createProvider({ env, ...doubles }), /set AGENTRUN_COMPUTER_LIVE_MORPH=1/);
	await assert.rejects(conformanceModule.createDriftedProvider({ env, ...doubles }), /set AGENTRUN_COMPUTER_LIVE_MORPH=1/);
	await assert.rejects(conformanceModule.conformanceImage({ env, ...doubles }), /set AGENTRUN_COMPUTER_LIVE_MORPH=1/, "the box snapshot is built live");
	const provider = await conformanceModule.createProvider({ env: { ...env, [ENV.live]: "1" }, ...doubles });
	assert.equal(provider.capabilities().maxLifetimeMs, 30 * 60_000, "a conformance computer lives at most 30 minutes");
	const shorter = await conformanceModule.createProvider({ env: { ...env, [ENV.live]: "1", [ENV.maxLifetimeMs]: "600000" }, ...doubles });
	assert.equal(shorter.capabilities().maxLifetimeMs, 600_000, "a shorter cap from the environment is kept");
	assert.equal(await conformanceModule.conformanceImage({ env: { [ENV.snapshot]: "snapshot_mine" } }), "snapshot_mine");
	const host = await conformanceModule.createHost({ env, ...doubles });
	assert.equal(host.descriptor.id, "morph");
	assert.equal(sweepScope({ env }), accountOf(KEY));
	assert.doesNotMatch(sweepScope({ env }), new RegExp(KEY));
	assert.notEqual(sweepScope({ env: { ...env, [ENV.key]: BARE } }), sweepScope({ env }), "another key is another account");
	assert.deepEqual(rest.calls, []);
});

test("the conformance module's box snapshot comes from prepareImage once live, and its drifted twin uploads a daemon of another version", async () => {
	const rest = fakeRest();
	const box = rest.snapshot({ digest: BOX }).id;
	const env = { [ENV.key]: KEY, [ENV.live]: "1", [ENV.apiUrl]: API_URL };
	assert.equal(await conformanceModule.conformanceImage({ env, ssh2: { Client: class {} }, fetch: rest.fetch }), box);
	const built = [];
	const drifted = await conformanceModule.createDriftedProvider({
		env,
		ssh2: { Client: class {} },
		fetch: rest.fetch,
		buildDaemon: async (version) => {
			built.push(version);
			return "/tmp/computerd-drift";
		},
	});
	assert.equal(built.length, 1);
	assert.match(built[0], /-drift$/);
	assert.equal(drifted.id, "morph");
});
