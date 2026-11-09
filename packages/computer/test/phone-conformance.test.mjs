// The whole conformance suite on the phone-harness provider over its fake (test/fake-phone-harness.mjs): a cloud
// Android that takes no fixture file passes Core through the stock Settings app, read back in its UI tree. No port, no
// adb, no wall-clock wait on the provider's side.
import assert from "node:assert/strict";
import test from "node:test";
import { conformanceCases, formatReport, runConformance } from "../dist/index.js";
import { fakePhoneHarness, KEY } from "./fake-phone-harness.mjs";

const { create, memoryLedger } = await import("../dist/phone-harness.js");

const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasonOf = (report, id) => report.results.find((r) => r.id === id)?.reason ?? "";

test("a cloud Android with no fixture passes Core through Settings: tap, swipe, typing, the key table, apps and the UI tree", { timeout: 120_000 }, async () => {
	const fake = fakePhoneHarness();
	const options = { apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 };
	const provider = await create(options);
	const drifted = await create({ ...options, daemonVersion: "0.0.0-drift" });
	const report = await runConformance(provider, { image: "android", drifted: () => drifted, patience: 5000, cases: conformanceCases });
	assert.equal(report.core, "pass", formatReport(report));
	const got = statuses(report);
	for (const id of [
		"health.hello",
		"health.kind-consistent",
		"provider.create-release",
		"provider.list",
		"provider.stop",
		"drift.version",
		"screen.screenshot-size",
		"touch.tap",
		"touch.swipe",
		"input.type-text",
		"input.key-table-refuses-unknown",
		"apps.launch-terminate",
		"apps.ui-tree-shape",
	]) {
		assert.equal(got[id], "pass", `${id}: ${reasonOf(report, id)}`);
	}
	assert.equal(got["touch.pinch"], "skip");
	assert.match(reasonOf(report, "touch.pinch"), /^the provider refuses a pinch in words: action 0: pinch: a cloud Android takes one finger through adb/);
	for (const id of ["exec.argv", "files.home", "process.stdin", "apps.install-launch", "provider.deadline", "input.click-lands"]) {
		assert.equal(got[id], "skip", `${id} is not declared, so it skips: ${reasonOf(report, id)}`);
	}
	assert.deepEqual(report.cleanup.left, []);
	assert.equal(fake.sessions.size, 0, "every phone the run rented is ended");
});

test("--kind phone passes the phone harness: a pinch it refuses in words is a Full case, which no required group owes", { timeout: 120_000 }, async () => {
	const fake = fakePhoneHarness();
	const options = { apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 };
	const provider = await create(options);
	const drifted = await create({ ...options, daemonVersion: "0.0.0-drift" });
	const report = await runConformance(provider, { image: "android", kind: "phone", drifted: () => drifted, patience: 5000 });
	assert.equal(statuses(report)["touch.pinch"], "skip", "the run still tries the pinch, and says why it skipped");
	assert.deepEqual(report.kindVerdict, { kind: "phone", verdict: "pass", reasons: [] }, formatReport(report));
	assert.equal(fake.sessions.size, 0);
});

test("apps.launch-terminate fails a phone that launches nothing: the case is no pass by default", { timeout: 60_000 }, async () => {
	const fake = fakePhoneHarness({ launchNothing: true });
	const provider = await create({ apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 });
	const report = await runConformance(provider, { image: "android", patience: 1000, cases: conformanceCases.filter((c) => c.id === "apps.launch-terminate") });
	assert.equal(statuses(report)["apps.launch-terminate"], "fail");
	assert.match(reasonOf(report, "apps.launch-terminate"), /^com\.android\.settings in front after apps\.launch: still not so/);
	assert.equal(fake.sessions.size, 0);
});

test("apps.launch-terminate fails a phone whose apps.list says Settings is in front while its tree still shows the launcher", { timeout: 60_000 }, async () => {
	const fake = fakePhoneHarness({ launchHidden: true });
	const provider = await create({ apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 });
	const report = await runConformance(provider, { image: "android", patience: 1000, cases: conformanceCases.filter((c) => c.id === "apps.launch-terminate") });
	assert.equal(statuses(report)["apps.launch-terminate"], "fail");
	assert.match(reasonOf(report, "apps.launch-terminate"), /^com\.android\.settings shown after apps\.launch: Settings' list in apps\.ui_tree, not the screen before it/);
	assert.equal(fake.sessions.size, 0);
});
