// The numbers a report states, the report over a fake run, a person's labels, the verify proof, and the command line
// end to end, all at $0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FAKE_AGENTS, fakeBackend } from "../dist/fake-world.js";
import { buildReport, clustered, loadSuite, pairedDifference, proofMarkdown, readResults, reportMarkdown, runBench, Store, verifySuite, wilson } from "../dist/index.js";
import { arm, FAKE, fakeTasks, ROOT, store, tmp } from "./support.mjs";

const close = (actual, expected, digits = 3) => assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} is not ${expected}`);

test("wilson: known values, and an empty sample says nothing", () => {
	const half = wilson(5, 10);
	close(half.low, 0.2366);
	close(half.high, 0.7634);
	const none = wilson(0, 10);
	assert.equal(none.low, 0);
	close(none.high, 0.2775);
	assert.deepEqual(wilson(0, 0), { estimate: 0, low: 0, high: 1 });
});

test("clustered: the task is the unit; one task is Wilson over its runs; tasks that all agree still get an interval", () => {
	const one = clustered([{ k: 3, n: 4 }]);
	assert.deepEqual({ low: one.low, high: one.high }, { low: wilson(3, 4).low, high: wilson(3, 4).high });
	const allPass = clustered(Array.from({ length: 6 }, () => ({ k: 3, n: 3 })));
	assert.equal(allPass.estimate, 1);
	close(allPass.low, wilson(6, 6).low);
	assert.ok(allPass.low < 0.65, "six tasks that all pass don't prove 100%");
	const mixed = clustered([
		{ k: 3, n: 3 },
		{ k: 0, n: 3 },
		{ k: 3, n: 3 },
		{ k: 0, n: 3 },
	]);
	assert.equal(mixed.estimate, 0.5);
	const naive = wilson(6, 12);
	assert.ok(mixed.high - mixed.low > naive.high - naive.low, "tasks that split the arm widen the interval past the per-run one");
	assert.equal(mixed.tasks, 4);
	assert.equal(mixed.runs, 12);
});

test("pairedDifference: over the tasks both arms ran, never collapsed to a point", () => {
	const a = new Map([
		["t1", { k: 3, n: 3 }],
		["t2", { k: 2, n: 3 }],
		["t3", { k: 3, n: 3 }],
		["only-a", { k: 0, n: 3 }],
	]);
	const b = new Map([
		["t1", { k: 1, n: 3 }],
		["t2", { k: 2, n: 3 }],
		["t3", { k: 0, n: 3 }],
	]);
	const d = pairedDifference(a, b);
	assert.equal(d.tasks, 3);
	close(d.estimate, (2 / 3 + 0 + 1) / 3);
	assert.ok(d.low < d.estimate && d.high > d.estimate);
	const same = pairedDifference(
		new Map([
			["t1", { k: 1, n: 1 }],
			["t2", { k: 1, n: 1 }],
		]),
		new Map([
			["t1", { k: 0, n: 1 }],
			["t2", { k: 0, n: 1 }],
		]),
	);
	assert.equal(same.estimate, 1);
	assert.ok(same.low < 0.5, "two tasks that both moved by 100 points don't prove 100 points");
});

test("the report over a fake run: per arm success, steps, routes and the paired difference; only final attempts count", async () => {
	const s = store();
	await runBench({ tasks: fakeTasks(), arms: [arm("fake-right"), arm("fake-wrong")], seeds: [1, 2], backend: fakeBackend({ agents: FAKE_AGENTS, failOpens: 2 }), store: s, grade: "never" });
	const { results, labels } = readResults(s.dir);
	assert.equal(labels.length, 0);
	const report = buildReport(results, labels);
	const [right, wrong] = report.arms;
	assert.equal(right.arm, "fake-right");
	assert.equal(right.success.estimate, 1);
	assert.equal(right.success.runs, 12);
	assert.deepEqual(right.pass_all, { tasks: 6, of: 6 });
	assert.deepEqual(right.infra, { attempts: 2, final: 0, why: { "the computer could not be had: vendor: the fake vendor had no computer free": 2 } });
	assert.equal(wrong.passed, 2, "only the judged task's stage 1 passes the wrong agent");
	assert.ok(right.routes.semantic > 0);
	assert.equal(right.queue, 2);
	assert.equal(report.paired[0].arm, "fake-wrong");
	assert.equal(report.paired[0].against, "fake-right");
	assert.ok(report.paired[0].difference.estimate < -0.5);
	assert.equal(report.tasks.length, 6);
	const markdown = reportMarkdown(report);
	assert.match(markdown, /\| fake-right \| 100\.0% \(/);
	assert.match(markdown, /## How the agents acted/);
	assert.match(markdown, /## Against the first arm/);
	const dev = buildReport(results, labels, { split: "dev" });
	assert.equal(dev.tasks.length, 3);
	assert.deepEqual(dev.splits, ["dev"]);
});

test("the paired difference compares a task on the seeds both arms scored, never one arm's seed 1 against another's seed 2", () => {
	const row = (arm, seed, outcome) => ({ bench: "b", run: `${arm}-${seed}`, task: "t.one", version: 1, sha256: "s", split: "dev", seed, arm, attempt: 1, outcome, scored: outcome !== "infra", rerun: false, steps: 1, wall_s: 1, routes: {}, stale: 0, noop: 0, verified: 0, acts: 0 });
	// Two arms that both pass seed 1 and fail seed 2, each with the other seed lost to infra.
	const lopsided = buildReport([row("a", 1, "pass"), row("a", 2, "infra"), row("b", 1, "infra"), row("b", 2, "fail")]);
	assert.equal(lopsided.paired[0].difference.tasks, 0, "no seed was scored in both arms");
	assert.equal(lopsided.paired[0].difference.estimate, 0);
	const both = buildReport([row("a", 1, "pass"), row("a", 2, "fail"), row("b", 1, "pass"), row("b", 2, "pass"), row("b", 3, "pass")]);
	assert.equal(both.paired[0].difference.tasks, 1);
	assert.equal(both.paired[0].difference.estimate, 0.5, "b passes 2 of the 2 seeds a ran, a 1 of 2; b's seed 3 has no pair");
});

/** A bench folder written by hand: its bench.json (arms in their order, seeds, judge) and its results, terra's first. */
function blogRun() {
	const dir = tmp();
	const bench = { bench: "b", arms: [{ id: "sonnet-5.5", harness: "pi", surface: "code", model: "s" }, { id: "gpt-6.1-terra", harness: "pi", surface: "code", model: "t" }], seeds: [1, 2], judge: "anthropic:claude-opus-5-5", retries: 2 };
	writeFileSync(join(dir, "bench.json"), JSON.stringify(bench));
	const row = (task, platform, exec, seed, arm, outcome, steps, tool_calls, wall_s, cost_usd, exec_calls) => ({ bench: "b", run: `${task}-${seed}-${arm}`, task, version: 1, sha256: `sha-${task}`, split: "dev", platform, exec, seed, arm, attempt: 1, outcome, scored: outcome !== "infra", rerun: false, steps, tool_calls, wall_s, cost_usd, exec_calls, routes: {}, stale: 0, noop: 0, verified: 0, acts: 0 });
	const rows = [
		row("a1", "android phone", "deny", 1, "gpt-6.1-terra", "pass", 6, 3, 12, 0.01, 0),
		row("a1", "android phone", "deny", 2, "gpt-6.1-terra", "pass", 5, 5, 14, 0.01, 0),
		row("a2", "android phone", "allow", 1, "gpt-6.1-terra", "pass", 3, 3, 8, 0.005, 0),
		row("a2", "android phone", "allow", 2, "gpt-6.1-terra", "infra", 0, 0, 0, undefined, 0),
		row("l1", "linux desktop", "allow", 1, "gpt-6.1-terra", "fail", 12, 6, 40, 0.02, 0),
		row("a1", "android phone", "deny", 1, "sonnet-5.5", "pass", 4, 2, 10, 0.02, 0),
		row("a1", "android phone", "deny", 2, "sonnet-5.5", "fail", 8, 4, 20, 0.04, 0),
		row("a2", "android phone", "allow", 1, "sonnet-5.5", "pass", 2, 1, 6, 0.01, 1),
		row("a2", "android phone", "allow", 2, "sonnet-5.5", "pass", 3, 2, 7, 0.01, 0),
		row("l1", "linux desktop", "allow", 1, "sonnet-5.5", "pass", 10, 5, 30, 0.05, 2),
	];
	writeFileSync(join(dir, "results.jsonl"), rows.map((one) => JSON.stringify(one)).join("\n"));
	return dir;
}

test("the report follows bench.json's arms: the first arm is the baseline, not the first to finish or the first alphabetically", () => {
	const { results, labels, bench } = readResults(blogRun());
	assert.deepEqual(bench.arms.map((one) => one.id), ["sonnet-5.5", "gpt-6.1-terra"]);
	const report = buildReport(results, labels, { bench });
	assert.deepEqual(report.arms.map((one) => one.arm), ["sonnet-5.5", "gpt-6.1-terra"]);
	assert.deepEqual([report.paired[0].arm, report.paired[0].against], ["gpt-6.1-terra", "sonnet-5.5"]);
	const markdown = reportMarkdown(report);
	assert.ok(markdown.indexOf("| sonnet-5.5 | ") < markdown.indexOf("| gpt-6.1-terra | "), "the first arm's row first");
	assert.match(markdown, /\| task \| split \| sonnet-5\.5 \| gpt-6\.1-terra \|/);
	assert.match(markdown, /## Against the first arm \(sonnet-5\.5, paired by task\)/);
	// Without bench.json the order is the arms' first appearance, and an arm bench.json does not name comes after.
	assert.equal(buildReport(results).arms[0].arm, "gpt-6.1-terra");
});

test("the report for the blog: a table per platform with the paired difference, medians and $ per pass, tasks per platform, and how we measured", () => {
	const { results, labels, bench } = readResults(blogRun());
	const report = buildReport(results, labels, { bench });
	assert.deepEqual(report.platforms.map((one) => one.platform), ["android phone", "linux desktop"]);
	const [android, linux] = report.platforms;
	const [sonnet, terra] = android.arms;
	assert.deepEqual([sonnet.arm, sonnet.passed, sonnet.scored, sonnet.steps_median, sonnet.tool_calls_median, sonnet.wall_s_median], ["sonnet-5.5", 3, 4, 3.5, 2, 8.5]);
	close(sonnet.usd_per_pass, 0.08 / 3);
	assert.equal(sonnet.difference, undefined, "the first arm is the baseline");
	assert.deepEqual([terra.arm, terra.passed, terra.scored, terra.steps_median, terra.tool_calls_median, terra.wall_s_median], ["gpt-6.1-terra", 3, 3, 5, 3, 12]);
	close(terra.usd_per_pass, 0.025 / 3);
	assert.equal(terra.difference.tasks, 2, "a2 seed 2 is infra for terra: a2 pairs on seed 1 alone");
	close(terra.difference.estimate, 0.25);
	assert.deepEqual([linux.arms[1].difference.estimate, linux.arms[1].difference.tasks], [-1, 1]);
	assert.deepEqual(android.tasks.map((one) => [one.task, one.exec, one.arms["sonnet-5.5"].k, one.arms["sonnet-5.5"].n, one.arms["gpt-6.1-terra"].k, one.arms["gpt-6.1-terra"].n]), [
		["a1", "deny", 1, 2, 2, 2],
		["a2", "allow", 2, 2, 1, 1],
	]);
	assert.deepEqual(report.exec, { deny: ["a1"], allow: ["a2", "l1"] });
	assert.deepEqual(
		report.arms.map((one) => [one.arm, one.exec_passes]),
		[
			["sonnet-5.5", { passes: 2, of: 4 }],
			["gpt-6.1-terra", { passes: 0, of: 3 }],
		],
	);
	const markdown = reportMarkdown(report);
	assert.match(markdown, /## android phone\n\n\| arm \| passed \/ scored \| success \| difference vs sonnet-5\.5 \(95% CI\) \| median computer steps \| median model turns \| median wall s \| \$ \/ pass \|/);
	assert.match(markdown, /\| sonnet-5\.5 \| 3 \/ 4 \| 75\.0% \| baseline \| 3\.5 \| 2 \| 8\.5 \| 0\.027 \|/);
	assert.match(markdown, /\| gpt-6\.1-terra \| 3 \/ 3 \| 100\.0% \| \+25\.0 pt \(-?\d+\.\d to \d+\.\d\), 2 tasks \| 5 \| 3 \| 12 \| 0\.008 \|/);
	assert.match(markdown, /### android phone: tasks\n\n\| task \| exec \| sonnet-5\.5 \| gpt-6\.1-terra \|\n\|---\|---\|---\|---\|\n\| a1 \| deny \| 1\/2 \| 2\/2 \|/);
	assert.match(markdown, /## linux desktop\n/);
	assert.match(markdown, /\| sonnet-5\.5 \| 2 of 4 \|/);
	const measured = markdown.slice(markdown.indexOf("## How we measured"));
	assert.match(measured, /3 tasks \(android phone 2, linux desktop 1\)/);
	assert.match(measured, /seeds 1, 2/);
	assert.match(measured, /anthropic:claude-opus-5-5/);
	assert.match(measured, /infra/);
	assert.match(measured, /re-run up to 2 times/);
	assert.match(measured, /deny exec \(1\): a1/);
	assert.match(measured, /allow exec \(2\): a2, l1/);
});

test("a bench run refuses a folder that already holds results", async () => {
	const s = store();
	await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS }), store: s, grade: "never" });
	await assert.rejects(runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("fake-wrong")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS }), store: s, grade: "never" }), /already holds a bench run's results/);
});

test("a person's label overrides a verdict, and a labelled run leaves the queue", async () => {
	const s = store();
	const results = await runBench({ tasks: fakeTasks("fake.settings.volume-judged"), arms: [arm("fake-wrong")], seeds: [1, 2], backend: fakeBackend({ agents: FAKE_AGENTS }), store: s, grade: "never" });
	assert.ok(results.every((result) => result.outcome === "pass" && result.queue));
	s.append("labels.jsonl", { run: results[0].run, verdict: "fail", note: "volume 1 is not a little" });
	s.append("labels.jsonl", { run: results[1].run, verdict: "infra", note: "the slider was broken" });
	const read = readResults(s.dir);
	const [wrong] = buildReport(read.results, read.labels).arms;
	assert.equal(wrong.passed, 0);
	assert.equal(wrong.success.runs, 1, "the run labelled infra is not scored");
	assert.equal(wrong.labelled, 2);
	assert.equal(wrong.queue, 0);
});

test("verify: the fake suite's checks fail every untouched state and pass every solved one", async () => {
	const out = tmp();
	const proofs = await verifySuite({ tasks: loadSuite(FAKE), seeds: [1, 2], backend: fakeBackend({ agents: {} }), nullStore: new Store(join(out, "null")), oracleStore: new Store(join(out, "oracle")) });
	assert.equal(proofs.length, 12);
	for (const proof of proofs) {
		assert.equal(proof.untouched, "fails", `${proof.task}: ${proof.why ?? ""}`);
		assert.equal(proof.solved, proof.task === "fake.settings.device-name" ? "no oracle" : "passes", `${proof.task}: ${proof.why ?? ""}`);
		assert.deepEqual(proof.wrong, []);
	}
	assert.match(proofMarkdown(proofs), /12 task × seed proofs; 0 not right/);
});

test("verify names a broken check: one that passes the untouched state, or fails the solved one", async () => {
	const root = tmp();
	cpSync(join(FAKE, "settings-dark-theme"), join(root, "lenient"), { recursive: true });
	cpSync(join(FAKE, "settings-dark-theme"), join(root, "strict"), { recursive: true });
	const edit = (dir, id, change) => {
		const path = join(root, dir, "task.json");
		const spec = JSON.parse(readFileSync(path, "utf8"));
		spec.id = id;
		change(spec);
		writeFileSync(path, JSON.stringify(spec));
	};
	edit("lenient", "broken.lenient", (spec) => {
		spec.checks = [{ id: "any", kind: "exec", why: "too lenient", argv: ["get", "dark"], stdout: { oneOf: ["yes", "no"] } }];
	});
	edit("strict", "broken.strict", (spec) => {
		spec.checks = [{ id: "never", kind: "exec", why: "asks the impossible", argv: ["get", "dark"], stdout: { equals: "maybe" } }];
	});
	const out = tmp();
	const proofs = await verifySuite({ tasks: loadSuite(root), seeds: [1], backend: fakeBackend({ agents: {} }), nullStore: new Store(join(out, "null")), oracleStore: new Store(join(out, "oracle")) });
	const of = (id) => proofs.find((proof) => proof.task === id);
	assert.equal(of("broken.lenient").untouched, "passes");
	assert.deepEqual(of("broken.lenient").wrong, ["every check passed the untouched state"]);
	assert.equal(of("broken.strict").solved, "fails");
	assert.deepEqual(of("broken.strict").wrong, ["never failed the solved state"]);
	assert.match(proofMarkdown(proofs), /2 not right/);
});

const cli = (...args) => spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), ...args], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" } });

test("the command line: validate, verify, run and report over the fake suite, and usage on a bad flag", () => {
	const validated = cli("validate", FAKE, join(ROOT, "suites", "mac-dev"));
	assert.equal(validated.status, 0, validated.stderr);
	assert.match(validated.stdout, /fake: 6 tasks ok \(3 dev, 3 heldout\)/);
	assert.match(validated.stdout, /mac-dev: 20 tasks ok \(10 dev, 10 heldout\)/);
	const out = tmp();
	const verified = cli("verify", "--suite", FAKE, "--out", join(out, "verify"), "--seeds", "1");
	assert.equal(verified.status, 0, verified.stdout + verified.stderr);
	assert.ok(existsSync(join(out, "verify", "verify.json")));
	const arms = join(out, "arms.json");
	writeFileSync(arms, JSON.stringify([arm("fake-right"), arm("fake-null", "fake-null", "tools")]));
	const ran = cli("run", "--suite", FAKE, "--arms", arms, "--out", join(out, "run"), "--seeds", "1,2", "--split", "dev", "--grade", "never", "--parallel", "2");
	assert.equal(ran.status, 0, ran.stderr);
	assert.match(ran.stdout, /12 attempts, 12 scored, 6 passed/);
	const reported = cli("report", join(out, "run"), "--split", "dev");
	assert.equal(reported.status, 0, reported.stderr);
	assert.match(reported.stdout, /\| fake-right \| 100\.0%/);
	assert.ok(existsSync(join(out, "run", "report-dev.json")));
	const bad = cli("run", "--suite", FAKE, "--colour", "blue");
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /usage:/);
	const noKey = cli("run", "--suite", FAKE, "--arms", arms, "--out", join(out, "x"), "--judge", "anthropic:claude-opus-5-5");
	assert.equal(noKey.status, 2);
	assert.match(noKey.stderr, /ANTHROPIC_API_KEY/);
	const unknownTask = cli("run", "--suite", FAKE, "--arms", arms, "--out", join(out, "y"), "--task", "fake.nope");
	assert.equal(unknownTask.status, 2);
	assert.match(unknownTask.stderr, /no task fake\.nope/);
});
