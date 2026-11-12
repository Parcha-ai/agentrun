// Tasks as data: the schema and the rules past it, every suite in the package loading, and seeds resolving the same
// way every time, so arms are paired.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkGroup, loadSuite, loadTask, nonceOf, pickParam, resolveTask, TaskError } from "../dist/index.js";
import { FAKE, SUITES, tmp } from "./support.mjs";

const GOOD = {
	id: "t.good",
	version: 1,
	title: "A good task",
	split: "dev",
	needs: { os: "macos", kind: "desktop", groups: ["ui"] },
	instruction: "Do it",
	budget: { steps: 5, usd: 0.1, wall_s: 10 },
	checks: [{ id: "c", kind: "exec", why: "it is done", argv: ["true"] }],
};

function writeTask(spec, files = {}) {
	const dir = join(tmp(), spec.id ?? "task");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "task.json"), JSON.stringify(spec));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}

const problemsOf = (spec, files) => {
	try {
		loadTask(writeTask(spec, files));
	} catch (error) {
		assert.ok(error instanceof TaskError, String(error));
		return error.problems.join("\n");
	}
	return "";
};

test("every suite in the package loads, and mac-dev and android-dev are 20 tasks, half dev and half held out", () => {
	const counts = {};
	for (const suite of ["fake", "mac-dev", "android-dev", "macosworld", "mobileworld"]) {
		const tasks = loadSuite(join(SUITES, suite));
		counts[suite] = { all: tasks.length, dev: tasks.filter((task) => task.spec.split === "dev").length };
		for (const task of tasks) {
			assert.match(task.sha256, /^[0-9a-f]{64}$/);
			for (const seed of [1, 2, 3]) resolveTask(task, seed);
		}
	}
	assert.deepEqual(counts["mac-dev"], { all: 20, dev: 10 });
	assert.deepEqual(counts["android-dev"], { all: 20, dev: 10 });
	assert.equal(counts.macosworld.all + counts.mobileworld.all, 18);
});

test("the ported tasks name their source, its revision and licence", () => {
	for (const suite of ["macosworld", "mobileworld"]) {
		for (const task of loadSuite(join(SUITES, suite))) {
			const source = task.spec.source;
			assert.ok(source, `${task.spec.id} names no source`);
			assert.ok(source.suite && source.id && source.revision && source.licence, `${task.spec.id}: ${JSON.stringify(source)}`);
		}
	}
});

test("mac-dev and android-dev tasks cover the apps the brief names", () => {
	const apps = (suite) => new Set(loadSuite(join(SUITES, suite)).map((task) => task.spec.id.split(".")[1]));
	for (const app of ["notes", "calendar", "finder", "safari", "textedit", "settings", "reminders"]) assert.ok(apps("mac-dev").has(app), `mac-dev has no ${app} task`);
	for (const app of ["settings", "clock", "contacts", "files", "chrome"]) assert.ok(apps("android-dev").has(app), `android-dev has no ${app} task`);
});

test("a good task loads; its bench groups come from its setup and checks", () => {
	const task = loadTask(writeTask({ ...GOOD, setup: [{ method: "apps.launch", params: { id: "x" } }], checks: [...GOOD.checks, { id: "f", kind: "file", why: "w", path: "/x", exists: true }] }));
	assert.deepEqual([...task.benchGroups].sort(), ["apps", "exec", "files"]);
	assert.equal(checkGroup({ kind: "ui" }), "ui");
	assert.equal(checkGroup({ kind: "answer" }), undefined);
});

test("the schema refuses a task with a field missing, a bad id, an unknown check kind or an unknown field", () => {
	const { instruction: _, ...noInstruction } = GOOD;
	assert.match(problemsOf(noInstruction), /instruction/);
	assert.match(problemsOf({ ...GOOD, id: "Bad Id" }), /id/);
	assert.match(problemsOf({ ...GOOD, checks: [{ id: "c", kind: "vibes", why: "w" }] }), /kind|vibes/);
	assert.match(problemsOf({ ...GOOD, colour: "blue" }), /colour|additional/);
	assert.match(problemsOf({ ...GOOD, checks: [] }), /checks|fewer/);
});

test("the rules past the schema: placeholders, duplicate checks, regexes, exit, and a rubric for checks that are not sufficient", () => {
	assert.match(problemsOf({ ...GOOD, instruction: "Do {{thing}}" }), /thing/);
	assert.match(problemsOf({ ...GOOD, checks: [GOOD.checks[0], GOOD.checks[0]] }), /c/);
	assert.match(problemsOf({ ...GOOD, checks: [{ ...GOOD.checks[0], stdout: { matches: "([" } }] }), /regex|matches|\(\[/i);
	assert.match(problemsOf({ ...GOOD, setup: [{ method: "apps.launch", params: { id: "x" }, exit: [0] }] }), /exit/);
	assert.match(problemsOf({ ...GOOD, sufficient: false }), /rubric/);
	assert.equal(problemsOf({ ...GOOD, sufficient: false, rubric: "rubric.md" }, { "rubric.md": "# Done means\nit is done" }), "");
	assert.match(problemsOf({ ...GOOD, instruction: "{{file:missing.txt}}" }), /missing\.txt/);
	assert.match(problemsOf({ ...GOOD, params: { seed: { int: [1, 2] } } }), /seed/);
});

test("a suite with two tasks of one id is refused", () => {
	const root = tmp();
	for (const name of ["a", "b"]) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, "task.json"), JSON.stringify(GOOD));
	}
	assert.throws(() => loadSuite(root), /t\.good/);
});

test("a seed resolves the same way every time; params are picked independently; placeholders fill as strings", () => {
	const [task] = loadSuite(FAKE).filter((one) => one.spec.id === "fake.files.write");
	const one = resolveTask(task, 7);
	const again = resolveTask(task, 7);
	assert.deepEqual(one.params, again.params);
	assert.equal(one.instruction, again.instruction);
	assert.equal(one.nonce, nonceOf("fake.files.write", 7));
	assert.match(one.nonce, /^[0-9a-f]{6}$/);
	assert.equal(typeof one.params.n, "number", "an agent reads the param as it is");
	const write = one.oracle[0].params.argv;
	assert.deepEqual(write, ["write", `/tmp/bench-${one.nonce}.txt`, String(one.params.n)], "an argv word is always a string");
	assert.equal(one.checks[0].text.equals, String(one.params.n));
	const seen = new Set(Array.from({ length: 30 }, (_, seed) => pickParam("fake.files.write", seed, "n", { int: [2, 9] })));
	assert.ok(seen.size >= 6, `30 seeds pick ${seen.size} of 8 values`);
	for (const n of seen) assert.ok(n >= 2 && n <= 9);
	const a = Array.from({ length: 20 }, (_, seed) => pickParam("x", seed, "a", { pick: [0, 1] }));
	const b = Array.from({ length: 20 }, (_, seed) => pickParam("x", seed, "b", { pick: [0, 1] }));
	assert.notDeepEqual(a, b, "two params of one task are not picked in lockstep");
});

test("an object pick fills its fields, and a file placeholder is inlined with its own placeholders filled", () => {
	const dir = writeTask(
		{ ...GOOD, params: { mode: { pick: [{ name: "dark", want: "on" }] }, who: { pick: ["guests"] } }, instruction: "Set {{mode.name}}: {{file:steps.txt}}", checks: [{ id: "c", kind: "exec", why: "w", argv: ["get", "{{mode.name}}"], stdout: { equals: "{{mode.want}}" } }] },
		{ "steps.txt": "turn it {{mode.want}} for {{who}} ({{nonce}})" },
	);
	const resolved = resolveTask(loadTask(dir), 1);
	assert.equal(resolved.instruction, `Set dark: turn it on for guests (${resolved.nonce})`);
	assert.deepEqual(resolved.checks[0].argv, ["get", "dark"]);
	assert.equal(resolved.checks[0].stdout.equals, "on");
});
