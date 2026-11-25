// Agent37's own SSH key: with AGENT37_API_KEY alone, the provider makes an ed25519 key on first use, keeps its private
// half in the store it is given (a server's sealed one; else its process's memory), and registers the public half on the
// workspace (POST /v1/ssh-keys) before its first instance; a key the workspace has already (its fingerprint listed, or a
// 409) is reused, never registered twice. A set AGENT37_SSH_KEY is used as given. An instance made before the
// registration is retried while the key reaches it, within Agent37's few minutes; the 20-key cap refuses in words. The
// private key is in no call, note, error or inspection. On the fake workspace (fake-agent37.mjs fakeWorkspace), whose
// sshd takes only the keys registered on it.
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { inspect } from "node:util";
import { codeOfError } from "../dist/hosted/process.js";
import { pemOf } from "../dist/hosted/ssh-exec.js";
import { API_URL, fakeAgent37, fakeWorkspace, fingerprintOf, KEY, keyPair, MAX_SSH_KEYS, memorySecrets } from "./fake-agent37.mjs";

const { Agent37Provider } = await import("../dist/agent37.js");
const { AGENT37 } = await import("../dist/descriptors/agent37.js");
const conformanceModule = await import("../dist/conformance/agent37.js");
const { AGENT37_ENV: ENV, settingsFromEnv } = conformanceModule;

const CTX = { timeoutMs: 10_000 };
const COMPUTER = "agentrun.computer";
const request = () => ({ name: "computer-0123456789ab", image: "agent37-base", labels: { [COMPUTER]: "1" }, lifetimeMs: 600_000, egress: false });

/** Runs argv to its end: its exit code and stdout. */
async function run(host, id, argv) {
	const proc = await host.exec(id, argv, CTX);
	const out = [];
	const reading = (async () => {
		for await (const chunk of proc.stdout) out.push(Buffer.from(chunk));
	})();
	proc.stderr.resume();
	await proc.end();
	const code = await proc.wait();
	await reading;
	return { code, stdout: Buffer.concat(out).toString() };
}

/** An ed25519 private key as PKCS#8 PEM, and its OpenSSH public line. */
function ed25519() {
	const { privateKey } = generateKeyPairSync("ed25519");
	const pem = privateKey.export({ type: "pkcs8", format: "pem" });
	return { pem, line: lineOf(pem) };
}

/** The OpenSSH public line of a PKCS#8 ed25519 private key: "ssh-ed25519", then the length-prefixed type and key, base64. */
function lineOf(pem) {
	const x = Buffer.from(createPublicKey(createPrivateKey(pem)).export({ format: "jwk" }).x, "base64url");
	const string = (bytes) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		return Buffer.concat([length, Buffer.from(bytes)]);
	};
	return `ssh-ed25519 ${Buffer.concat([string("ssh-ed25519"), string(x)]).toString("base64")}`;
}

/** Every form of a private key that must never be shown: the PEM, its base64 lines, and the same for the OpenSSH form ssh2 is given. */
function secretForms(pem) {
	const lines = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("-----"));
	const openSsh = pemOf(pem);
	return [pem.trim(), ...lines(pem), ...(openSsh ? [openSsh.trim(), ...lines(openSsh)] : [])];
}

/** Each form of `pem` found in `text`. */
const leaks = (text, pem) => secretForms(pem).filter((form) => text.includes(form));

/** An instance made on the workspace directly, as another client would: before any key of this provider is registered. */
async function instanceBefore(rest) {
	const answer = await rest.fetch(`${API_URL}/v1/instances`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ template: "agent37-base" }) });
	return (await answer.json()).id;
}

const said = (calls) => calls.map((call) => `${call.method} ${call.path}`);
const jsonAnswer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the descriptor lists AGENT37_SSH_KEY as optional and declares the server's sealed store of the provider's own secrets, as its option secrets", () => {
	const ssh = AGENT37.keys.find((key) => key.name === "AGENT37_SSH_KEY");
	assert.equal(ssh?.required, false, "AGENT37_SSH_KEY is an optional override");
	assert.equal(AGENT37.keys.find((key) => key.name === "AGENT37_API_KEY")?.required, true);
	assert.deepEqual(AGENT37.secrets, { option: "secrets" });
});

test("with the API key alone, the provider makes an ed25519 key, keeps its private half in the store, and registers its public half once, before the first instance", async (t) => {
	const fake = await fakeWorkspace();
	t.after(() => fake.sshd.close());
	const secrets = memorySecrets();
	const provider = new Agent37Provider({ ...fake.options, secrets });
	assert.deepEqual(fake.rest.calls, [], "nothing is made or called at construction");
	const { id } = await provider.host.create(request(), CTX);
	const calls = said(fake.rest.calls);
	const registered = calls.indexOf("POST /v1/ssh-keys");
	assert.ok(registered >= 0 && registered < calls.indexOf("POST /v1/instances"), `the key is registered before the create: ${calls.join(", ")}`);
	assert.equal(calls.filter((call) => call === "POST /v1/ssh-keys").length, 1);
	const { public_key: line, name } = fake.rest.calls[registered].body;
	// The blob is 51 bytes (two length-prefixed strings: the 11-byte type and the 32-byte key), 68 base64 characters, no padding.
	assert.match(line, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} \S+$/, "one OpenSSH public line, ed25519");
	assert.match(name, /^agentrun-[A-Za-z0-9_-]+$/);
	const pem = secrets.held.get("ssh_key");
	assert.equal(createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }), pem, "the private half is kept in the store, PKCS#8 PEM");
	assert.deepEqual(secrets.puts, ["ssh_key"]);
	assert.equal(createPrivateKey(pem).asymmetricKeyType, "ed25519");
	assert.equal(fingerprintOf(lineOf(pem)), fake.rest.sshKeys[0].fingerprint, "the stored key is the registered one");
	assert.equal(fingerprintOf(line), fake.rest.sshKeys[0].fingerprint);
	assert.deepEqual(await run(provider.host, id, ["echo", "hi"]), { code: 0, stdout: "hi\n" });
	assert.equal(fake.sshd.state.denied, 0, "an instance made after the registration has the key from boot");
	assert.deepEqual(leaks(JSON.stringify(fake.rest.calls), pem), [], "no call carries the private key");
	assert.equal(said(fake.rest.calls).filter((call) => call === "POST /v1/ssh-keys").length, 1, "the exec registers nothing more");
});

test("a second provider on the same store reuses the key: its fingerprint is listed, so nothing is registered; a key the listing misses answers 409, taken as registered", async (t) => {
	const fake = await fakeWorkspace();
	t.after(() => fake.sshd.close());
	const secrets = memorySecrets();
	const first = new Agent37Provider({ ...fake.options, secrets });
	const { id } = await first.host.create(request(), CTX);
	const pem = secrets.held.get("ssh_key");
	const second = new Agent37Provider({ ...fake.options, secrets });
	const before = fake.rest.calls.length;
	assert.deepEqual(await run(second.host, id, ["echo", "again"]), { code: 0, stdout: "again\n" });
	assert.deepEqual(said(fake.rest.calls.slice(before)), ["GET /v1/ssh-keys"], "read, never registered again");
	assert.equal(secrets.held.get("ssh_key"), pem, "the same key");
	assert.deepEqual(secrets.puts, ["ssh_key"], "written once");
	// The listing misses it (a stale page): the POST answers 409 ssh_key_exists, which is the registration it needed.
	fake.rest.fail("GET", /^\/v1\/ssh-keys$/, () => jsonAnswer(200, { object: "list", data: [] }));
	const third = new Agent37Provider({ ...fake.options, secrets });
	const mark = fake.rest.calls.length;
	assert.deepEqual(await run(third.host, id, ["echo", "third"]), { code: 0, stdout: "third\n" });
	assert.deepEqual(said(fake.rest.calls.slice(mark)), ["GET /v1/ssh-keys", "POST /v1/ssh-keys"]);
	assert.equal(fake.rest.sshKeys.length, 1, "one key on the workspace");
	assert.equal(fake.sshd.state.denied, 0);
});

test("a set AGENT37_SSH_KEY is used as given: nothing is made, stored or registered", async (t) => {
	const fake = await fakeAgent37();
	t.after(() => fake.sshd.close());
	const secrets = memorySecrets();
	const provider = new Agent37Provider({ ...fake.options, secrets });
	const { id } = await provider.host.create(request(), CTX);
	assert.deepEqual(await run(provider.host, id, ["echo", "given"]), { code: 0, stdout: "given\n" });
	assert.deepEqual(said(fake.rest.calls).filter((call) => call.includes("/v1/ssh-keys")), []);
	assert.deepEqual(secrets.puts, []);
});

test("a workspace at its 20 SSH keys: the provider refuses in words naming the cap and what to do, deletes none, and makes no instance; a POST that answers the cap says the same", async (t) => {
	const fake = await fakeWorkspace();
	t.after(() => fake.sshd.close());
	for (let i = 0; i < MAX_SSH_KEYS; i++) fake.rest.register(keyPair().public, { name: `someone-${i}` });
	const secrets = memorySecrets();
	const provider = new Agent37Provider({ ...fake.options, secrets });
	const refused = await provider.host.create(request(), CTX).then(
		() => assert.fail("made an instance"),
		(error) => error,
	);
	assert.equal(codeOfError(provider.host, refused), "limit");
	assert.match(refused.message, /at most 20 SSH keys/);
	assert.match(refused.message, /agentrun-/, "names the keys this platform made, to delete");
	assert.match(refused.message, /AGENT37_SSH_KEY/, "or a key of the owner's own");
	assert.deepEqual(said(fake.rest.calls).filter((call) => call !== "GET /v1/ssh-keys"), [], "no POST, no DELETE, no instance");
	assert.equal(fake.rest.sshKeys.length, MAX_SSH_KEYS);
	assert.deepEqual(leaks(refused.message + refused.stack, secrets.held.get("ssh_key")), []);
	// Another client took the 20th place between the listing and the POST.
	fake.rest.sshKeys.pop();
	fake.rest.fail("POST", /^\/v1\/ssh-keys$/, () => jsonAnswer(400, { error: { code: "invalid_request", message: "A workspace can have at most 20 SSH keys" } }));
	const raced = await provider.host.create(request(), CTX).then(
		() => assert.fail("made an instance"),
		(error) => error,
	);
	assert.equal(codeOfError(provider.host, raced), "limit");
	assert.match(raced.message, /at most 20 SSH keys/);
	assert.equal(said(fake.rest.calls).filter((call) => call === "POST /v1/instances").length, 0);
});

test("an instance made before the key's registration is retried while the key reaches its sshd, then reached; one made after has it from boot", async (t) => {
	const fake = await fakeWorkspace({ settleMs: 1_500 });
	t.after(() => fake.sshd.close());
	const older = await instanceBefore(fake.rest);
	const provider = new Agent37Provider({ ...fake.options, secrets: memorySecrets() });
	const started = Date.now();
	assert.deepEqual(await run(provider.host, older, ["echo", "late"]), { code: 0, stdout: "late\n" });
	assert.ok(fake.sshd.state.denied >= 1, "refused at first");
	assert.ok(Date.now() - started >= 1_400, "reached once the key settled");
	const denied = fake.sshd.state.denied;
	const { id } = await provider.host.create(request(), CTX);
	assert.deepEqual(await run(provider.host, id, ["echo", "fresh"]), { code: 0, stdout: "fresh\n" });
	assert.equal(fake.sshd.state.denied, denied, "a new instance takes the key at once");
});

test("a key registered long ago that an sshd refuses is denied at once, in words; one registered within the last few minutes is retried until they pass, then denied", async (t) => {
	const fake = await fakeWorkspace();
	t.after(() => fake.sshd.close());
	const id = await instanceBefore(fake.rest);
	const key = ed25519();
	const secrets = memorySecrets();
	secrets.held.set("ssh_key", key.pem);
	// Registered an hour ago, and never reaching this instance (someone took it off the machine).
	fake.rest.register(`${key.line} agentrun`, { name: "agentrun-old", created: Math.floor(Date.now() / 1000) - 3_600, liveAt: Number.POSITIVE_INFINITY });
	const provider = new Agent37Provider({ ...fake.options, secrets });
	let started = Date.now();
	const denied = await provider.host.exec(id, ["true"], CTX).then(
		() => assert.fail("reached"),
		(error) => error,
	);
	assert.ok(Date.now() - started < 1_500, `denied at once, not retried (${Date.now() - started} ms)`);
	assert.equal(codeOfError(provider.host, denied), "denied");
	assert.match(denied.message, /SSH key/);
	assert.match(denied.message, new RegExp(fake.rest.sshKeys[0].fingerprint.replace(/[+/]/g, "\\$&")), "names the key by its fingerprint");
	assert.deepEqual(leaks(`${denied.message}\n${denied.stack}`, key.pem), []);
	// Registered 178 s ago: Agent37's few minutes (three, here) end within two seconds, and the sshd still refuses.
	const fresh = ed25519();
	const other = memorySecrets();
	other.held.set("ssh_key", fresh.pem);
	fake.rest.register(`${fresh.line} agentrun`, { created: Math.floor(Date.now() / 1000) - 178, liveAt: Number.POSITIVE_INFINITY });
	const retried = new Agent37Provider({ ...fake.options, secrets: other });
	started = Date.now();
	const late = await retried.host.exec(id, ["true"], CTX).then(
		() => assert.fail("reached"),
		(error) => error,
	);
	const took = Date.now() - started;
	assert.ok(took >= 500 && took < 8_000, `retried until the few minutes passed (${took} ms)`);
	assert.equal(codeOfError(retried.host, late), "denied");
	assert.match(late.message, /within about two minutes/);
	assert.deepEqual(leaks(`${late.message}\n${late.stack}`, fresh.pem), []);
});

test("the private key is in no note, no error and no inspection of the provider", async (t) => {
	const fake = await fakeWorkspace();
	t.after(() => fake.sshd.close());
	const notes = [];
	const secrets = memorySecrets();
	const provider = new Agent37Provider({ ...fake.options, secrets, onNote: (note) => notes.push(note) });
	const { id } = await provider.host.create(request(), CTX);
	await run(provider.host, id, ["true"]);
	const pem = secrets.held.get("ssh_key");
	assert.ok(notes.some((note) => note.note.includes(fake.rest.sshKeys[0].fingerprint)), "the registration is said, by its fingerprint");
	assert.deepEqual(leaks(JSON.stringify(notes), pem), []);
	assert.deepEqual(leaks(inspect(provider, { depth: 8, showHidden: true }), pem), []);
	assert.deepEqual(leaks(inspect(provider.host, { depth: 8, showHidden: true }), pem), []);
	// A refused registration's words carry Agent37's, never the key.
	fake.rest.fail("GET", /^\/v1\/ssh-keys$/, () => jsonAnswer(500, { error: { code: "internal_error", message: "boom" } }));
	const other = new Agent37Provider({ ...fake.options, secrets });
	const failed = await other.host.create(request(), CTX).then(
		() => assert.fail("made an instance"),
		(error) => error,
	);
	assert.match(failed.message, /SSH key/);
	assert.deepEqual(leaks(`${failed.message}\n${failed.stack}`, pem), []);
});

test("with neither a key nor a store (the conformance path), one key is made for the process and shared by its providers; the conformance module needs only COMPUTER_AGENT37_API_KEY", async (t) => {
	const fake = await fakeWorkspace();
	t.after(() => fake.sshd.close());
	const one = new Agent37Provider({ ...fake.options });
	const { id } = await one.host.create(request(), CTX);
	assert.deepEqual(await run(one.host, id, ["echo", "one"]), { code: 0, stdout: "one\n" });
	const two = new Agent37Provider({ ...fake.options });
	assert.deepEqual(await run(two.host, id, ["echo", "two"]), { code: 0, stdout: "two\n" });
	assert.equal(said(fake.rest.calls).filter((call) => call === "POST /v1/ssh-keys").length, 1, "one key for the process, registered once");
	assert.equal(fake.rest.sshKeys.length, 1);
	assert.deepEqual(settingsFromEnv({ [ENV.key]: KEY }), { apiKey: KEY });
	const hash = createHash("sha256").update(KEY).digest("hex").slice(0, 12);
	assert.ok(!fake.rest.sshKeys[0].name.includes(hash), "the key's name says nothing of the API key");
});
