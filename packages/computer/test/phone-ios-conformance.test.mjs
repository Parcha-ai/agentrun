// The conformance suite on the phone-harness provider's cloud iPhone (machine ios), over its fakes
// (test/fake-phone-harness.mjs, test/fake-iphone.mjs): an iPhone that declares screen, input.touch and apps, with no
// tree, no keys, no terminate and no fixture, passes Core and --kind phone through the stock Settings app and the
// screen. On the owner's iPhone, which is never wiped, the run only navigates: it launches, scrolls and goes home, and
// changes no setting.
import assert from "node:assert/strict";
import test from "node:test";
import { conformanceCases, formatReport, runConformance } from "../dist/index.js";
import { fakePhoneHarness, IPHONE_ID, KEY } from "./fake-phone-harness.mjs";

const { create, memoryLedger } = await import("../dist/phone-harness.js");

const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasonOf = (report, id) => report.results.find((r) => r.id === id)?.reason ?? "";
/** The ops a run on the owner's iPhone may send: looking, launching, scrolling and going home. */
const NAVIGATION = new Set(["screen.capture", "apps.list", "apps.current", "apps.launch", "input.drag", "nav.home"]);

/**
 * The fake account holds one iPhone, which one session at a time holds (409 profile_running), as the docs say. The
 * provider declares maxComputers 1, so the runner ends the run's shared computer before a case that makes its own, and a
 * case that holds two at once skips in words, owed to maxComputers.
 */
async function iphoneProvider(fakeOptions = {}) {
	const fake = fakePhoneHarness({ iphones: [IPHONE_ID], ...fakeOptions });
	const options = { apiKey: KEY, platform: "ios", fetch: fake.fetch, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 };
	return { fake, provider: await create(options), drifted: await create({ ...options, daemonVersion: "0.0.0-drift" }) };
}

test("a cloud iPhone, one session at a time, passes Core through Settings and the screen; two-at-once cases and what it does not declare skip in words", { timeout: 120_000 }, async () => {
	const { fake, provider, drifted } = await iphoneProvider();
	const report = await runConformance(provider, { image: "ios", drifted: () => drifted, patience: 5000, cases: conformanceCases });
	assert.equal(report.core, "pass", formatReport(report));
	const got = statuses(report);
	for (const id of ["health.hello", "health.kind-consistent", "provider.create-release", "provider.list", "provider.stop", "provider.network-change", "drift.version", "screen.screenshot-size", "touch.swipe", "apps.launch"]) {
		assert.equal(got[id], "pass", `${id}: ${reasonOf(report, id)}`);
	}
	for (const [id, n] of [
		["provider.attach", 2],
		["provider.release-older", 4],
	]) {
		const r = report.results.find((one) => one.id === id);
		assert.deepEqual([r.status, r.reason, r.undeclared], ["skip", `the case holds ${n} computers at once, and the provider holds at most 1 (maxComputers)`, [`computers:${n}`]], id);
	}
	assert.equal(report.results.filter((r) => r.status === "fail").length, 0, formatReport(report));
	assert.equal(got["touch.tap"], "skip");
	assert.equal(reasonOf(report, "touch.tap"), "no way to observe a tap on this phone: it declares neither files nor apps.ui_tree");
	const tap = report.results.find((r) => r.id === "touch.tap");
	assert.deepEqual([tap.undeclared, tap.owed], [["files", "apps.ui_tree"], true], "a skip the case owed to groups the iPhone does not declare");
	// The report shows such a skip apart, so a reader sees why Core passed.
	const text = formatReport(report);
	assert.match(text, /^ {2}- touch\.tap: owed to undeclared files, apps\.ui_tree: no way to observe a tap on this phone/m);
	assert.match(text.trimEnd().split("\n").at(-1), / · 1 Core case skipped, owed to undeclared files apps\.ui_tree · /);
	for (const id of ["apps.launch-terminate", "apps.install-launch", "apps.ui-tree-shape", "input.type-text", "input.key-table-refuses-unknown", "exec.argv", "files.home"]) {
		assert.equal(got[id], "skip", `${id} needs a group an iPhone does not declare: ${reasonOf(report, id)}`);
	}
	assert.match(reasonOf(report, "apps.launch-terminate"), /does not declare apps\.terminate/);
	for (const group of ["input.keys", "apps.terminate", "apps.ui_tree"]) assert.ok(report.undeclared.includes(group), group);
	assert.deepEqual(report.cleanup.left, []);
	assert.equal(fake.sessions.size, 0, "every session the run started is ended");
	const sent = new Set(fake.iphone.ops().map(([op]) => op));
	assert.deepEqual([...sent].filter((op) => !NAVIGATION.has(op)), [], "the run only looks, launches, scrolls and goes home: no tap, no typing, no setting changed");
});

test("--kind phone passes the iPhone: every case of the required groups that runs passes, and apps.terminate's case skips as undeclared", { timeout: 120_000 }, async () => {
	const { fake, provider, drifted } = await iphoneProvider();
	const report = await runConformance(provider, { image: "ios", kind: "phone", drifted: () => drifted, patience: 5000 });
	assert.deepEqual(report.kindVerdict, { kind: "phone", verdict: "pass", reasons: [] }, formatReport(report));
	assert.equal(statuses(report)["apps.launch"], "pass");
	assert.equal(fake.sessions.size, 0);
});

test("the first live run's shape, --only health,screen,touch,apps, passes on the one-session iPhone fake", { timeout: 120_000 }, async () => {
	const { fake, provider, drifted } = await iphoneProvider();
	const report = await runConformance(provider, { image: "ios", only: ["health", "screen", "touch", "apps"], drifted: () => drifted, patience: 5000 });
	assert.equal(report.results.filter((r) => r.status === "fail").length, 0, formatReport(report));
	assert.notEqual(report.core, "fail", formatReport(report));
	assert.equal(fake.sessions.size, 0);
});

test("apps.launch fails an iPhone whose launch shows nothing new on the screen", { timeout: 60_000 }, async () => {
	const { fake, provider } = await iphoneProvider({ iphone: { fail: ({ op }) => (op === "apps.launch" ? new Response(JSON.stringify({ result: "com.apple.Preferences" }), { status: 200, headers: { "content-type": "application/json" } }) : undefined) } });
	const report = await runConformance(provider, { image: "ios", patience: 1000, cases: conformanceCases.filter((c) => c.id === "apps.launch") });
	assert.equal(statuses(report)["apps.launch"], "fail");
	assert.match(reasonOf(report, "apps.launch"), /^com\.apple\.Preferences in front after apps\.launch: still not so/);
	assert.equal(fake.sessions.size, 0);
});
