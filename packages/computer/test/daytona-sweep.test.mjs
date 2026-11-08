// The sweep after a live Daytona run, against the fake Daytona (test/fake-daytona.mjs): --before records every sandbox
// carrying agentrun.computer=1; --after deletes every one not in that record, reads each back until Daytona answers 404,
// and prints one JSON line. No key, no network: every request goes to the fake, and the key is an obvious fake.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { API, fakeDaytona, HOSTS, KEY } from "./fake-daytona.mjs";

const dir = mkdtempSync(join(tmpdir(), "computer-daytona-sweep-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const ENV = { COMPUTER_DAYTONA_API_KEY: KEY, COMPUTER_DAYTONA_API_URL: API };
const OURS = { "agentrun.computer": "1" };
const sweep = async () => (await import("../dist/conformance/daytona-sweep.js")).main;

const sink = () => {
	let text = "";
	return {
		write: (chunk, done) => {
			text += chunk;
			done?.();
			return true;
		},
		text: () => text,
	};
};

async function run(argv, fake, { env = ENV, waitMs = 2000, pollMs = 1 } = {}) {
	const main = await sweep();
	const stdout = sink();
	const stderr = sink();
	const code = await main(argv, { env, fetch: fake.fetch, webSocket: fake.webSocket, stdout, stderr, waitMs, pollMs });
	return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const deletes = (fake) => fake.requests.filter((r) => r.method === "DELETE").map((r) => decodeURIComponent(r.path.split("/").at(-1)));
const reads = (fake, id) => fake.requests.filter((r) => r.method === "GET" && r.path === `/api/sandbox/${id}`).length;

function allToTheFake(fake) {
	for (const request of fake.requests) {
		assert.ok(HOSTS.includes(request.host), `${request.method} ${request.url} went to the fake`);
		assert.equal(request.headers.authorization, `Bearer ${KEY}`);
	}
	assert.deepEqual(fake.sockets, [], "the sweep opens no log stream");
}

test("--before records the id of every sandbox carrying agentrun.computer=1, every page, whatever its name or state, and deletes nothing", async () => {
	const fake = fakeDaytona({ pageSize: 1 });
	const ours = fake.seed({ name: "computer-00000000000a", labels: { ...OURS, team: "a" } });
	const stopped = fake.seed({ name: "computer-00000000000b", labels: OURS, state: "stopped" });
	const named = fake.seed({ name: "someone-else", labels: OURS });
	fake.seed({ name: "computer-00000000000c", labels: { team: "a" } });
	const file = join(dir, "before-1.json");
	const ran = await run(["--before", file], fake);
	assert.equal(ran.code, 0, ran.stderr);
	const record = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual([...record.ids].sort(), [ours.id, stopped.id, named.id].sort());
	assert.deepEqual(JSON.parse(ran.stdout), { recorded: 3, file });
	assert.equal(ran.stdout.trim().split("\n").length, 1, "one JSON line");
	assert.deepEqual(deletes(fake), []);
	assert.ok(fake.requests.every((r) => r.method === "GET" && r.path === "/api/sandbox"), "listing calls alone");
	assert.ok(fake.requests.every((r) => JSON.parse(r.query.labels)["agentrun.computer"] === "1"));
	assert.ok(fake.requests.length >= 3, "every page");
	allToTheFake(fake);
});

test("--after deletes every labelled sandbox not in the before file, reads each back until Daytona answers 404, and never touches one that was there before", async () => {
	const fake = fakeDaytona({ lingerReads: 3 });
	const old = fake.seed({ name: "computer-0000000000a1", labels: OURS });
	const oldStopped = fake.seed({ name: "computer-0000000000a2", labels: OURS, state: "stopped" });
	const file = join(dir, "before-2.json");
	assert.equal((await run(["--before", file], fake)).code, 0);
	const fresh = [fake.seed({ name: "computer-0000000000b1", labels: { ...OURS, "agentrun.conformance": "run" } }), fake.seed({ name: "computer-0000000000b2", labels: OURS, state: "stopped" })];
	const unlabelled = fake.seed({ name: "computer-0000000000b3", labels: { team: "a" } });
	fake.requests.length = 0;
	const ran = await run(["--after", file], fake);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(ran.stdout.trim().split("\n").length, 1, "one JSON line");
	assert.deepEqual(JSON.parse(ran.stdout), { swept: 2, notFound: 2, stillThere: [] });
	assert.deepEqual(deletes(fake).sort(), fresh.map((sb) => sb.id).sort(), "the new ones alone are deleted");
	for (const sb of fresh) {
		assert.equal(fake.sandboxes.has(sb.id), false);
		const deletedAt = fake.requests.findIndex((r) => r.method === "DELETE" && r.path.endsWith(sb.id));
		const lastRead = fake.requests.findLastIndex((r) => r.method === "GET" && r.path === `/api/sandbox/${sb.id}`);
		assert.ok(lastRead > deletedAt, `${sb.id}: read back after its delete`);
		assert.ok(reads(fake, sb.id) >= 4, `${sb.id}: read until it was 404, past the reads that still found it`);
	}
	for (const sb of [old, oldStopped, unlabelled]) {
		assert.ok(fake.sandboxes.has(sb.id), `${sb.name} is left as it is`);
		assert.equal(fake.requests.filter((r) => r.path.includes(sb.id)).length, 0, `${sb.name}: not a single call names it`);
	}
	allToTheFake(fake);
});

test("--after reports a sandbox still there after its bounded wait, and exits 1", async () => {
	const fake = fakeDaytona({ deleteIgnored: true });
	const file = join(dir, "before-3.json");
	assert.equal((await run(["--before", file], fake)).code, 0);
	const kept = fake.seed({ name: "computer-0000000000c1", labels: OURS });
	const foreign = fake.seed({ name: "not-a-computer-name", labels: OURS });
	const started = Date.now();
	const ran = await run(["--after", file], fake, { waitMs: 300, pollMs: 20 });
	assert.ok(Date.now() - started < 10_000, "the wait is bounded");
	assert.equal(ran.code, 1);
	const line = JSON.parse(ran.stdout);
	assert.equal(line.swept, 2);
	assert.equal(line.notFound, 0);
	assert.deepEqual([...line.stillThere].sort(), [kept.id, foreign.id].sort());
	assert.ok(reads(fake, kept.id) >= 2, "read again until its wait ran out");
	assert.deepEqual(deletes(fake), [kept.id], "a sandbox the provider did not name is never deleted");
	assert.match(ran.stderr, /not-a-computer-name/, "the refusal is in words");
	assert.ok(fake.sandboxes.has(kept.id) && fake.sandboxes.has(foreign.id));
});

test("the sweep refuses in words, exit 2, with no request: no mode, both modes, no file, a before file it cannot read, and no COMPUTER_DAYTONA_API_KEY", async () => {
	const missing = join(dir, "missing.json");
	const bad = join(dir, "bad.json");
	writeFileSync(bad, JSON.stringify({ ids: [1, 2] }));
	for (const [argv, env, words] of [
		[[], ENV, /--before <file> or --after <file>/],
		[["--before", join(dir, "x.json"), "--after", join(dir, "x.json")], ENV, /--before <file> or --after <file>/],
		[["--before"], ENV, /needs a file/],
		[["--frobnicate"], ENV, /unknown option --frobnicate/],
		[["--after", missing], ENV, /cannot read the before file/],
		[["--after", bad], ENV, /not a before file/],
		[["--before", join(dir, "y.json")], { DAYTONA_API_KEY: "fake-test-key", COMPUTER_DAYTONA_API_URL: API }, /set COMPUTER_DAYTONA_API_KEY/],
	]) {
		const fake = fakeDaytona();
		fake.seed({ name: "computer-0000000000d1", labels: OURS });
		const ran = await run(argv, fake, { env });
		assert.equal(ran.code, 2, JSON.stringify(argv));
		assert.match(ran.stderr, words, JSON.stringify(argv));
		assert.doesNotMatch(ran.stderr, /fake-test-key/);
		assert.deepEqual(fake.requests, [], `${JSON.stringify(argv)}: no request`);
		assert.equal(fake.sandboxes.size, 1);
	}
});

test("--after with a listing Daytona refuses deletes nothing, and exits 2", async () => {
	const fake = fakeDaytona();
	const file = join(dir, "before-4.json");
	assert.equal((await run(["--before", file], fake)).code, 0);
	fake.seed({ name: "computer-0000000000e1", labels: OURS });
	fake.knobs.fail = [{ method: "GET", path: /^\/api\/sandbox$/, status: 401, times: 10 }];
	const ran = await run(["--after", file], fake);
	assert.equal(ran.code, 2);
	assert.match(ran.stderr, /GET \/api\/sandbox: 401/);
	assert.deepEqual(deletes(fake), []);
});
