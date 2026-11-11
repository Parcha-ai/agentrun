// workflowIssues and readWorkflowRun (workflow-run.ts): what a save of a workflow revision would refuse, each issue at its node's path, and
// a call node whose tool the revision does not list. Ported with workflow-run.ts from @parcha/pi-durable-agent's
// workflow-body.test.mjs, whose checkWorkflowBody wrapped it; the cases read the issues it answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readWorkflowRun, workflowIssues, WorkflowRunUnread } from "../dist/workflow-run.js";

const TOOLS = ["stock.check", "prices.quote", "prices.slow_quote"];
function workflowDoc() {
  const quote = (label, tool) => ({ node: "call", label, via: "tool", tool, args: { sku: "{sku}" }, out: "Quote", as: "quote", deadline_s: 20 });
  return {
    v: 2, name: "stock-and-quote",
    schemas: {
      In: { type: "object", additionalProperties: false, required: ["sku", "amount"], properties: { sku: { type: "string" }, amount: { type: "number", minimum: 0, maximum: 1000 } } },
      Stock: { type: "object", required: ["tier"], properties: { tier: { enum: ["fast", "slow"] } } },
      Quote: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Quote", path: "quote" },
    root: {
      node: "chain",
      steps: [
        { node: "call", label: "stock", via: "tool", tool: "stock.check", args: { sku: "{sku}" }, out: "Stock", as: "stock", deadline_s: 20 },
        { node: "route", label: "by tier", valuePath: "stock.tier", branches: { fast: { body: quote("quote fast", "prices.quote") }, slow: { body: quote("quote slow", "prices.slow_quote") } } },
      ],
    },
  };
}
const codes = async (workflow, tools) => (await workflowIssues(workflow, tools)).issues.map(({ path, code }) => [path, code]);

test("a valid workflow whose tools list every call node's tool has no issue; undefined tools list every tool", async () => {
  assert.deepEqual(await codes(workflowDoc(), TOOLS), []);
  assert.deepEqual(await codes(workflowDoc(), [...TOOLS, "other.tool"]), []);
  assert.deepEqual(await codes(workflowDoc()), []);
});

test("a malformed workflow is an issue at the node's path, and its message quotes none of its values", async () => {
  const malformed = workflowDoc();
  malformed.root.steps[0] = { ...malformed.root.steps[0], label: "Private label", out: "PrivateSchema" };
  const { issues } = await workflowIssues(malformed, TOOLS);
  assert.deepEqual(issues.map(({ path, code }) => [path, code]), [["/root/steps/0", "SCHEMA_UNKNOWN"]]);
  assert.deepEqual(await codes("not a workflow", TOOLS), [["", "NODE_FIELD_INVALID"]]);
});

test("a call node whose tool the revision does not list is TOOL_NOT_LISTED at its path; no tools listed is none", async () => {
  assert.deepEqual(await codes(workflowDoc(), ["stock.check", "prices.quote"]), [["/root/steps/1/branches/slow/body", "TOOL_NOT_LISTED"]]);
  assert.deepEqual((await codes(workflowDoc(), [])).map(([, code]) => code), ["TOOL_NOT_LISTED", "TOOL_NOT_LISTED", "TOOL_NOT_LISTED"]);
});

test("what the durable runner refuses before any step is an issue too: two nodes on one label", async () => {
  const twice = workflowDoc();
  twice.root.steps[1].label = "Private label";
  twice.root.steps[0].label = "Private label";
  const { issues } = await workflowIssues(twice, TOOLS);
  assert.deepEqual(issues.map(({ code }) => code), ["DUPLICATE_LABEL"]);
});

test("a run in the driver's keyed layout is not read here, and a read with no journal or context is refused in words", async () => {
  // A journal whose driver document is in the keyed layout, as a host that opts into layout v4 writes it.
  const storage = {
    findDocument: async (query) => ({ id: query.kind }),
    document: async (id) => ({ value: id === "agentrun.driver" ? { state: { schema: "agentrun.frozen_run.v4" } } : {} }),
    task: async () => undefined,
  };
  const revision = { id: "rev-1", kind: "workflow", body: { workflow: workflowDoc() } };
  await assert.rejects(readWorkflowRun({ runId: "run-1", storage, revision }, { context: BACKGROUND_CONTEXT }), (error) => error instanceof WorkflowRunUnread && /keyed layout/.test(error.message));
  await assert.rejects(readWorkflowRun({ runId: "run-1", revision }, { context: BACKGROUND_CONTEXT }), WorkflowRunUnread);
  await assert.rejects(readWorkflowRun({ runId: "run-1", storage, revision }), WorkflowRunUnread);
});
