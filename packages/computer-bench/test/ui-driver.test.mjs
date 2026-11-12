// The runner over the protocol's own fake ui driver at $0: the fixture suite's checks fail the untouched window and pass
// the oracle's, a right agent passes and a wrong one fails, each act's record holds its routes, verified count, state
// and change, frames come from the window's image where the computer has no screen group, and a stale ref is counted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fakeUiConnection } from "@parcha/agentrun-computer/fake-ui-driver";
import { FAKE_AGENTS, FIXTURE_APP, fakeBackend, helper } from "../dist/fake-world.js";
import { ENTRY, imageType, loadSuite, proofMarkdown, runBench, Store, verifySuite } from "../dist/index.js";
import { arm, recordOf, SUITES, store, tmp } from "./support.mjs";

const FIXTURE = join(SUITES, "ui-fixture");
const tasks = (...ids) => {
	const all = loadSuite(FIXTURE);
	return ids.length === 0 ? all : all.filter((task) => ids.includes(task.spec.id));
};

/** Each episode on a fresh fake ui driver, over its real line stream; `drivers` collects them. */
function driverBackend(agents, drivers = []) {
	return fakeBackend({
		agents,
		connect: async () => {
			const connection = await fakeUiConnection({ quietMs: 20 });
			drivers.push(connection.driver);
			return { wire: connection.client, close: connection.close };
		},
	});
}

test("verify on the fake ui driver: every fixture check fails the untouched window and passes the oracle's", async () => {
	const out = tmp();
	const proofs = await verifySuite({ tasks: tasks(), seeds: [1, 2], backend: driverBackend({}), nullStore: new Store(join(out, "null")), oracleStore: new Store(join(out, "oracle")) });
	assert.equal(proofs.length, 3 * 2);
	for (const proof of proofs) {
		assert.equal(proof.untouched, "fails", `${proof.task}: ${proof.why ?? ""}`);
		assert.equal(proof.solved, "passes", `${proof.task}: ${proof.why ?? ""}`);
		assert.deepEqual(proof.wrong, []);
	}
	assert.match(proofMarkdown(proofs), /6 task × seed proofs; 0 not right/);
});

test("the fake agents on the fake ui driver: right passes every fixture task, wrong and null fail every one", async () => {
	const s = store();
	const drivers = [];
	const results = await runBench({ tasks: tasks(), arms: [arm("fake-right"), arm("fake-wrong"), arm("fake-null")], seeds: [1, 2], backend: driverBackend(FAKE_AGENTS, drivers), store: s, grade: "never" });
	assert.equal(results.length, 3 * 3 * 2);
	for (const result of results) {
		assert.equal(result.scored, true, `${result.task} ${result.arm}: ${result.outcome} ${result.why ?? ""}`);
		assert.equal(result.outcome, result.arm === "fake-right" ? "pass" : "fail", `${result.task} ${result.arm} seed ${result.seed}: ${JSON.stringify(result.checks)}`);
	}
	// Teardown ended the app on every computer before it was released.
	assert.equal(drivers.length, results.length);
	for (const driver of drivers) assert.equal(driver.screenOf(FIXTURE_APP), undefined);
});

test("an act's record on the fake ui driver: routes, verified, state before and after, changed, expect, and window frames", async () => {
	const s = store();
	const [result] = await runBench({ tasks: tasks("fixture.save"), arms: [arm("fake-right")], seeds: [1], backend: driverBackend(FAKE_AGENTS), store: s, grade: "never" });
	assert.equal(result.outcome, "pass", result.why);
	assert.deepEqual(result.routes, { semantic: 2 });
	assert.equal(result.verified, 2);
	assert.equal(result.acts, 1);
	assert.equal(result.stale, 0);
	const entries = recordOf(s, result.run);
	const header = entries.find((entry) => entry.kind === ENTRY.run).data;
	assert.deepEqual(header.computer.hello.groups, ["apps", "ui"]);
	const steps = entries.filter((entry) => entry.kind === ENTRY.step).map((entry) => entry.data);
	const act = steps.find((step) => step.phase === "agent" && step.method === "ui.act");
	assert.deepEqual(act.routes, ["semantic", "semantic"]);
	assert.equal(act.ran, 2);
	assert.equal(act.verified, 2);
	assert.equal(act.changed, true);
	assert.equal(act.expect, "met");
	assert.match(act.state.before, /^\S+$/);
	assert.match(act.state.after, /^\S+$/);
	assert.notEqual(act.state.before, act.state.after);
	// No screen group, but ui.image is on: frames are the window's image, taken on the bench's channel after each act.
	assert.ok(act.image.pre && act.image.post, "the act has a frame before and after it");
	assert.notEqual(act.image.pre, act.image.post, "the saved window is another frame");
	for (const sha of [act.image.pre, act.image.post]) assert.equal(imageType(readFileSync(s.blobPath(sha))), "image/png");
	assert.ok(steps.some((step) => step.phase === "frame" && step.method === "ui.observe"));
	// The checks read the window before release: their ui.observe calls come after the agent's and before teardown's terminate.
	const checks = steps.filter((step) => step.phase === "check" && step.method === "ui.observe");
	assert.equal(checks.length, 2);
	const teardown = steps.find((step) => step.phase === "teardown");
	assert.ok(checks.every((check) => check.n < teardown.n));
});

test("a ref whose element left the window is refused stale, and the run counts it", async () => {
	const s = store();
	const agents = {
		stale: async (wire) => {
			const h = helper(wire);
			await h.observe(FIXTURE_APP);
			const name = h.find("Name");
			await h.act([{ press: h.find("Next") }], { app: FIXTURE_APP, expect: { text: "Second page" } });
			const refused = await h.act([{ set: name, value: "late" }], { app: FIXTURE_APP });
			assert.equal(refused.steps[0].error.kind, "stale");
			return { outcome: "done", cost_usd: 0 };
		},
	};
	const [result] = await runBench({ tasks: tasks("fixture.save"), arms: [arm("stale")], seeds: [1], backend: driverBackend(agents), store: s, grade: "never" });
	assert.equal(result.outcome, "fail");
	assert.equal(result.stale, 1);
	assert.equal(result.acts, 2);
	assert.deepEqual(result.routes, { semantic: 1, error: 1 });
	const act = recordOf(s, result.run)
		.filter((entry) => entry.kind === ENTRY.step && entry.data.phase === "agent" && entry.data.method === "ui.act")
		.at(-1).data;
	assert.deepEqual(act.routes, ["error"]);
	assert.equal(act.ran, 0);
	assert.equal(act.stale, 1);
});

test("an oracle act whose find matches nothing, or whose step is refused, or whose expect never holds, fails in words", async () => {
	const [task] = tasks("fixture.wifi");
	const broken = (id, steps, expect) => ({ ...task, spec: { ...task.spec, id, oracle: [{ method: "ui.act", params: { target: { app: FIXTURE_APP }, steps, ...(expect ? { expect } : {}) } }] } });
	const cases = [
		[broken("fixture.missing", [{ press: { find: { role: "button", name: { equals: "Launch" } } } }]), /ui\.act could not find its elements: not_found: no node of the window matches .*Launch/],
		[broken("fixture.refused", [{ set: { find: { role: "button", name: { equals: "Save" } } }, value: "x" }]), /ui\.act: its step 1 was refused: unsupported/],
		[broken("fixture.unmet", [{ press: { find: { role: "switch", name: { equals: "Wi-Fi" } } } }], { text: "Never shown", timeoutMs: 100 }), /ui\.act: its expect did not hold in time/],
	];
	const out = tmp();
	const proofs = await verifySuite({ tasks: cases.map(([one]) => one), seeds: [1], backend: driverBackend({}), nullStore: new Store(join(out, "null")), oracleStore: new Store(join(out, "oracle")) });
	for (const [one, why] of cases) {
		const proof = proofs.find((p) => p.task === one.spec.id);
		assert.match(proof.why ?? "", why, one.spec.id);
	}
	// The unmet expect's switch did turn on and its checks pass, but an oracle that did not run to its end proves nothing.
	for (const proof of proofs) {
		assert.equal(proof.solved, "fails", proof.task);
		assert.ok(proof.wrong.includes("the oracle did not run to its end"), proof.task);
	}
});
