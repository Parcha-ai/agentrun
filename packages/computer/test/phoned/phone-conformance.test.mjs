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

/** A provider over the fake phone harness whose phones run FakeMain for phoned, and a drifted twin of it. */
async function setup() {
	const fake = fakePhoneHarness({ startPhoned: () => startFakeMain().stream });
	const options = { apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000, phoned: PHONED_JAR };
	return { fake, provider: await create(options), drifted: await create({ ...options, daemonVersion: "0.0.0-drift" }) };
}

test("a cloud Android with phoned passes Core, and the kind's verdict is pass", { timeout: 300_000 }, async () => {
	const { fake, provider, drifted } = await setup();
	const report = await runConformance(provider, { image: "android", kind: "phone", drifted: () => drifted, patience: 10_000, cases: conformanceCases });
	assert.equal(report.core, "pass", formatReport(report));
	assert.deepEqual(report.kindVerdict, { kind: "phone", verdict: "pass", reasons: [] }, formatReport(report));
	const got = statuses(report);
	for (const id of ["health.hello", "health.kind-consistent", "provider.create-release", "provider.list", "drift.version", "screen.screenshot-size", "touch.tap", "touch.swipe", "input.type-text", "apps.launch-terminate", "ui.hello", "exec.argv"]) {
		assert.equal(got[id], "pass", `${id}: ${reasonOf(report, id)}\n${formatReport(report)}`);
	}
	assert.deepEqual(report.cleanup.left, []);
	assert.equal(fake.sessions.size, 0, "every phone the run rented is ended");
	assert.equal(fake.running().length, 0, "every phoned the run started has ended");
});
