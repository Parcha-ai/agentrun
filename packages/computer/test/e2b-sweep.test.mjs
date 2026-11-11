// The E2B sweep (dist/conformance/e2b-sweep.js) against the fake E2B SDK: --before records the labelled sandboxes,
// --after kills every labelled one that was not there before and reads each back until E2B no longer has it. No SDK is
// loaded, no key is read from the environment and nothing reaches the network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeE2B, KEY } from "./fake-e2b.mjs";

const COMPUTER = "agentrun.computer";
const ENV = { COMPUTER_E2B_API_KEY: KEY };
const DIR = mkdtempSync(join(tmpdir(), "computer-e2b-sweep-"));
test.after(() => rmSync(DIR, { recursive: true, force: true }));
let files = 0;
const fileIn = () => join(DIR, `before-${++files}.json`);

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

async function sweep(argv, fake, { env = ENV, waitMs = 200, pollMs = 5 } = {}) {
	const stdout = sink();
	const stderr = sink();
	const { main } = await import("../dist/conformance/e2b-sweep.js");
	const code = await main(argv, { env, Sandbox: fake.Sandbox, stdout, stderr, waitMs, pollMs });
	return { code, stdout: stdout.text, stderr: stderr.text };
}

const labelled = () => ({ metadata: { [COMPUTER]: "1", [`${COMPUTER}.name`]: "computer-0123456789ab" } });
/** A conformance run's computer: the provider's label and the run's (RUN_LABEL, agentrun.conformance). */
const ofRun = () => ({ metadata: { ...labelled().metadata, "agentrun.conformance": "run-1" } });

test("--before records every sandbox carrying the computer label, and kills none", async () => {
	const fake = fakeE2B();
	const [one, two] = [fake.add(labelled()), fake.add(labelled())];
	fake.add({ metadata: { other: "1" } });
	const file = fileIn();
	const ran = await sweep(["--before", file], fake);
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(JSON.parse(ran.stdout), { recorded: 2, file });
	const record = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(record.ids, [one.id, two.id].sort());
	assert.equal(record.label, `${COMPUTER}=1`);
	assert.deepEqual(fake.kills, []);
	const listOpts = fake.calls.find(([name]) => name === "Sandbox.list")[1];
	assert.deepEqual(listOpts.query.metadata, { [COMPUTER]: "1" });
	assert.equal(listOpts.apiKey, KEY);
});

test("--after kills every new conformance sandbox, reads each back until gone, and touches no other: not one there before, nor one another user made mid-run", async () => {
	const fake = fakeE2B({ lingers: { reads: 2, lists: 1 } });
	const kept = fake.add(ofRun());
	const other = fake.add({ metadata: { other: "1" } });
	const file = fileIn();
	assert.equal((await sweep(["--before", file], fake)).code, 0);
	const fresh = [fake.add(ofRun()), fake.add(ofRun())];
	// A computer another user of the account (a server) made during the run: the provider's label, no conformance label.
	const midRun = fake.add(labelled());
	const ran = await sweep(["--after", file], fake);
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(JSON.parse(ran.stdout), { swept: 2, gone: 2, stillThere: [], leftAlone: 1 });
	assert.deepEqual(fake.kills.sort(), fresh.map((sb) => sb.id).sort());
	const named = new Set(fake.calls.filter(([name]) => name === "Sandbox.kill" || name === "Sandbox.getInfo").map(([, id]) => id));
	assert.ok(!named.has(kept.id) && !named.has(other.id), "no call names a sandbox that was there before, or one without the label");
	assert.ok(!named.has(midRun.id), "no call names the sandbox made mid-run with no conformance label: it survives");
});

test("--after exits 1 naming a sandbox that is still there after the wait", async () => {
	const fake = fakeE2B({ lingers: { reads: 10_000, lists: 10_000 } });
	const file = fileIn();
	assert.equal((await sweep(["--before", file], fake)).code, 0);
	const stuck = fake.add(ofRun());
	const ran = await sweep(["--after", file], fake);
	assert.equal(ran.code, 1);
	assert.deepEqual(JSON.parse(ran.stdout), { swept: 1, gone: 0, stillThere: [stuck.id], leftAlone: 0 });
});

test("usage errors, a missing key and an unreadable before file exit 2 and kill nothing; E2B_API_KEY is never read", async () => {
	const fake = fakeE2B();
	fake.add(labelled());
	for (const [argv, env, pattern] of [
		[[], ENV, /give --before <file> or --after <file>/],
		[["--after", join(DIR, "missing.json")], ENV, /cannot read the before file/],
		[["--before", fileIn()], { E2B_API_KEY: "fake-test-key" }, /COMPUTER_E2B_API_KEY/],
	]) {
		const ran = await sweep(argv, fake, { env });
		assert.equal(ran.code, 2, ran.stderr);
		assert.match(ran.stderr, pattern);
		assert.doesNotMatch(ran.stderr, /fake-test-key/);
	}
	assert.deepEqual(fake.kills, []);
});
