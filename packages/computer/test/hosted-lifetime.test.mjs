// The hosted adapter's two vendor timers (src/hosted/provider.ts, src/host.ts): the backstop a janitor's host sets as its
// vendor's delete timer (MachineRequest.backstopAt), and the keepalive that holds off a vendor's idle timer
// (facts.idleMs, keepalive). The fake host (test/fake-host.mjs) runs both timers on a clock the test moves; the
// adapter's keepalive interval runs on node:test's mocked setInterval, moved with it. No wall-clock wait.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeHost } from "./fake-host.mjs";

const { HostedProvider } = await import("../dist/hosted/provider.js");
const { conformanceCases } = await import("../dist/conformance/index.js");
const { runConformance } = await import("../dist/conformance/index.js");

const MAX = "agentrun.computer.max-deadline";
const SPEC = { image: "img", lifetimeMs: 600_000, network: "none" };
const MINUTE = 60_000;
const dir = mkdtempSync(join(tmpdir(), "computer-lifetime-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, "a stand-in for computerd, linux/amd64\n");
test.after(() => rmSync(dir, { recursive: true, force: true }));
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 2_000 };

const provider = (fake, options = {}) => new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...options });
let requests = 0;
const create = (on) => on.create(SPEC, { requestId: `lifetime-${++requests}` });
const made = (result) => {
	assert.equal(result.ok, true, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
	return result.value;
};
/** The wall clock, plus what the test has moved it on by: what the fake host's timers read. */
function movedClock() {
	let moved = 0;
	return { now: () => Date.now() + moved, move: (ms) => (moved += ms) };
}
/** Moves the mocked setInterval on by ms, then lets what its callbacks started settle. */
async function tick(t, ms) {
	t.mock.timers.tick(ms);
	for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
}
const keepalives = (fake) => fake.calls.filter(([name]) => name === "keepalive").map(([, id]) => id);

test("create gives a janitor's host backstopAt, five minutes past the most the deadline may reach; with the server gone, the vendor's timer ends the machine there", async () => {
	const clock = movedClock();
	const fake = fakeHost({ facts: { lifetime: "janitor" }, backstop: true, clock });
	const before = Date.now();
	const ref = made(await create(provider(fake, { maxLifetimeMs: 2 * 3_600_000 })));
	const machine = fake.machines.get(ref.id);
	const at = machine.request.backstopAt;
	assert.equal(new Date(Date.parse(at)).toISOString(), at, "an ISO time, as the deadline labels are");
	assert.equal(Date.parse(at) - Date.parse(machine.labels[MAX]), 5 * MINUTE, "five minutes past the most extend may move the deadline to");
	assert.ok(Date.parse(at) >= before + 2 * 3_600_000 + 5 * MINUTE, "past create + maxLifetimeMs, the provider's cap");
	// No release and no janitor from here: only the vendor's own timer ends it.
	const ctx = { timeoutMs: 1_000 };
	clock.move(Date.parse(at) - clock.now() - 1_000);
	assert.equal((await fake.host.get(ref.id, ctx))?.state, "running", "a second before its backstop");
	clock.move(1_000);
	assert.equal(await fake.host.get(ref.id, ctx), undefined, "at its backstop the vendor has ended it");
	assert.deepEqual(fake.events.filter(({ what }) => what.startsWith("ended")), [{ machine: ref.id, what: "ended (backstop)" }]);
});

test("a host that declares an idle timer and no keepalive is refused when the provider is made, in words; so is an idleMs that is not a whole number of ms", () => {
	const quiet = fakeHost({ facts: { idleMs: 5 * MINUTE } });
	assert.throws(() => provider(quiet), {
		message: "Fakehost declares an idle timer (facts.idleMs 300000) and no keepalive, so a quiet computer would end under its run: give the host keepalive, the vendor's call that restarts the timer",
	});
	assert.throws(() => provider(fakeHost({ facts: { idleMs: 1.5 }, keepalive: true })), { message: "facts.idleMs must be a whole number of ms above 0 and at most 2147483647, not 1.5" });
	assert.doesNotThrow(() => provider(fakeHost({ facts: { idleMs: 5 * MINUTE }, keepalive: true })));
});

test("keepalive every idleMs / 3 from create, through a closed connection (a park's keep), until release: one that fails is told and the next tries again; none after the delete", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const notes = [];
	const fake = fakeHost({ facts: { idleMs: 30_000 }, keepalive: true, keepaliveFails: 1 });
	const on = provider(fake, { onNote: (note) => notes.push(note) });
	const ref = made(await create(on));
	assert.deepEqual(keepalives(fake), [], "none before the first third of the window");
	await tick(t, 10_000);
	assert.deepEqual(keepalives(fake), [ref.id], "the first, 10 s after create");
	assert.deepEqual(notes, [{ computer: ref.name, note: `the keepalive of ${ref.name} failed: 503: the timer service is busy; the next keepalive tries again in 10 s` }]);
	assert.equal(fake.live().length, 1, "a failed keepalive tears nothing down");
	await tick(t, 10_000);
	assert.equal(keepalives(fake).length, 2, "the next tries again");
	// What a parked run does: its connection closed, the computer kept, nothing released.
	const connection = made(await on.connect(ref));
	await connection.close();
	await tick(t, 10_000);
	await tick(t, 10_000);
	assert.equal(keepalives(fake).length, 4, "the computer is held with no connection open");
	made(await on.release(ref, "delete"));
	await tick(t, 60_000);
	assert.equal(keepalives(fake).length, 4, "none after release");
	const deleted = fake.calls.findIndex(([name]) => name === "delete");
	assert.ok(fake.calls.findLastIndex(([name]) => name === "keepalive") < deleted, "every keepalive came before the delete");
	assert.equal(notes.length, 1);
});

test("attach keeps a computer it did not make alive (a restarted server); a create that gives up deletes its machine with no keepalive after; a machine the vendor ended stops it", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const fake = fakeHost({ facts: { idleMs: 30_000 }, keepalive: true });
	const ref = made(await create(provider(fake)));
	const restarted = provider(fake);
	await tick(t, 10_000);
	assert.deepEqual(keepalives(fake), [ref.id], "the first provider's, before the restart is attached");
	made(await restarted.attach({ id: ref.id }));
	await tick(t, 10_000);
	assert.deepEqual(keepalives(fake), [ref.id, ref.id, ref.id], "both providers hold it now");
	fake.vanish(ref.id);
	await tick(t, 10_000);
	await tick(t, 30_000);
	assert.equal(keepalives(fake).length, 5, "one more from each, which reads it not found, then none");

	const failing = fakeHost({ facts: { idleMs: 30_000 }, keepalive: true, install: 1 });
	assert.equal((await create(provider(failing))).ok, false, "the install fails, so create gives up and deletes the machine");
	await tick(t, 60_000);
	assert.deepEqual(keepalives(failing), [], "no keepalive of the deleted machine");
});

test("lifetime.idle on the hosted adapter, a 5 min vendor idle timer on the run's clock: a host with idleMs and keepalive passes; one without fails in the case's words", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const cases = conformanceCases.filter((one) => one.id === "lifetime.idle");
	const run = async (facts, keepalive) => {
		const moved = movedClock();
		// The case's 6 min sleep, moved in steps of 10 s, so each keepalive lands at its time on the fake's clock.
		const clock = {
			now: moved.now,
			sleep: async (ms) => {
				for (let left = Math.max(0, ms); left > 0; left -= 10_000) {
					moved.move(Math.min(10_000, left));
					await tick(t, Math.min(10_000, left));
				}
			},
		};
		const fake = fakeHost({ facts, keepalive, idle: 5 * MINUTE, clock });
		const report = await runConformance(provider(fake), { image: "img", cases, clock, long: true, cleanupTimeoutMs: 2_000, caseTimeoutMs: 20_000 });
		return report.results[0];
	};
	const kept = await run({ idleMs: 5 * MINUTE }, true);
	assert.equal(kept.status, "pass", kept.reason);
	const ended = await run({}, false);
	assert.equal(ended.status, "fail");
	assert.match(ended.reason, /^after 6 min with no call, well inside its lifetime: still listed, running \(a vendor's idle timer ends a quiet computer under the run: turn it off, or keep the computer busy\): expected \[\["computer-[0-9a-f]{12}","running"\]\], got \[\]/);
});
