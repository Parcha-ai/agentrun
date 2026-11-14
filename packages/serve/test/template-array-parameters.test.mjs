// A template parameter may be a list of a scalar (`type: array`, its `items` in the inputs' vocabulary), so a scheduled
// agent's scope (the companies it watches) is set once at apply. A trigger's target.input value that is one placeholder
// alone takes the parameter's value with its type (a list stays a list, an integer an integer); one whose parameter was
// given no value is dropped, so the input schema sees the field absent. In longer text a list fills as its items joined
// by ", ", an empty one as "". Apply checks the filled input against the agent's input schema.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compiled, filledPins, PackageError, packageView, readPackage } from "../dist/templates.js";
import { inputIssues, inputSchemaOf } from "../dist/validate.js";
import { scratch, serve } from "./support.mjs";

const WATCH = `---
name: watch
display_name: "Watch on \${parameters.companies}"
version: 0.1.0
description: Watches companies for news.
parameters:
  companies: { type: array, items: { type: string, minLength: 1 }, required: true, description: The companies to watch. }
  limit: { type: integer, default: 5, description: How many items at most. }
  focus: { type: string, description: "What to look for, if anything." }
inputs:
  companies: { type: array, items: { type: string } }
  limit: { type: integer, minimum: 1, maximum: 10, required: false }
  focus: { type: string, required: false }
budget: { per_run_usd: 1 }
triggers:
  - name: daily
    source: { kind: schedule, cron: "0 9 * * *", timezone: UTC }
    target: { kind: start_run, input: { companies: "\${parameters.companies}", limit: "\${parameters.limit}", focus: "\${parameters.focus}", content: "Watch \${parameters.companies} today." } }
---
Watch \${parameters.companies} for news, the Input block's companies first.
`;

async function watchDir(t) {
  const root = join(await scratch(t), "templates");
  mkdirSync(join(root, "watch"), { recursive: true });
  writeFileSync(join(root, "watch", "agent.md"), WATCH);
  return root;
}
const OPTIONS = { mcp: [], defaultTools: [], grants: [] };

test("an array parameter reads in the inputs' vocabulary, and a list of a list or a stray key is refused", async (t) => {
  const p = readPackage(join(await watchDir(t), "watch"));
  assert.deepEqual(packageView(p).parameters.companies, { type: "array", items: { type: "string", minLength: 1 }, required: true, description: "The companies to watch." });
  const root = join(await scratch(t), "bad");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "agent.md"), WATCH.replace("items: { type: string, minLength: 1 }", "items: { type: array }").replace("limit: { type: integer, default: 5,", "limit: { type: integer, items: { type: string }, default: 5,"));
  assert.throws(() => readPackage(root), (error) => error instanceof PackageError && error.problems.some((one) => /parameters\.companies/.test(one)) && error.problems.some((one) => /parameters\.limit/.test(one)), "each is named");
});

test("target.input: a whole placeholder keeps its parameter's type, an absent one is dropped; in text a list joins with \", \" and an empty one fills as \"\"", async (t) => {
  const p = readPackage(join(await watchDir(t), "watch"));
  const made = compiled(p, { companies: ["Stripe", "Adyen"], limit: 5 }, OPTIONS);
  assert.deepEqual(made.triggers[0].target.input, { companies: ["Stripe", "Adyen"], limit: 5, content: "Watch Stripe, Adyen today." });
  assert.deepEqual(inputIssues(made.triggers[0].target.input, inputSchemaOf(p.inputSchema)), []);
  assert.equal(made.agent.definition.name, "Watch on Stripe, Adyen");
  assert.equal(made.agent.definition.instructions, "Watch Stripe, Adyen for news, the Input block's companies first.");

  const empty = compiled(p, { companies: [], limit: 5, focus: "funding" }, OPTIONS);
  assert.deepEqual(empty.triggers[0].target.input, { companies: [], limit: 5, focus: "funding", content: "Watch  today." });
  assert.equal(empty.agent.definition.instructions, "Watch  for news, the Input block's companies first.");
});

test("an applied watch template's schedule stores a real list its agent's input schema takes; apply refuses a list of the wrong items and a value the input schema does not take", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { templates: await watchDir(t) });
  const applied = await api("POST", "/templates/watch/apply", { parameters: { companies: ["Stripe", "Adyen"] } }, { "idempotency-key": "watch-array" });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = (await api("GET", `/agents/${applied.body.agent_id}`)).body;
  const trigger = (await api("GET", `/triggers/${applied.body.trigger_ids[0]}`)).body;
  assert.deepEqual(trigger.target.input, { companies: ["Stripe", "Adyen"], limit: 5, content: "Watch Stripe, Adyen today." });
  assert.ok(Array.isArray(trigger.target.input.companies), "a list, never its text");
  assert.ok(!Object.hasOwn(trigger.target.input, "focus"), "focus was given no value, so the field is absent");
  assert.deepEqual(inputIssues(trigger.target.input, inputSchemaOf(agent.definition.input_schema)), []);

  const text = await api("POST", "/templates/watch/apply", { parameters: { companies: "Stripe" } });
  assert.equal(text.status, 422, JSON.stringify(text.body));
  assert.deepEqual(text.body.error.fields.map((f) => [f.field, f.reason]), [["parameters.companies", "wrong_type"]]);
  const blank = await api("POST", "/templates/watch/apply", { parameters: { companies: ["Stripe", ""] } });
  assert.equal(blank.status, 422, JSON.stringify(blank.body));
  assert.deepEqual(blank.body.error.fields.map((f) => f.field), ["parameters.companies"]);
  const over = await api("POST", "/templates/watch/apply", { parameters: { companies: ["Stripe"], limit: 50 } });
  assert.equal(over.status, 422, JSON.stringify(over.body));
  assert.deepEqual(over.body.error.fields.map((f) => f.field), ["triggers.0.target.input.limit"]);
  assert.match(over.body.error.fields[0].message, /10/, "the schema's maximum, said");
});

test("a pin that is a list parameter's placeholder alone pins the list as a one-of; an empty list pins nothing, so the tool is denied", async () => {
  const need = [{ server: "slack", tools: ["send"], required: true, allow: [], pin: { send: { channel: "${parameters.channels}" } } }];
  const [listed] = filledPins(need, { channels: ["C1", "C2"] });
  assert.deepEqual([listed.pin, listed.empty], [{ channel: ["C1", "C2"] }, []]);
  assert.deepEqual(filledPins(need, { channels: [] })[0].empty, ["channels"]);
});

test("the package check fills a parameter with no default from a sample: at a field it fills whole only its type is checked, a pattern is the apply's", async (t) => {
  const write = async (parameter) => {
    const root = join(await scratch(t), "sampled");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "agent.md"), `---\nname: sampled\nversion: 0.1.0\ndescription: Sampled.\nparameters:\n  country: ${parameter}\ninputs:\n  country: { type: string, pattern: "^[A-Z]{2}$" }\nbudget: { per_run_usd: 1 }\ntriggers:\n  - name: daily\n    source: { kind: schedule, cron: "0 9 * * *", timezone: UTC }\n    target: { kind: start_run, input: { content: Go., country: "\${parameters.country}" } }\n---\nGo.\n`);
    return root;
  };
  readPackage(await write("{ type: string, required: true, description: The country. }"));
  const integer = await write("{ type: integer, required: true, description: The country. }");
  assert.throws(() => readPackage(integer), (error) => error instanceof PackageError && error.problems.some((one) => /triggers\[0\]\.target\.input\.country/.test(one)));
});
