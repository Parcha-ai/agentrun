// The one live sweep (dist/conformance/sweep.js) against the adapter's fake host: --before records the labelled
// machines, --after deletes only a conformance run's new ones and reads each back gone, never touching one that was
// there before or one another user of the account made. No vendor, no network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeHost } from "./fake-host.mjs";

const { main, sweepMachines } = await import("../dist/conformance/sweep.js");

const DIR = mkdtempSync(join(tmpdir(), "computer-sweep-"));
test.after(() => rmSync(DIR, { recursive: true, force: true }));
const OURS = { "agentrun.computer": "1" };
const RUN = { "agentrun.conformance": "abc123" };

/** A writer that keeps what it is given. */
const sink = () => {
	const lines = [];
	return { lines, write: (text, done) => (lines.push(text), done?.()), text: () => lines.join("") };
};

async function sweep(argv, host, extra = {}) {
	const stdout = sink();
	const stderr = sink();
	const code = await main(argv, { host, stdout, stderr, waitMs: 300, pollMs: 5, ...extra });
	return { code, out: stdout.text(), err: stderr.text() };
}

test("--before records every labelled machine; --after deletes only a run's new ones, reads each back gone, and leaves the rest", async () => {
	const fake = fakeHost({ lingers: { reads: 1, lists: 1 } });
	const old = fake.add({ labels: { ...OURS, ...RUN } });
	const file = join(DIR, "before.json");
	const before = await sweep(["--provider", "fakehost", "--before", file], fake.host);
	assert.equal(before.code, 0, before.err);
	assert.deepEqual(JSON.parse(before.out), { recorded: 1, file });
	assert.equal(JSON.parse(readFileSync(file, "utf8")).provider, "fakehost");
	const run = fake.add({ labels: { ...OURS, ...RUN } });
	const another = fake.add({ labels: { ...OURS, team: "someone-else" } });
	const unlabelled = fake.add({ labels: { ...RUN } });
	const after = await sweep(["--provider", "fakehost", "--after", file], fake.host);
	assert.equal(after.code, 0, after.err);
	assert.deepEqual(JSON.parse(after.out), { swept: 1, gone: 1, stillThere: [], leftAlone: 1 });
	assert.equal(run.deleted, true);
	for (const kept of [old, another, unlabelled]) assert.equal(kept.deleted, false, "never touched");
	assert.ok(!fake.calls.some(([name, id]) => name === "delete" && id !== run.id), "no call names another machine");
});

test("a machine still there after the wait is named, and the sweep exits 1", async () => {
	const fake = fakeHost({ lingers: { reads: 1_000_000, lists: 0 } });
	const file = join(DIR, "before-stuck.json");
	assert.equal((await sweep(["--provider", "fakehost", "--before", file], fake.host)).code, 0);
	const stuck = fake.add({ labels: { ...OURS, ...RUN } });
	const after = await sweep(["--provider", "fakehost", "--after", file], fake.host);
	assert.equal(after.code, 1);
	assert.deepEqual(JSON.parse(after.out), { swept: 1, gone: 0, stillThere: [stuck.id], leftAlone: 0 });
	assert.match(after.err, /still there after 0\.3 s/);
});

test("usage errors, a before file of another provider, and a provider not on the adapter exit 2 with nothing deleted", async () => {
	const fake = fakeHost();
	const victim = fake.add({ labels: { ...OURS, ...RUN } });
	const file = join(DIR, "other.json");
	writeFileSync(file, JSON.stringify({ provider: "modal", ids: [] }));
	for (const argv of [[], ["--provider", "fakehost"], ["--before", file], ["--provider", "fakehost", "--before", file, "--after", file], ["--provider", "fakehost", "--bogus", file], ["--provider", "fakehost", "--after", join(DIR, "missing.json")]]) {
		assert.equal((await sweep(argv, fake.host)).code, 2, JSON.stringify(argv));
	}
	const other = await sweep(["--provider", "fakehost", "--after", file], fake.host);
	assert.equal(other.code, 2);
	assert.match(other.err, /before file of "modal", not of fakehost/);
	const docker = await sweep(["--provider", "docker", "--before", join(DIR, "docker.json")], undefined);
	assert.equal(docker.code, 2);
	assert.match(docker.err, /not on the shared machine-host adapter/);
	assert.equal(victim.deleted, false);
});

test("sweepMachines over a run's label: what the conformance runner calls at a run's end", async () => {
	const fake = fakeHost();
	const left = fake.add({ labels: { ...OURS, ...RUN } });
	fake.add({ labels: { ...OURS, "agentrun.conformance": "another-run" } });
	const swept = await sweepMachines(fake.host, { labels: RUN, waitMs: 300, pollMs: 5 });
	assert.deepEqual(swept.value, { swept: 1, gone: 1, stillThere: [], leftAlone: 0 });
	assert.equal(left.deleted, true);
	assert.equal(fake.live().length, 1, "another run's machine is not this run's sweep's");
});

test("a provider that names where it lists (sweepScope: an app and a server): --before records it, and --after refuses a file of another place, or one that names none, before any list or delete", async () => {
	const fake = fakeHost();
	const scope = "the app computers on https://api.example.invalid:443";
	const file = join(DIR, "scoped.json");
	const before = await sweep(["--provider", "fakehost", "--before", file], fake.host, { scope });
	assert.equal(before.code, 0, before.err);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).scope, scope);
	const victim = fake.add({ labels: { ...OURS, ...RUN } });
	const { scope: _scope, ...unscoped } = JSON.parse(readFileSync(file, "utf8"));
	const bare = join(DIR, "unscoped.json");
	writeFileSync(bare, JSON.stringify(unscoped));
	for (const [what, path, now, pattern] of [
		["the settings name another app", file, "the app elsewhere on https://api.example.invalid:443", /was listed in the app computers on https:\/\/api\.example\.invalid:443, and the settings name the app elsewhere/],
		["the settings name another server", file, "the app computers on https://other.example.invalid:443", /and the settings name the app computers on https:\/\/other\.example\.invalid:443 now/],
		["the file names no place", bare, scope, /names no place it was listed in/],
	]) {
		fake.calls.length = 0;
		const ran = await sweep(["--provider", "fakehost", "--after", path], fake.host, { scope: now });
		assert.equal(ran.code, 2, `${what}: ${ran.err}`);
		assert.match(ran.err, pattern, what);
		assert.match(ran.err, /nothing was listed or deleted/, what);
		assert.equal(ran.out, "", what);
		assert.deepEqual(fake.calls.filter(([name]) => name === "list" || name === "delete"), [], `${what}: no list, no delete`);
	}
	assert.equal(victim.deleted, false, "every machine runs on");
	const same = await sweep(["--provider", "fakehost", "--after", file], fake.host, { scope });
	assert.equal(same.code, 0, same.err);
	assert.deepEqual(JSON.parse(same.out), { swept: 1, gone: 1, stillThere: [], leftAlone: 0 });
});
