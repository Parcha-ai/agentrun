// A compile draft the static checks pass is dry-run before it is committed (runner/learning-end.ts checkDraftOf, over
// workflow-draft.ts draftDryRun and the DSL's dryRunWorkflow): every model and tool answer synthesized, nothing sent,
// paid or run. A draft whose wiring breaks at run time (an output path no step produces, a step's output that fails its
// schema) though validateWorkflow and every other check pass it is refused, saying so; one that passes is kept. Its
// block's `example:` line (the run's own input) is what it runs on, never written to the folder, and read for secrets.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as dsl from "@parcha/agentrun-dsl";
import * as drafts from "../dist/learn/workflow-draft.js";
import { learningFolderOf, seedOf } from "../dist/learning.js";
import { checkDraftOf } from "../dist/runner/learning-end.js";

const { draftProblems, DRY_RUN_FAILED } = drafts;
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
/** A compile block's text, as readCompile gives it: its front matter, then its workflow.json. */
const block = (flow, example) => `---\ndescription: Answers a question as a number; use when asked for the answer\n${example === undefined ? "" : `example: ${example}\n`}---\n${JSON.stringify(flow)}\n`;

/** checkDraftOf over `flow` (its block with `example`) against an empty folder, refusing `refuse`: its errors and what it kept. */
async function checked(t, flow, example, refuse = []) {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-draft-dry-run-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const { sha } = await seedOf(data, AGENT);
  // A run the store does not hold: no tools, no gate, no output schema.
  const deps = { store: { runs: { get: async () => undefined }, mcp: {} }, data, learningFolder: (agentId) => learningFolderOf(data, agentId) };
  return checkDraftOf(deps, { runId: "run-1", agentId: AGENT, seed: sha, draft: { name: flow.name, text: block(flow, example) }, refuse });
}
/** Whether `errors` is one error at `name`'s workflow.json saying its dry run failed. */
const dryFailed = (errors, name) => errors.length === 1 && errors[0].startsWith(`workflows/${name}/workflow.json: ${DRY_RUN_FAILED}`);

test("the gate: these drafts pass validateWorkflow and every check, and fail their dry run", async () => {
  for (const flow of [UNPRODUCED("x"), MISTYPED("x")]) {
    assert.equal(dsl.validateWorkflow(flow).ok, true, JSON.stringify(flow));
    assert.deepEqual(draftProblems(dsl, JSON.stringify(flow), []), []);
    assert.equal((await dsl.dryRunWorkflow(flow)).status, "failed");
  }
});

test("a draft whose output path no step produces is refused, saying its dry run failed", async (t) => {
  const result = await checked(t, UNPRODUCED("broken"));
  assert.ok(dryFailed(result.errors, "broken"), JSON.stringify(result));
  assert.equal(result.kept, undefined);
});

test("a draft whose step's output fails its schema at run time is refused, saying where", async (t) => {
  const result = await checked(t, MISTYPED("mistyped"));
  assert.ok(dryFailed(result.errors, "mistyped"), JSON.stringify(result));
});

test("a draft that passes its dry run on its example is kept, and the README it commits holds no example", async (t) => {
  const example = JSON.stringify({ question: "What is six times seven, for customer Ada Lovelace?" });
  const result = await checked(t, GOOD("answer"), example);
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  assert.deepEqual(result.kept.files.map(({ path }) => path), ["workflows/answer/workflow.json", "workflows/answer/README.md"]);
  const readme = result.kept.files.find(({ path }) => path === "workflows/answer/README.md").text;
  assert.doesNotMatch(readme, /example/, readme);
  assert.ok(!JSON.stringify(result.kept).includes("Ada Lovelace"), "the example is in no file the merge commits");
});

test("an example that fails the draft's input schema fails its dry run: the draft is refused", async (t) => {
  assert.ok(dryFailed((await checked(t, GOOD("answer"), JSON.stringify({ question: 42 }))).errors, "answer"));
  assert.ok(dryFailed((await checked(t, GOOD("answer"), "[1, 2]")).errors, "answer"), "an example that is not one JSON object");
});

test("an example holding a held secret refuses the draft, as any text the run gives does, and names no value", async (t) => {
  const result = await checked(t, GOOD("answer"), JSON.stringify({ question: `use ${SECRET}` }), [SECRET]);
  assert.equal(result.kept, undefined);
  assert.deepEqual(result.errors.map((error) => error.split(":")[0]), ["workflows/answer/README.md"], JSON.stringify(result));
  assert.ok(!JSON.stringify(result).includes(SECRET));
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
    const result = await checked(t, flow, JSON.stringify({ question: "q" }));
    assert.equal(globalThis[MARKER], undefined, `${flow.name}: its code ran in the host: ${JSON.stringify(globalThis[MARKER])}`);
    assert.equal(result.kept, undefined);
    assert.ok(result.errors.length > 0, JSON.stringify(result));
    assert.ok(!result.errors.some((error) => error.includes(DRY_RUN_FAILED)), `${flow.name}: never dry-run: ${JSON.stringify(result.errors)}`);
  }
  delete globalThis[MARKER];
});

test("a dry run handed a draft with a code node anyway runs none of its code: the node goes to a runner that refuses it", async () => {
  for (const flow of [coded("coded"), nested("nested")]) {
    delete globalThis[MARKER];
    const dry = await drafts.draftDryRun(dsl, JSON.stringify(flow), JSON.stringify({ question: "q" }));
    assert.equal(globalThis[MARKER], undefined, `${flow.name}: its code ran in the host: ${JSON.stringify(globalThis[MARKER])}`);
    assert.equal(dry.status, "failed", JSON.stringify(dry));
    assert.match(dry.detail, /code/, dry.detail);
  }
  delete globalThis[MARKER];
});

// A draft's schemas are synthesized in the host by its dry run: an untrusted draft whose schemas would build a huge value
// (two nested arrays of minItems 10000: 100M elements) is refused by the static checks, and a dry run handed one anyway
// stands down as not run before anything is built. Both within a time bound, with no allocation to speak of.
const HUGE = { type: "object", properties: { grid: { type: "array", minItems: 10_000, items: { type: "array", minItems: 10_000, items: { type: "string" } } } }, required: ["grid"] };
/** A draft whose input schema is `input`, and whose one step's output schema is `out`. */
const sized = (name, input, out = schemas.Answer) => ({ v: 2, name, schemas: { Question: input, Answer: out }, input: { schemaId: "Question" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] } });
const BIG_INPUT = sized("big-input", HUGE);
/** The same arrays in a step's output schema, with an example given: synthesized at the step, not as the input. */
const BIG_OUTPUT = sized("big-output", schemas.Question, { type: "object", properties: { answer: { type: "number" }, grid: HUGE.properties.grid }, required: ["answer"] });

test("a draft whose call node runs an MCP tool dry-runs on its output synthesized from out, as any call's: no request leaves the host (LS-07)", async (t) => {
  const flow = { v: 2, name: "file-ticket", schemas: { ...schemas, Ticket: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, input: { schemaId: "Question" }, output: { schemaId: "Ticket", path: "ticket" }, root: { node: "chain", steps: [{ node: "call", label: "File the ticket", via: "tool", tool: "mcp:linear/create_issue", args: { title: "{question}" }, out: "Ticket", as: "ticket", deadline_s: 60 }] } };
  // Every way out of the host this process has, watched: none is taken.
  const sent = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => (sent.push(String(args[0])), new Response("{}"));
  t.after(() => (globalThis.fetch = fetch));
  for (const http of [(await import("node:http")).default, (await import("node:https")).default]) {
    const request = http.request;
    http.request = (...args) => (sent.push(String(args[0]?.href ?? args[0]?.host ?? args[0])), request(...args));
    t.after(() => (http.request = request));
  }
  assert.deepEqual(draftProblems(dsl, JSON.stringify(flow), ["mcp:linear/create_issue"]), []);
  const dry = await drafts.draftDryRun(dsl, JSON.stringify(flow), JSON.stringify({ question: "The checkout page is down" }));
  assert.equal(dry.status, "passed", JSON.stringify(dry));
  assert.deepEqual(sent, [], "nothing was sent");
});

test("a draft whose schemas would synthesize a huge value is refused statically, never dry-run, within a time bound", async (t) => {
  for (const [flow, example] of [[BIG_INPUT, undefined], [BIG_OUTPUT, JSON.stringify({ question: "q" })]]) {
    const started = Date.now();
    const result = await checked(t, flow, example);
    assert.ok(Date.now() - started < 10_000, `${flow.name}: settled in ${Date.now() - started} ms`);
    assert.equal(result.kept, undefined);
    assert.ok(result.errors.some((error) => error.startsWith(`workflows/${flow.name}/workflow.json: `) && /synthesi/.test(error) && !error.includes(DRY_RUN_FAILED)), `${flow.name}: refused for its size, statically: ${JSON.stringify(result.errors)}`);
  }
});

test("draftProblems refuses a schema past the synthesis bound: a minItems or minLength past its cap, or a nesting whose product is", () => {
  const minItems = sized("x", { type: "object", properties: { list: { type: "array", minItems: 5_000, items: { type: "number" } } } });
  const minLength = sized("x", { type: "object", properties: { text: { type: "string", minLength: 1_000_000 } } });
  const product = sized("x", { type: "object", properties: { a: { type: "array", minItems: 60, items: { type: "array", minItems: 60, items: { type: "number" } } } } });
  for (const [what, flow] of [["minItems", minItems], ["minLength", minLength], ["product", product]]) {
    const problems = draftProblems(dsl, JSON.stringify(flow), []);
    assert.ok(problems.some(({ rule, detail }) => rule === "workflow" && /synthesi/.test(detail)), `${what}: ${JSON.stringify(problems)}`);
  }
  // Within the bounds: nothing said.
  const fine = sized("x", { type: "object", properties: { a: { type: "array", minItems: 10, items: { type: "array", minItems: 10, items: { type: "string", minLength: 20 } } } } });
  assert.deepEqual(draftProblems(dsl, JSON.stringify(fine), []), []);
});

test("a dry run handed a huge draft anyway stands down as not run before it builds anything, within a time bound", async () => {
  for (const [flow, example] of [[BIG_INPUT, undefined], [BIG_OUTPUT, JSON.stringify({ question: "q" })]]) {
    const started = Date.now();
    const dry = await drafts.draftDryRun(dsl, JSON.stringify(flow), example);
    assert.ok(Date.now() - started < 2_000, `${flow.name}: settled in ${Date.now() - started} ms`);
    assert.equal(dry.status, "not_run", JSON.stringify(dry));
    assert.match(dry.detail, /synthesi/, dry.detail);
  }
});

test("the count is the DSL's own synthesis, counted without building it: values and string characters, for every shape it reads", () => {
  const counted = (value) => (value === null || typeof value !== "object" ? { values: 1, chars: typeof value === "string" ? value.length : 0 } : Object.values(value).map(counted).reduce((a, b) => ({ values: a.values + b.values, chars: a.chars + b.chars }), { values: 1, chars: 0 }));
  const definitions = { Row: { type: "object", properties: { id: { type: "string", minLength: 3 }, tags: { type: "array", minItems: 2, items: { type: "string" } } } } };
  for (const schema of [
    { type: "object", properties: { a: { type: "array", minItems: 10, items: { type: "array", minItems: 10, items: { type: "string", minLength: 20 } } } } },
    { type: "object", properties: { rows: { type: "array", minItems: 4, items: { $ref: "#/definitions/Row" } }, missing: { $ref: "#/definitions/None" } } },
    { type: "object", properties: { maybe: { anyOf: [{ type: "null" }, { type: "string", minLength: 7 }] }, one: { oneOf: [{ type: "number" }, { type: "string" }] }, none: { type: "array", maxItems: 0, items: { type: "string" } } } },
    { type: "object", properties: { pick: { enum: ["left", "right"] }, fixed: { const: "x" }, empty: { type: "string", maxLength: 0 }, flag: { type: "boolean" }, bare: { type: "array" } } },
  ]) {
    const built = dsl.synthesizeInstance(schema, definitions);
    assert.deepEqual(drafts.synthesizedSize(schema, definitions), counted(built), JSON.stringify(schema));
  }
});

// A loop the dry run's step count never sees: its body a map over an empty list (no model or tool answer, so no step),
// its until never true, its maxIters huge. Refused statically by its bound (a loop's maxIters, and nested loops' product,
// past their caps), and a dry run handed one anyway stands down as not run: both within a time bound.
const spinning = (name, maxIters = 100_000_000, inner) => ({
  v: 2, name,
  schemas: { Question: { type: "object", properties: { question: { type: "string" }, items: { type: "array", maxItems: 0, items: { type: "string" } }, done: { type: "boolean" } }, required: ["question", "items", "done"] }, Answer: schemas.Answer },
  input: { schemaId: "Question" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "loop", label: "spin", maxIters, until: { predicate: "field_true", path: "done" }, body: inner ?? { node: "map", label: "each", itemsPath: "items", as: "seen", body: { node: "extract", label: "one", instructions: "x", out: "Answer", as: "one" } } },
    { node: "extract", label: "answer", instructions: "Answer.", out: "Answer", as: "answer" },
  ] },
});
const EMPTY = JSON.stringify({ question: "q", items: [], done: false });

test("a draft whose loop could spin with no step (an empty map for its body, an until never true) is refused statically, within a time bound", async (t) => {
  const started = Date.now();
  const result = await checked(t, spinning("spin"), EMPTY);
  assert.ok(Date.now() - started < 10_000, `settled in ${Date.now() - started} ms`);
  assert.equal(result.kept, undefined);
  assert.ok(result.errors.some((error) => error.startsWith("workflows/spin/workflow.json: ") && /maxIters/.test(error) && !error.includes(DRY_RUN_FAILED)), JSON.stringify(result.errors));
});

test("draftProblems refuses a loop's maxIters past its cap, and nested loops whose bounds multiply past theirs; within both, nothing", () => {
  const nestedLoops = spinning("x", 40, { node: "loop", label: "inner", maxIters: 40, until: { predicate: "field_true", path: "done" }, body: { node: "extract", label: "one", instructions: "x", out: "Answer", as: "one" } });
  for (const [what, flow] of [["one loop", spinning("x", 1_000)], ["nested", nestedLoops]]) {
    const problems = draftProblems(dsl, JSON.stringify(flow), []);
    assert.ok(problems.some(({ rule, detail }) => rule === "workflow" && /maxIters/.test(detail)), `${what}: ${JSON.stringify(problems)}`);
  }
  assert.deepEqual(draftProblems(dsl, JSON.stringify(spinning("x", 20)), []), []);
});

test("a dry run handed a spinning draft anyway stands down as not run, within a time bound", async () => {
  const started = Date.now();
  const dry = await drafts.draftDryRun(dsl, JSON.stringify(spinning("spin")), EMPTY);
  assert.ok(Date.now() - started < 2_000, `settled in ${Date.now() - started} ms`);
  assert.equal(dry.status, "not_run", JSON.stringify(dry));
  assert.match(dry.detail, /maxIters/, dry.detail);
});

// The bounds read a draft's schemas at schema positions only, and its loops at node positions only: a literal (a
// const, an enum's value, a default) that holds a bound's or a loop's words is data, never a bound or a loop.
test("a literal that holds minItems, minLength or a loop is no bound and no loop; a real one past its cap is still refused", () => {
  const literal = { minItems: 200, minLength: 5_000, node: "loop", label: "fake", maxIters: 100, body: { node: "loop", maxIters: 100 } };
  const quoting = sized("quoting", { type: "object", properties: { question: { type: "string" }, fixed: { const: literal }, pick: { enum: ["a", "b"], default: literal }, shown: { type: "string", examples: [literal] } }, required: ["question"] });
  assert.deepEqual(drafts.synthesisProblems(quoting, dsl), [], "no bound in a literal");
  assert.deepEqual(drafts.loopProblems(quoting), [], "no loop in a literal");
  // Real bounds, at schema positions other than properties: still refused.
  for (const schema of [
    { type: "object", properties: { pick: { anyOf: [{ type: "array", minItems: 5_000, items: { type: "number" } }, { type: "null" }] } } },
    { type: "object", $defs: { Big: { type: "string", minLength: 1_000_000 } }, properties: { a: { type: "string" } } },
    { type: "object", properties: { rows: { type: "array", items: { type: "array", minItems: 5_000, items: { type: "number" } } } } },
  ]) assert.ok(drafts.synthesisProblems(sized("x", schema), dsl).length, JSON.stringify(schema));
  // A real loop past the cap, inside a composed workflow node's child: still refused.
  const child = spinning("child", 1_000);
  const composed = { ...spinning("outer", 2), root: { node: "chain", steps: [{ node: "workflow", label: "inner", workflow: child, as: "inner" }] } };
  assert.ok(drafts.loopProblems(composed).some((problem) => /maxIters 1000/.test(problem)), JSON.stringify(drafts.loopProblems(composed)));
});

// The count reads each schema as the dry run does, after the DSL's resolution (resolveSchemaForWorkflow): a schema whose
// own `definitions` is empty still has its `$ref`s to the workflow's other schemas filled in, so a chain of arrays of
// minItems 100 through them (100M values), each link hiding the next behind its own empty definitions, is counted,
// refused statically and never dry-run.
const chained = (name) => ({
  v: 2, name,
  schemas: {
    Question: { type: "object", definitions: {}, properties: { grid: { $ref: "#/definitions/Level1" } }, required: ["grid"] },
    Level1: { type: "array", definitions: {}, minItems: 100, items: { $ref: "#/definitions/Level2" } },
    Level2: { type: "array", definitions: {}, minItems: 100, items: { $ref: "#/definitions/Level3" } },
    Level3: { type: "array", definitions: {}, minItems: 100, items: { $ref: "#/definitions/Level4" } },
    Level4: { type: "array", definitions: {}, minItems: 100, items: { type: "number" } },
    Answer: schemas.Answer,
  },
  input: { schemaId: "Question" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
});

test("a chain of $refs a schema's empty definitions hides is counted as the dry run resolves it: refused statically, never dry-run, within a time bound", async (t) => {
  assert.equal(dsl.validateWorkflow(chained("x"), { executeCode: false }).ok, true, "a valid workflow");
  assert.ok(draftProblems(dsl, JSON.stringify(chained("x")), []).some(({ rule, detail }) => rule === "workflow" && /synthesi/.test(detail) && /Question/.test(detail)), JSON.stringify(draftProblems(dsl, JSON.stringify(chained("x")), [])));
  const started = Date.now();
  const result = await checked(t, chained("chained"));
  assert.ok(Date.now() - started < 10_000, `settled in ${Date.now() - started} ms`);
  assert.equal(result.kept, undefined);
  assert.ok(result.errors.some((error) => error.startsWith("workflows/chained/workflow.json: ") && /synthesi/.test(error) && !error.includes(DRY_RUN_FAILED)), JSON.stringify(result.errors));
  const dryStarted = Date.now();
  const dry = await drafts.draftDryRun(dsl, JSON.stringify(chained("chained")));
  assert.ok(Date.now() - dryStarted < 2_000, `stood down in ${Date.now() - dryStarted} ms`);
  assert.equal(dry.status, "not_run", JSON.stringify(dry));
});
