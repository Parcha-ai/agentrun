// A revision is checked for what keeps it from running here when it is saved, with the same checks a run makes before
// it starts. One that can never run here (a tool this host does not bind, a model pi-ai does not know, no instructions,
// a workflow that needs what this host does not give) is refused, 422 by field, and nothing is written. One a setting of
// this host could fix (a provider key, a default model) is saved with `warnings`, and its runs are refused (409) until
// the host has it.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "@parcha/pi-durable-agent";
import { Agents } from "../dist/agents.js";
import { startServe } from "../dist/index.js";
import { checkDefinitionBody } from "../dist/validate.js";
import { agent, answerFlow, client, scratch, serve, withEnv } from "./support.mjs";

/** No gateway, no default model, no OpenAI key: pi-ai's providers serve the models, and none has a key. */
const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "OPENAI_API_KEY"];
async function keyless(t) {
  withEnv(t, {}, MODEL_VARS);
  return serve(t, { faux: undefined });
}
const fields = (answer) => answer.body.error.fields.map((f) => [f.field, f.reason]);
const nothingSaved = async (api, id) => assert.equal((await api("GET", `/agents/${id}`)).status, 404, `no agent ${id} was made`);

test("a tool this host does not bind refuses the save, 422 at each tools[i] that names one", async (t) => {
  const { api } = await serve(t);
  const refused = await api("POST", "/agents", agent("shell", { tools: ["read", "bash", "web_search"] }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "input_invalid");
  assert.deepEqual(fields(refused), [["definition.tools[1]", "not_an_option"], ["definition.tools[2]", "not_an_option"]]);
  assert.match(refused.body.error.fields[0].message, /bash/);
  await nothingSaved(api, "shell");
});

test("a model pi-ai does not know refuses the save, 422 at definition.model, saying why", async (t) => {
  const { api } = await keyless(t);
  const refused = await api("POST", "/agents", agent("nope", { model: "nope/nope" }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(fields(refused), [["definition.model", "not_an_option"]]);
  assert.match(refused.body.error.fields[0].message, /knows no model nope of nope/);
  await nothingSaved(api, "nope");
});

test("empty instructions refuse the save, 422 at definition.instructions", async (t) => {
  const { api } = await serve(t);
  const refused = await api("POST", "/agents", agent("blank", { instructions: "  \n " }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(fields(refused), [["definition.instructions", "too_short"]]);
  await nothingSaved(api, "blank");
});

test("a model whose provider has no key here, or no model on a host with no default, saves with a warning; its runs are refused until the host has one", async (t) => {
  const { api } = await keyless(t);
  const saved = await api("POST", "/agents", agent("keyless", { model: "openai/gpt-5" }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings.map((w) => [w.field, w.reason]), [["definition.model", "not_set_up_here"]]);
  assert.match(saved.body.warnings[0].message, /no key for openai/);
  const plain = await api("POST", "/agents", agent("plain"));
  assert.equal(plain.status, 201);
  assert.deepEqual(plain.body.warnings.map((w) => [w.field, w.reason]), [["definition.model", "not_set_up_here"]]);
  assert.match(plain.body.warnings[0].message, /names no model, and this host has no default/);
  const run = await api("POST", "/agents/keyless/runs", { input: { content: "hi" } });
  assert.deepEqual([run.status, run.body.error.code], [409, "agent_not_runnable"]);
  assert.match(run.body.error.message, /no key for openai/);
});

test("a definition that runs here saves with no warnings", async (t) => {
  const { api } = await serve(t);
  const saved = await api("POST", "/agents", agent("fine", { tools: ["read", "ask_person"] }));
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.body.warnings, []);
});

test("an edit is checked the same way: 422 by field leaves the current revision, a host-fixable one saves with a warning (200)", async (t) => {
  const { api } = await keyless(t);
  assert.equal((await api("POST", "/agents", agent("edited", { model: "openai/gpt-5" }))).status, 201);
  const before = (await api("GET", "/agents/edited")).body;
  const refused = await api("PUT", "/agents/edited/definition", { definition: { instructions: "Answer.", tools: ["bash"], model: "nope/nope" } });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(fields(refused), [["definition.tools[0]", "not_an_option"], ["definition.model", "not_an_option"]]);
  assert.deepEqual((await api("GET", "/agents/edited")).body.home_etag, before.home_etag, "the current revision did not move");
  const edited = await api("PUT", "/agents/edited/definition", { definition: { instructions: "Answer briefly.", model: "openai/gpt-4o" } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.warnings.map((w) => [w.field, w.reason]), [["definition.model", "not_set_up_here"]]);
});

test("a workflow is checked by what its inspection gives: a node's tool this host does not give, or a tool call, refuses the save (422)", async (t) => {
  const { api } = await serve(t);
  const shell = answerFlow();
  shell.root.steps[0].tools = ["bash"];
  const refused = await api("POST", "/agents", { definition: { id: "node-bash", name: "node-bash", workflow: shell, tools: ["bash"] } });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(fields(refused), [["definition.workflow", "not_an_option"]]);
  assert.match(refused.body.error.fields[0].message, /bash/);
  await nothingSaved(api, "node-bash");
  const call = answerFlow();
  call.schemas.Stock = { type: "object", required: ["tier"], properties: { tier: { type: "string" } } };
  call.root.steps.unshift({ node: "call", label: "stock", via: "tool", tool: "stock.check", args: { sku: "{question}" }, out: "Stock", as: "stock", deadline_s: 20 });
  const caller = await api("POST", "/agents", { definition: { id: "caller", name: "caller", workflow: call, tools: ["stock.check"] } });
  assert.equal(caller.status, 422, JSON.stringify(caller.body));
  assert.ok(caller.body.error.fields.every((f) => f.field === "definition.workflow"), JSON.stringify(caller.body.error.fields));
  assert.ok(caller.body.error.fields.some((f) => /call nodes run the tools fetch_page, web_fetch, pdf_pages, llm here; this workflow also calls stock\.check/.test(f.message)), JSON.stringify(caller.body.error.fields));
  await nothingSaved(api, "caller");
});

test("a workflow whose tier has no model on this host saves with a warning", async (t) => {
  const { api } = await keyless(t);
  const fast = answerFlow();
  fast.root.steps[0].tier = "fast";
  const saved = await api("POST", "/agents", { definition: { id: "fast", name: "fast", workflow: fast } });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings.map((w) => [w.field, w.reason]), [["definition.workflow", "not_set_up_here"]]);
  assert.match(saved.body.warnings[0].message, /fast tier/);
});

test("a revision saved before these checks is refused at its run with the same reasons (409)", async (t) => {
  const data = join(await scratch(t), "agents");
  const store = openStore(data);
  try {
    const { id } = store.createAgent({ name: "old", id: "old" });
    await store.commitRevision(id, { kind: "agentic", instructions: "Answer.", tools: ["read", "bash"] }, { setCurrent: true });
  } finally {
    store.close();
  }
  const server = await startServe({ data, port: 0, faux: new URL("./fixtures/faux-model.mjs", import.meta.url).pathname });
  t.after(() => server.close());
  const run = await client(server.baseUrl, server.token)("POST", "/agents/old/runs", { input: { content: "hi" } });
  assert.deepEqual([run.status, run.body.error.code, run.body.error.details.unbound], [409, "agent_not_runnable", ["bash"]]);
  assert.match(run.body.error.message, /bash/);
});

test("a save whose checks run while another request changes the current revision is held to its If-Match: 412, never a stale 200", async (t) => {
  const agents = new Agents(join(await scratch(t), "agents"));
  t.after(() => agents.close());
  const body = (extra) => checkDefinitionBody(agent("x", extra), { creating: false });
  const a = await agents.create(checkDefinitionBody(agent("x")));
  const b = await agents.commit(a, body({ instructions: "Answer briefly.", version: 2 }));
  const current = await agents.setCurrent(b, a.revision.id);
  /** A check that says when it starts, and ends when the test lets it. */
  const gate = () => {
    let started, release;
    const running = new Promise((resolve) => (started = resolve));
    const held = new Promise((resolve) => (release = resolve));
    return { running, release, check: () => (started(), held) };
  };
  // The same PUT of A again, with If-Match A; while its checks run, another request makes B current.
  const first = gate();
  const saving = agents.commit(current, body(), { ifCurrent: a.revision.id, check: first.check });
  await first.running;
  await agents.setCurrent(current, b.revision.id);
  first.release();
  await assert.rejects(saving, (error) => error.code === "precondition_failed");
  assert.equal((await agents.get("x")).revision.id, b.revision.id, "B stays current");
  // A PUT of B with If-Match A, while another request makes B current: the edit is now no change, and still 412.
  const back = await agents.setCurrent(current, a.revision.id);
  const second = gate();
  const savingB = agents.commit(back, body({ instructions: "Answer briefly.", version: 2 }), { ifCurrent: a.revision.id, check: second.check });
  await second.running;
  await agents.setCurrent(back, b.revision.id);
  second.release();
  await assert.rejects(savingB, (error) => error.code === "precondition_failed");
  // With no If-Match, a save naming version 3 while another request saves version 3 first: this one would be 4, so 422.
  const two = await agents.get("x");
  const third = gate();
  const savingC = agents.commit(two, body({ instructions: "Answer in a word.", version: 3 }), { check: third.check });
  await third.running;
  await agents.commit(two, body({ instructions: "Answer in a sentence.", version: 3 }));
  third.release();
  await assert.rejects(savingC, (error) => error.code === "input_invalid" && /^definition\.version is 4 /.test(error.message));
});
