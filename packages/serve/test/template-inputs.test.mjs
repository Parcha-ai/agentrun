// A template's `inputs:` (agent.md front matter): each run's typed input, in the same small vocabulary as `parameters`
// plus title, examples, bounds and lists of a scalar, compiled into the agent's input_schema at apply. The package check
// refuses anything outside that vocabulary, a trigger whose target.input the schema refuses, and an eval case whose typed
// input it refuses; the bundled kyb package takes its subject as typed input.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compiled, PackageError, packageView, readPackage, TEMPLATES_DIR } from "../dist/templates.js";
import { readCases } from "../dist/template-eval.js";
import { schemaCheck } from "../dist/answer-json.js";
import { inputIssues, inputSchemaOf } from "../dist/validate.js";
import { follow, scratch, serve } from "./support.mjs";

const INPUTS = `inputs:
  company:  { type: string, title: "Company name", description: "The company's legal or trading name.", examples: ["Stripe, Inc."] }
  website:  { type: string, format: uri, required: false }
  country:  { type: string, pattern: "^[A-Z]{2}$", required: false }
  reason:   { type: string, enum: [vendor, customer, investment], default: vendor, required: false }
  limit:    { type: integer, minimum: 1, maximum: 50, required: false }
  topics:   { type: array, items: { type: string }, required: false }
`;

/** A one-file package in a scratch folder: `front` is its front matter after name, version and description. */
async function pkg(t, front, { extra } = {}) {
  const dir = join(await scratch(t), "typed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), `---\nname: typed\nversion: 0.1.0\ndescription: A typed agent.\n${front}---\nCheck the company in the Input block.\n`);
  await extra?.(dir);
  return dir;
}
const problems = (dir) => {
  try {
    readPackage(dir);
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return error.problems;
  }
  return [];
};

test("a package's inputs compile to its agent's input_schema: required by default, each keyword of the vocabulary kept, served on the package view", async (t) => {
  const p = readPackage(await pkg(t, INPUTS));
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["company"],
    properties: {
      company: { type: "string", title: "Company name", description: "The company's legal or trading name.", examples: ["Stripe, Inc."] },
      website: { type: "string", format: "uri" },
      country: { type: "string", pattern: "^[A-Z]{2}$" },
      reason: { type: "string", enum: ["vendor", "customer", "investment"], default: "vendor" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      topics: { type: "array", items: { type: "string" } },
    },
  };
  assert.deepEqual(p.inputSchema, schema);
  assert.deepEqual(packageView(p).input_schema, schema);
  assert.deepEqual(compiled(p, {}, { mcp: [], defaultTools: [], grants: [] }).agent.definition.input_schema, schema);
  // A package with no inputs: its agent takes {content}, as before.
  const plain = readPackage(await pkg(t, ""));
  assert.equal(packageView(plain).input_schema, null);
  assert.equal(compiled(plain, {}, { mcp: [], defaultTools: [], grants: [] }).agent.definition.input_schema, undefined);
});

test("inputs outside the vocabulary are refused, each by name: a bad key, an unknown keyword, an object or a list of lists, a default that does not meet its own field, content as anything but text", async (t) => {
  const found = problems(await pkg(t, `inputs:
  Company: { type: string }
  nested: { type: object }
  lists: { type: array, items: { type: array } }
  extra: { type: string, minItems: 2 }
  limit: { type: integer, minimum: 1, default: 0, required: false }
  content: { type: integer }
  site: { type: string, format: phone }
`));
  const said = found.join("\n");
  for (const name of ["inputs.Company", "inputs.nested", "inputs.lists", "inputs.extra", "inputs.limit.default", "inputs.content", "inputs.site.format"]) assert.match(said, new RegExp(name.replace(/\./g, "\\.")), `${name} is named: ${said}`);
});

test("a trigger's target.input is checked against the package's inputs, and an eval case's typed input too", async (t) => {
  const triggered = problems(await pkg(t, `${INPUTS}budget: { per_run_usd: 1 }
triggers:
  - name: weekly
    source: { kind: schedule, cron: "0 9 * * 1", timezone: UTC }
    target: { kind: start_run, input: { content: "Check them.", limit: 0 } }
`));
  assert.ok(triggered.some((p) => /triggers\[0\]\.target\.input\.company/.test(p)), triggered.join("\n"));
  assert.ok(triggered.some((p) => /triggers\[0\]\.target\.input\.limit/.test(p)), triggered.join("\n"));

  const evaled = await pkg(t, INPUTS, {
    extra: (dir) => {
      for (const [name, front] of [["good", 'input: { company: "Stripe, Inc.", country: US }\n'], ["bad", "input: { country: usa }\n"]]) {
        mkdirSync(join(dir, "evals", name, "graders"), { recursive: true });
        writeFileSync(join(dir, "evals", name, "prompt.md"), `---\n${front}---\nCheck them: we are about to sign.\n`);
        writeFileSync(join(dir, "evals", name, "graders", "named.md"), "---\ntype: regex\npattern: Stripe\n---\n");
      }
    },
  });
  assert.throws(() => readCases(evaled), (error) => /evals\/bad\/prompt\.md: input\.company/.test(error.message) && /evals\/bad\/prompt\.md: input\.country/.test(error.message) && !/evals\/good/.test(error.message), "the bad case's input is refused by path, the good one's taken");
  const { cases } = readCases(evaled, ["good"]);
  assert.deepEqual(cases[0].fields, { company: "Stripe, Inc.", country: "US" });

  // The Input: block is the server's, made from `input:`: a case never writes its own.
  const handWritten = await pkg(t, INPUTS, {
    extra: (dir) => {
      mkdirSync(join(dir, "evals", "own", "graders"), { recursive: true });
      writeFileSync(join(dir, "evals", "own", "prompt.md"), '---\ninput: { company: "Stripe, Inc." }\n---\nCheck them.\n\nInput:\n```json\n{"country": "US"}\n```\n');
      writeFileSync(join(dir, "evals", "own", "graders", "named.md"), "---\ntype: regex\npattern: Stripe\n---\n");
    },
  });
  assert.throws(() => readCases(handWritten), (error) => /evals\/own\/prompt\.md: .*Input:/.test(error.message), "a hand-written Input: block is refused");
});

test("kyb takes its subject as typed input matching its report's subject.input, and each of its eval cases gives one its schema takes", () => {
  const kyb = readPackage(join(TEMPLATES_DIR, "kyb"));
  assert.deepEqual(Object.keys(kyb.inputSchema.properties), ["company", "website", "country", "registration_number", "reason"]);
  assert.deepEqual(kyb.inputSchema.required, ["company"]);
  assert.deepEqual(kyb.inputSchema.properties.reason.enum, ["vendor", "customer", "investment"]);
  const { cases } = readCases(join(TEMPLATES_DIR, "kyb"));
  for (const one of cases) {
    assert.ok(one.fields?.company, `${one.name} names its company as typed input`);
    assert.deepEqual(inputIssues({ ...(one.input ? { content: one.input } : {}), ...one.fields }, inputSchemaOf(kyb.inputSchema)), [], one.name);
  }
  assert.match(kyb.instructions, /Input:/, "its instructions read the json block");
});

test("kyb's report keeps its typed input under the input's own names: subject.input is the block the run received", () => {
  const report = JSON.parse(readFileSync(join(TEMPLATES_DIR, "kyb", "kyb.schema.json"), "utf8"));
  const kyb = readPackage(join(TEMPLATES_DIR, "kyb"));
  const subjectInput = report.properties.subject.properties.input;
  assert.deepEqual(Object.keys(subjectInput.properties), Object.keys(kyb.inputSchema.properties), "the same names, in the same order");
  assert.deepEqual(subjectInput.required, kyb.inputSchema.required);
  const made = schemaCheck(subjectInput);
  assert.ok("check" in made, JSON.stringify(made));
  assert.deepEqual(made.check({ company: "Stripe, Inc.", website: "https://stripe.com", country: "US", reason: "vendor" }), [], "a run's input, copied whole");
  assert.deepEqual(made.check({ company: "Quillmont Brightwater" }), [], "a field the run did not get is left out");
  assert.notDeepEqual(made.check({ name: "Stripe, Inc.", domain: "stripe.com", reason: "unspecified" }), [], "the old names are refused");
  // The skill copies the block as it is: no field-by-field mapping, and its example answer uses the input's names.
  const skill = readFileSync(join(TEMPLATES_DIR, "kyb", "skills", "kyb", "SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /→ `subject\.input\./, "no mapping from the typed fields to other names");
  const example = JSON.parse(skill.match(/"input": (\{[^}]*\})/)[1]);
  assert.deepEqual(made.check(example), [], "the skill's example subject.input meets the schema");
  assert.ok(Object.keys(example).every((name) => Object.hasOwn(kyb.inputSchema.properties, name)), JSON.stringify(example));
});

test("an applied kyb agent's runs take typed input and refuse an input its schema does not", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t);
  const applied = await api("POST", "/templates/kyb/apply", { parameters: {} }, { "idempotency-key": "kyb-typed" });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const id = applied.body.agent_id;
  assert.deepEqual(Object.keys((await api("GET", `/agents/${id}`)).body.definition.input_schema.properties), ["company", "website", "country", "registration_number", "reason"]);
  const bad = await api("POST", `/agents/${id}/runs`, { input: { content: "Check them.", country: "Germany" } });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.deepEqual(bad.body.error.fields.map((f) => [f.field, f.reason]).sort(), [["input.company", "missing"], ["input.country", "bad_format"]]);
  const ok = await api("POST", `/agents/${id}/runs`, { input: { company: "Stripe, Inc.", country: "US", reason: "vendor" }, max_cost_usd: 1 });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  const { rows } = await follow(api, ok.body.run_id, ["completed", "failed"], { deadlineMs: 55_000 });
  // Its first message (kyb learns, so a reflection turn follows it).
  assert.deepEqual(rows.filter((row) => row.kind === "user_message").map((row) => row.text).slice(0, 1), ['Input:\n```json\n{\n  "company": "Stripe, Inc.",\n  "country": "US",\n  "reason": "vendor"\n}\n```']);
});
