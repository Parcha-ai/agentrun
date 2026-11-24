// The one live sweep (dist/conformance/sweep.js) against the adapter's fake host: --before records the labelled
// machines and mints the run's id, into a file that is not there yet, --after deletes only that run's new ones and reads each back gone, never touching one
// that was there before, one another user of the account made, or one of another conformance run. No vendor, no network.
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
const RUN = { "agentrun.conformance": "abc123abc123" };
/** The run label of the run a before file minted. */
const runOf = (file) => ({ "agentrun.conformance": JSON.parse(readFileSync(file, "utf8")).run });

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

test("--before records every labelled machine and mints the run's id; --after deletes only that run's new ones, reads each back gone, and leaves the rest", async () => {
	const fake = fakeHost({ lingers: { reads: 1, lists: 1 } });
	const old = fake.add({ labels: { ...OURS, ...RUN } });
	const file = join(DIR, "before.json");
	const before = await sweep(["--provider", "fakehost", "--before", file], fake.host);
	assert.equal(before.code, 0, before.err);
	const printed = JSON.parse(before.out);
	assert.match(printed.run, /^[0-9a-f]{12}$/, "the id the conformance CLI's --run takes");
	assert.deepEqual(printed, { recorded: 1, file, run: printed.run });
	const recorded = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual([recorded.provider, recorded.run], ["fakehost", printed.run]);
	const run = fake.add({ labels: { ...OURS, ...runOf(file) } });
	const another = fake.add({ labels: { ...OURS, team: "someone-else" } });
	const otherRun = fake.add({ labels: { ...OURS, "agentrun.conformance": "fedcba987654" } });
	const unlabelled = fake.add({ labels: { ...runOf(file) } });
	const after = await sweep(["--provider", "fakehost", "--after", file], fake.host);
	assert.equal(after.code, 0, after.err);
	assert.deepEqual(JSON.parse(after.out), { swept: 1, gone: 1, stillThere: [], leftAlone: 2 });
	assert.equal(run.deleted, true);
	for (const kept of [old, another, otherRun, unlabelled]) assert.equal(kept.deleted, false, "never touched");
	assert.ok(!fake.calls.some(([name, id]) => name === "delete" && id !== run.id), "no call names another machine");
});

test("two runs on one account, each between its own sweeps: one's --after never deletes the other's computers", async () => {
	const fake = fakeHost();
	const first = join(DIR, "first.json");
	const second = join(DIR, "second.json");
	assert.equal((await sweep(["--provider", "fakehost", "--before", first], fake.host)).code, 0);
	const a = fake.add({ labels: { ...OURS, ...runOf(first) } });
	assert.equal((await sweep(["--provider", "fakehost", "--before", second], fake.host)).code, 0);
	assert.notEqual(runOf(first)["agentrun.conformance"], runOf(second)["agentrun.conformance"], "each run its own id");
	const b = fake.add({ labels: { ...OURS, ...runOf(second) } });
	const after = await sweep(["--provider", "fakehost", "--after", first], fake.host);
	assert.equal(after.code, 0, after.err);
	assert.deepEqual(JSON.parse(after.out), { swept: 1, gone: 1, stillThere: [], leftAlone: 1 });
	assert.deepEqual([a.deleted, b.deleted], [true, false], "the second run's computer runs on");
});

test("--before never writes over a before file: a second --before into the same path exits 2 with nothing listed, and the first run's file is as it was", async () => {
	const fake = fakeHost();
	const file = join(DIR, "once.json");
	const first = await sweep(["--provider", "fakehost", "--before", file], fake.host);
	assert.equal(first.code, 0, first.err);
	const recorded = readFileSync(file, "utf8");
	const a = fake.add({ labels: { ...OURS, ...runOf(file) } });
	fake.calls.length = 0;
	const second = await sweep(["--provider", "fakehost", "--before", file], fake.host);
	assert.equal(second.code, 2, `the second --before into ${file} exited ${second.code}: ${second.out}${second.err}`);
	assert.match(second.err, /once\.json is there already, and --before never writes over a before file/);
	assert.match(second.err, /nothing was listed/);
	assert.equal(second.out, "");
	assert.equal(readFileSync(file, "utf8"), recorded, "the first run's before file, its run and its ids, as it was");
	assert.deepEqual(fake.calls.filter(([name]) => name === "list" || name === "delete"), [], "nothing listed, nothing deleted");
	const after = await sweep(["--provider", "fakehost", "--after", file], fake.host);
	assert.deepEqual(JSON.parse(after.out), { swept: 1, gone: 1, stillThere: [], leftAlone: 0 }, "the first run's --after still sweeps the first run");
	assert.equal(a.deleted, true);
});

test("a --before whose listing the vendor refused leaves no file behind, so the same path takes the next --before", async () => {
	const fake = fakeHost();
	const listing = fake.host.list;
	fake.host.list = async () => {
		throw new Error("503: the listing is down");
	};
	const file = join(DIR, "refused-listing.json");
	const refused = await sweep(["--provider", "fakehost", "--before", file], fake.host);
	assert.equal(refused.code, 2, refused.err);
	assert.match(refused.err, /so nothing was recorded/);
	assert.throws(() => readFileSync(file, "utf8"), { code: "ENOENT" }, "no before file is left");
	fake.host.list = listing;
	const again = await sweep(["--provider", "fakehost", "--before", file], fake.host);
	assert.equal(again.code, 0, again.err);
	assert.match(JSON.parse(readFileSync(file, "utf8")).run, /^[0-9a-f]{12}$/);
});

test("--after matches the run's id exactly: a label that only starts with it, or that it starts with, is another run's and left alone", async () => {
	const fake = fakeHost();
	const file = join(DIR, "prefix.json");
	assert.equal((await sweep(["--provider", "fakehost", "--before", file], fake.host)).code, 0);
	const { "agentrun.conformance": run } = runOf(file);
	const ours = fake.add({ labels: { ...OURS, "agentrun.conformance": run } });
	const longer = fake.add({ labels: { ...OURS, "agentrun.conformance": `${run}0` } });
	const shorter = fake.add({ labels: { ...OURS, "agentrun.conformance": run.slice(0, -1) } });
	const after = await sweep(["--provider", "fakehost", "--after", file], fake.host);
	assert.equal(after.code, 0, after.err);
	assert.deepEqual(JSON.parse(after.out), { swept: 1, gone: 1, stillThere: [], leftAlone: 2 });
	assert.deepEqual([ours.deleted, longer.deleted, shorter.deleted], [true, false, false], "only the run's own machine");
});

test("a machine still there after the wait is named, and the sweep exits 1", async () => {
	const fake = fakeHost({ lingers: { reads: 1_000_000, lists: 0 } });
	const file = join(DIR, "before-stuck.json");
	assert.equal((await sweep(["--provider", "fakehost", "--before", file], fake.host)).code, 0);
	const stuck = fake.add({ labels: { ...OURS, ...runOf(file) } });
	const after = await sweep(["--provider", "fakehost", "--after", file], fake.host);
	assert.equal(after.code, 1);
	assert.deepEqual(JSON.parse(after.out), { swept: 1, gone: 0, stillThere: [stuck.id], leftAlone: 0 });
	assert.match(after.err, /still there after 0\.3 s/);
});

test("usage errors, a before file of another provider or with no run, and a provider not on the adapter exit 2 with nothing deleted", async () => {
	const fake = fakeHost();
	const victim = fake.add({ labels: { ...OURS, ...RUN } });
	const file = join(DIR, "other.json");
	writeFileSync(file, JSON.stringify({ provider: "modal", ids: [], run: "abc123abc123" }));
	for (const argv of [[], ["--provider", "fakehost"], ["--before", file], ["--provider", "fakehost", "--before", file, "--after", file], ["--provider", "fakehost", "--bogus", file], ["--provider", "fakehost", "--after", join(DIR, "missing.json")]]) {
		assert.equal((await sweep(argv, fake.host)).code, 2, JSON.stringify(argv));
	}
	const other = await sweep(["--provider", "fakehost", "--after", file], fake.host);
	assert.equal(other.code, 2);
	assert.match(other.err, /before file of "modal", not of fakehost/);
	// A before file with no run, or one that is not an id --before mints, names no run to sweep: nothing is listed.
	for (const run of [undefined, "", "abc123", "ABC123ABC123", 7]) {
		const bare = join(DIR, "no-run.json");
		writeFileSync(bare, JSON.stringify({ provider: "fakehost", ids: [], ...(run === undefined ? {} : { run }) }));
		fake.calls.length = 0;
		const ran = await sweep(["--provider", "fakehost", "--after", bare], fake.host);
		assert.equal(ran.code, 2, `${JSON.stringify(run)}: ${ran.err}`);
		assert.match(ran.err, /names no conformance run \("run", 12 hex characters\): record it again with --before, and give the run it prints to the conformance CLI's --run/);
		assert.deepEqual(fake.calls.filter(([name]) => name === "list" || name === "delete"), [], "no list, no delete");
	}
	const docker = await sweep(["--provider", "docker", "--before", join(DIR, "docker.json")], undefined);
	assert.equal(docker.code, 2);
	assert.match(docker.err, /not on the shared machine-host adapter/);
	assert.equal(victim.deleted, false);
});

test("sweepMachines over a run's label: what the conformance runner calls at a run's end", async () => {
	const fake = fakeHost();
	const left = fake.add({ labels: { ...OURS, ...RUN } });
	fake.add({ labels: { ...OURS, "agentrun.conformance": "another-run" } });
	const swept = await sweepMachines(fake.host, { labels: RUN, run: RUN["agentrun.conformance"], waitMs: 300, pollMs: 5 });
	assert.deepEqual(swept.value, { swept: 1, gone: 1, stillThere: [], leftAlone: 0 });
	assert.equal(left.deleted, true);
	assert.equal(fake.live().length, 1, "another run's machine is not this run's sweep's");
});

test("sweepMachines with no run, or one that is not a run id, is invalid before any list or delete: it never matches the machines that carry no run label", async () => {
	const fake = fakeHost();
	const unlabelled = fake.add({ labels: { ...OURS } });
	for (const options of [{}, { run: undefined }, { run: "" }, { run: "another-run" }, { run: 7 }]) {
		fake.calls.length = 0;
		const swept = await sweepMachines(fake.host, { ...options, waitMs: 300, pollMs: 5 });
		assert.equal(swept.ok, false, JSON.stringify(options));
		assert.equal(swept.error.code, "invalid");
		assert.match(swept.error.message, /^run is a conformance run's id, 12 hex characters; got /);
		assert.deepEqual(fake.calls.filter(([name]) => name === "list" || name === "delete"), [], "no list, no delete");
	}
	assert.equal(unlabelled.deleted, false);
});

test("sweepMachines keeps to the run where the host's listing answers more machines than carry its label", async () => {
	const fake = fakeHost();
	const listing = fake.host.list;
	fake.host.list = (labels, ctx) => listing(OURS, ctx);
	const left = fake.add({ labels: { ...OURS, ...RUN } });
	const other = fake.add({ labels: { ...OURS, "agentrun.conformance": "another-run" } });
	const swept = await sweepMachines(fake.host, { labels: RUN, run: RUN["agentrun.conformance"], waitMs: 300, pollMs: 5 });
	assert.deepEqual(swept.value, { swept: 1, gone: 1, stillThere: [], leftAlone: 0 });
	assert.equal(left.deleted, true);
	assert.equal(other.deleted, false, "another run's machine is never deleted");
});

test("a provider that names where it lists (sweepScope: an app and a server): --before records it, and --after refuses a file of another place, or one that names none, before any list or delete", async () => {
	const fake = fakeHost();
	const scope = "the app computers on https://api.example.invalid:443";
	const file = join(DIR, "scoped.json");
	const before = await sweep(["--provider", "fakehost", "--before", file], fake.host, { scope });
	assert.equal(before.code, 0, before.err);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).scope, scope);
	const victim = fake.add({ labels: { ...OURS, ...runOf(file) } });
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
