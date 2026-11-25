// Typed input: an agentic agent's definition keeps an input_schema (a JSON Schema object schema, compiled at save), a run's
// input is checked against the schema in force with the full compiler on every path that starts one (the run route, a
// trigger's target at save and at firing, a template's trigger), and the model reads the run's content, then the other
// fields as one fenced json block under the line "Input:", on pi, claude-agent and codex alike.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inputIssues, inputSchemaIssues, inputSchemaOf, DEFAULT_INPUT_SCHEMA } from "../dist/validate.js";
import { inputMessage } from "../dist/run-manifest.js";
import { agent, flowAgent, follow, serve } from "./support.mjs";
import { schedule } from "./trigger-support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

/** A due-diligence agent's input: a company, and what else a run may say about it. */
const SUBJECT = {
  type: "object",
  additionalProperties: false,
  required: ["company"],
  properties: {
    company: { type: "string", title: "Company name", minLength: 1, examples: ["Stripe, Inc."] },
    website: { type: "string", format: "uri" },
    country: { type: "string", pattern: "^[A-Z]{2}$" },
    reason: { type: "string", enum: ["vendor", "customer", "investment"], default: "vendor" },
    limit: { type: "integer", minimum: 1, maximum: 50 },
    topics: { type: "array", items: { type: "string" } },
  },
};
const fields = (body) => body.error.fields.map((f) => [f.field, f.reason]).sort((a, b) => a[0].localeCompare(b[0]));

test("an agentic definition keeps its input_schema: it reads back, an edit that leaves it out keeps it, and a schema that is no object schema, names content as anything but a string, does not compile or sits on a workflow is refused by field", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  const made = await api("POST", "/agents", agent("kyb", { input_schema: SUBJECT }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual((await api("GET", "/agents/kyb")).body.definition.input_schema, SUBJECT);
  const edited = await api("PUT", "/agents/kyb/definition", { definition: { name: "kyb", instructions: "Check again.", skills: [], tools: [] } }, { "if-match": made.headers.get("etag") });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual((await api("GET", "/agents/kyb")).body.definition.input_schema, SUBJECT, "an edit that leaves it out keeps it");

  const refused = async (schema) => {
    const answer = await api("POST", "/agents", agent(`bad-${Math.random().toString(36).slice(2, 8)}`, { input_schema: schema }));
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    return answer.body.error.fields.map((f) => [f.field, f.reason]);
  };
  assert.deepEqual(await refused("an object"), [["definition.input_schema", "wrong_type"]]);
  assert.deepEqual(await refused({ type: "array", items: { type: "string" } }), [["definition.input_schema", "bad_format"]], "the top level is an object");
  assert.deepEqual(await refused({ type: "object", properties: { content: { type: "number" } } }), [["definition.input_schema.properties.content", "bad_format"]], "content is reserved: a string");
  assert.deepEqual(await refused({ type: "object", properties: { country: { type: "string", pattern: "(" } } }), [["definition.input_schema", "bad_format"]], "it compiles");
  assert.deepEqual(await refused({ type: "object", description: "x".repeat(64 * 1024) }), [["definition.input_schema", "too_long"]]);
  // propertyNames is checked against the input's own fields with the schema's definitions alone (X_OWN_FIELDS): a
  // reference to anything else compiled in the schema as written, then failed every run's start with a 500.
  const NAMED = { type: "object", properties: { name: { type: "string", pattern: "^[a-z]+$" } } };
  assert.deepEqual(await refused({ ...NAMED, propertyNames: { $ref: "#/properties/name" } }), [["definition.input_schema.propertyNames", "bad_format"]], "propertyNames names its definitions");
  const defined = await api("POST", "/agents", agent("named", { input_schema: { ...NAMED, $defs: { Name: { pattern: "^[a-z]+$" } }, propertyNames: { $ref: "#/$defs/Name" } } }));
  assert.equal(defined.status, 201, JSON.stringify(defined.body));
  const started = await api("POST", "/agents/named/runs", { input: { name: "acme", content: "Go." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const onFlow = await api("POST", "/agents", flowAgent("flow", undefined, { input_schema: SUBJECT }));
  assert.deepEqual([onFlow.status, onFlow.body.error.fields.map((f) => [f.field, f.reason])], [422, [["definition.input_schema", "not_allowed"]]], "a workflow keeps its own schema");
});

test("a run's input is checked against the agent's input_schema with the full compiler: nested items, formats, patterns, bounds and closed objects, each issue at its own path", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("kyb", { input_schema: SUBJECT }))).status, 201);

  const ok = await api("POST", "/agents/kyb/runs", { input: { company: "Stripe, Inc.", country: "US", topics: ["sanctions"], limit: 5 } });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  const withContent = await api("POST", "/agents/kyb/runs", { input: { content: "Check them.", company: "Stripe, Inc." } });
  assert.equal(withContent.status, 202, `content is reserved, and always taken as text: ${JSON.stringify(withContent.body)}`);

  const bad = await api("POST", "/agents/kyb/runs", { input: { website: "not a url", country: "usa", reason: "fun", limit: 99, topics: ["x", 3], extra: 1 } });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.equal(bad.body.error.code, "input_invalid");
  assert.deepEqual(fields(bad.body), [
    ["input.company", "missing"],
    ["input.country", "bad_format"],
    ["input.extra", "not_allowed"],
    ["input.limit", "invalid"],
    ["input.reason", "not_an_option"],
    ["input.topics.1", "wrong_type"],
    ["input.website", "bad_format"],
  ]);
  const contentOnly = await api("POST", "/agents/kyb/runs", { input: { content: "Check Stripe." } });
  assert.deepEqual([contentOnly.status, fields(contentOnly.body)], [422, [["input.company", "missing"]]], "content does not stand in for a required field");
  const contentNumber = await api("POST", "/agents/kyb/runs", { input: { content: 3, company: "Stripe" } });
  assert.deepEqual([contentNumber.status, fields(contentNumber.body)], [422, [["input.content", "wrong_type"]]]);

  // No input_schema: {content: string}, as before.
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const plain = await api("POST", "/agents/plain/runs", { input: { company: "Stripe" } });
  assert.deepEqual([plain.status, fields(plain.body)], [422, [["input.content", "missing"]]]);
  // A schema whose own fields are all optional: a run gives content or one of them, and an empty input is refused.
  assert.equal((await api("POST", "/agents", agent("loose", { input_schema: { type: "object", properties: { company: { type: "string" } } } }))).status, 201);
  const loose = await api("POST", "/agents/loose/runs", { input: { company: "Stripe" } });
  assert.equal(loose.status, 202, `one of its own fields stands for content: ${JSON.stringify(loose.body)}`);
  assert.equal((await api("POST", "/agents/loose/runs", { input: { content: "Go.", company: "Stripe" } })).status, 202);
  assert.equal((await api("POST", "/agents/loose/runs", { input: { content: "Go." } })).status, 202);
  const empty = await api("POST", "/agents/loose/runs", { input: {} });
  assert.deepEqual([empty.status, fields(empty.body)], [422, [["input.content", "missing"]]], "an input that says nothing");
  assert.match(empty.body.error.fields[0].message, /^input\.content is required, or one of input\.company\b/, "the route adds its example after the fields that would do");
});

test("a closed schema with one optional field (a template's pr_number): a run by hand gives the field alone, a trigger's run gives content alone, and an empty input is refused", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  const PR = { type: "object", additionalProperties: false, properties: { pr_number: { type: "integer", minimum: 1 } } };
  assert.equal((await api("POST", "/agents", agent("pfl", { input_schema: PR }))).status, 201);
  const byHand = await api("POST", "/agents/pfl/runs", { input: { pr_number: 3318 } });
  assert.equal(byHand.status, 202, JSON.stringify(byHand.body));
  assert.equal((await api("POST", "/agents/pfl/runs", { input: { content: "A pull request was opened: #3318." } })).status, 202);
  const empty = await api("POST", "/agents/pfl/runs", { input: {} });
  assert.deepEqual([empty.status, fields(empty.body)], [422, [["input.content", "missing"]]]);
  const zero = await api("POST", "/agents/pfl/runs", { input: { pr_number: 0 } });
  assert.deepEqual([zero.status, fields(zero.body)], [422, [["input.pr_number", "invalid"]]], "the field is still checked; it alone is wrong");
});

test("the schema in force: content is reserved as a string; with no field of its own required, content or one of its own fields is; without a schema it is the default", () => {
  assert.deepEqual(inputSchemaOf(undefined), DEFAULT_INPUT_SCHEMA);
  const inForce = inputSchemaOf(SUBJECT);
  assert.deepEqual(inForce.properties.content, { type: "string" });
  assert.deepEqual(inForce.required, ["company"]);
  assert.deepEqual(inputSchemaOf({ type: "object" }).required, ["content"], "no field of its own: content");
  assert.deepEqual(inputSchemaOf({ type: "object", properties: { content: { type: "string" } } }).required, ["content"]);
  assert.deepEqual(inputSchemaOf({ type: "object", required: ["content"], properties: { a: { type: "string" } } }).required, ["content"], "content required by the schema stays so");
  const optional = inputSchemaOf({ type: "object", properties: { a: { type: "string" }, b: { type: "integer" } } });
  assert.deepEqual(optional.required, []);
  const issues = (input) => inputIssues(input, optional).map((i) => [i.field, i.reason, i.message]);
  assert.deepEqual(issues({}), [["input.content", "missing", "input.content is required, or one of input.a, input.b"]]);
  assert.deepEqual(issues({ a: "x" }), []);
  assert.deepEqual(issues({ content: "x" }), []);
  assert.deepEqual(issues({ b: "x" }), [["input.b", "wrong_type", "input.b must be integer"]], "a wrong field is said as itself, never as the missing content");
  assert.deepEqual(inputIssues({ company: "x", topics: [1] }, inForce).map((i) => [i.field, i.reason]), [["input.topics.0", "wrong_type"]]);
  assert.deepEqual(inputIssues({ company: "x" }, inForce, "target.input"), []);
  assert.deepEqual(inputIssues({}, inForce, "target.input").map((i) => i.field), ["target.input.company"]);
});

test("content is exempt from a schema's maxProperties and propertyNames: a trigger's message and its additions never push an input over them", () => {
  const COMPANY = { type: "object", required: ["company"], properties: { company: { type: "string" }, note: { type: "string" } } };
  const capped = inputSchemaOf({ ...COMPANY, maxProperties: 1 });
  const said = (input, schema) => inputIssues(input, schema).map((i) => [i.field, i.reason]);
  assert.deepEqual(said({ company: "Acme" }, capped), []);
  assert.deepEqual(said({ company: "Acme", content: "" }, capped), [], "a blank message beside the field the cap allows");
  assert.deepEqual(said({ company: "Acme", content: "A webhook fired." }, capped), []);
  assert.deepEqual(said({ company: "Acme", note: "x" }, capped), [["input", "too_many"]], "the schema's own fields still meet its cap");
  assert.deepEqual(said({ company: "Acme", note: "x", content: "" }, capped), [["input", "too_many"]]);
  const named = inputSchemaOf({ ...COMPANY, propertyNames: { enum: ["company"] } });
  assert.deepEqual(said({ company: "Acme", content: "" }, named), [], "content is a name the schema always takes");
  assert.deepEqual(said({ company: "Acme", note: "x", content: "" }, named), [["input.note", "not_an_option"], ["input", "invalid"]], "a name the schema refuses is still refused, once");
  const patterned = inputSchemaOf({ ...COMPANY, propertyNames: { pattern: "^c[a-z]+y$" } });
  assert.deepEqual(said({ company: "Acme", content: "x" }, patterned), []);
  assert.deepEqual(said({ company: "Acme", cash: "x" }, patterned), [["input.cash", "bad_format"], ["input", "invalid"]]);
  assert.deepEqual(inputIssues({ company: "Acme", note: "x" }, capped, "target.input").map((i) => [i.field, i.message]), [["target.input", "target.input must not have more than 1 properties"]], "said at the input, in the schema's own number");
  assert.deepEqual(inputSchemaOf(COMPANY), { ...COMPANY, properties: { ...COMPANY.properties, content: { type: "string" } } }, "a schema with neither keeps its shape");
  // The save's check is the run's: a reference propertyNames can't resolve among the definitions is refused before any run.
  const outside = { ...COMPANY, propertyNames: { $ref: "#/properties/company" } };
  assert.deepEqual(inputSchemaIssues(outside).map((i) => [i.field, i.reason]), [["definition.input_schema.propertyNames", "bad_format"]]);
  assert.match(inputSchemaIssues(outside)[0].message, /^definition\.input_schema\.propertyNames is checked against the input's own fields beside the schema's \$defs and definitions alone: /);
  for (const [where, at] of [["$defs", "#/$defs/Name"], ["definitions", "#/definitions/Name"]]) {
    assert.deepEqual(inputSchemaIssues({ ...COMPANY, [where]: { Name: { enum: ["company"] } }, propertyNames: { $ref: at } }), []);
    const referenced = inputSchemaOf({ ...COMPANY, [where]: { Name: { enum: ["company"] } }, propertyNames: { $ref: at } });
    assert.deepEqual(said({ company: "Acme" }, referenced), [], `propertyNames by ${at} still resolves`);
    assert.deepEqual(said({ company: "Acme", content: "" }, referenced), []);
    assert.deepEqual(said({ company: "Acme", note: "x" }, referenced).map(([field]) => field), ["input.note", "input"]);
  }
});

test("a required text field left empty is said as missing, in a missing field's words; an optional one or a list's item keeps its length issue", () => {
  const said = (input) => inputIssues(input, inputSchemaOf({ ...SUBJECT, properties: { ...SUBJECT.properties, note: { type: "string", minLength: 2 }, topics: { type: "array", items: { type: "string", minLength: 1 } } } })).map((i) => [i.field, i.reason, i.message]);
  assert.deepEqual(said({ company: "" }), said({}));
  assert.deepEqual(said({ company: "" }), [["input.company", "missing", "input.company is required"]]);
  assert.deepEqual(said({ company: "x", note: "" }), [["input.note", "too_short", "input.note must not have fewer than 2 characters"]]);
  assert.deepEqual(said({ company: "x", topics: [""] }), [["input.topics.0", "too_short", "input.topics.0 must not have fewer than 1 characters"]]);
});

test("the model reads the run's content, then the other fields as one fenced json block under Input:; a value holding a fence gets a longer one", () => {
  assert.equal(inputMessage({ content: "Check this company." }), "Check this company.");
  assert.equal(inputMessage({ content: "Check this company.", company: "Stripe, Inc.", topics: ["sanctions"] }), 'Check this company.\n\nInput:\n```json\n{\n  "company": "Stripe, Inc.",\n  "topics": [\n    "sanctions"\n  ]\n}\n```');
  assert.equal(inputMessage({ company: "Stripe" }), 'Input:\n```json\n{\n  "company": "Stripe"\n}\n```');
  assert.equal(inputMessage({ note: "a ``` b ```` c" }), 'Input:\n`````json\n{\n  "note": "a ``` b ```` c"\n}\n`````');
  assert.equal(inputMessage(undefined), "");
  // More runs of backticks than a call takes arguments: still one block, never a RangeError.
  const many = inputMessage({ note: "`a".repeat(400_000) });
  assert.ok(many.startsWith('Input:\n```json\n{\n  "note": "`a`a'), many.slice(0, 40));
});

/** The user messages of a run of `id` with `input`, as its timeline has them (what its harness was sent). */
async function said(api, id, input) {
  const started = await api("POST", `/agents/${id}/runs`, { input });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"], { deadlineMs: 55_000 });
  return rows.filter((row) => row.kind === "user_message").map((row) => row.text);
}

const TYPED = { content: "Check this company.", company: "Stripe, Inc.", country: "US" };
const SENT = 'Check this company.\n\nInput:\n```json\n{\n  "company": "Stripe, Inc.",\n  "country": "US"\n}\n```';

test("a pi run's first message is its content, then its typed fields as one json block", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("kyb", { input_schema: SUBJECT }))).status, 201);
  assert.deepEqual(await said(api, "kyb", TYPED), [SENT]);
  assert.deepEqual(await said(api, "kyb", { company: "Stripe, Inc." }), ['Input:\n```json\n{\n  "company": "Stripe, Inc."\n}\n```'], "no content: the block alone");
});

test("a run's read serves its input whole, a message longer than the timeline keeps and its typed fields, so starting it again sends the same task; a list's run carries none", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("kyb", { input_schema: SUBJECT }))).status, 201);
  const input = { content: `${"Check every filing this company made, line by line. ".repeat(50)}End.`, company: "Stripe, Inc.", topics: ["a ``` b"] };
  assert.ok(input.content.length > 2000, `${input.content.length} characters`);
  const first = await api("POST", "/agents/kyb/runs", { input });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const read = (await api("GET", `/runs/${first.body.run_id}`)).body;
  assert.deepEqual([read.input, read.file_ids], [input, []], "the input, whole, as the run was started with it");
  const listed = (await api("GET", "/runs")).body.runs.find((r) => r.run_id === first.body.run_id);
  assert.deepEqual([listed.input, listed.file_ids], [undefined, undefined], "a list's run carries no input");
  // Run again: the read's input and files, sent as they are.
  const again = await api("POST", "/agents/kyb/runs", { input: read.input, file_ids: read.file_ids });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.deepEqual((await api("GET", `/runs/${again.body.run_id}`)).body.input, input);
});

for (const harness of ["claude-agent", "codex"]) {
  test(`a ${harness} run's first message is its content, then its typed fields as one json block`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
    assert.equal((await api("POST", "/agents", agent(`kyb-${harness}`, { harness, input_schema: SUBJECT }))).status, 201);
    assert.deepEqual(await said(api, `kyb-${harness}`, TYPED), [SENT]);
  });
}

test("a trigger's start_run target is checked against the agent's input schema when it is saved, and a fired run reads its typed input", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("kyb", { input_schema: SUBJECT }))).status, 201);
  const body = (input) => ({ ...schedule("kyb", { cron: "0 9 * * 1", timezone: "UTC" }, { enabled: false }), target: { kind: "start_run", agent_id: "kyb", input, max_cost_usd: 0.5 } });
  const refused = await api("POST", "/triggers", body({ content: "Check them.", limit: 0 }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(fields(refused.body), [["target.input.company", "missing"], ["target.input.limit", "invalid"]]);
  const made = await api("POST", "/triggers", body({ content: "Check them.", company: "Stripe, Inc." }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const fired = await api("POST", `/triggers/${made.body.id}/fire`, undefined, { "idempotency-key": "typed-1" });
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  const { rows } = await follow(api, fired.body.run_id, ["completed"], { deadlineMs: 55_000 });
  // A trigger's message is its own row (origin trigger), never a person's user_message.
  const first = rows.find((row) => row.origin === "trigger")?.text;
  assert.match(first, /^Check them\.\n\n\(Started by hand from the schedule "nightly" at [^)]*\)\.?\n\nInput:\n```json\n\{\n {2}"company": "Stripe, Inc\."\n\}\n```$/, first);
  // A schema capping its input at one field takes that field beside content: a trigger's line rides in content.
  assert.equal((await api("POST", "/agents", agent("kyb-capped", { input_schema: { ...SUBJECT, maxProperties: 1 } }))).status, 201);
  const capped = (input) => ({ ...body(input), target: { ...body(input).target, agent_id: "kyb-capped" } });
  const one = await api("POST", "/triggers", capped({ content: "", company: "Stripe, Inc." }));
  assert.equal(one.status, 201, JSON.stringify(one.body));
  const two = await api("POST", "/triggers", capped({ content: "", company: "Stripe, Inc.", limit: 3 }));
  assert.deepEqual([two.status, fields(two.body)], [422, [["target.input", "too_many"]]], "its own fields still meet the cap");
  const firedCapped = await api("POST", `/triggers/${one.body.id}/fire`, undefined, { "idempotency-key": "capped-1" });
  assert.equal(firedCapped.status, 202, JSON.stringify(firedCapped.body));
  const capRows = (await follow(api, firedCapped.body.run_id, ["completed"], { deadlineMs: 55_000 })).rows;
  assert.match(capRows.find((row) => row.origin === "trigger")?.text ?? "", /^\(Started by hand from the schedule "nightly" at [^)]*\)\.?\n\nInput:\n```json\n\{\n {2}"company": "Stripe, Inc\."\n\}\n```$/);
});
