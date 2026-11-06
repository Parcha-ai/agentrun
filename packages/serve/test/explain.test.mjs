// A body an agent gets right on the first try: every request example the document gives is one this server takes, and a
// 422's field issues say what the field accepts (`example`, and in the message) or, for a field sent at the wrong level,
// where it belongs. Replays the bodies a coding agent sent when it had only the help and the 422s to go by.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, serve } from "./support.mjs";

const METHODS = ["get", "put", "post", "patch", "delete"];

test("every request example the document gives is a body this server takes: each sent, in the document's order, answers 2xx", async (t) => {
  const { baseUrl, api } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const examples = Object.entries(doc.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).flatMap((method) =>
    Object.entries(item[method].requestBody?.content?.["application/json"]?.examples ?? {}).map(([name, example]) => ({ path, method, id: item[method].operationId, name, value: example.value }))));
  for (const id of ["createAgent", "createRun", "createTrigger"]) assert.ok(examples.some((e) => e.id === id), `${id} documents a working body`);
  // A path parameter is filled from an earlier answer's field of its name (createAgent's agent_id for createRun): the
  // routes with none go first.
  const known = {};
  for (const e of [...examples.filter((e) => !e.path.includes("{")), ...examples.filter((e) => e.path.includes("{"))]) {
    const path = e.path.replace(/\{(\w+)\}/g, (_, name) => {
      assert.ok(known[name] !== undefined, `${e.id}'s ${name} comes from an earlier example's answer`);
      return encodeURIComponent(known[name]);
    });
    const answer = await api(e.method.toUpperCase(), path, e.value);
    assert.ok(answer.status >= 200 && answer.status < 300, `${e.method.toUpperCase()} ${e.path}, example ${e.name}: ${answer.status} ${JSON.stringify(answer.body)}`);
    for (const [key, value] of Object.entries(answer.body ?? {})) if (/_id$/.test(key) && typeof value === "string") known[key] ??= value;
  }
});

test("the five wrong bodies of a coding agent's first tries: each 422 names the field and gives what it accepts, or where it belongs", async (t) => {
  const { api } = await serve(t);
  const refused = async (method, path, body) => {
    const answer = await api(method, path, body);
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    return answer.body.error;
  };
  const field = (error, name) => error.fields.find((f) => f.field === name) ?? assert.fail(`no issue at ${name}: ${JSON.stringify(error)}`);

  // 1. A definition's field at the top level: it belongs under definition, as the fix shows.
  const top = await refused("POST", "/agents", { name: "Business due diligence" });
  assert.deepEqual(field(top, "name"), { field: "name", reason: "not_allowed", message: "The body keeps no field name: name belongs under definition.", fix: 'name belongs under definition: {"definition":{"name":"…"}}', example: { definition: { name: "…" } } });
  assert.equal(top.message, "The body keeps no field name: name belongs under definition.");
  assert.deepEqual(field(top, "definition").example, { version: 1, name: "…", instructions: "…", skills: [], tools: [] }, "definition gives its required fields");
  const many = await refused("POST", "/agents", { name: "Business due diligence", harness: "claude-agent", learning: "on", instructions: "Research.", tools: ["web_search"] });
  for (const name of ["name", "harness", "learning", "instructions", "tools"]) assert.match(field(many, name).fix, new RegExp(`^${name} belongs under definition: \\{"definition":\\{"${name}":`));

  // 2. An empty definition: its name is required, and the issue says what a name is.
  const empty = await refused("POST", "/agents", { definition: {} });
  assert.deepEqual(field(empty, "definition.name"), { field: "definition.name", reason: "missing", message: 'definition.name is required, e.g. "…"', example: "…" });

  // 3. A switch given a word: it is true or false.
  const learning = await refused("POST", "/agents", { definition: { name: "Business due diligence", instructions: "Research.", tools: ["web_search", "web_fetch"], learning: "on" } });
  assert.deepEqual(field(learning, "definition.learning"), { field: "definition.learning", reason: "wrong_type", message: "definition.learning is true or false, e.g. true", example: true });

  // 4 and 5. A run's input as a string, then under another name: it is an object, and content is what it needs.
  assert.equal((await api("POST", "/agents", agent("brief"))).status, 201);
  const text = await refused("POST", "/agents/brief/runs", { input: "Research https://stripe.com and write the due-diligence brief." });
  assert.deepEqual(field(text, "input"), { field: "input", reason: "wrong_type", message: 'input is an object, e.g. {"content":"…"}', example: { content: "…" } });
  const named = await refused("POST", "/agents/brief/runs", { input: { message: "Research https://stripe.com and write the due-diligence brief." } });
  assert.deepEqual(field(named, "input.content"), { field: "input.content", reason: "missing", message: 'input.content is required, e.g. "…"', example: "…" });
  assert.equal(named.message, 'input.content is required, e.g. "…"');
});

test("an option, a number and a field an object below keeps are told from the schema too", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("brief"))).status, 201);
  const run = (await api("POST", "/agents/brief/runs", { input: {}, effort: "max-ish", max_cost_usd: -1, content: "Hi." })).body.error;
  const at = (name) => run.fields.find((f) => f.field === name);
  assert.match(at("effort").message, /, e\.g\. "[a-z]+"$/);
  assert.equal(at("max_cost_usd").message, "max_cost_usd is a number above 0, e.g. 1");
  assert.equal(at("content").fix, 'content belongs under input: {"input":{"content":"…"}}');
});

test("a suggested value is one the server takes: a bad id gets the documented one, a model no value at all, and every value a 422 suggests, sent in place of the wrong one, clears the field's issue", async (t) => {
  const { api } = await serve(t);
  const good = { name: "Business due diligence", instructions: "Research.", tools: ["web_search", "web_fetch"] };
  /** POSTs `definition`, then again with each suggested value put where the issue's field is: the field's issue goes. */
  const resent = async (definition, path) => {
    const first = await api("POST", "/agents", { definition });
    assert.equal(first.status, 422, JSON.stringify(first.body));
    const issue = first.body.error.fields.find((f) => f.field === path) ?? assert.fail(JSON.stringify(first.body));
    if (issue.example !== undefined) {
      const key = path.split(".").at(-1);
      const again = await api("POST", "/agents", { definition: { ...definition, [key]: issue.example } });
      assert.ok(!(again.body?.error?.fields ?? []).some((f) => f.field === path), `${path} = ${JSON.stringify(issue.example)} is refused too: ${JSON.stringify(again.body)}`);
    }
    return issue;
  };
  const id = await resent({ ...good, id: "bad id" }, "definition.id");
  assert.equal(id.example, "due-diligence", "the documented createAgent body's id");
  assert.match(id.message, /, e\.g\. "due-diligence"$/);
  const model = await resent({ ...good, model: "gpt" }, "definition.model");
  assert.equal(model.example, undefined, "no model this server would refuse");
  assert.doesNotMatch(model.message, /e\.g\./);
  for (const [definition, path] of [[{ ...good, learning: "on" }, "definition.learning"], [{ instructions: "Research." }, "definition.name"]]) {
    const issue = await resent(definition, path);
    assert.notEqual(issue.example, undefined, path);
  }
  // A run's input: the suggested input, sent as the input, starts the run.
  assert.equal((await api("POST", "/agents", { definition: { ...good, id: "brief", tools: [] } })).status, 201);
  const input = (await api("POST", "/agents/brief/runs", { input: "Research." })).body.error.fields.find((f) => f.field === "input");
  assert.equal((await api("POST", "/agents/brief/runs", { input: input.example })).status, 202);
});
