// The report's levels, on their own: a Core case skipped for a group the computer's kind does not require is filed under
// optional, never under core, and the verdict names it optional. Kept apart from the runner's and the groups' tests so a
// merge that takes another branch's report.ts and test files whole still meets this one. Fake provider, no Docker.
import assert from "node:assert/strict";
import test from "node:test";
import { conformanceCases, formatReport, runConformance } from "../dist/index.js";
import { fakeComputers } from "./fake-computer.mjs";

const cases = (...ids) => conformanceCases.filter((c) => ids.includes(c.id));

test("a linux computer whose provider declares no screen: its screen case is optional, not core, in the lines and the verdict", async () => {
	const { provider } = fakeComputers({ kind: "linux", groups: ["exec", "files", "processes"] });
	const report = await runConformance(provider, { image: "fixture:image", cases: cases("health.hello", "screen.screenshot-size"), patience: 1000 });
	const screen = report.results.find((r) => r.id === "screen.screenshot-size");
	assert.equal(screen?.level, "core", "the case itself is Core; the report files it by what the kind requires");
	assert.equal(screen?.status, "skip");
	assert.equal(report.core, "pass");

	const text = formatReport(report).trimEnd().split("\n");
	const all = text.join("\n");
	assert.ok(text.some((line) => /^optional screen +screenshot-size +- 1$/.test(line)), all);
	assert.deepEqual(text.filter((line) => /^core screen /.test(line)), [], all);
	assert.ok(text.some((line) => /^core health +hello +✓ 1$/.test(line)), all);
	assert.match(text.at(-1), /^core PASS 1\/1 · 1 optional case skipped, not declared · /, all);
	assert.doesNotMatch(all, /Core cases? skipped/);
});
