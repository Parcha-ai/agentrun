// The Modal sweep (dist/conformance/modal-sweep.js) against the fake Modal SDK: --before records the tagged sandboxes of
// the app, --after terminates every tagged one that was not there before and reads each back until it has finished.
// No Modal client is constructed, no token is read and nothing reaches the network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeModal } from "./fake-modal.mjs";

const COMPUTER = "agentrun.computer";
const APP = "computers";
const ENV = { COMPUTER_MODAL_TOKEN_ID: "fake-dev-id", COMPUTER_MODAL_TOKEN_SECRET: "fake-dev-secret", COMPUTER_MODAL_APP: APP };
const DIR = mkdtempSync(join(tmpdir(), "computer-modal-sweep-"));
test.after(() => rmSync(DIR, { recursive: true, force: true }));
let files = 0;
const fileIn = () => join(DIR, `before-${++files}.json`);

/** A stream main writes to, and what it wrote. */
function sink() {
	const stream = {
		text: "",
		write(text, done) {
			stream.text += text;
			done?.();
			return true;
		},
	};
	return stream;
}

/** main with the fake as the client, and what it printed. */
async function sweep(argv, fake, { env = ENV, waitMs = 200, pollMs = 10 } = {}) {
	const stdout = sink();
	const stderr = sink();
	const made = [];
	function ModalClient(params) {
		made.push(params);
		return fake.sdk;
	}
	const { main } = await import("../dist/conformance/modal-sweep.js");
	const code = await main(argv, { env, ModalClient, stdout, stderr, waitMs, pollMs });
	return { code, stdout: stdout.text, stderr: stderr.text, made };
}

const tagged = (extra = {}) => ({ tags: { [COMPUTER]: "1", [`${COMPUTER}.name`]: "computer-0123456789ab", ...extra } });
/** The ids a call names, as its first argument after the method's name. */
const named = (fake) => new Set(fake.calls.filter(([name]) => name.startsWith("sandbox.") || name === "sandboxes.fromId").map(([, id]) => id));

test("--before records every running sandbox in the app that carries the computer tag, and touches none", async () => {
	const fake = fakeModal({
		sandboxes: [tagged(), tagged(), { tags: { other: "1" } }, { ...tagged(), appId: "ap-elsewhere" }, { ...tagged(), running: false }],
	});
	const [one, two] = [...fake.sandboxes.keys()];
	const file = fileIn();
	const ran = await sweep(["--before", file], fake);
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(JSON.parse(ran.stdout), { recorded: 2, file });
	const record = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(record.ids, [one, two].sort());
	assert.equal(record.tag, `${COMPUTER}=1`);
	assert.equal(record.app, APP);
	assert.equal(record.serverUrl, "https://api.modal.com:443", "the server the listing came from, the SDK's default when unset");
	assert.deepEqual(ran.made, [{ tokenId: "fake-dev-id", tokenSecret: "fake-dev-secret" }], "the COMPUTER_MODAL_ token, passed explicitly");
	assert.deepEqual(
		fake.calls.find(([name]) => name === "sandboxes.list"),
		["sandboxes.list", { appId: `ap-${APP}`, tags: { [COMPUTER]: "1" } }],
		"one list by the tag, in the app",
	);
	assert.deepEqual(fake.names().filter((name) => name.startsWith("sandbox.")), [], "no sandbox was read or ended");
});

test("--after terminates every tagged sandbox that was not there before, reads each back until it has finished, and touches no other", async () => {
	const fake = fakeModal({ sandboxes: [tagged(), { tags: { other: "1" } }] });
	const [kept, untagged] = [...fake.sandboxes.keys()];
	const file = fileIn();
	assert.equal((await sweep(["--before", file], fake)).code, 0);
	const fresh = [fake.add(tagged()), fake.add(tagged({ run: "x" }))];
	fake.calls.length = 0;
	const ran = await sweep(["--after", file], fake);
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(JSON.parse(ran.stdout), { swept: 2, gone: 2, stillThere: [] });
	for (const id of fresh) {
		assert.equal(fake.sandboxes.get(id).running, false, `${id} was terminated`);
		assert.equal(fake.sandboxes.get(id).terminated, 1);
	}
	assert.equal(fake.sandboxes.get(kept).running, true, "the sandbox there before runs on");
	assert.equal(fake.sandboxes.get(untagged).running, true, "an untagged sandbox runs on");
	const touched = named(fake);
	assert.equal(touched.has(kept), false, "no call names the sandbox there before");
	assert.equal(touched.has(untagged), false, "no call names an untagged sandbox");
	for (const id of fresh) {
		const reads = fake.calls.filter(([name, of]) => name === "sandbox.poll" && of === id);
		assert.ok(reads.length >= 1, `${id} was read back with poll`);
	}
	assert.ok(fake.calls.some(([name]) => name === "sandboxes.fromId"), "read back through fromId");
});

test("--after with nothing new sweeps nothing and exits 0", async () => {
	const fake = fakeModal({ sandboxes: [tagged()] });
	const file = fileIn();
	await sweep(["--before", file], fake);
	const ran = await sweep(["--after", file], fake);
	assert.equal(ran.code, 0);
	assert.deepEqual(JSON.parse(ran.stdout), { swept: 0, gone: 0, stillThere: [] });
	assert.equal(fake.names().includes("sandbox.terminate"), false);
});

test("--after exits 1 and names a sandbox still running once its wait runs out", async () => {
	const fake = fakeModal();
	const file = fileIn();
	await sweep(["--before", file], fake);
	const stuck = fake.add({ ...tagged(), stuck: true });
	const ended = fake.add(tagged());
	const started = Date.now();
	const ran = await sweep(["--after", file], fake, { waitMs: 150, pollMs: 10 });
	assert.ok(Date.now() - started < 5_000, "bounded");
	assert.equal(ran.code, 1);
	assert.deepEqual(JSON.parse(ran.stdout), { swept: 2, gone: 1, stillThere: [stuck] });
	assert.match(ran.stderr, new RegExp(`${stuck} is still running after 0\\.15 s`));
	assert.equal(fake.sandboxes.get(ended).running, false);
});

test("--after: a terminate that fails is said, and the sandbox counts as still there", async () => {
	const fake = fakeModal({ terminate: "fail" });
	const file = fileIn();
	await sweep(["--before", file], fake);
	const id = fake.add(tagged());
	const ran = await sweep(["--after", file], fake, { waitMs: 60 });
	assert.equal(ran.code, 1);
	assert.deepEqual(JSON.parse(ran.stdout), { swept: 1, gone: 0, stillThere: [id] });
	assert.match(ran.stderr, /terminate failed on the server/);
});

test("exit 2 on a usage error, a before file it cannot read, a missing token or app, or a listing Modal refused; nothing is terminated", async () => {
	const fake = fakeModal({ sandboxes: [tagged()] });
	const good = fileIn();
	writeFileSync(good, `${JSON.stringify({ app: APP, serverUrl: "https://api.modal.com:443", ids: [] })}\n`);
	const notBefore = fileIn();
	writeFileSync(notBefore, "{}\n");
	for (const [argv, env, pattern] of [
		[[], ENV, /give --before <file> or --after <file>/],
		[["--before"], ENV, /--before needs a file/],
		[["--before", good, "--after", good], ENV, /one of them/],
		[["--sweep", good], ENV, /unknown option --sweep/],
		[["--after", join(DIR, "absent.json")], ENV, /cannot read the before file/],
		[["--after", notBefore], ENV, /not a before file/],
		[["--after", good], { ...ENV, COMPUTER_MODAL_TOKEN_SECRET: undefined }, /COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET/],
		[["--after", good], { COMPUTER_MODAL_APP: APP, MODAL_TOKEN_ID: "prod-id-must-not-be-used", MODAL_TOKEN_SECRET: "prod-token-must-not-be-used" }, /never MODAL_TOKEN_ID/],
		[["--after", good], { ...ENV, COMPUTER_MODAL_APP: undefined }, /COMPUTER_MODAL_APP/],
		[["--after", good], { ...ENV, MODAL_SERVER_URL: "https://prod.example.invalid:443" }, /MODAL_SERVER_URL is set/],
	]) {
		const ran = await sweep(argv, fake, { env });
		assert.equal(ran.code, 2, `${argv.join(" ")}: ${ran.stderr}`);
		assert.match(ran.stderr, pattern, argv.join(" "));
		assert.equal(ran.stdout, "");
		assert.doesNotMatch(ran.stderr, /prod-(id|token)-must-not-be-used|fake-dev-secret/, "no token is printed");
	}
	assert.equal(fake.names().includes("sandbox.terminate"), false);
	const refused = fakeModal({ sandboxes: [tagged()], list: "fail" });
	const ran = await sweep(["--after", good], refused);
	assert.equal(ran.code, 2);
	assert.match(ran.stderr, /listing .* failed, so nothing was terminated: .*permission denied/);
	assert.equal(refused.names().includes("sandbox.terminate"), false);
	const before = await sweep(["--before", fileIn()], refused);
	assert.equal(before.code, 2);
	assert.match(before.stderr, /nothing was recorded/);
});

test("--after refuses a before file of another app or server, or one that names neither, before any list or terminate", async () => {
	const fake = fakeModal({ sandboxes: [tagged()] });
	const file = fileIn();
	assert.equal((await sweep(["--before", file], fake)).code, 0);
	const record = JSON.parse(readFileSync(file, "utf8"));
	const other = { ...ENV, COMPUTER_MODAL_APP: "elsewhere" };
	fake.add({ ...tagged(), appId: "ap-elsewhere" });
	const write = (patch) => {
		const path = fileIn();
		writeFileSync(path, `${JSON.stringify({ ...record, ...patch })}\n`);
		return path;
	};
	const { app: _app, ...noApp } = record;
	const { serverUrl: _server, ...noServer } = record;
	const bare = (value) => {
		const path = fileIn();
		writeFileSync(path, `${JSON.stringify(value)}\n`);
		return path;
	};
	for (const [what, path, env, pattern] of [
		["the environment names another app", file, other, /recorded in the app computers.*COMPUTER_MODAL_APP names elsewhere/],
		["the file names another app", write({ app: "elsewhere" }), ENV, /recorded in the app elsewhere.*COMPUTER_MODAL_APP names computers/],
		["the environment names another server", file, { ...ENV, COMPUTER_MODAL_SERVER_URL: "https://other.example.invalid:443" }, /recorded from https:\/\/api\.modal\.com:443.*https:\/\/other\.example\.invalid:443/],
		["the file names no app", bare(noApp), ENV, /names no app/],
		["the file names no server", bare(noServer), ENV, /names no server/],
	]) {
		fake.calls.length = 0;
		const ran = await sweep(["--after", path], fake, { env });
		assert.equal(ran.code, 2, `${what}: ${ran.stderr}`);
		assert.match(ran.stderr, pattern, what);
		assert.match(ran.stderr, /nothing was listed or terminated/, what);
		assert.equal(ran.stdout, "", what);
		assert.deepEqual(fake.names().filter((name) => name === "sandboxes.list" || name === "sandbox.terminate"), [], `${what}: no list, no terminate`);
	}
	assert.ok([...fake.sandboxes.values()].every((one) => one.running), "every sandbox runs on");
});

test("--before records the server COMPUTER_MODAL_SERVER_URL names, and --after takes it back from the same", async () => {
	const fake = fakeModal({ sandboxes: [tagged()] });
	const env = { ...ENV, COMPUTER_MODAL_SERVER_URL: "https://dev.example.invalid:443" };
	const file = fileIn();
	assert.equal((await sweep(["--before", file], fake, { env })).code, 0);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).serverUrl, "https://dev.example.invalid:443");
	const fresh = fake.add(tagged());
	const ran = await sweep(["--after", file], fake, { env });
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(JSON.parse(ran.stdout), { swept: 1, gone: 1, stillThere: [] });
	assert.equal(fake.sandboxes.get(fresh).running, false);
});

test("the sweep needs no live switch, and imports nothing from the SDK at load", async () => {
	const fake = fakeModal();
	const ran = await sweep(["--before", fileIn()], fake, { env: ENV });
	assert.equal(ran.code, 0, ran.stderr);
	const source = readFileSync(new URL("../dist/conformance/modal-sweep.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /^import[^\n]*["']modal["']/m);
});
