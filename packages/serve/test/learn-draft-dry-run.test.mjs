// A workflow draft the checks pass is dry-run before it is proposed (learn/skills.ts draftDryRun over the DSL's
// dryRunWorkflow): every model and tool answer synthesized, nothing sent, paid or run. A draft whose wiring breaks at run
// time (an output path no step produces, a step's output that fails its schema) though validateWorkflow and every other
// check pass it is left out alone, saying so; one that passes is kept with its dry run, which the grader is told. Its
// block's `example:` line (the run's own input) is what it runs on, never written to the folder, and read for secrets.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as dsl from "@parcha/agentrun-dsl";
import * as skills from "../dist/learn/skills.js";

const { draftProblems } = skills;
/** The words a draft left out for its dry run starts with (skills.ts DRY_RUN_FAILED). */
const DRY_RUN_FAILED = skills.DRY_RUN_FAILED ?? "its dry run failed";
import { gradePrompt } from "../dist/learn/grade.js";
import { PROPOSAL, seedOf } from "../dist/learning.js";
import { proposeRun } from "../dist/propose.js";
import { learningWorkspace } from "../dist/workspace/index.js";
import { note } from "./learn-format-support.mjs";

const AGENT = "agent-1";
const SECRET = `not-a-secret-held-${process.pid}-dry-run`;
const schemas = {
  Question: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  Answer: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
  Lines: { type: "object", properties: { lines: { type: "string" } }, required: ["lines"] },
};
/** A draft named `name` with one extract step `step`, its output `output`. */
const draft = (name, step, output = { schemaId: "Answer", path: "answer" }) => ({ v: 2, name, schemas, input: { schemaId: "Question" }, output, root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", ...step }] } });
const GOOD = (name) => draft(name, { out: "Answer", as: "answer" });
/** Validates and passes every check, but no step produces its output's path. */
const UNPRODUCED = (name) => draft(name, { out: "Answer", as: "other" });
/** Validates and passes every check, but its output is a Lines where its schema says Answer. */
const MISTYPED = (name) => draft(name, { out: "Lines", as: "answer" });
const block = (name, flow, example) => `\`\`\`\`workflow ${name}\n---\ndescription: Answers a question as a number; use when asked for the answer\n${example === undefined ? "" : `example: ${example}\n`}---\n${JSON.stringify(flow)}\n\`\`\`\``;
const noteBlock = `\`\`\`note units.md\n${note({ name: "Units", description: "Check units first" })}\`\`\``;

/** proposeRun over `answer` against an empty folder, refusing `refuse`: its result and the proposal it kept. */
async function proposed(t, answer, refuse = []) {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-draft-dry-run-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const { sha } = await seedOf(data, AGENT);
  const runDir = mkdtempSync(join(data, "run-"));
  const folder = learningWorkspace({ mode: "local", data, agentId: AGENT });
  try {
    const result = await proposeRun({ folder: folder.workspace, runDir, seed: sha, turn: { answer, asked: [] }, refuse, outcome: "completed", tools: [] });
    const proposal = result.state === "proposed" ? JSON.parse(readFileSync(join(runDir, PROPOSAL), "utf8")) : undefined;
    return { result, proposal };
  } finally {
    await folder.end();
  }
}
const leftOf = (result) => (result.left ?? []).map(({ rule, path, detail }) => [rule, path, detail.startsWith(DRY_RUN_FAILED)]);

test("the gate: these drafts pass validateWorkflow and every check, and fail their dry run", async () => {
  for (const flow of [UNPRODUCED("x"), MISTYPED("x")]) {
    assert.equal(dsl.validateWorkflow(flow).ok, true, JSON.stringify(flow));
    assert.deepEqual(draftProblems(dsl, JSON.stringify(flow), []), []);
    assert.equal((await dsl.dryRunWorkflow(flow)).status, "failed");
  }
});

test("a draft whose output path no step produces is left out alone, saying its dry run failed; the note is kept", async (t) => {
  const { result } = await proposed(t, [noteBlock, block("broken", UNPRODUCED("broken"))].join("\n\n"));
  assert.equal(result.state, "proposed", JSON.stringify(result));
  assert.deepEqual([result.notes, result.workflows], [1, 0]);
  assert.deepEqual(leftOf(result), [["workflow", "workflows/broken/workflow.json", true]]);
});

test("a draft whose step's output fails its schema at run time is left out, saying where", async (t) => {
  const { result } = await proposed(t, [noteBlock, block("mistyped", MISTYPED("mistyped"))].join("\n\n"));
  assert.deepEqual([result.notes, result.workflows], [1, 0], JSON.stringify(result));
  assert.deepEqual(leftOf(result), [["workflow", "workflows/mistyped/workflow.json", true]]);
});

test("a draft that passes its dry run on its example is kept with it: the proposal says passed, and the README it commits holds no example", async (t) => {
  const example = JSON.stringify({ question: "What is six times seven, for customer Ada Lovelace?" });
  const { result, proposal } = await proposed(t, block("answer", GOOD("answer"), example));
  assert.deepEqual([result.state, result.workflows], ["proposed", 1], JSON.stringify(result));
  assert.deepEqual(proposal.dryRuns, { "workflows/answer/workflow.json": { status: "passed" } });
  const readme = proposal.files.find(({ file }) => file === "workflows/answer/README.md").text;
  assert.doesNotMatch(readme, /example/, readme);
  assert.ok(!JSON.stringify(proposal.files).includes("Ada Lovelace"), "the example is in no file the merge commits");
});

test("an example that fails the draft's input schema fails its dry run: the draft is left out", async (t) => {
  const { result } = await proposed(t, [noteBlock, block("answer", GOOD("answer"), JSON.stringify({ question: 42 }))].join("\n\n"));
  assert.deepEqual([result.notes, result.workflows], [1, 0], JSON.stringify(result));
  assert.deepEqual(leftOf(result), [["workflow", "workflows/answer/workflow.json", true]]);
  const { result: notJson } = await proposed(t, [noteBlock, block("answer", GOOD("answer"), "[1, 2]")].join("\n\n"));
  assert.deepEqual(leftOf(notJson), [["workflow", "workflows/answer/workflow.json", true]], "an example that is not one JSON object");
});

test("an example holding a held secret refuses the whole answer, as any text the run gives does, and names no value", async (t) => {
  const { result } = await proposed(t, [noteBlock, block("answer", GOOD("answer"), JSON.stringify({ question: `use ${SECRET}` }))].join("\n\n"), [SECRET]);
  assert.equal(result.state, "dropped", JSON.stringify(result));
  assert.deepEqual(result.problems.map(({ rule, path }) => [rule, path]), [["secret_value", "workflows/answer/README.md"]]);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test("the grader is told each draft's dry run under it: passed, or not run and why", () => {
  const files = [{ file: "workflows/answer/workflow.json", text: JSON.stringify(GOOD("answer")) }, { file: "workflows/answer/README.md", text: "---\nname: answer\ndescription: Answers\n---\n" }];
  const passed = gradePrompt({ run: "run-1", active: [], superseded: [], proposed: [], files, dryRuns: { "workflows/answer/workflow.json": { status: "passed" } } });
  assert.match(passed, /Its dry run passed on the supplied or synthesized input with synthetic model and tool answers \(no model or tool was called\)\. Only the exercised path was checked; skipped bodies and other branches remain unchecked\./);
  const notRun = gradePrompt({ run: "run-1", active: [], superseded: [], proposed: [], files, dryRuns: { "workflows/answer/workflow.json": { status: "not_run", detail: "Could not synthesize a valid input object." } } });
  assert.match(notRun, /Its dry run did not run: Could not synthesize a valid input object\. It has never been exercised\./);
  assert.doesNotMatch(gradePrompt({ run: "run-1", active: [], superseded: [], proposed: [], files }), /dry run/, "none given, none said");
});

// A hostile draft's code never runs in the host: not while it is checked, not in its dry run. Its code node escapes the
// DSL's shadowed globals (the Function constructor through a prototype) to leave a marker: once as the expression is
// compiled (its factory), once as its body runs. The static checks refuse it first, so it is never dry-run; and a dry run
// handed one anyway (draftDryRun alone) hands every code node to a runner that refuses it.
const MARKER = "__learnDryRunMarker";
const marking = (where) => `({}).constructor.constructor("globalThis.${MARKER} = (globalThis.${MARKER} || []).concat('${where}')")()`;
const CODE = `(${marking("factory")}, (s) => { ${marking("body")}; return { answer: { answer: 42 } }; })`;
const coded = (name) => ({ v: 2, name, schemas, input: { schemaId: "Question" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "chain", steps: [{ node: "code", label: "mark", code: CODE }] } });
/** The same code node one level down, in a composed workflow node's child. */
const nested = (name) => ({ v: 2, name, schemas, input: { schemaId: "Question" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "chain", steps: [{ node: "workflow", label: "inner", input: { question: "{question}" }, out: "Answer", as: "answer", workflow: coded(`${name}-inner`) }] } });

test("the marker: a code node's expression and body leave it when the DSL runs them in this process", () => {
  delete globalThis[MARKER];
  const fn = dsl.compileTransform(CODE);
  fn({});
  assert.deepEqual(globalThis[MARKER], ["factory", "body"], "the escape works, so its absence below means nothing ran");
  // Both drafts are valid workflows (checked without running code), so only the code node keeps them out.
  for (const flow of [coded("coded"), nested("nested")]) assert.equal(dsl.validateWorkflow(flow, { executeCode: false }).ok, true, JSON.stringify(dsl.validateWorkflow(flow, { executeCode: false }).errors));
  delete globalThis[MARKER];
});

test("a draft holding a code node is refused statically and never dry-run: none of its code runs in the host", async (t) => {
  for (const flow of [coded("coded"), nested("nested")]) {
    delete globalThis[MARKER];
    const { result, proposal } = await proposed(t, [noteBlock, block(flow.name, flow, JSON.stringify({ question: "q" }))].join("\n\n"));
    assert.equal(globalThis[MARKER], undefined, `${flow.name}: its code ran in the host: ${JSON.stringify(globalThis[MARKER])}`);
    assert.deepEqual([result.state, result.notes, result.workflows], ["proposed", 1, 0], JSON.stringify(result));
    const left = (result.left ?? []).filter(({ path }) => path === `workflows/${flow.name}/workflow.json`);
    assert.ok(left.some(({ rule }) => rule === "executable_node"), `${flow.name}: refused for its code node: ${JSON.stringify(result.left)}`);
    assert.ok(!left.some(({ detail }) => detail.startsWith(DRY_RUN_FAILED)), `${flow.name}: never dry-run: ${JSON.stringify(left)}`);
    assert.equal(proposal?.dryRuns?.[`workflows/${flow.name}/workflow.json`], undefined);
  }
  delete globalThis[MARKER];
});

test("a dry run handed a draft with a code node anyway runs none of its code: the node goes to a runner that refuses it", async () => {
  for (const flow of [coded("coded"), nested("nested")]) {
    delete globalThis[MARKER];
    const dry = await skills.draftDryRun(dsl, JSON.stringify(flow), JSON.stringify({ question: "q" }));
    assert.equal(globalThis[MARKER], undefined, `${flow.name}: its code ran in the host: ${JSON.stringify(globalThis[MARKER])}`);
    assert.equal(dry.status, "failed", JSON.stringify(dry));
    assert.match(dry.detail, /code/, dry.detail);
  }
  delete globalThis[MARKER];
});
