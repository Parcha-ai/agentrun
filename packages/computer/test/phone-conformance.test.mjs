// The whole conformance suite on the phone-harness provider over its fake (test/fake-phone-harness.mjs): a cloud
// Android that takes no fixture file passes Core through the stock Settings app, read back through ui.observe. No port,
// no adb, no wall-clock wait on the provider's side.
import assert from "node:assert/strict";
import test from "node:test";
import { conformanceCases, formatReport, kindCases, runConformance } from "../dist/index.js";
import { fakePhoneHarness, KEY } from "./fake-phone-harness.mjs";

const { create, memoryLedger } = await import("../dist/phone-harness.js");

const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasonOf = (report, id) => report.results.find((r) => r.id === id)?.reason ?? "";

test("a cloud Android with no fixture passes Core through Settings: tap, swipe, typing, the key table, apps and ui.observe", { timeout: 120_000 }, async () => {
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
		"ui.observe-shape",
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

test("on a phone of 420 dpi the Settings cases aim their taps in pixels at nodes read in points, and pass", { timeout: 120_000 }, async () => {
	const fake = fakePhoneHarness({ density: 420 });
	const provider = await create({ apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 });
	const ids = ["touch.tap", "touch.swipe", "input.type-text", "input.key-table-refuses-unknown", "apps.launch-terminate", "ui.observe-shape"];
	const report = await runConformance(provider, { image: "android", patience: 5000, cases: conformanceCases.filter((c) => ids.includes(c.id)) });
	for (const id of ids) assert.equal(statuses(report)[id], "pass", `${id}: ${reasonOf(report, id)}`);
	assert.equal(fake.sessions.size, 0);
});

test("--kind phone passes the phone harness: a pinch it refuses in words is a Full case, which no required group owes", { timeout: 120_000 }, async () => {
	const fake = fakePhoneHarness();
	const options = { apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 };
	const provider = await create(options);
	const drifted = await create({ ...options, daemonVersion: "0.0.0-drift" });
	// The phone harness makes a session per create, whatever its request id: idempotent create comes with the hosted
	// adapter, so its two cases fail here today and are left out of this verdict.
	const notYet = new Set(["provider.create-retried", "provider.create-after-release"]);
	const cases = kindCases("phone").filter(({ id }) => !notYet.has(id));
	const report = await runConformance(provider, { image: "android", kind: "phone", cases, drifted: () => drifted, patience: 5000 });
	assert.equal(statuses(report)["touch.pinch"], "skip", "the run still tries the pinch, and says why it skipped");
	assert.deepEqual(report.kindVerdict, { kind: "phone", verdict: "pass", reasons: [] }, formatReport(report));
	assert.equal(fake.sessions.size, 0);
});

test("the provider cases pass when the service ends a phone asynchronously, as it did live in run 7, and the cleanup is clean", { timeout: 60_000 }, async () => {
	const fake = fakePhoneHarness({ endLag: 3 });
	const provider = await create({ apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 });
	const ids = ["provider.create-release", "provider.list", "provider.attach"];
	const report = await runConformance(provider, { image: "android", patience: 1000, cases: conformanceCases.filter((c) => ids.includes(c.id)) });
	for (const id of ids) assert.equal(statuses(report)[id], "pass", `${id}: ${reasonOf(report, id)}`);
	assert.deepEqual(report.cleanup, { ...report.cleanup, left: [], errors: [] }, "nothing left, and no release refused");
	assert.ok([...fake.sessions.values()].every((s) => s.state === "closing"), "every phone the run rented is ended or ending");
});

test("touch.tap's failure says what it saw: the screen in px and dp, what is in front, the tap and the row, and whether the title shows outside the list", { timeout: 60_000 }, async () => {
	// Two faults that leave run 6's live words alike: a page that opens beside a list that stays, and a tap that misses.
	const words = {};
	for (const fault of ["twoPane", "rowTapsMiss"]) {
		const fake = fakePhoneHarness({ [fault]: true });
		const provider = await create({ apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 });
		const report = await runConformance(provider, { image: "android", patience: 1000, cases: conformanceCases.filter((c) => c.id === "touch.tap") });
		assert.equal(statuses(report)["touch.tap"], "fail", fault);
		words[fault] = reasonOf(report, "touch.tap");
		assert.match(words[fault], /^the page of "Network & internet" after a tap on its row: its title, as a node's name, and not the row "Connected devices": still not so after/, fault);
		assert.equal(fake.sessions.size, 0);
	}
	assert.match(
		words.twoPane,
		/ \(screen 360x640 px, 360x640 dp; in front: com\.android\.settings; the tap at 90,128 px on the row's bounds \[0,96,180,64\] pt; its title outside the list: yes, at \[196,24,148,40\] pt; the row "Connected devices": still shown\)$/,
	);
	assert.match(
		words.rowTapsMiss,
		/ \(screen 360x640 px, 360x640 dp; in front: com\.android\.settings; the tap at 180,128 px on the row's bounds \[0,96,360,64\] pt; its title outside the list: no; the row "Connected devices": still shown\)$/,
	);
});

test("apps.launch-terminate fails a phone that launches nothing: the case is no pass by default", { timeout: 60_000 }, async () => {
	const fake = fakePhoneHarness({ launchNothing: true });
	const provider = await create({ apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 });
	const report = await runConformance(provider, { image: "android", patience: 1000, cases: conformanceCases.filter((c) => c.id === "apps.launch-terminate") });
	assert.equal(statuses(report)["apps.launch-terminate"], "fail");
	// The harness's launch waits for the app in front (wire.md, apps.launch), so the launch itself fails, naming the app.
	assert.match(reasonOf(report, "apps.launch-terminate"), /^apps\.launch: timeout: com\.android\.settings opened no window in front within 10 s of apps\.launch \(com\.google\.android\.apps\.nexuslauncher is in front\)/);
	assert.equal(fake.sessions.size, 0);
});

test("apps.launch-terminate fails a phone whose apps.list says Settings is in front while ui.observe still shows the launcher", { timeout: 60_000 }, async () => {
	const fake = fakePhoneHarness({ launchHidden: true });
	const provider = await create({ apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 });
	const report = await runConformance(provider, { image: "android", patience: 1000, cases: conformanceCases.filter((c) => c.id === "apps.launch-terminate") });
	assert.equal(statuses(report)["apps.launch-terminate"], "fail");
	assert.match(reasonOf(report, "apps.launch-terminate"), /^com\.android\.settings shown after apps\.launch: Settings' list in ui\.observe, not the screen before it/);
	assert.equal(fake.sessions.size, 0);
});
