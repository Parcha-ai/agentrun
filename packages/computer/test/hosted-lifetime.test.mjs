// The hosted adapter and two vendor timers (src/hosted/provider.ts, src/host.ts): the backstop a janitor's host sets as
// its vendor's delete timer (MachineRequest.backstopAt), and an idle timer, which a host switches off and lifetime.idle
// catches. The fake host (test/fake-host.mjs) runs both timers on a clock the test moves. No wall-clock wait.
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

test("lifetime.idle on the hosted adapter, on the run's clock: a host whose vendor has no idle timer passes; one whose vendor ends a machine quiet for 5 min fails in the case's words", async () => {
	const cases = conformanceCases.filter((one) => one.id === "lifetime.idle");
	const run = async (idle) => {
		const moved = movedClock();
		const clock = { now: moved.now, sleep: async (ms) => moved.move(Math.max(0, ms)) };
		const report = await runConformance(provider(fakeHost({ idle, clock })), { image: "img", cases, clock, long: true, cleanupTimeoutMs: 2_000, caseTimeoutMs: 20_000 });
		return report.results[0];
	};
	const off = await run(undefined);
	assert.equal(off.status, "pass", off.reason);
	const ended = await run(5 * MINUTE);
	assert.equal(ended.status, "fail");
	assert.match(ended.reason, /^after 6 min with no call, well inside its lifetime: still listed, running \(a vendor's idle timer ends a quiet computer under the run: turn it off, or keep the computer busy\): expected \[\["computer-[0-9a-f]{12}","running"\]\], got \[\]/);
});
