import test from "node:test";
import assert from "node:assert/strict";
import { dryRunWorkflow, synthesizeInstance } from "../dist/index.js";

const SCHEMAS = {
  Finding: { type: "object", additionalProperties: false, required: ["verdict", "reason"], properties: { verdict: { type: "string", enum: ["ASSIGNED", "REFER"] }, reason: { type: "string" }, code: { type: ["string", "null"] } } },
  Output: { type: "object", additionalProperties: false, required: ["verdict", "code", "rationale"], properties: { verdict: { type: "string" }, code: { type: ["string", "null"] }, rationale: { type: "string" } } },
};
const wf = (root, schemas = SCHEMAS) => ({ v: 2, name: "dry", schemas, output: { schemaId: "Output", path: "final" }, root });

test("synthesizeInstance produces schema-conforming instances (enum first, required+optional, one array item, $ref deref)", () => {
  const definitions = { Row: { type: "object", required: ["id"], properties: { id: { type: "string" } } } };
  const instance = synthesizeInstance({
    type: "object",
    required: ["verdict", "rows"],
    properties: {
      verdict: { type: "string", enum: ["ASSIGNED", "REFER"] },
      rows: { type: "array", items: { $ref: "#/definitions/Row" } },
      note: { type: ["string", "null"] },
      score: { type: "integer", minimum: 3 },
    },
  }, definitions);
  assert.equal(instance.verdict, "ASSIGNED");
  assert.deepEqual(instance.rows, [{ id: "x" }]);
  assert.equal(instance.score, 3);
});

test("dry run rejects assembly that omits required output fields", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "agent", label: "gather", instructions: "g", out: "Finding", as: "evidence" },
      // The defect: rationale is required by Output but the assemble never writes it.
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.evidence.verdict, code: s.evidence.code ?? null } })" },
    ],
  });
  const result = await dryRunWorkflow(workflow);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /rationale/.test(p)), `problems name the missing field: ${JSON.stringify(result.problems)}`);
});

test("dry run REJECTS a code node that throws over schema-conforming inputs, naming the node", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "agent", label: "gather", instructions: "g", out: "Finding", as: "evidence" },
      { node: "code", label: "explode", code: "(s) => ({ x: s.evidence.missing.deep })" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: 'ASSIGNED', code: null, rationale: 'r' } })" },
    ],
  });
  const result = await dryRunWorkflow(workflow);
  assert.equal(result.ok, false);
  assert.ok(result.problems[0].includes("explode"), result.problems[0]);
});

test("dry run PASSES a workflow whose assemble satisfies the output schema", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "agent", label: "gather", instructions: "g", out: "Finding", as: "evidence" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.evidence.verdict, code: s.evidence.code ?? null, rationale: s.evidence.reason } })" },
    ],
  });
  const result = await dryRunWorkflow(workflow);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
});

test("dry run STANDS DOWN (ok + skipped) on generator-unsupported constructs like pattern", async () => {
  const schemas = {
    ...SCHEMAS,
    Finding: { ...SCHEMAS.Finding, properties: { ...SCHEMAS.Finding.properties, reason: { type: "string", pattern: "^[A-Z]{4}$" } } },
  };
  const workflow = wf({
    node: "chain", steps: [
      { node: "agent", label: "gather", instructions: "g", out: "Finding", as: "evidence" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: 'x' } })" }, // would fail — must not be reached
    ],
  }, schemas);
  const result = await dryRunWorkflow(workflow);
  assert.equal(result.ok, true);
  assert.ok(result.skipped.some((s) => /pattern/.test(s)));
});

test("an escalate tripping on synthetic values is a stand-down, not a rejection", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "decide", label: "judge", instructions: "d", out: "Finding", as: "sel" },
      // Synthetic enum-first always picks ASSIGNED — force the predicate to fire on it.
      { node: "escalate", label: "gate", when: { predicate: "field_equals", path: "sel.verdict", value: "ASSIGNED" }, kind: "always_fires", stage: "judge", summary: "synthetic" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.sel.verdict, code: null, rationale: s.sel.reason } })" },
    ],
  });
  const result = await dryRunWorkflow(workflow);
  assert.equal(result.ok, true);
  assert.ok(result.skipped.some((s) => /escalated:always_fires/.test(s)));
});

test("dry run executes a map over a generated list and assembles its results", async () => {
  const schemas = {
    Items: { type: "object", required: ["hits"], properties: { hits: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } } },
    Finding: SCHEMAS.Finding,
    Output: SCHEMAS.Output,
  };
  const workflow = wf({
    node: "chain", steps: [
      { node: "agent", label: "screen", instructions: "s", out: "Items", as: "screened" },
      { node: "map", label: "rate", itemsPath: "screened.hits", as: "ratings", body: { node: "decide", label: "rateOne", instructions: "r", out: "Finding", as: "rating" } },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.ratings[0].verdict, code: null, rationale: s.ratings[0].reason } })" },
    ],
  }, schemas);
  const result = await dryRunWorkflow(workflow);
  assert.equal(result.ok, true);
});

test("a PROPERTY literally named 'pattern' (or 'format'/'not') never stands the gate down", async () => {
  const schemas = {
    Finding: { type: "object", required: ["pattern", "format"], properties: { pattern: { type: "string" }, format: { type: "string" }, not: { type: ["string", "null"] } } },
    Output: SCHEMAS.Output,
  };
  const workflow = wf({
    node: "chain", steps: [
      { node: "agent", label: "gather", instructions: "g", out: "Finding", as: "evidence" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.evidence.pattern, code: null, rationale: s.evidence.format } })" },
    ],
  }, schemas);
  const result = await dryRunWorkflow(workflow);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined, `gate ran, no stand-down: ${JSON.stringify(result.skipped)}`);
});

test("numeric probes honor maximum/exclusive bounds instead of violating their own schema", () => {
  assert.equal(synthesizeInstance({ type: "integer", maximum: -1 }), -1);
  assert.equal(synthesizeInstance({ type: "number", exclusiveMinimum: 0 }), 1);
  assert.equal(synthesizeInstance({ type: "integer", exclusiveMaximum: 0 }), -1);
  assert.equal(synthesizeInstance({ type: "integer", minimum: 2, maximum: 5 }), 2);
});

test("integer probes with fractional bounds land on integers inside the bounds", () => {
  assert.equal(synthesizeInstance({ type: "integer", minimum: 1.8 }), 2);
  assert.equal(synthesizeInstance({ type: "integer", maximum: -1.2 }), -2);
  assert.equal(synthesizeInstance({ type: "number", minimum: 1.8 }), 1.8);
});

test("an exclusive bound beyond float ±1 resolution stands the gate down instead of falsely rejecting", async () => {
  const schemas = {
    Finding: { type: "object", required: ["big"], properties: { big: { type: "number", exclusiveMinimum: 1e18 } } },
    Output: SCHEMAS.Output,
  };
  const workflow = wf({
    node: "chain", steps: [
      { node: "agent", label: "gather", instructions: "g", out: "Finding", as: "evidence" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: 'v', code: null, rationale: 'r' } })" },
    ],
  }, schemas);
  const result = await dryRunWorkflow(workflow);
  assert.equal(result.ok, true);
  assert.ok(result.skipped.some((s) => /exclusiveMinimum beyond float step/.test(s)));
});

test("narrow two-sided numeric intervals take the midpoint instead of clamping across a bound", () => {
  assert.equal(synthesizeInstance({ type: "number", exclusiveMinimum: 5.2, exclusiveMaximum: 5.5 }), 5.35);
  assert.equal(synthesizeInstance({ type: "number", minimum: 2, maximum: 3 }), 2);
  assert.equal(synthesizeInstance({ type: "integer", exclusiveMinimum: 5.2, maximum: 9 }), 6);
});

test("midpoint of float-max-scale bounds does not overflow to Infinity", () => {
  const value = synthesizeInstance({ type: "number", exclusiveMinimum: 1.5e308, exclusiveMaximum: 1.7e308 });
  assert.equal(value, 1.6e308);
  assert.ok(Number.isFinite(value));
});

// extract rides the same synthetic runNode as agent/decide: an extract-first workflow must
// clear the dry-run gate with no special-casing.
test("an extract-first workflow dry-runs clean", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "extract", label: "subject", instructions: "transcribe", out: "Finding", as: "subj", requires: ["question"] },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.subj.verdict, code: s.subj.code ?? null, rationale: s.subj.reason } })" },
    ],
  });
  const result = await dryRunWorkflow(workflow, { input: { question: "A subject to transcribe" } });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("dry run passes a report-terminal workflow with zero special-casing (the stub is schema-driven)", async () => {
  const { dryRunWorkflow } = await import("../dist/index.js");
  const workflow = {
    v: 2, name: "report-terminal", schemas: { Out: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } } }, output: { schemaId: "Out", path: "final" },
    root: { node: "chain", steps: [
      { node: "decide", label: "select", instructions: "i", out: "Out", as: "sel" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.sel.verdict } })" },
      { node: "report", label: "write-up", instructions: "render" },
    ] },
  };
  assert.deepEqual(await dryRunWorkflow(workflow), { ok: true });
});
