// Round 2's runner fixes, on the fake world at $0: a task's apps and capabilities are preconditions (refused "skipped",
// never retried, remembered for the bench run without opening another computer); a computer that stops answering in
// the agent's turn is infra, decided by a ping before the checks and the record's order of events; answer checks
// normalise emphasis and thousands separators; and a run takes only the task × seed pairs verify proved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FAKE_AGENTS, FakeWorld, fakeBackend } from "../dist/fake-world.js";
import { ENTRY, loadSuite, loadTask, lostBeforeStop, proofMarkdown, runBench, runChecks, Store, unverifiedPairs, verifySuite } from "../dist/index.js";
import { arm, FAKE, recordOf, ROOT, store, tmp } from "./support.mjs";

/** The fake dark-theme task (the fake agents play it by its id), with its task.json changed by `change`. */
function darkTheme(change) {
	const dir = join(tmp(), "dark");
	cpSync(join(FAKE, "settings-dark-theme"), dir, { recursive: true });
	const path = join(dir, "task.json");
	const spec = JSON.parse(readFileSync(path, "utf8"));
	change(spec);
	writeFileSync(path, JSON.stringify(spec));
	return loadTask(dir);
}

const CAMERA = { id: "camera", kind: "exec", why: "The computer has a camera.", argv: ["get", "camera"], stdout: { equals: "yes" } };

test("a missing app is a precondition: refused 'skipped', read once through apps.list before setup, and remembered", async () => {
	const task = darkTheme((spec) => (spec.needs.apps = ["fake.settings", ["fake.camera", "fake.photos"]]));
	const worlds = [];
	const results = await runBench({ tasks: [task], arms: [arm("fake-right"), arm("fake-wrong")], seeds: [1, 2], backend: fakeBackend({ agents: FAKE_AGENTS, worlds }), store: store(), grade: "never" });
	assert.equal(results.length, 4, "one result per task × seed × arm, none re-run");
	for (const result of results) {
		assert.equal(result.outcome, "refused");
		assert.equal(result.scored, false);
		assert.equal(result.rerun, false);
		assert.equal(result.phase, "preconditions");
		assert.equal(result.why, "skipped: needs one of fake.camera, fake.photos");
	}
	assert.equal(worlds.length, 1, "the task's other runs are refused without claiming a computer");
	assert.deepEqual(worlds[0].calls, ["hello", "apps.list"], "nothing set up, nothing torn down");
	assert.equal(worlds[0].released, true);
});

test("apps that are there (one of each list's alternatives) let the task run, and a single id missing is named alone", async () => {
	const present = darkTheme((spec) => (spec.needs.apps = ["fake.settings", ["fake.camera", "fake.notes"]]));
	const [ran] = await runBench({ tasks: [present], arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS }), store: store(), grade: "never" });
	assert.equal(ran.outcome, "pass", ran.why);
	const chrome = darkTheme((spec) => (spec.needs.apps = ["com.android.chrome", "fake.settings"]));
	const [refused] = await runBench({ tasks: [chrome], arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS }), store: store(), grade: "never" });
	assert.equal(refused.why, "skipped: needs com.android.chrome");
});

test("needs.apps on a computer with no apps group is refused in words, and remembered", async () => {
	const task = darkTheme((spec) => {
		spec.setup = spec.setup.filter((call) => call.method !== "apps.launch");
	});
	const worlds = [];
	const backend = fakeBackend({ agents: FAKE_AGENTS, worlds, world: () => new FakeWorld({ groups: ["exec", "files", "screen", "ui"] }) });
	const results = await runBench({ tasks: [task], arms: [arm("fake-right")], seeds: [1, 2], backend, store: store(), grade: "never" });
	assert.deepEqual(
		results.map((result) => result.outcome),
		["refused", "refused"],
	);
	assert.equal(results[0].why, "skipped: needs fake.settings, and this computer has no apps group to list its apps");
	assert.equal(results[1].why, results[0].why);
	assert.equal(worlds.length, 1);
});

test("an apps.list that fails is infra (the computer, not the task): run again", async () => {
	const backend = fakeBackend({ agents: FAKE_AGENTS, world: () => new FakeWorld({ faults: { deny: ["apps.list"] } }) });
	const results = await runBench({ tasks: [darkTheme(() => {})], arms: [arm("fake-right")], seeds: [1], backend, store: store(), retries: 1, grade: "never" });
	assert.deepEqual(
		results.map((result) => [result.outcome, result.rerun]),
		[
			["infra", true],
			["infra", false],
		],
	);
	assert.match(results[0].why, /the preconditions could not be read: apps\.list failed: denied/);
});

test("a capability probe that fails refuses the task 'skipped: needs <id>: <reason>' after the apps check and before setup", async () => {
	const task = darkTheme((spec) => (spec.needs.capabilities = [CAMERA]));
	const worlds = [];
	const s = store();
	const results = await runBench({ tasks: [task], arms: [arm("fake-right")], seeds: [1, 2, 3], backend: fakeBackend({ agents: FAKE_AGENTS, worlds }), store: s, grade: "never" });
	assert.equal(results.length, 3);
	for (const result of results) assert.equal(result.why, "skipped: needs camera: exited 1, not 0 (exit 1; stdout:; stderr: no setting camera)");
	assert.equal(worlds.length, 1);
	assert.deepEqual(worlds[0].calls, ["hello", "apps.list", "exec.run"]);
	const phases = recordOf(s, results[0].run)
		.filter((entry) => entry.kind === ENTRY.step)
		.map((entry) => `${entry.data.phase} ${entry.data.method}`);
	assert.deepEqual(phases, ["precondition apps.list", "precondition exec.run"]);
});

test("a capability probe that passes lets the task run; one that can't run is infra", async () => {
	const task = darkTheme((spec) => (spec.needs.capabilities = [CAMERA]));
	const withCamera = () => {
		const world = new FakeWorld();
		world.settings.set("camera", "yes");
		return world;
	};
	const worlds = [];
	const [ran] = await runBench({ tasks: [task], arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS, worlds, world: withCamera }), store: store(), grade: "never" });
	assert.equal(ran.outcome, "pass", ran.why);
	assert.deepEqual(worlds[0].calls.slice(0, 4), ["hello", "apps.list", "exec.run", "exec.run"], "the probe, then setup's first call");
	const broken = fakeBackend({ agents: FAKE_AGENTS, world: () => new FakeWorld({ faults: { deny: ["exec.run"] } }) });
	const [infra] = await runBench({ tasks: [task], arms: [arm("fake-right")], seeds: [1], backend: broken, store: store(), retries: 0, grade: "never" });
	assert.equal(infra.outcome, "infra");
	assert.match(infra.why, /the preconditions could not be read: capability camera: exec\.run could not run: denied/);
});

test("verify reports a skipped task × seed apart from 'not right', in verify.json's skipped_because and the summary", async () => {
	const root = tmp();
	cpSync(join(FAKE, "settings-dark-theme"), join(root, "dark"), { recursive: true });
	cpSync(join(FAKE, "settings-dark-theme"), join(root, "camera"), { recursive: true });
	const path = join(root, "camera", "task.json");
	const spec = JSON.parse(readFileSync(path, "utf8"));
	spec.id = "fake.camera.photo";
	spec.needs.capabilities = [CAMERA];
	writeFileSync(path, JSON.stringify(spec));
	const out = tmp();
	const worlds = [];
	const proofs = await verifySuite({ tasks: loadSuite(root), seeds: [1, 2], backend: fakeBackend({ agents: {}, worlds }), nullStore: new Store(join(out, "null")), oracleStore: new Store(join(out, "oracle")) });
	const camera = proofs.filter((proof) => proof.task === "fake.camera.photo");
	assert.equal(camera.length, 2);
	for (const proof of camera) {
		assert.equal(proof.untouched, "skipped");
		assert.equal(proof.solved, "skipped");
		assert.match(proof.skipped_because, /^needs camera: exited 1/);
	}
	assert.equal(worlds.length, 2 * 2 + 1, "the dark task's four runs, and one computer for the camera task in both passes");
	const markdown = proofMarkdown(proofs);
	assert.match(markdown, /4 task × seed proofs: 2 right, 2 skipped, 0 not right\./);
	assert.match(markdown, /\| fake\.camera\.photo \| 1 \| skipped \| skipped \|\s*\|\s*\| skipped: needs camera: exited 1/);
});

test("a computer that stops answering in the agent's turn is infra, from a ping before the checks, and no check runs", async () => {
	const s = store();
	// The computer dies a few calls into the agent's turn; the agent gives up, done, with an answer.
	const giving = async (wire) => {
		for (let i = 0; i < 3; i += 1) await wire.call("ui.observe", { target: { app: "fake.settings" } });
		return { outcome: "done", answer: "I couldn't: every call failed with the daemon's stream ended." };
	};
	const backend = fakeBackend({ agents: { giving }, world: () => new FakeWorld({ faults: { goneAfter: 6 } }) });
	const results = await runBench({ tasks: [darkTheme(() => {})], arms: [arm("giving")], seeds: [1], backend, store: s, retries: 1, grade: "never" });
	assert.deepEqual(
		results.map((result) => [result.outcome, result.scored, result.rerun, result.phase]),
		[
			["infra", false, true, "agent"],
			["infra", false, false, "agent"],
		],
	);
	assert.equal(results[0].why, "the computer stopped answering during the agent's turn: ping: gone: the daemon's stream ended");
	const phases = recordOf(s, results[0].run).filter((entry) => entry.kind === ENTRY.step).map((entry) => entry.data.phase);
	assert.ok(phases.includes("ping"));
	assert.ok(!phases.includes("check"), "the checks never ran on a dead computer");
});

test("round 1's stream-ended runs (serve reports the agent's steps): the ping, not a check, makes them infra", async () => {
	// android.files.rename-file s1: the daemon's stream ended before the agent's first call; every agent tool call failed.
	const worlds = [];
	const serveLike = async (_wire, request) => {
		worlds.at(-1).options.faults.goneAfter = 0;
		for (const method of ["computer_script", "computer_script", "computer_observe", "computer_screenshot"]) request.onStep({ phase: "agent", method, params: { preview: null }, t_ms: 10, ms: 900, ok: false, error: { code: "tool_failed", message: "the daemon's stream ended" } });
		return { outcome: "done", answer: "I couldn't rename the file. Every tool call failed with \"the daemon's stream ended\".", cost_usd: 0.008 };
	};
	const backend = fakeBackend({ agents: { serveLike }, worlds, world: () => new FakeWorld({ faults: {} }) });
	const [result] = await runBench({ tasks: [darkTheme(() => {})], arms: [arm("serveLike")], seeds: [1], backend, store: store(), retries: 0, grade: "never" });
	assert.equal(result.outcome, "infra");
	assert.equal(result.phase, "agent");
	assert.match(result.why, /^the computer stopped answering during the agent's turn/);
	assert.equal(result.checks, undefined);
});

test("round 1's brightness-min s2: a budget stop whose cancel let the computer go is budget, scored once, not death", async () => {
	// Every computer call answered; the 21st was refused by the harness's own budget, the bench cancelled the run and
	// serve let the computer go: the ping after it fails, and that is the cancel's doing.
	const worlds = [];
	const cancelled = async (_wire, request) => {
		for (let i = 0; i < 20; i += 1) request.onStep({ phase: "agent", method: i % 3 ? "computer_act" : "computer_screenshot", params: { preview: null }, t_ms: i * 2000, ms: 1800, ok: true });
		request.onStep({ phase: "agent", method: "computer_script", params: { preview: null }, t_ms: 41164, ms: 2399, ok: false, error: { code: "tool_failed", message: "Tool budget spent: this conversation has made every tool call it may." } });
		worlds.at(-1).released = true;
		return { outcome: "budget", message: "the task's budget of 20 computer calls is spent", cost_usd: 0.062 };
	};
	const results = await runBench({ tasks: [darkTheme(() => {})], arms: [arm("cancelled")], seeds: [2], backend: fakeBackend({ agents: { cancelled }, worlds }), store: store(), grade: "never" });
	assert.equal(results.length, 1, "no re-run");
	assert.equal(results[0].outcome, "budget");
	assert.equal(results[0].scored, true);
	assert.match(results[0].why, /budget of 20 computer calls is spent/);
});

test("a computer lost before the step budget fired is infra: the record shows the loss came first", async () => {
	// The computer dies; the agent keeps calling into the dead connection until its step budget stops it.
	const s = store();
	const looping = async (wire, request) => {
		for (let i = 0; i < 20 && !request.signal.aborted; i += 1) await wire.call("ui.observe", { target: { app: "fake.settings" } });
		return { outcome: "done" };
	};
	const backend = fakeBackend({ agents: { looping }, world: () => new FakeWorld({ faults: { goneAfter: 7 } }) });
	const [result] = await runBench({ tasks: [darkTheme(() => {})], arms: [arm("looping")], seeds: [1], backend, store: s, retries: 0, grade: "never" });
	assert.equal(result.outcome, "infra");
	assert.match(result.why, /^the computer stopped answering during the agent's turn: its calls failed \(gone: the daemon's stream ended\) before the step budget stopped it; ping: gone/);
});

test("a loss counts as before the stop only when the bench saw it fail by then: one in flight at the stop is the stop's", () => {
	const lost = { code: "gone", message: "the daemon's stream ended" };
	// Steps are in the order the bench saw their answers; the times are a driver's own and order nothing.
	const ok = { n: 1, phase: "agent", method: "ui.observe", params: {}, t_ms: 900, ms: 10, ok: true };
	const failed = { n: 2, phase: "agent", method: "ui.observe", params: {}, t_ms: 5, ms: 10, ok: false, error: lost };
	assert.deepEqual(lostBeforeStop([ok, failed], 2), lost, "it failed, and the bench saw it, before the stop");
	assert.equal(lostBeforeStop([ok, failed], 1), undefined, "sent before the stop, answered after it: the stop let the computer go");
	assert.equal(lostBeforeStop([ok, failed], undefined), undefined, "a stop the bench can't place is no evidence of a death");
});

test("a driver's budget stop whose cancel cut the agent's last call is budget: the loss can't be shown to come first", async () => {
	// serve cancels a run past its step budget and lets the computer go; the call in flight then fails with the
	// connection's words. The driver says budget, not when it stopped, so nothing orders that failure before the stop.
	const worlds = [];
	const cancelled = async (_wire, request) => {
		for (let i = 0; i < 6; i += 1) request.onStep({ phase: "agent", method: "computer_act", params: { preview: null }, t_ms: i * 2000, ms: 1800, ok: true });
		worlds.at(-1).released = true;
		request.onStep({ phase: "agent", method: "computer_act", params: { preview: null }, t_ms: 12000, ms: 300, ok: false, error: { code: "tool_failed", message: "the daemon's stream ended" } });
		return { outcome: "budget", message: "the task's budget of 6 computer calls is spent" };
	};
	const results = await runBench({ tasks: [darkTheme(() => {})], arms: [arm("cancelled")], seeds: [1], backend: fakeBackend({ agents: { cancelled }, worlds }), store: store(), grade: "never" });
	assert.deepEqual(results.map((result) => [result.outcome, result.scored]), [["budget", true]]);
});

test("a wall stop orders a driver's steps by when the bench saw them, not by the driver's own clock", async () => {
	// serve's step times count from its run's start, later than the bench's: a call cut by the wall stop's cancel would
	// look sent long before the stop. The bench places it when it reported it, after the stop.
	const worlds = [];
	const walled = async (_wire, request) => {
		request.onStep({ phase: "agent", method: "computer_act", params: { preview: null }, t_ms: 0, ms: 100, ok: true });
		await new Promise((done) => request.signal.addEventListener("abort", done, { once: true }));
		worlds.at(-1).released = true;
		request.onStep({ phase: "agent", method: "computer_act", params: { preview: null }, t_ms: 50, ms: 100, ok: false, error: { code: "tool_failed", message: "the daemon's stream ended" } });
		return { outcome: "budget", message: "the run was cancelled" };
	};
	const task = darkTheme((spec) => {
		spec.budget.wall_s = 1;
	});
	const results = await runBench({ tasks: [task], arms: [arm("walled")], seeds: [1], backend: fakeBackend({ agents: { walled }, worlds }), store: store(), grade: "never" });
	assert.deepEqual(results.map((result) => [result.outcome, result.scored]), [["budget", true]], results.map((result) => result.why).join(" / "));
});

test("answer checks drop markdown emphasis and thousands separators before they compare, and nothing fuzzier", async () => {
	const [invoice] = loadSuite(join(ROOT, "suites", "mobileworld")).filter((task) => task.spec.id === "mobileworld.check-invoice-1");
	const amount = invoice.spec.checks.find((check) => check.id === "amount");
	const wire = new FakeWorld();
	const judge = async (answer, check = amount) => (await runChecks([check], { wire, answer }))[0].status;
	// Round 1: Sonnet answered "**103190.70**" on both seeds and failed.
	assert.equal(await judge("**103190.70**"), "pass");
	assert.equal(await judge("**103,190.70**"), "pass");
	assert.equal(await judge("__104,417.70__"), "pass");
	assert.equal(await judge("`104417.70`"), "pass");
	assert.equal(await judge("*$103,190.70*"), "pass");
	assert.equal(await judge("104417.7"), "pass");
	assert.equal(await judge("The total is **103,190.70**"), "fail", "the anchored check still wants the number alone");
	assert.equal(await judge("103,190.71"), "fail", "no fuzzy number matching");
	assert.equal(await judge("103190"), "fail", "no rounding");
	const equals = (text) => ({ id: "n", kind: "answer", why: "w", text: { equals: text } });
	assert.equal(await judge("1,234,567", equals("1234567")), "pass");
	assert.equal(await judge("1234567", equals("1,234,567")), "pass", "the check's own literal is normalised the same way");
	assert.equal(await judge("1,2345", equals("12345")), "fail", "only groups of exactly three digits after a comma");
	assert.equal(await judge("3, 4", equals("34")), "fail");
	assert.equal(await judge("_Paris_", equals("Paris")), "pass");
	assert.equal(await judge("*7*", equals("7")), "pass", "a one-character italic is emphasis too");
	assert.equal(await judge("_A_", equals("A")), "pass");
	assert.equal(await judge("**7**", equals("7")), "pass");
	assert.equal(await judge("__A__", equals("A")), "pass");
	assert.equal(await judge("bid_1_final", equals("bid1final")), "fail", "an underscore inside a word is no emphasis");
	assert.equal(await judge("2*3*4", equals("234")), "fail", "an asterisk between digits is no emphasis");
});

test("run --verified: only the pairs verify proved run; the rest are refused without a computer, and the CLI says how many", async () => {
	const task = darkTheme(() => {});
	const at = { version: task.spec.version, sha256: task.sha256 };
	const proofs = [
		{ task: "fake.settings.dark-theme", seed: 1, ...at, untouched: "fails", solved: "passes", wrong: [], skipped: [] },
		{ task: "fake.settings.dark-theme", seed: 2, ...at, untouched: "passes", solved: "passes", wrong: ["every check passed the untouched state"], skipped: [] },
		{ task: "fake.settings.dark-theme", seed: 3, ...at, untouched: "skipped", solved: "skipped", wrong: [], skipped: [], skipped_because: "needs camera: no camera" },
		// Proved right, but on the task as it was before its folder changed: that proof says nothing of the task now.
		{ task: "fake.settings.dark-theme", seed: 5, version: task.spec.version, sha256: "0".repeat(64), untouched: "fails", solved: "passes", wrong: [], skipped: [] },
	];
	const refuse = unverifiedPairs(proofs, [task]);
	assert.equal(refuse("fake.settings.dark-theme", 1), undefined);
	assert.equal(refuse("fake.settings.dark-theme", 2), "not verified for seed 2: verify found it not right (every check passed the untouched state)");
	assert.equal(refuse("fake.settings.dark-theme", 3), "skipped: needs camera: no camera");
	assert.equal(refuse("fake.settings.dark-theme", 4), "not verified for seed 4");
	assert.equal(refuse("fake.settings.dark-theme", 5), `not verified for seed 5: verify proved the task at version ${task.spec.version}, sha256 000000000000, and it is now version ${task.spec.version}, sha256 ${task.sha256.slice(0, 12)}`);
	assert.equal(refuse("fake.notes.front", 1), "not verified for seed 1");
	const worlds = [];
	const results = await runBench({ tasks: [task], arms: [arm("fake-right")], seeds: [1, 2, 3, 4, 5], backend: fakeBackend({ agents: FAKE_AGENTS, worlds }), store: store(), grade: "never", refuse });
	assert.deepEqual(
		results.map((result) => [result.seed, result.outcome, result.scored]),
		[
			[1, "pass", true],
			[2, "refused", false],
			[3, "refused", false],
			[4, "refused", false],
			[5, "refused", false],
		],
	);
	assert.equal(results[3].why, "not verified for seed 4");
	assert.equal(worlds.length, 1, "a pair verify did not prove is not opened");
});

test("the command line: verify seed 1, then run seeds 1 and 2 --verified, and seed 2 is left out (round 1 ran it unproved)", () => {
	const cli = (...args) => spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), ...args], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" } });
	const out = tmp();
	const verified = cli("verify", "--suite", FAKE, "--out", join(out, "verify"), "--seeds", "1", "--task", "fake.settings.dark-theme");
	assert.equal(verified.status, 0, verified.stdout + verified.stderr);
	assert.match(verified.stdout, /1 task × seed proofs: 1 right, 0 skipped, 0 not right\./);
	const arms = join(out, "arms.json");
	writeFileSync(arms, JSON.stringify([arm("fake-right")]));
	const ran = cli("run", "--suite", FAKE, "--arms", arms, "--out", join(out, "run"), "--seeds", "1,2", "--task", "fake.settings.dark-theme", "--grade", "never", "--verified", join(out, "verify", "verify.json"));
	assert.equal(ran.status, 0, ran.stderr);
	assert.match(ran.stdout, /--verified left out 1 of 2 task × seed pairs \(1 not verified, 0 skipped\)/);
	assert.match(ran.stderr, /refused fake\.settings\.dark-theme seed 2 fake-right #1: not verified for seed 2/);
	assert.match(ran.stdout, /2 attempts, 1 scored, 1 passed/);
	const missing = cli("run", "--suite", FAKE, "--arms", arms, "--out", join(out, "run2"), "--verified", join(out, "nope.json"));
	assert.equal(missing.status, 2);
	assert.match(missing.stderr, /--verified .*nope\.json/);
	// A file that is a list but not of proofs is refused in words, never with a stack trace.
	const proof = JSON.parse(readFileSync(join(out, "verify", "verify.json"), "utf8"))[0];
	for (const [n, bad] of [[null], [{ task: "fake.settings.dark-theme", seed: 1 }], [{ ...proof, wrong: undefined }], [{ ...proof, sha256: undefined }]].entries()) {
		const path = join(out, `bad-${n}.json`);
		writeFileSync(path, JSON.stringify(bad));
		const refused = cli("run", "--suite", FAKE, "--arms", arms, "--out", join(out, `bad-run-${n}`), "--verified", path);
		assert.equal(refused.status, 2, refused.stderr);
		assert.match(refused.stderr, /--verified .* is not a verify\.json: its proof 1 /, refused.stderr);
		assert.doesNotMatch(refused.stderr, /\n\s+at /, "no stack trace");
	}
});

test("run --verified refuses a task whose folder changed after verify proved it", () => {
	const cli = (...args) => spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), ...args], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" } });
	const out = tmp();
	const suite = join(out, "suite");
	cpSync(FAKE, suite, { recursive: true });
	assert.equal(cli("verify", "--suite", suite, "--out", join(out, "verify"), "--seeds", "1", "--task", "fake.settings.dark-theme").status, 0);
	// The task's folder changes after verify (one byte is enough): the old proof no longer covers it.
	const path = join(suite, "settings-dark-theme", "task.json");
	writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
	const arms = join(out, "arms.json");
	writeFileSync(arms, JSON.stringify([arm("fake-right")]));
	const ran = cli("run", "--suite", suite, "--arms", arms, "--out", join(out, "run"), "--seeds", "1", "--task", "fake.settings.dark-theme", "--grade", "never", "--verified", join(out, "verify", "verify.json"));
	assert.equal(ran.status, 0, ran.stderr);
	assert.match(ran.stdout, /--verified left out 1 of 1 task × seed pairs \(1 not verified, 0 skipped\)/);
	assert.match(ran.stderr, /not verified for seed 1: verify proved the task at version 1, sha256 [0-9a-f]{12}, and it is now version 1, sha256 [0-9a-f]{12}/);
});
