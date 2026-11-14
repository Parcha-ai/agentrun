// The runner over the fake world at $0: a right agent passes and a wrong one fails, deterministically; the checks read
// the computer before it is released; infra is re-run and never scored; budgets and grants hold; the record keeps a
// header, every call without its bytes, and each image once.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FAKE_AGENTS, FakeWorld, fakeBackend, helper, pngOf } from "../dist/fake-world.js";
import { ENTRY, runBench, runChecks } from "../dist/index.js";
import { arm, fakeTasks, jsonl, recordOf, store, withSpec } from "./support.mjs";

test("the fake agents: right passes every fake task, wrong and null fail every task whose checks are sufficient", async () => {
	const s = store();
	const results = await runBench({ tasks: fakeTasks(), arms: [arm("fake-right"), arm("fake-wrong"), arm("fake-null")], seeds: [1, 2], backend: fakeBackend({ agents: FAKE_AGENTS }), store: s, grade: "never" });
	assert.equal(results.length, 6 * 3 * 2);
	for (const result of results) {
		assert.equal(result.rerun, false);
		assert.equal(result.scored, true, `${result.task} ${result.arm}: ${result.outcome} ${result.why ?? ""}`);
		const judged = result.task === "fake.settings.volume-judged";
		const want = result.arm === "fake-right" || (judged && result.arm === "fake-wrong") ? "pass" : "fail";
		assert.equal(result.outcome, want, `${result.task} ${result.arm} seed ${result.seed}`);
		if (judged) assert.equal(result.queue, "the checks are not sufficient and no grader ran");
	}
	assert.equal(jsonl(join(s.dir, "results.jsonl")).length, results.length);
	const bench = JSON.parse(readFileSync(join(s.dir, "bench.json"), "utf8"));
	assert.deepEqual(bench.seeds, [1, 2]);
	assert.equal(bench.tasks.length, 6);
	assert.equal(jsonl(join(s.dir, "human-queue.jsonl")).length, 3 * 2, "every run of the judged task waits for a person when no grader ran");
});

test("a run's record: the header first, then every call in order, the checks, and the verdict", async () => {
	const s = store();
	const [result] = await runBench({ tasks: fakeTasks("fake.notes.new-note"), arms: [arm("fake-right")], seeds: [3], backend: fakeBackend({ agents: FAKE_AGENTS }), store: s, grade: "never" });
	const entries = recordOf(s, result.run);
	const kinds = entries.map((entry) => entry.kind);
	assert.equal(kinds[0], ENTRY.run);
	const header = entries[0].data;
	assert.equal(header.task.id, "fake.notes.new-note");
	assert.equal(header.task.sha256, result.sha256);
	assert.equal(header.task.seed, 3);
	assert.equal(header.arm.harness, "fake-right");
	assert.deepEqual(header.budget, { steps: 8, usd: 0.1, wall_s: 10 });
	assert.equal(header.computer.provider, "fake");
	assert.equal(header.computer.hello.protocol, "0.2");
	assert.ok(header.computer.hello.device);
	const steps = entries.filter((entry) => entry.kind === ENTRY.step).map((entry) => entry.data);
	// A step is numbered when it is sent and written when it is answered: the frame after an act is answered first.
	assert.deepEqual(
		steps.map((step) => step.n).sort((a, b) => a - b),
		steps.map((_, i) => i + 1),
		"every call has its own number, from 1",
	);
	const byN = [...steps].sort((a, b) => a.n - b.n);
	for (let i = 1; i < byN.length; i += 1) assert.ok(byN[i].t_ms >= byN[i - 1].t_ms, "numbers follow the time each call was sent");
	const phases = [...new Set(steps.map((step) => step.phase))];
	assert.deepEqual(phases, ["setup", "frame", "agent", "check", "observe", "teardown"]);
	const acts = steps.filter((step) => step.method === "ui.act");
	assert.equal(acts.length, 2);
	for (const act of acts) {
		assert.ok(act.routes.every((route) => route === "semantic"));
		assert.equal(act.verified, act.routes.length);
		assert.equal(act.changed, true);
		assert.match(act.state.before, /^s\d+$/);
		assert.match(act.state.after, /^s\d+$/);
		assert.match(act.image.pre, /^[0-9a-f]{64}$/);
		assert.match(act.image.post, /^[0-9a-f]{64}$/);
		assert.notEqual(act.image.pre, act.image.post);
		assert.ok(existsSync(s.blobPath(act.image.post)));
	}
	const verdictAt = kinds.indexOf(ENTRY.verdict);
	assert.ok(kinds.indexOf(ENTRY.checks) < verdictAt);
	const verdict = entries[verdictAt].data;
	assert.equal(verdict.outcome, "pass");
	assert.equal(verdict.steps, 4, "the agent's calls: two observes and two acts");
	assert.deepEqual(verdict.routes, { semantic: 4 });
	assert.equal(verdict.acts, 2);
});

test("the checks read the computer as the agent left it, before teardown and release", async () => {
	const worlds = [];
	const s = store();
	const [result] = await runBench({ tasks: fakeTasks("fake.notes.new-note"), arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS, worlds }), store: s, grade: "never" });
	assert.equal(result.outcome, "pass");
	const [world] = worlds;
	assert.equal(world.released, true);
	assert.equal(world.notes.length, 0, "teardown deleted the note");
	const steps = recordOf(s, result.run).filter((entry) => entry.kind === ENTRY.step).map((entry) => entry.data);
	const lastCheck = steps.findLastIndex((step) => step.phase === "check");
	const firstTeardown = steps.findIndex((step) => step.phase === "teardown");
	assert.ok(lastCheck >= 0 && firstTeardown > lastCheck);
	assert.deepEqual(
		steps.filter((step) => step.phase === "check").map((step) => step.method),
		["exec.run", "exec.run", "ui.observe"],
	);
});

test("an open that fails is infra, run again and never scored", async () => {
	const s = store();
	const results = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS, failOpens: 1 }), store: s, grade: "never" });
	assert.deepEqual(
		results.map((result) => [result.attempt, result.outcome, result.scored, result.rerun]),
		[
			[1, "infra", false, true],
			[2, "pass", true, false],
		],
	);
	assert.match(results[0].why, /could not be had: vendor/);
});

test("a computer that goes away under the agent is infra every time, and the last attempt is not scored either", async () => {
	const s = store();
	const backend = fakeBackend({ agents: FAKE_AGENTS, world: () => new FakeWorld({ faults: { goneAfter: 5 } }) });
	const results = await runBench({ tasks: fakeTasks("fake.notes.new-note"), arms: [arm("fake-right")], seeds: [1], backend, store: s, retries: 1, grade: "never" });
	assert.deepEqual(
		results.map((result) => [result.outcome, result.scored, result.rerun]),
		[
			["infra", false, true],
			["infra", false, false],
		],
	);
	assert.match(results[1].why, /gone|stream ended/);
});

test("a computer that is not what the task needs is refused before setup, and nothing is torn down", async () => {
	const worlds = [];
	const s = store();
	const backend = fakeBackend({ agents: FAKE_AGENTS, worlds, world: () => new FakeWorld({ os: "android", kind: "android" }) });
	const [result] = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("fake-right")], seeds: [1], backend, store: s });
	assert.equal(result.outcome, "refused");
	assert.equal(result.scored, false);
	assert.equal(result.rerun, false, "a refusal is not re-run: the next computer would be the same");
	assert.match(result.why, /needs macos; this computer is android/);
	assert.deepEqual(worlds[0].calls, ["hello"]);
	assert.equal(worlds[0].released, true);
});

test("a task names no agent tools: an agent given only ui, or every group, runs it alike", async () => {
	for (const agentGroups of [["ui"], undefined]) {
		const [result] = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS, ...(agentGroups ? { agentGroups } : {}) }), store: store(), grade: "never" });
		assert.equal(result.outcome, "pass", `${agentGroups ?? "all"}: ${result.why ?? ""}`);
	}
});

test("a group a task can't be done without is checked against hello: refused in one sentence naming it", async () => {
	const [task] = fakeTasks("fake.settings.dark-theme");
	// The same task (the fake agents play by its id), as if it needed a drag.
	const drag = { ...task, spec: { ...task.spec, needs: { ...task.spec.needs, groups: ["input.pointer"] } } };
	const worlds = [];
	const lacking = fakeBackend({ agents: FAKE_AGENTS, worlds, world: () => new FakeWorld({ groups: ["exec", "files", "apps", "ui"] }) });
	const [missing] = await runBench({ tasks: [drag], arms: [arm("fake-right")], seeds: [1], backend: lacking, store: store(), grade: "never" });
	assert.equal(missing.outcome, "refused");
	assert.equal(missing.why, "the task can't be done without input.pointer, which this computer does not have (it has exec, files, apps, ui)");
	assert.deepEqual(worlds[0].calls, ["hello"], "refused before setup");
	const [withheld] = await runBench({ tasks: [drag], arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS, agentGroups: ["ui", "apps"] }), store: store(), grade: "never" });
	assert.equal(withheld.outcome, "refused");
	assert.match(withheld.why, /the task can't be done without input\.pointer, which the agent is not given here \(it has ui, apps\)$/);
	const [given] = await runBench({ tasks: [drag], arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS }), store: store(), grade: "never" });
	assert.equal(given.outcome, "pass", given.why);
});

test("the grant: a call outside the agent's groups is denied and recorded, and the world never sees it", async () => {
	const worlds = [];
	const s = store();
	const sneaky = async (wire) => {
		const ran = await wire.call("exec.run", { argv: ["set", "dark", "yes"] });
		assert.equal(ran.ok, false);
		assert.equal(ran.error.code, "denied");
		return { outcome: "done" };
	};
	const backend = fakeBackend({ agents: { sneaky }, worlds, agentGroups: ["ui", "apps", "screen"] });
	const [result] = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("sneaky")], seeds: [1], backend, store: s, grade: "never" });
	assert.equal(result.outcome, "fail");
	assert.equal(worlds[0].settings.get("dark"), "no");
	const denied = recordOf(s, result.run).find((entry) => entry.kind === ENTRY.step && entry.data.phase === "agent");
	assert.equal(denied.data.error.code, "denied");
	assert.match(denied.data.error.message, /exec is the bench's/);
});

test("the step budget: the call past it answers limit, the agent is stopped, and the run counts as budget", async () => {
	const s = store();
	let refused;
	const looping = async (wire, request) => {
		for (let i = 0; i < 20 && !request.signal.aborted; i += 1) {
			const seen = await wire.call("ui.observe", { target: { app: "fake.settings" } });
			if (!seen.ok) refused = seen.error.code;
		}
		return { outcome: "done" };
	};
	const [result] = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("looping")], seeds: [1], backend: fakeBackend({ agents: { looping } }), store: s, grade: "never" });
	assert.equal(refused, "limit");
	assert.equal(result.outcome, "budget");
	assert.equal(result.scored, true, "a budget is the agent's failure, and counts");
	assert.equal(result.steps, 7, "six calls within the budget, and the one refused");
});

test("the wall budget stops an agent that waits, and the usd budget fails one that spent too much", async () => {
	const s = store();
	const [task] = fakeTasks("fake.settings.dark-theme");
	const slow = { ...task, spec: { ...task.spec, budget: { ...task.spec.budget, wall_s: 0.2 } } };
	const waiting = (wire, request) =>
		new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
	const spender = async (wire) => {
		const h = helper(wire);
		await h.observe("fake.settings");
		await h.act([{ press: h.find("Dark theme") }]);
		return { outcome: "done", cost_usd: 0.5 };
	};
	const [waited] = await runBench({ tasks: [slow], arms: [arm("waiting")], seeds: [1], backend: fakeBackend({ agents: { waiting } }), store: s, grade: "never" });
	assert.equal(waited.outcome, "budget");
	assert.ok(waited.wall_s < 2, `it waited ${waited.wall_s} s`);
	const [spent] = await runBench({ tasks: [task], arms: [arm("spender")], seeds: [1], backend: fakeBackend({ agents: { spender } }), store: store(), grade: "never" });
	assert.equal(spent.stage1, "pass", "the dark theme is on");
	assert.equal(spent.outcome, "budget", "but a success bought over budget is not one");
	assert.equal(spent.cost_usd, 0.5);
});

test("a file check reads the whole file, chunk by chunk, so a match past the first 512 KiB is seen", async () => {
	const world = new FakeWorld();
	world.files.set("/tmp/big.txt", `${"a".repeat(600 * 1024)}END`);
	const signal = AbortSignal.timeout(10_000);
	const [found, absent] = await runChecks(
		[
			{ id: "found", kind: "file", why: "the end is read", path: "/tmp/big.txt", text: { contains: "END" } },
			{ id: "absent", kind: "file", why: "a negative match sees the end too", path: "/tmp/big.txt", text: { contains: "END", not: true } },
		],
		{ wire: world, signal },
	);
	assert.equal(found.status, "pass", found.reason);
	assert.equal(absent.status, "fail");
	// With no text to match, the first read proves the file is there: no more reads, however big it is.
	const reads = [];
	const counting = { call: (method, params, options) => (reads.push(method), world.call(method, params, options)) };
	const [there] = await runChecks([{ id: "there", kind: "file", why: "it exists", path: "/tmp/big.txt" }], { wire: counting, signal });
	assert.equal(there.status, "pass", there.reason);
	assert.deepEqual(reads, ["files.read"]);
});

test("a budget stop that let the computer go is scored as budget once, never re-run as infra", async () => {
	// serve's cancel past a budget releases the run's computer, so the checks after it can't read anything.
	const worlds = [];
	const cancelled = async () => {
		worlds.at(-1).released = true;
		return { outcome: "budget", message: "the run was cancelled past its step budget" };
	};
	const results = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("cancelled")], seeds: [1], backend: fakeBackend({ agents: { cancelled }, worlds }), store: store(), grade: "never" });
	assert.equal(results.length, 1, "no re-run");
	assert.equal(results[0].outcome, "budget");
	assert.equal(results[0].scored, true);
	assert.equal(results[0].stage1, "error");
	assert.match(results[0].why, /cancelled past its step budget; a check could not run/);
});

test("frames and images: each image is kept once as a blob, a chunked shot is put back together, and bytes never sit in a step", async () => {
	const s = store();
	const writer = async (wire) => {
		await wire.call("files.write", { path: "/tmp/bench-x.txt", data: Buffer.from("a long text").toString("base64") });
		const shot = await wire.call("screen.shot", {});
		let offset = Buffer.from(shot.value.data, "base64").length;
		let eof = shot.value.eof;
		while (!eof) {
			const more = await wire.call("screen.read", { id: shot.value.id, offset });
			offset += Buffer.from(more.value.data, "base64").length;
			eof = more.value.eof;
		}
		return { outcome: "done" };
	};
	const backend = fakeBackend({ agents: { writer }, world: () => new FakeWorld({ chunk: 16 }) });
	const [task] = fakeTasks("fake.files.write");
	const roomy = { ...task, spec: { ...task.spec, budget: { ...task.spec.budget, steps: 50 } } };
	const [result] = await runBench({ tasks: [roomy], arms: [arm("writer")], seeds: [1], backend, store: s, grade: "never" });
	assert.equal(result.outcome, "fail");
	const steps = recordOf(s, result.run).filter((entry) => entry.kind === ENTRY.step).map((entry) => entry.data);
	const write = steps.find((step) => step.method === "files.write");
	assert.deepEqual(Object.keys(write.params.data).sort(), ["bytes", "sha256"]);
	const reads = steps.filter((step) => step.phase === "agent" && step.method === "screen.read");
	assert.ok(reads.length >= 2, "the shot came in chunks");
	const got = reads.at(-1).image.got;
	assert.match(got, /^[0-9a-f]{64}$/);
	assert.deepEqual(readFileSync(s.blobPath(got)), pngOf(JSON.stringify({ front: null, view: null })));
	for (const step of steps) assert.ok(!JSON.stringify(step.params).includes("iVBOR"), `${step.method} kept a PNG's bytes`);
});

test("a stale act is counted: a point read on an old state is refused, and the act that changed nothing is a no-op", async () => {
	const s = store();
	const clumsy = async (wire) => {
		const h = helper(wire);
		const first = await h.observe("fake.settings");
		await h.act([{ press: h.find("Dark theme") }]);
		await wire.call("ui.act", { target: { app: "fake.settings" }, state: first.state, steps: [{ click: [30, 50] }] });
		return { outcome: "done" };
	};
	const [result] = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("clumsy")], seeds: [1], backend: fakeBackend({ agents: { clumsy } }), store: s, grade: "never" });
	assert.equal(result.outcome, "pass");
	assert.equal(result.stale, 1);
	assert.equal(result.acts, 2);
	assert.equal(result.noop, 1);
	assert.deepEqual(result.routes, { semantic: 1, error: 1 });
});

test("null mode runs no agent, and oracle mode solves the task on the bench's channel", async () => {
	const s = store();
	const tasks = fakeTasks("fake.settings.dark-theme", "fake.notes.new-note");
	const none = await runBench({ tasks, arms: [arm("none")], seeds: [1], backend: fakeBackend({ agents: {} }), store: s, mode: "null" });
	assert.deepEqual(
		none.map((result) => result.outcome),
		["fail", "fail"],
	);
	const solved = await runBench({ tasks, arms: [arm("none")], seeds: [1], backend: fakeBackend({ agents: {} }), store: store(), mode: "oracle" });
	assert.deepEqual(
		solved.map((result) => result.outcome),
		["pass", "pass"],
	);
});

test("the arm's surface is real: tools gives the agent one method per tool call, code one script per tool call and no bare call", async () => {
	const s = store();
	const [stepwise, scripted] = await runBench({ tasks: fakeTasks("fake.notes.new-note"), arms: [arm("fake-right", "right-tools", "tools"), arm("fake-right", "right-code", "code")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS }), store: s, grade: "never" });
	assert.deepEqual([stepwise.outcome, scripted.outcome], ["pass", "pass"]);
	assert.deepEqual([stepwise.steps, stepwise.tool_calls], [4, 4], "tools: each of the four computer calls is its own tool call");
	assert.deepEqual([scripted.steps, scripted.tool_calls], [4, 1], "code: one script of four computer calls is one tool call");
	const agentSteps = (result) => recordOf(s, result.run).filter((entry) => entry.kind === ENTRY.step && entry.data.phase === "agent").map((entry) => entry.data);
	assert.deepEqual(agentSteps(stepwise).map((step) => step.turn), [1, 2, 3, 4]);
	assert.deepEqual(agentSteps(scripted).map((step) => step.turn), [1, 1, 1, 1]);
	assert.deepEqual(recordOf(s, scripted.run)[0].data.agent, { surface: "code", exec: "allow", groups: ["exec", "files", "screen", "input.pointer", "input.keys", "apps", "ui"] });
	// What each surface is given, as the agent sees it.
	const seen = {};
	const probe = async (wire, request) => {
		const bare = await wire.call("ui.observe", { target: { app: "fake.settings" } });
		seen[request.arm.surface] = { script: typeof wire.script, bare: bare.ok ? "ok" : `${bare.error.code}: ${bare.error.message}` };
		if (wire.script) await wire.script(async (computer) => computer.call("ui.observe", { target: { app: "fake.settings" } }));
		return { outcome: "done" };
	};
	await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("probe", "probe-tools", "tools"), arm("probe", "probe-code", "code")], seeds: [1], backend: fakeBackend({ agents: { probe } }), store: store(), grade: "never" });
	assert.deepEqual(seen.tools, { script: "undefined", bare: "ok" });
	assert.equal(seen.code.script, "function");
	assert.match(seen.code.bare, /^denied: .*code mode.*script/);
});

test("exec deny: the agent's grant has no exec or processes, the record and result say so; exec allow keeps the shell", async () => {
	const [task] = fakeTasks("fake.settings.dark-theme");
	const deny = withSpec(task, { exec: "deny" });
	const shell = async (wire) => {
		const ran = await wire.call("exec.run", { argv: ["set", "dark", "yes"] });
		const started = await wire.call("process.start", { argv: ["true"] });
		return { outcome: "done", message: `${ran.ok ? "ran" : ran.error.code} ${started.ok ? "started" : started.error.code}` };
	};
	const worlds = [];
	const s = store();
	const groups = ["exec", "processes", "files", "screen", "input.pointer", "input.keys", "apps", "ui"];
	const [denied] = await runBench({ tasks: [deny], arms: [arm("shell")], seeds: [1], backend: fakeBackend({ agents: { shell }, worlds, world: () => new FakeWorld({ groups }) }), store: s, grade: "never" });
	assert.equal(denied.exec, "deny");
	assert.equal(denied.outcome, "fail");
	assert.equal(worlds[0].settings.get("dark"), "no", "the world never saw the exec.run");
	assert.equal(denied.exec_calls, 0, "a refused exec.run is no use of the shell");
	const header = recordOf(s, denied.run)[0].data;
	assert.deepEqual(header.agent, { surface: "tools", exec: "deny", groups: ["files", "screen", "input.pointer", "input.keys", "apps", "ui"] });
	const refused = recordOf(s, denied.run).filter((entry) => entry.kind === ENTRY.step && entry.data.phase === "agent").map((entry) => [entry.data.method, entry.data.error?.code]);
	assert.deepEqual(refused, [["exec.run", "denied"], ["process.start", "denied"]]);
	const [allowed] = await runBench({ tasks: [task], arms: [arm("shell")], seeds: [1], backend: fakeBackend({ agents: { shell } }), store: store(), grade: "never" });
	assert.equal(allowed.exec, "allow");
	assert.equal(allowed.outcome, "pass", "exec allow: the agent may use the shell");
	assert.equal(allowed.exec_calls, 1);
	assert.equal(allowed.platform, "macos desktop");
});

test("parallel episodes give the same verdicts as one at a time", async () => {
	const run = (parallel) => runBench({ tasks: fakeTasks(), arms: [arm("fake-right"), arm("fake-wrong")], seeds: [1, 2], backend: fakeBackend({ agents: FAKE_AGENTS }), store: store(), grade: "never", parallel });
	const key = (results) => results.map((result) => `${result.task}/${result.seed}/${result.arm}=${result.outcome}`).sort();
	assert.deepEqual(key(await run(4)), key(await run(1)));
});
