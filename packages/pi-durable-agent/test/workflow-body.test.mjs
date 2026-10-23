import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentHomeError } from "../dist/index.js";
import { checkWorkflowBody } from "../dist/workflow.js";
import { bodyOf, workflowDoc } from "./workflow-support.mjs";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const DSL_AND_PI = /^@parcha\/agentrun-(dsl|pi)(\/|$)/;

/** A refusal as `invalid` whose message matches `message` and quotes none of `values`. */
const invalidAs = (message, values = []) => (error) => {
  assert.ok(error instanceof AgentHomeError, `an AgentHomeError, not ${error?.name}: ${error?.message}`);
  assert.equal(error.code, "invalid");
  if (message) assert.match(error.message, message);
  for (const value of values) assert.ok(!error.message.includes(value), `the message quotes ${value}: ${error.message}`);
  return true;
};

test("checkWorkflowBody passes a body whose workflow is valid and whose tools list every call node's tool", async () => {
  assert.equal(await checkWorkflowBody(bodyOf()), undefined);
  assert.equal(await checkWorkflowBody({ workflow: workflowDoc(), tools: ["stock.check", "prices.quote", "prices.slow_quote", "other.tool"] }), undefined);
});

test("checkWorkflowBody refuses a malformed workflow as invalid, naming the node's path and the problem, never a value", async () => {
  const malformed = workflowDoc();
  malformed.root.steps[0] = { ...malformed.root.steps[0], label: "Private label", out: "PrivateSchema" };
  await assert.rejects(checkWorkflowBody(bodyOf(malformed)), invalidAs(/\/root\/steps\/0: SCHEMA_UNKNOWN/, ["Private label", "PrivateSchema"]));
  await assert.rejects(checkWorkflowBody({ ...bodyOf(), workflow: { v: 2, name: "Private name" } }), invalidAs(/not valid/, ["Private name"]));
});

test("checkWorkflowBody refuses a body that is not one, and a call node whose tool the body does not list, at the node's path", async () => {
  for (const body of [null, "workflow", [], {}, { workflow: "{}" }, { workflow: workflowDoc(), tools: "stock.check" }]) {
    await assert.rejects(checkWorkflowBody(body), invalidAs(), JSON.stringify(body));
  }
  await assert.rejects(checkWorkflowBody({ workflow: workflowDoc(), tools: ["stock.check", "prices.quote"] }),
    invalidAs(/call node at \/root\/steps\/1\/branches\/slow\/body uses a tool/, ["prices.slow_quote"]));
  // No tools listed is none: the first call node is refused.
  await assert.rejects(checkWorkflowBody({ workflow: workflowDoc() }), invalidAs(/call node at \/root\/steps\/0 uses a tool/, ["stock.check"]));
});

test("checkWorkflowBody refuses what the durable runner refuses before any step: two nodes on one label", async () => {
  const twice = workflowDoc();
  twice.root.steps[1].label = "Private label";
  twice.root.steps[0].label = "Private label";
  await assert.rejects(checkWorkflowBody(bodyOf(twice)), invalidAs(/two nodes with one label/, ["Private label"]));
});

/** The modules the static import closure of the built `entry` reaches: the package's own files and the bare specifiers. */
function staticImports(entry) {
  const seen = new Set(), bare = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith(".")) visit(path.resolve(path.dirname(file), specifier));
      else bare.add(specifier);
    }
  };
  visit(path.join(dist, entry));
  return { files: [...seen].map((file) => path.relative(dist, file)), bare: [...bare] };
}

test("the package root never loads the DSL or agentrun-pi: its static import closure holds neither, nor ./workflow.js", () => {
  const { files, bare } = staticImports("index.js");
  assert.ok(files.length > 5, "the closure was read");
  assert.ok(!files.includes("workflow.js"), "the root does not import ./workflow.js");
  assert.deepEqual(bare.filter((specifier) => DSL_AND_PI.test(specifier)), []);
});

test("./workflow imports neither statically: it loads them inside the functions that need them", () => {
  assert.deepEqual(staticImports("workflow.js").bare.filter((specifier) => DSL_AND_PI.test(specifier)), []);
});
