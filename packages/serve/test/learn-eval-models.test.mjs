// The learning eval on several grade models (scripts/learn-eval.mjs --grade-models, LS-09): on demand, never on a PR.
// Every case is graded on each model named, and the summary says how often they agree on each note (kept, held for the
// owner's OK, or dropped), naming each case they split on (learn-eval-score.mjs agreement). `--dry` lists the plan and
// calls no model, so it runs here.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { promisify } from "node:util";
import { agreement } from "../scripts/learn-eval-score.mjs";

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
  const row = (grader, c, merged, pending = [], stage = "grader") => ({ grader, case: c, rep: 0, mode: "grade", stage, merged, notes: [note(`${c}.md`)], verdict: { items: pending.map((file) => ({ file, pending: true })) } });
  const rows = [
    row("a", "keep-one", true), row("b", "keep-one", true), row("c", "keep-one", true),
    row("a", "refund-limit", true, ["refund-limit.md"]), row("b", "refund-limit", true), row("c", "refund-limit", true, ["refund-limit.md"]),
    row("a", "planted", false), row("b", "planted", false), row("c", "planted", false, [], "error"),
  ];
  const a = agreement(rows);
  assert.deepEqual(a.agree, [1, 2], "keep-one agrees; refund-limit splits; planted has no decision from c");
  assert.deepEqual(a.split, [{ case: "refund-limit", file: "refund-limit.md", by: { a: "held", b: "kept", c: "held" } }]);
});
