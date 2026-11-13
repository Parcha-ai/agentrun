// A run input the workflow's schema refuses names the field and the reason (#1926): the validator's message, which
// names the schema's path and never the input's own data, is the answer's words, and the field carries that path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { flowAgent, serve } from "./support.mjs";

// The reporter's schema: no `required` list, an optional field with a constraint.
const reporterFlow = () => ({
  v: 2, name: "echo",
  schemas: {
    In: { type: "object", properties: { a: { type: "string" }, b: { type: "string", minLength: 1 } } },
    Out: { type: "object", required: ["echo"], properties: { echo: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Out", path: "result" },
  root: { node: "code", label: "echo", code: "(s) => ({ result: { echo: s.a ?? '' } })" },
});

test("a rejected run input says which schema path and why, and never echoes the input", async (t) => {
  const { api } = await serve(t, { allowCodeNodes: true });
  assert.equal((await api("POST", "/agents", flowAgent("echo", reporterFlow()))).status, 201);
  const secretish = "the-input-value-that-must-not-come-back";
  const refused = await api("POST", "/agents/echo/runs", { input: { a: secretish, b: "" } });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "input_invalid");
  assert.equal(refused.body.error.message, "the workflow does not take this input: #/properties/b: must not have fewer than 1 characters");
  assert.deepEqual(refused.body.error.fields, [{ field: "input at #/properties/b", reason: "invalid", message: "the workflow does not take this input: #/properties/b: must not have fewer than 1 characters" }]);
  assert.ok(!JSON.stringify(refused.body).includes(secretish), "the answer echoes the input's data");
  // Without the field, the same workflow runs.
  const started = await api("POST", "/agents/echo/runs", { input: { a: "hello" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
});

test("an input that is no JSON object says so in words, not as a code", async (t) => {
  const { api } = await serve(t, { allowCodeNodes: true });
  assert.equal((await api("POST", "/agents", flowAgent("echo", reporterFlow()))).status, 201);
  const refused = await api("POST", "/agents/echo/runs", { input: ["not", "an", "object"] });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.doesNotMatch(refused.body.error.message, /INPUT_INVALID/);
});
