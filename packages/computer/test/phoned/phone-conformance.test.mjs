// The whole conformance suite on the phone-harness provider, with phoned's real core (FakeMain, over its scripted
// phone) answering where a phone's phoned would: the provider pushes the jar and starts phoned through the fake adb, and
// every case runs against the Java code that runs on a phone. Run by `npm run test:phoned`, which builds FakeMain first.
import assert from "node:assert/strict";
import test from "node:test";
import { conformanceCases, formatReport, runConformance } from "../../dist/index.js";
import { fakePhoneHarness, KEY, PHONED_JAR } from "../fake-phone-harness.mjs";
import { startFakeMain } from "./fake-main.mjs";

const { create, memoryLedger } = await import("../../dist/phone-harness.js");

const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasonOf = (report, id) => report.results.find((r) => r.id === id)?.reason ?? "";

/**
 * The wall clock, with every wait cut to a few milliseconds: FakeMain's phone keeps real time, and the suite checks a
 * computer's deadline against Date.now(), so the provider's clock must not run ahead of it as a fake clock's sleeps do.
 */
const clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) };

/** A provider over the fake phone harness whose phones run FakeMain for phoned, and a drifted twin of it. */
async function setup() {
	const fake = fakePhoneHarness({ startPhoned: () => startFakeMain().stream, clock });
	const options = { apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: clock.now, sleep: clock.sleep, maxLifetimeMs: 10 * 60_000, phoned: PHONED_JAR };
	return { fake, provider: await create(options), drifted: await create({ ...options, daemonVersion: "0.0.0-drift" }) };
}

test("a cloud Android with phoned passes the phone kind, the ui fixture's Full cases with it", { timeout: 300_000 }, async () => {
	const { fake, provider, drifted } = await setup();
	const report = await runConformance(provider, { image: "android", kind: "phone", drifted: () => drifted, patience: 10_000, cases: conformanceCases });
	// A run by kind leaves out the Core cases of groups a phone does not offer (exec, files, process): partial, with
	// every case that ran passed. The kind's verdict is the phone's.
	assert.equal(report.core, "partial", formatReport(report));
	assert.ok(report.coreNotRun.every((id) => /^(exec|files|process)\./.test(id) || ["provider.deadline", "drift.arch", "isolation.vendor-agent", "input.click-lands", "input.actions-stops-at-first-failure", "apps.install-launch"].includes(id)), report.coreNotRun.join(" "));
	assert.deepEqual(report.kindVerdict, { kind: "phone", verdict: "pass", reasons: [] }, formatReport(report));
	const got = statuses(report);
	const ui = ["ui.fixture-shape", "ui.refs-stable", "ui.expect", "ui.stale-ref", "ui.stale-point", "ui.route-reported", "ui.features-declared", "ui.features-off-refused"];
	for (const id of ["health.hello", "health.kind-consistent", "provider.create-release", "provider.list", "drift.version", "screen.screenshot-size", "touch.tap", "touch.swipe", "input.type-text", "input.key-table-refuses-unknown", "apps.launch-terminate", "ui.observe-shape", "ui.hello", ...ui]) {
		assert.equal(got[id], "pass", `${id}: ${reasonOf(report, id)}\n${formatReport(report)}`);
	}
	assert.deepEqual(report.cleanup.left, []);
	assert.equal(fake.sessions.size, 0, "every phone the run rented is ended");
	assert.equal(fake.running().length, 0, "every phoned the run started has ended");
});
