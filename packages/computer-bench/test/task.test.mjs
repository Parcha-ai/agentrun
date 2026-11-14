// Tasks as data: the schema and the rules past it, every suite in the package loading, and seeds resolving the same
// way every time, so arms are paired.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DAEMON_METHODS } from "@parcha/agentrun-computer";
import { checkGroup, groupOf, helloMismatch, loadSuite, loadTask, nonceOf, pickParam, PROTOCOL_METHODS, resolveTask, TaskError } from "../dist/index.js";
import { FAKE, SUITES, tmp } from "./support.mjs";

const GOOD = {
	id: "t.good",
	version: 1,
	title: "A good task",
	split: "dev",
	needs: { os: "macos", kind: "desktop" },
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

test("every suite in the package loads; mac-dev, android-dev and linux-desktop are half dev and half held out", () => {
	const counts = {};
	for (const suite of ["fake", "ui-fixture", "mac-dev", "android-dev", "linux-desktop", "macosworld", "mobileworld"]) {
		const tasks = loadSuite(join(SUITES, suite));
		counts[suite] = { all: tasks.length, dev: tasks.filter((task) => task.spec.split === "dev").length };
		for (const task of tasks) {
			assert.match(task.sha256, /^[0-9a-f]{64}$/);
			for (const seed of [1, 2, 3]) resolveTask(task, seed);
		}
	}
	assert.deepEqual(counts["mac-dev"], { all: 20, dev: 10 });
	assert.deepEqual(counts["android-dev"], { all: 38, dev: 19 });
	assert.deepEqual(counts["linux-desktop"], { all: 10, dev: 5 });
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
	for (const app of ["editor", "terminal", "files", "browser", "cross"]) assert.ok(apps("linux-desktop").has(app), `linux-desktop has no ${app} task`);
});

test("every linux-desktop task denies exec and gets different params on seeds 1, 2 and 3", () => {
	for (const task of loadSuite(join(SUITES, "linux-desktop"))) {
		assert.equal(task.spec.exec, "deny", task.spec.id);
		const seen = new Set([1, 2, 3].map((seed) => JSON.stringify(resolveTask(task, seed).params)));
		assert.equal(seen.size, 3, `${task.spec.id} repeats its params across seeds 1-3`);
	}
});

test("a linux-desktop teardown stops only the apps its run started, and git-email checks the global config is kept", () => {
	for (const task of loadSuite(join(SUITES, "linux-desktop"))) {
		const scripts = (steps) => (steps ?? []).map((step) => (step.params?.argv ?? []).join(" "));
		for (const script of scripts(task.spec.teardown)) {
			for (const kill of script.match(/pkill[^;]*/g) ?? []) assert.match(kill, /computer-bench-\{\{nonce\}\}/, `${task.spec.id}'s teardown kills by a name any desktop's app has: ${kill}`);
		}
		for (const script of scripts(task.spec.setup.filter((step) => step.method === "process.start"))) {
			const app = /exec (mousepad|xfce4-terminal|thunar)\b/.exec(script)?.[1];
			if (app) assert.match(script, /echo \$\$ > \/tmp\/computer-bench-\{\{nonce\}\}-[a-z]+\.pid && exec /, `${task.spec.id} starts ${app} without keeping its pid`);
		}
	}
	const [git] = loadSuite(join(SUITES, "linux-desktop")).filter((task) => task.spec.id === "linux.terminal.git-email");
	assert.ok(git.spec.checks.some((check) => check.id === "global-email-kept"), "git-email passes an agent that also sets the global user.email");
});

test("a good task loads; its bench groups come from its setup and checks", () => {
	const task = loadTask(writeTask({ ...GOOD, setup: [{ method: "apps.launch", params: { id: "x" } }], checks: [...GOOD.checks, { id: "f", kind: "file", why: "w", path: "/x", exists: true }] }));
	assert.deepEqual([...task.benchGroups].sort(), ["apps", "exec", "files"]);
	assert.deepEqual(task.oracleGroups, []);
	assert.equal(checkGroup({ kind: "ui" }), "ui");
	assert.equal(checkGroup({ kind: "answer" }), undefined);
});

test("an oracle's input.actions needs any input group, and only when the oracle runs", () => {
	const task = loadTask(writeTask({ ...GOOD, oracle: [{ method: "input.actions", params: { actions: [{ type: "key", key: "a" }] } }] }));
	assert.deepEqual(task.benchGroups, ["exec"]);
	assert.deepEqual(task.oracleGroups, ["input"]);
	const hello = (groups) => ({ protocol: "0.2", os: "macos", kind: "desktop", arch: "arm64", groups });
	assert.equal(helloMismatch(hello(["exec", "input.keys", "input.pointer"]), task, ["exec"], "oracle"), undefined);
	assert.equal(helloMismatch(hello(["exec"]), task, ["exec"], "agent"), undefined);
	assert.equal(helloMismatch(hello(["exec"]), task, ["exec"], "null"), undefined);
	assert.match(helloMismatch(hello(["exec"]), task, ["exec"], "oracle"), /oracle needs input/);
});

test("the schema refuses a task with a field missing, a bad id, an unknown check kind or an unknown field", () => {
	const { instruction: _, ...noInstruction } = GOOD;
	assert.match(problemsOf(noInstruction), /instruction/);
	assert.match(problemsOf({ ...GOOD, id: "Bad Id" }), /id/);
	assert.match(problemsOf({ ...GOOD, checks: [{ id: "c", kind: "vibes", why: "w" }] }), /kind|vibes/);
	assert.match(problemsOf({ ...GOOD, colour: "blue" }), /colour|additional/);
	assert.match(problemsOf({ ...GOOD, checks: [] }), /checks|fewer/);
});

test("a ui.act call may name an element by find, and the schema holds the find to a ui query", () => {
	const act = (slot) => ({ ...GOOD, oracle: [{ method: "ui.act", params: { steps: [{ press: slot }] } }] });
	assert.equal(problemsOf(act("@e4")), "");
	assert.equal(problemsOf(act({ find: { role: "button", name: { equals: "Save" } } })), "");
	assert.match(problemsOf(act({ find: { colour: "red" } })), /colour|additional/);
	assert.match(problemsOf(act({ find: { role: "button" }, also: 1 })), /also|additional/);
	assert.match(problemsOf(act({ find: { name: { equals: "Save", near: "x" } } })), /near|additional/);
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

test("a capability probe is a check on the bench's channel: never an answer, the same for every seed, and its group is the bench's", () => {
	const probe = { id: "camera", kind: "exec", why: "the phone has a camera", argv: ["get", "camera"], stdout: { equals: "yes" } };
	const task = loadTask(writeTask({ ...GOOD, checks: [{ id: "a", kind: "answer", why: "w", text: { equals: "x" } }], needs: { ...GOOD.needs, capabilities: [probe] } }));
	assert.deepEqual(task.benchGroups, ["exec"], "the probe's exec is asked of the computer before anything runs");
	assert.match(problemsOf({ ...GOOD, needs: { ...GOOD.needs, capabilities: [{ id: "camera", kind: "answer", why: "w", text: { equals: "x" } }] } }), /capability camera is an answer check: a probe reads the computer, never an agent's answer/);
	assert.match(problemsOf({ ...GOOD, needs: { ...GOOD.needs, capabilities: [probe, probe] } }), /capability camera is probed twice/);
	assert.match(problemsOf({ ...GOOD, needs: { ...GOOD.needs, capabilities: [{ ...probe, argv: ["get", "{{nonce}}"] }] } }), /capability camera: a probe is the same for every seed, so it holds no \{\{nonce\}\}/);
	assert.match(problemsOf({ ...GOOD, needs: { ...GOOD.needs, capabilities: [{ ...probe, stdout: { matches: "([" } }] } }), /capability camera stdout/);
	// A probe gets every rule a check gets: a probe that can never pass would skip the task on every computer.
	const ui = { id: "dock", kind: "ui", why: "w", find: { role: "button", value: { matches: "([" } } };
	assert.match(problemsOf({ ...GOOD, needs: { ...GOOD.needs, capabilities: [ui] } }), /capability dock find\.value/);
	assert.match(problemsOf({ ...GOOD, needs: { ...GOOD.needs, capabilities: [{ ...ui, find: { role: "button" }, min: 2, max: 1 }] } }), /capability dock: min is above max/);
	assert.match(problemsOf({ ...GOOD, needs: { ...GOOD.needs, capabilities: [{ id: "f", kind: "file", why: "w", path: "/x", exists: false, text: { equals: "y" } }] } }), /capability f: a file that must not exist has no text to match/);
});

test("exec deny: the oracle drives the path the agent must, so a call outside ui, input, screen and apps is refused by name", () => {
	const deny = (oracle) => problemsOf({ ...GOOD, exec: "deny", oracle });
	const act = { method: "ui.act", params: { steps: [{ press: { find: { role: "button", name: { equals: "Save" } } } }] } };
	assert.equal(deny([act, { method: "input.actions", params: { actions: [] } }, { method: "apps.launch", params: { id: "x" } }, { method: "screen.shot", params: {} }]), "");
	assert.match(deny([act, { method: "exec.run", params: { argv: ["true"] } }]), /exec deny: the oracle's call 2, exec\.run, is the exec group's; an exec-deny oracle uses only ui, input, screen and apps/);
	assert.match(deny([{ method: "apps.install", params: { path: "/x.apk" } }]), /oracle's call 1, apps\.install, is the apps\.install group's/);
	assert.match(deny([{ method: "files.write", params: { path: "/x", data: "" } }]), /files\.write, is the files group's/);
	assert.equal(problemsOf({ ...GOOD, oracle: [{ method: "exec.run", params: { argv: ["true"] } }] }), "", "exec allow (the default) lets the oracle use exec");
});

test("a call names a protocol method: the wire's processes are process.*, and a name it doesn't have is refused at load", () => {
	assert.equal(groupOf("process.start"), "processes");
	assert.equal(groupOf("process.wait"), "processes");
	assert.deepEqual([...PROTOCOL_METHODS].sort(), Object.keys(DAEMON_METHODS).sort(), "the bench's list is the protocol's");
	assert.match(problemsOf({ ...GOOD, setup: [{ method: "processes.start", params: { argv: ["mousepad"] } }] }), /processes\.start is not a method of the computer protocol \(the wire's are process\.start/);
	assert.match(problemsOf({ ...GOOD, oracle: [{ method: "ui.tap", params: {} }] }), /ui\.tap is not a method of the computer protocol/);
	assert.equal(problemsOf({ ...GOOD, setup: [{ method: "process.start", params: { argv: ["mousepad"] } }] }), "");
});

test("needs.apps in the suites: each entry required, a list of alternatives where phone makers differ, Settings alone for settings", () => {
	const suites = ["fake", "ui-fixture", "mac-dev", "android-dev", "macosworld", "mobileworld"].flatMap((suite) => loadSuite(join(SUITES, suite)));
	const apps = (id) => suites.find((task) => task.spec.id === id).spec.needs.apps;
	const CLOCKS = ["com.google.android.deskclock", "com.android.deskclock", "com.sec.android.app.clockpackage"];
	const CONTACTS = ["com.google.android.contacts", "com.android.contacts", "com.samsung.android.app.contacts"];
	const FILES = ["com.google.android.documentsui", "com.android.documentsui", "com.google.android.apps.nbu.files", "com.sec.android.app.myfiles"];
	for (const id of ["android.clock.alarm-off", "android.clock.alarm-time", "android.clock.change-alarm", "android.clock.set-alarm"]) assert.deepEqual(apps(id), [CLOCKS], id);
	for (const id of ["android.contacts.add-contact", "android.contacts.add-email", "android.contacts.edit-phone"]) assert.deepEqual(apps(id), [CONTACTS], id);
	for (const id of ["android.files.delete-file", "android.files.move-file", "android.files.rename-file", "mobileworld.bid-file-rename", "mobileworld.invoice-receipt-copy"]) assert.deepEqual(apps(id), [FILES], id);
	assert.deepEqual(apps("mobileworld.check-invoice-1"), [[...FILES, "com.google.android.apps.docs"]]);
	assert.deepEqual(apps("android.share.link-to-contact"), ["com.android.chrome", CONTACTS]);
	assert.deepEqual(apps("mobileworld.take-selfie"), [["com.google.android.GoogleCamera", "com.android.camera2", "com.android.camera", "com.sec.android.app.camera"]]);
	for (const task of suites.filter((one) => /^(android\.settings|mobileworld\.(adjust-brightness|open-flight|close-flight))/.test(one.spec.id))) assert.deepEqual(task.spec.needs.apps, ["com.android.settings"], task.spec.id);
	// apps.list lists the apps a person can open: never a system service such as systemui.
	for (const task of suites) assert.ok(!JSON.stringify(task.spec.needs.apps ?? []).includes("com.android.systemui"), task.spec.id);
});

test("take-selfie probes for a camera and takes its photo through the camera app's shutter", () => {
	const [task] = loadSuite(join(SUITES, "mobileworld")).filter((one) => one.spec.id === "mobileworld.take-selfie");
	const [camera] = task.spec.needs.capabilities;
	assert.equal(camera.id, "camera");
	assert.equal(camera.kind, "exec");
	assert.match(camera.argv.join(" "), /dumpsys media\.camera/);
	const methods = task.spec.oracle.map((call) => call.method);
	assert.ok(methods.includes("ui.act"), "the oracle presses the shutter");
	assert.ok(!JSON.stringify(task.spec.oracle).includes("screencap"), "no screen capture stands in for a photo");
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
