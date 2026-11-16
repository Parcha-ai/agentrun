// The shared adapter over a host that keeps no labels (HostFacts.labels "machine"): the adapter writes a machine's labels
// to a root-only file in it right after it runs, reads them back from there, rewrites them on extend, and sweeps a
// request's machine with no file only by the request's own name and once it is older than any create's write. The
// fake host plays such a vendor: it keeps the name create gave, answers no labels, and lists every machine.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computerNameFor as nameOf } from "../dist/index.js";
import { deferred, fakeHost, LABEL_FILE } from "./fake-host.mjs";

const { HostedProvider } = await import("../dist/hosted/provider.js");
const SCRIPTS = await import("../dist/hosted/scripts.js");
const { conformanceCases, runConformance } = await import("../dist/index.js");

const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DEADLINE = "agentrun.computer.deadline";
const MAX = "agentrun.computer.max-deadline";
const SPEC = { image: "img", lifetimeMs: 600_000, network: "none" };
const KEEPS = { facts: { labels: "machine" } };
const dir = mkdtempSync(join(tmpdir(), "computer-hosted-labels-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, "a stand-in for computerd, linux/amd64\n");
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Short bounds, so the waits in these tests take milliseconds. */
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 2_000 };
/** What a machine with no label file must be older than before a sweep takes it, with TIMEOUTS: 2 createMs, listMs, requestMs, execMs and the 300 s margin. */
const UNFILED_MS = 2 * 2_000 + 2_000 + 2_000 + 2_000 + 300_000;

const provider = (host, options = {}) => new HostedProvider(host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...options });
let requests = 0;
const made = (result) => {
	assert.equal(result.ok, true, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
	return result.value;
};
const fileOf = (m) => (m.file === undefined ? undefined : JSON.parse(m.file));
const reads = (fake) => (fake.labelRuns ?? []).filter((run) => !run.write).length;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
/** Another instance's view of host: its first listing doesn't show the machine yet, and the vendor fails its create after it may have made one (a 502), so it sweeps the request's name. */
const lagging = (host) => {
	let listed = false;
	return { ...host, list: async (...args) => (listed ? host.list(...args) : ((listed = true), [])), create: async () => Promise.reject(new Error("502: Bad Gateway")) };
};

test("a host that keeps no labels has them written to a root-only file once the machine runs, before anything else of the create's, and read back from there", async () => {
	const fake = fakeHost(KEEPS);
	const hosted = provider(fake.host);
	const requestId = `keeps-${++requests}`;
	const ref = made(await hosted.create({ ...SPEC, labels: { run: "r1" } }, { requestId }));
	const [m] = fake.machines.values();
	assert.equal(m.name, nameOf(requestId), "the machine has the request's name, its native name");
	assert.deepEqual((await fake.host.get(m.id, { timeoutMs: 1_000 })).labels, {}, "the vendor answers no labels");
	const file = fileOf(m);
	assert.equal(file[COMPUTER], "1");
	assert.equal(file[NAME], ref.name);
	assert.equal(file.run, "r1");
	assert.ok(file[DEADLINE] && file[MAX], "the deadline and the most it may move to are in the file");
	assert.deepEqual(fake.labelRuns.filter((run) => run.write), [{ machine: m.id, path: LABEL_FILE, write: true }], "one write, at the label file");
	const steps = fake.calls.map(([step]) => step);
	assert.ok(steps.indexOf("exec labels") < steps.indexOf("upload"), "the file is written before the daemon's upload");
	assert.ok(steps.indexOf("exec labels") < steps.indexOf("exec install"), "and before its install");
	// list and attach read the labels from the file; a get poll reads them once and then as last read.
	const listed = made(await hosted.list({ run: "r1" }));
	assert.deepEqual(listed.map((info) => info.ref), [{ id: ref.id, name: ref.name }]);
	assert.equal(listed[0].labels.run, "r1");
	assert.deepEqual(made(await hosted.list({ run: "other" })), []);
	const before = reads(fake);
	for (let i = 0; i < 3; i++) (await hosted.connect(ref)).value.client.close();
	assert.equal(reads(fake), before, "a computer's connects read no file: its labels are as written");
	assert.equal(made(await hosted.attach({ labels: { run: "r1" } })).id, ref.id);
	// No bound on the labels but what a run's output keeps, the file read back whole: 64 KiB as JSON.
	const many = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`label-${i}`, "x".repeat(200)]));
	assert.deepEqual(hosted.check({ ...SPEC, labels: many }), []);
	const past = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`label-${i}`, "x".repeat(200)]));
	const [over] = hosted.check({ ...SPEC, labels: past });
	assert.match(over?.message ?? "", /keeps its labels in the machine, at most 65536 bytes as JSON, and this computer's would come to \d+/);
	const refused = await hosted.create({ ...SPEC, labels: past }, { requestId: `keeps-past-${++requests}` });
	assert.equal(refused.ok, false);
	assert.equal(fake.machines.size, 1, "refused before the vendor makes a machine");
	made(await hosted.release(ref, "delete"));
	assert.equal(m.deleted, true);
});

test("a machine of the account that is not the adapter's (another name, no file) is never listed, attached or counted as a computer", async () => {
	const fake = fakeHost(KEEPS);
	const stranger = fake.add({ name: "someone-elses" });
	const nameless = fake.add({});
	const hosted = provider(fake.host);
	const ref = made(await hosted.create(SPEC, { requestId: `keeps-${++requests}` }));
	assert.deepEqual(made(await hosted.list({})).map((info) => info.ref.id), [ref.id]);
	for (const m of [stranger, nameless]) assert.equal((await hosted.attach({ id: m.id })).error?.code, "not_found", `attach ${m.id}`);
	assert.match(made(await hosted.testConnection()).detail, /answered: 1 computer of this provider/, "the test counts the one computer, by its name");
	assert.equal(stranger.deleted || nameless.deleted, false);
});

test("the label script, run by sh: write replaces the file from stdin, 0600 in a 0700 directory, and prints it; a read prints it, or exits 3 when there is none, and two writers never share a file", async () => {
	const root = mkdtempSync(join(tmpdir(), "computer-labels-"));
	try {
		// Not root here: the script reaches root through sudo -n, which this stand-in runs as it is, and chown is a no-op.
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "sudo"), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n', { mode: 0o755 });
		writeFileSync(join(bin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const env = { PATH: `${bin}:${process.env.PATH}` };
		const file = join(root, "var", "lib", "agentrun", "labels.json");
		const at = (argv) => [...argv.slice(0, 4), file, ...argv.slice(5)];
		assert.equal(SCRIPTS.LABEL_FILE, LABEL_FILE, "under /var/lib, on the machine's disk");
		assert.deepEqual(SCRIPTS.labelsCommand(17).slice(4), [LABEL_FILE, "write", "17"]);
		assert.deepEqual(SCRIPTS.labelsCommand().slice(4), [LABEL_FILE]);
		const read = at(SCRIPTS.labelsCommand());
		assert.equal(spawnSync(read[0], read.slice(1), { env }).status, 3, "no file: exit 3");
		const write = (text) => at(SCRIPTS.labelsCommand(Buffer.byteLength(text)));
		const text = JSON.stringify({ [COMPUTER]: "1", [NAME]: "computer-0123456789ab" });
		assert.equal(execFileSync(write(text)[0], write(text).slice(1), { env, input: text, encoding: "utf8" }), text, "the write prints the file it wrote");
		assert.equal(statSync(join(root, "var", "lib", "agentrun")).mode & 0o777, 0o700, "the directory is root's alone");
		assert.equal(statSync(file).mode & 0o777, 0o600, "the file is root's alone");
		assert.equal(execFileSync(read[0], read.slice(1), { env, encoding: "utf8" }), text);
		execFileSync(write("{}")[0], write("{}").slice(1), { env, input: "{}", encoding: "utf8" });
		assert.equal(readFileSync(file, "utf8"), "{}", "a write replaces it");
		// Its length is read, so stdin needs no end: a write whose stdin stays open still ends, the file written.
		const open = spawn(write(text)[0], write(text).slice(1), { env });
		open.stdin.write(text);
		assert.equal(await new Promise((done) => open.on("close", done)), 0, "stdin left open");
		open.stdin.destroy();
		assert.equal(readFileSync(file, "utf8"), text);
		// A stdin that ends short writes nothing.
		assert.equal(spawnSync(write(text)[0], write(text).slice(1), { env, input: text.slice(0, 10) }).status, 5, "short: exit 5");
		assert.equal(readFileSync(file, "utf8"), text, "and the file is left as it was");
		// Two writers at once (two instances' extends): the second starts and ends while the first is half written, and
		// each renames in its own whole file.
		const writer = (text) => {
			const child = spawn(write(text)[0], write(text).slice(1), { env });
			// Each prints the file it wrote: read it, so a long one never fills the pipe.
			child.stdout.resume();
			return { child, code: new Promise((done) => child.on("close", done)) };
		};
		const long = JSON.stringify({ [COMPUTER]: "1", [DEADLINE]: "a".repeat(200_000) });
		const first = writer(long);
		first.child.stdin.write(long.slice(0, 100_000));
		// The first is half written: its own file beside the label file holds bytes (head writes whole blocks of what it read).
		const dir = join(root, "var", "lib", "agentrun");
		const half = () => readdirSync(dir).some((name) => name.startsWith("labels.json.") && statSync(join(dir, name)).size > 0);
		for (let at = 0; at < 250 && !half(); at++) await pause(20);
		assert.equal(half(), true, "the first writer has half its file written");
		const second = writer(text);
		second.child.stdin.end(text);
		assert.equal(await second.code, 0, "the second writer");
		first.child.stdin.end(long.slice(100_000));
		assert.equal(await first.code, 0, "the first writer");
		assert.equal(readFileSync(file, "utf8"), long, "the last rename's whole file, never a mix");
		assert.deepEqual(readdirSync(join(root, "var", "lib", "agentrun")), ["labels.json"], "no writer's file is left beside it");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("two instances, one request: a sweep of the request's name leaves another instance's machine with no labels written yet, and takes it once it is older than any create's write", async () => {
	const gate = deferred();
	const held = deferred();
	let holding = false;
	// Instance A's create stops at its first label run, the machine made and running and no file in it yet.
	const fake = fakeHost({
		...KEEPS,
		onStep: async (step) => {
			if (step !== "exec labels" || holding) return;
			holding = true;
			held.resolve();
			await gate.promise;
		},
	});
	const requestId = `two-instances-${++requests}`;
	const a = provider(fake.host).create(SPEC, { requestId });
	await held.promise;
	const [mine] = fake.machines.values();
	assert.equal(mine.name, nameOf(requestId));
	assert.equal(mine.file, undefined, "A's machine has no label file yet");
	// Instance B's create of the same request, whose listing doesn't show A's machine yet: the vendor fails it after it
	// may have made a machine (a 502), so B sweeps the request's name, the late sweep #2913 holds to.
	const b = await provider(lagging(fake.host)).create(SPEC, { requestId });
	assert.equal(b.ok, false);
	assert.equal(b.error.code, "vendor");
	assert.match(b.error.message, new RegExp(`1 machine named ${nameOf(requestId)} with no labels written yet, younger than ${UNFILED_MS / 1000} s, left: another create of this request may still be making it`));
	assert.equal(mine.deleted, false, "B's sweep leaves A's machine alone");
	// A machine of another request's name with no file, however old, is never this request's.
	const other = fake.add({ name: nameOf(`another-${requestId}`) });
	other.createdAt = new Date(Date.now() - 2 * UNFILED_MS);
	// Past the guard with still no file: instance C's create of the request lists it, never got its labels, and takes it.
	mine.createdAt = new Date(Date.now() - UNFILED_MS - 1_000);
	const c = await provider(fake.host).create(SPEC, { requestId });
	assert.equal(c.ok, false);
	assert.equal(c.error.code, "exists");
	assert.match(c.error.message, new RegExp(`${nameOf(requestId)} was made for this request and its labels were never written: create with a new request id; the machine named .* ${mine.id} was deleted and read back gone`));
	assert.equal(mine.deleted, true, "the old machine with no file is swept");
	assert.equal(other.deleted, false, "a machine of another name is left");
	gate.resolve();
	assert.equal((await a).ok, false, "A's create finds its machine gone");
});

test("a retry of a request on another instance, while the first create has not written its labels yet, waits for them and answers that computer: no second machine", async () => {
	const gate = deferred();
	const held = deferred();
	const waiting = deferred();
	let holding = false;
	let gets = 0;
	const fake = fakeHost({
		...KEEPS,
		onStep: async (step) => {
			// B's reads of A's machine once A is held: its listing reads it once, and from the third B is waiting for
			// its labels, past the one point where it could make a machine of its own.
			if (step === "get" && holding && ++gets === 3) waiting.resolve();
			if (step !== "exec labels" || holding) return;
			holding = true;
			held.resolve();
			await gate.promise;
		},
	});
	const requestId = `retry-unwritten-${++requests}`;
	const a = provider(fake.host).create(SPEC, { requestId });
	await held.promise;
	const b = provider(fake.host).create(SPEC, { requestId });
	await waiting.promise;
	assert.equal(fake.machines.size, 1, "B makes no machine of its own while A's has no labels");
	gate.resolve();
	const [first, second] = [made(await a), made(await b)];
	assert.equal(second.id, first.id, "B answers A's computer");
	assert.equal(fake.machines.size, 1);
});

test("a running machine whose label file reads as no label map fails the listing in words: it is never left out as a machine with no labels", async () => {
	const fake = fakeHost(KEEPS);
	const hosted = provider(fake.host);
	const ref = made(await hosted.create(SPEC, { requestId: `unreadable-${++requests}` }));
	const [m] = fake.machines.values();
	m.file = "not a label map";
	const listed = await provider(fake.host).list({});
	assert.equal(listed.ok, false, "a fresh instance can't read the file, so its listing fails");
	assert.equal(listed.error.code, "vendor");
	assert.match(listed.error.message, new RegExp(`reading the labels in ${ref.id} failed \\(exit 0\\): not a label map`));
});

test("a machine of the request's name with no file and no createdAt is never old enough: a sweep leaves it, for the vendor's timer", async () => {
	const fake = fakeHost({ ...KEEPS, born: () => undefined });
	const requestId = `undated-${++requests}`;
	const left = fake.add({ name: nameOf(requestId) });
	const result = await provider(lagging(fake.host)).create(SPEC, { requestId });
	assert.match(result.error.message, /1 machine named .* with no labels written yet, younger than/);
	assert.equal(left.deleted, false);
});

test("a host that keeps no labels needs a vendor timer: lifetime vendor, or a janitor's backstop; a janitor without one is refused, naming both", () => {
	assert.throws(() => provider(fakeHost({ facts: { labels: "machine", lifetime: "janitor" } }).host), {
		message:
			'Fakehost keeps no labels (facts.labels "machine"), so a vendor timer must end its machines: a machine whose create stopped before its labels were written has none the janitor lists. Declare lifetime "vendor", or set the vendor\'s delete timer from req.backstopAt and declare backstop: true',
	});
	assert.doesNotThrow(() => provider(fakeHost({ facts: { labels: "machine", lifetime: "janitor", backstop: true } }).host));
});

test("extend rewrites the file's deadline after the vendor's timer moves; with a timer the host can't move, there is no extend", async () => {
	for (const [what, options, has] of [
		["a vendor timer", { facts: { labels: "machine" } }, true],
		["a vendor timer the host cannot move", { facts: { labels: "machine" }, timer: "none" }, false],
	]) {
		const fake = fakeHost(options);
		const hosted = provider(fake.host);
		assert.equal(typeof hosted.extend === "function", has, `${what}: extend`);
		const ref = made(await hosted.create(SPEC, { requestId: `extend-${++requests}` }));
		const [m] = fake.machines.values();
		if (!has) {
			assert.equal(fileOf(m)[MAX], undefined, `${what}: no most it may move to`);
			continue;
		}
		const { deadline } = made(await hosted.extend(ref, 1_200_000));
		assert.equal(fileOf(m)[DEADLINE], deadline.toISOString(), `${what}: the file holds the new deadline`);
		assert.equal(m.init.deadline, deadline.toISOString(), `${what}: init's deadline follows`);
		// Another instance reads the deadline the file holds, and moves it on from there.
		const second = provider(fake.host);
		assert.equal(made(await second.list({}))[0].deadline.toISOString(), deadline.toISOString(), `${what}: listed by another instance`);
		const later = made(await second.extend(ref, 1_800_000)).deadline;
		assert.equal(fileOf(m)[DEADLINE], later.toISOString());
		assert.match((await hosted.extend(ref, 1_500_000)).error?.message ?? "", /earlier than/, `${what}: the first instance reads the file now, not as it last wrote it`);
	}
});

test("a host that keeps no labels passes the provider cases a labelled host passes, case by case, the isolation of its label file among them, and leaves nothing behind", async () => {
	const cases = conformanceCases.filter((c) => (c.group === "provider" && c.id !== "provider.deadline") || c.id === "isolation.label-file");
	const run = async (facts) => {
		const report = await runConformance(provider(fakeHost({ facts }).host), { image: "img", cases, caseTimeoutMs: 20_000, cleanupTimeoutMs: 5_000 });
		return { statuses: report.results.map(({ id, status }) => [id, status]), cleanup: report.cleanup };
	};
	const [labelled, kept] = [await run({}), await run({ labels: "machine" })];
	assert.deepEqual(kept.statuses, labelled.statuses, "the same results");
	for (const id of ["provider.create-retried", "provider.create-after-release", "provider.list", "provider.release-older", "isolation.label-file"]) {
		assert.ok(kept.statuses.some(([one, status]) => one === id && status === "pass"), `${id} passes`);
	}
	assert.deepEqual(kept.cleanup.left, [], "nothing left");
	assert.deepEqual(kept.cleanup.sweep.stillThere, [], "the end-of-run sweep finds its label in the files");
});
