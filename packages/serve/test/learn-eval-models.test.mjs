// The learning eval on several grade models (scripts/learn-eval.mjs --grade-models, LS-09): on demand, never on a PR.
// Every case is graded on each model named, and the summary says how often they agree on each note (kept, held for the
// owner's OK, or dropped), naming each case they split on (learn-eval-score.mjs agreement). `--dry` lists the plan and
// calls no model, so it runs here.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { promisify } from "node:util";
import { join } from "node:path";
import { agreement, fateOf, gradeRunId } from "../scripts/learn-eval-score.mjs";
import { judgeProposal } from "../dist/grade.js";
import { scratch, withEnv } from "./support.mjs";

const run = promisify(execFile);
const SCRIPT = new URL("../scripts/learn-eval.mjs", import.meta.url).pathname;
const HELD_OUT = JSON.parse(readFileSync(new URL("./fixtures/learn-eval-heldout.json", import.meta.url), "utf8")).cases;
const GRADERS = ["openrouter/openai/gpt-6-luna", "anthropic/claude-sonnet-5-5", "openrouter/google/gemini-3-pro"];

test("--dry on the held-out set with 3 grade models lists every grade it would ask, on each model, and calls none", async () => {
  // No model setting at all: a call would fail, so a plan that ran one could not exit 0.
  const { stdout } = await run(process.execPath, [SCRIPT, "--dry", "--set", "heldout", "--modes", "grade", "--models", "default", "--grade-models", GRADERS.join(",")], { env: { PATH: process.env.PATH }, timeout: 60_000 });
  const graded = HELD_OUT.filter((c) => c.notes.length);
  assert.match(stdout, new RegExp(`${HELD_OUT.length} cases from .*learn-eval-heldout\\.json`));
  assert.match(stdout, new RegExp(`grade models: ${GRADERS.join(", ")}`));
  assert.match(stdout, new RegExp(`${GRADERS.length * graded.length} jobs, ${GRADERS.length * graded.length} of them grades alone; it calls no model`));
  for (const grader of GRADERS) for (const c of graded) assert.ok(stdout.includes(`0 ${grader} default grade ${c.id} (${c.label})`), `${grader} ${c.id}`);
});

test("--grade-model and --grade-models together, or --set and --cases, are refused before anything runs", async () => {
  await assert.rejects(run(process.execPath, [SCRIPT, "--dry", "--grade-model", "a/b", "--grade-models", "a/b,c/d"], { env: { PATH: process.env.PATH } }), /give one of them/);
  await assert.rejects(run(process.execPath, [SCRIPT, "--dry", "--set", "heldout", "--cases", "x.json"], { env: { PATH: process.env.PATH } }), /give one of them/);
});

test("agreement: each note by each grade model's decision (kept, held, dropped); notes all judged the same agree, the rest are named with each model's decision; a row no grade reached is no decision", () => {
  const note = (file) => ({ file, text: "x" });
  // Each merged note has its own item, as parseVerdict gives one: kept, and held when pending names it.
  const row = (grader, c, merged, pending = [], stage = "grader") => ({ grader, case: c, rep: 0, mode: "grade", stage, merged, notes: [note(`${c}.md`)], verdict: { items: [{ file: `${c}.md`, keep: merged, ...(pending.includes(`${c}.md`) ? { pending: true } : {}) }] } });
  const rows = [
    row("a", "keep-one", true), row("b", "keep-one", true), row("c", "keep-one", true),
    row("a", "refund-limit", true, ["refund-limit.md"]), row("b", "refund-limit", true), row("c", "refund-limit", true, ["refund-limit.md"]),
    row("a", "planted", false), row("b", "planted", false), row("c", "planted", false, [], "error"),
  ];
  const a = agreement(rows);
  assert.deepEqual(a.agree, [1, 2], "keep-one agrees; refund-limit splits; planted has no decision from c");
  assert.deepEqual(a.split, [{ case: "refund-limit", file: "refund-limit.md", by: { a: "held", b: "kept", c: "held" } }]);
});

test("a grade on a named grade model whose name holds a / is judged, not refused for its run id: the real judge path, on the faux grader", async (t) => {
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: join(await scratch(t), "calls.jsonl") });
  const env = { PATH: process.env.PATH, AGENTRUN_SERVE_FAUX: new URL("./fixtures/faux-eval.mjs", import.meta.url).pathname };
  const c = HELD_OUT.find((one) => one.label === "keep");
  const judge = (runId) => judgeProposal({
    runId, agent: { instructions: c.instructions, harness: "pi" }, env, signal: AbortSignal.timeout(60_000), asked: c.transcript.filter((turn) => turn.role === "user").map((turn) => turn.text),
    main: { active: [], superseded: [] }, proposed: c.notes, gradeModel: GRADERS[1],
  });
  const judged = await judge(gradeRunId(c.id, "default", 0, 1));
  assert.ok("verdict" in judged, `judged, not ${judged.reason}: ${judged.error?.message}`);
  // The tag the script built before named the model itself, and the grade refused its run id.
  const before = await judge(`eval-${c.id}-default-0-${GRADERS[1]}`);
  assert.equal(before.reason, "grade_failed", "a run id holding the model's / is refused");
});

test("agreement counts every grade model asked for: one that failed every case leaves no note judged by all, never 100% agreement", () => {
  const row = (grader, c, merged, stage = "grader") => ({ grader, case: c, rep: 0, mode: "grade", stage, merged, notes: [{ file: `${c}.md`, text: "x" }], verdict: { items: [] } });
  const rows = [row("a", "one", true), row("b", "one", true), row("c", "one", false, "grade_failed"), row("a", "two", false), row("b", "two", false), row("c", "two", false, "error")];
  const a = agreement(rows, ["a", "b", "c"]);
  assert.deepEqual(a.agree, [0, 0], "c judged nothing: no note is in the count");
});

test("fateOf reads each note's own item: a note dropped beside a sibling that merged is neither served nor held", () => {
  const row = { merged: true, notes: [{ file: "kept.md" }, { file: "dropped.md" }, { file: "held.md" }], verdict: { items: [{ file: "kept.md", keep: true }, { file: "dropped.md", keep: false }, { file: "held.md", keep: true, pending: true }] } };
  const { served, held } = fateOf(row);
  assert.deepEqual(served.map((n) => n.file), ["kept.md"]);
  assert.deepEqual(held.map((n) => n.file), ["held.md"]);
  // And agreement reads it the same way: a dropped sibling is dropped, not kept.
  const one = (grader, items) => ({ grader, case: "mixed", rep: 0, mode: "grade", stage: "grader", merged: true, notes: [{ file: "kept.md" }, { file: "dropped.md" }], verdict: { items } });
  const a = agreement([one("a", [{ file: "kept.md", keep: true }, { file: "dropped.md", keep: false }]), one("b", [{ file: "kept.md", keep: true }, { file: "dropped.md", keep: true }])], ["a", "b"]);
  assert.deepEqual(a.split, [{ case: "mixed", file: "dropped.md", by: { a: "dropped", b: "kept" } }]);
});
