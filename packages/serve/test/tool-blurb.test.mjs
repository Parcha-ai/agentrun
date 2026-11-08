// Each tool's `blurb`: one short line for people (the agent editor's Tools grid), served beside its model-facing
// `summary` in capabilities.tools and in GET /v2/agents/{id}'s `tools`, from one source so both agree. The model never
// sees it. An MCP server's tool has none: its own description is all there is.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openapiDocument } from "../dist/openapi.js";
import { agentTools } from "../dist/tool-plane.js";
import { toolsView } from "../dist/tools.js";

const MAX = 48;

test("every tool in capabilities has a blurb: one line of at most 48 characters, sentence case, no full stop, not its summary", () => {
  const tools = toolsView({});
  assert.ok(tools.length > 10, "the table is read");
  for (const tool of tools) {
    assert.equal(typeof tool.blurb, "string", `${tool.name} has a blurb`);
    assert.ok(tool.blurb.length > 0 && tool.blurb.length <= MAX, `${tool.name}: ${tool.blurb.length} characters, at most ${MAX}`);
    assert.ok(!/[.\n]$/.test(tool.blurb) && !tool.blurb.includes("\n"), `${tool.name}: one line, no full stop: ${JSON.stringify(tool.blurb)}`);
    assert.match(tool.blurb, /^[A-Z]/, `${tool.name}: sentence case`);
    assert.notEqual(tool.blurb, tool.summary, `${tool.name}: the blurb is for people, not the model's summary`);
  }
  const by = Object.fromEntries(tools.map((tool) => [tool.name, tool.blurb]));
  assert.equal(by.web_fetch, "Read a public web page");
  assert.equal(by.bash, "Run shell commands in the sandbox");
  assert.equal(by.ask_person, "Ask you a question mid-run");
});

test("an agent's tools carry the same blurb as capabilities; an MCP tool has none", () => {
  const caps = toolsView({});
  const capBlurb = Object.fromEntries(caps.map((tool) => [tool.name, tool.blurb]));
  const names = [...caps.filter((tool) => !tool.call_only).map((tool) => tool.name), "learned_workflow", "mcp:srv/echo"];
  const tools = agentTools({}, {}, { tools: names }, caps.map((tool) => tool.name));
  const by = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const tool of caps.filter((tool) => !tool.call_only)) assert.equal(by[tool.name]?.blurb, capBlurb[tool.name], tool.name);
  assert.equal(typeof by.learned_workflow?.blurb, "string", "learned_workflow, the server's own tool, has one");
  assert.ok(by.learned_workflow.blurb.length <= MAX && !by.learned_workflow.blurb.endsWith("."), by.learned_workflow.blurb);
  assert.equal("blurb" in (by["mcp:srv/echo"] ?? {}), false, "an MCP server's tool has no blurb");
});

/** Every object schema in `doc` whose properties include all of `keys`. */
const schemasWith = (doc, keys) => {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.properties && keys.every((key) => Object.hasOwn(node.properties, key))) found.push(node);
    for (const value of Object.values(node)) walk(value);
  };
  walk(doc);
  return found;
};

test("openapi: capabilities.tools[] and an agent's tools[] declare blurb, an optional string", () => {
  const doc = openapiDocument(() => undefined);
  const capability = schemasWith(doc, ["summary", "nodes", "calls", "available"]);
  const agent = schemasWith(doc, ["permission_from", "default_permission", "permissions"]);
  assert.ok(capability.length > 0 && agent.length > 0, "both schemas are found");
  for (const schema of [...capability, ...agent]) {
    assert.equal(schema.properties.blurb?.type, "string", JSON.stringify(Object.keys(schema.properties)));
    assert.equal((schema.required ?? []).includes("blurb"), false, "optional: an older server sends none");
  }
});
