// Conformance by kind: `--kind <kind>` runs the kind's cases (those whose groups the kind requires or allows, and those
// that need no group), and a provider passes a kind only when it serves the kind and every case of each required group
// passes, at least one of them. Fake computers and the suite's own cases or stand-ins; no Docker, no vendor.
import assert from "node:assert/strict";
import test from "node:test";
import { conformanceCases, formatReport, kindCases, kindVerdict, runConformance } from "../dist/index.js";
import { main } from "../dist/conformance/cli.js";
import { fakeComputers } from "./fake-computer.mjs";

const IMAGE = "fixture:image";
const ids = (cases) => cases.map((c) => c.id);
const pass = (id, needs, extra = {}) => ({ id, level: "core", group: id.split(".")[0], needs, run: async () => {}, ...extra });
const sink = () => {
	let text = "";
	return { write: (chunk, done) => ((text += chunk), done?.(), true), text: () => text };
};

test("kindCases: sandbox runs the shell, file and process cases and those that need no group, and no screen, input, touch or apps case", () => {
	const sandbox = ids(kindCases("sandbox"));
	for (const id of ["exec.argv", "files.home", "process.stdin", "health.hello", "provider.create-release", "drift.version"]) assert.ok(sandbox.includes(id), id);
	for (const id of ["screen.screenshot-size", "input.click-lands", "touch.tap", "apps.install-launch"]) assert.ok(!sandbox.includes(id), id);
	for (const c of kindCases("sandbox")) assert.ok(conformanceCases.includes(c), "the suite's own cases");
});

test("kindCases: desktop runs the screen and input cases and its optional shell; phone runs screen, touch, keys and apps, and no shell case; browser no-group and its groups' cases; none runs none", () => {
	const desktop = ids(kindCases("desktop"));
	for (const id of ["exec.argv", "screen.screenshot-size", "input.click-lands", "input.type-text"]) assert.ok(desktop.includes(id), id);
	assert.ok(!desktop.includes("touch.tap"));
	const phone = ids(kindCases("phone"));
	for (const id of ["screen.screenshot-size", "touch.tap", "input.type-text", "apps.ui-tree-shape", "health.hello"]) assert.ok(phone.includes(id), id);
	for (const id of ["exec.argv", "input.click-lands", "apps.install-launch"]) assert.ok(!phone.includes(id), `${id}: it needs a group phone neither requires nor allows`);
	const browser = ids(kindCases("browser"));
	assert.ok(browser.includes("health.hello") && !browser.includes("exec.argv") && !browser.includes("screen.screenshot-size"), browser.join(" "));
	assert.deepEqual(kindCases("none"), []);
});

/** A sandbox run over stand-in cases, one per required group unless told otherwise. */
async function sandboxRun({ cases, groups } = {}) {
	const { provider } = fakeComputers(groups ? { groups } : {});
	const run = cases ?? [pass("exec.ok", ["exec"]), pass("files.ok", ["files"]), pass("process.ok", ["processes"]), pass("health.ok", [])];
	const report = await runConformance(provider, { image: IMAGE, kind: "sandbox", cases: run });
	return { report, verdict: kindVerdict("sandbox", provider.capabilities(), report, run) };
}

test("a provider passes a kind when it serves it and every case of each required group passes; the report carries the verdict", async () => {
	const { report, verdict } = await sandboxRun();
	assert.deepEqual(verdict, { kind: "sandbox", verdict: "pass", reasons: [] });
	assert.deepEqual(report.kindVerdict, verdict);
	assert.match(formatReport(report), /^kind sandbox PASS$/m);
});

test("it fails a kind, naming why: a failed case of a required group, a required group no case passed, a group not declared", async () => {
	const failed = await sandboxRun({ cases: [pass("exec.ok", ["exec"]), pass("files.ok", ["files"]), pass("process.bad", ["processes"], { run: async (t) => t.equal(1, 2, "one") })] });
	assert.equal(failed.verdict.verdict, "fail");
	assert.ok(failed.verdict.reasons.some((r) => r.includes("process.bad")), failed.verdict.reasons.join("; "));
	assert.match(formatReport(failed.report), /^kind sandbox FAIL: .*process\.bad/m);
	const untested = await sandboxRun({ cases: [pass("exec.ok", ["exec"]), pass("files.ok", ["files"])] });
	assert.equal(untested.verdict.verdict, "fail");
	assert.ok(untested.verdict.reasons.some((r) => /no case of processes passed/.test(r)), untested.verdict.reasons.join("; "));
	const undeclared = await sandboxRun({ groups: ["exec", "files"] });
	assert.equal(undeclared.verdict.verdict, "fail");
	assert.ok(undeclared.verdict.reasons.some((r) => /needs groups processes/.test(r)), undeclared.verdict.reasons.join("; "));
});

test("a case skipped for an optional group the computer does not declare does not fail its kind; one skipped otherwise does", async () => {
	const optional = await sandboxRun({ cases: [pass("exec.ok", ["exec"]), pass("exec.root", ["exec", "user:root"]), pass("files.ok", ["files"]), pass("process.ok", ["processes"])] });
	assert.equal(optional.verdict.verdict, "pass", optional.verdict.reasons.join("; "));
	const skipped = await sandboxRun({ cases: [pass("exec.ok", ["exec"]), pass("files.ok", ["files"]), pass("process.ok", ["processes"]), pass("process.skip", ["processes"], { run: async (t) => t.skip("no fixture here") })] });
	assert.equal(skipped.verdict.verdict, "fail");
	assert.ok(skipped.verdict.reasons.some((r) => r.includes("process.skip")), skipped.verdict.reasons.join("; "));
});

test("runConformance refuses kind and only together, and kind none, in words; browser fails until a cdp case passes", async () => {
	const { provider } = fakeComputers();
	await assert.rejects(runConformance(provider, { image: IMAGE, kind: "sandbox", only: ["exec"] }), /kind and only/);
	await assert.rejects(runConformance(provider, { image: IMAGE, kind: "none" }), /none.*no computer/);
	const browser = await runConformance(provider, { image: IMAGE, kind: "browser", cases: [pass("health.ok", [])] });
	assert.equal(browser.kindVerdict.verdict, "fail");
	assert.ok(browser.kindVerdict.reasons.some((r) => /no case of cdp passed/.test(r)), browser.kindVerdict.reasons.join("; "));
});

test("the CLI's --kind runs the kind and exits 0 only on its pass; it refuses an unknown kind, none, and --only beside it", async () => {
	const cases = [pass("exec.ok", ["exec"]), pass("files.ok", ["files"]), pass("process.ok", ["processes"])];
	const out = sink();
	assert.equal(await main(["--provider", "./fixtures/fake-provider.mjs", "--kind", "sandbox"], { stdout: out, stderr: sink(), cwd: new URL(".", import.meta.url).pathname, cases }), 0);
	assert.match(out.text(), /^kind sandbox PASS$/m);
	const failing = [...cases.slice(0, 2)];
	assert.equal(await main(["--provider", "./fixtures/fake-provider.mjs", "--kind", "sandbox"], { stdout: sink(), stderr: sink(), cwd: new URL(".", import.meta.url).pathname, cases: failing }), 1);
	for (const [argv, words] of [
		[["--kind", "laptop"], /--kind: "laptop" is not a kind/],
		[["--kind", "none"], /--kind none/],
		[["--kind", "sandbox", "--only", "exec"], /--kind and --only/],
	]) {
		const err = sink();
		assert.equal(await main(["--provider", "./fixtures/fake-provider.mjs", ...argv], { stdout: sink(), stderr: err, cases }), 2, argv.join(" "));
		assert.match(err.text(), words);
	}
});
