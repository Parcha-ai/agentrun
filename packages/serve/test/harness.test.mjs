// The harness a revision names: pi when it names none (and none stored, so older revisions read the same), one of
// pi, claude-agent and codex, or a 422. A harness this server does not run saves with a warning, and a run of it is
// refused 409 agent_not_runnable naming it, never run on pi instead. Capabilities lists each harness with whether it runs.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { blockersOf } from "../dist/runnable.js";
import { agent, flowAgent, serve, withEnv } from "./support.mjs";

const storedBodies = (data) => {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT body_json FROM revisions").all().map((row) => JSON.parse(row.body_json));
  } finally {
    db.close();
  }
};

test("a definition that names no harness reads as pi, and naming pi stores nothing: the stored body is the same either way", async (t) => {
  const { api, data } = await serve(t);
  const plain = await api("POST", "/agents", agent("plain"));
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(plain.body.definition.harness, "pi");
  assert.deepEqual(plain.body.warnings, []);
  assert.equal((await api("POST", "/agents", agent("named", { harness: "pi" }))).body.definition.harness, "pi");
  assert.equal((await api("GET", "/agents/plain")).body.definition.harness, "pi");
  assert.equal((await api("GET", "/agents/plain/revisions")).body.revisions[0].definition.harness, "pi");
  assert.ok(storedBodies(data).every((body) => !("harness" in body)), "the default is never stored");
});

test("a harness that is not pi, claude-agent or codex is a 422 on the field, and nothing is saved", async (t) => {
  const { api } = await serve(t);
  for (const harness of ["opencode", "Pi", "", 3]) {
    const made = await api("POST", "/agents", agent(`bad-${String(harness).length}`, { harness }));
    assert.equal(made.status, 422, JSON.stringify(made.body));
    assert.ok(made.body.error.fields.some((i) => i.field === "definition.harness" && i.reason === "not_an_option"), JSON.stringify(made.body));
  }
  assert.equal((await api("GET", "/agents")).body.agents.length, 0);
});

test("a harness this server does not run saves with a warning on the field, and a run of it is a 409 agent_not_runnable naming it: nothing starts, nothing runs on pi", async (t) => {
  const { api, data } = await serve(t);
  for (const [id, body, harness] of [["claude", agent("claude", { harness: "claude-agent" }), "claude-agent"], ["flow", flowAgent("flow", undefined, { harness: "codex" }), "codex"]]) {
    const made = await api("POST", "/agents", body);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.definition.harness, harness);
    // A workflow on another harness also warns that its nodes run on pi only (runnable.ts).
    const warned = id === "flow" ? [["definition.harness", "not_set_up_here"], ["definition.workflow", "not_set_up_here"]] : [["definition.harness", "not_set_up_here"]];
    assert.deepEqual(made.body.warnings.map((w) => [w.field, w.reason]), warned);
    const run = await api("POST", `/agents/${id}/runs`, { input: id === "flow" ? { question: "q" } : { content: "hi" } });
    assert.equal(run.status, 409, JSON.stringify(run.body));
    assert.equal(run.body.error.code, "agent_not_runnable");
    assert.equal(run.body.error.details.harness, harness);
  }
  assert.deepEqual(storedBodies(data).map((body) => body.harness).sort(), ["claude-agent", "codex"]);
  assert.equal((await api("GET", "/runs")).body.runs.length, 0, "no run started");
});

test("capabilities lists each harness: pi runs here; claude-agent and codex say why not", async (t) => {
  const { api } = await serve(t);
  const { body } = await api("GET", "/capabilities");
  assert.deepEqual(body.harnesses.map((h) => [h.id, h.available, h.steer]), [["pi", true, true], ["claude-agent", false, false], ["codex", false, false]], "only pi takes a message mid-turn");
  for (const h of body.harnesses.filter((h) => !h.available)) assert.match(h.reason, new RegExp(h.id));
  assert.deepEqual(body.harnesses.map((h) => [h.id, h.native_tools]), [["pi", false], ["claude-agent", false], ["codex", false]], "no harness's own tools on serve until runs get a confined box");
});

test("an edit that names no harness keeps the agent's; one that names pi moves it to pi", async (t) => {
  const { api } = await serve(t);
  const made = await api("POST", "/agents", agent("kept", { harness: "claude-agent" }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const edit = (definition) => api("PUT", "/agents/kept/definition", { definition }, { "if-match": `"${current.revision}"` });
  let current = made.body;
  const kept = await edit({ instructions: "Answer briefly." });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.definition.harness, "claude-agent", "absent on an edit: unchanged");
  current = kept.body;
  const moved = await edit({ instructions: "Answer briefly.", harness: "pi" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.definition.harness, "pi");
  current = moved.body;
  assert.equal((await edit({ instructions: "Answer at length." })).body.definition.harness, "pi", "and pi stays pi");
});

test("ask_person on a harness other than pi saves with a warning on the tool, and a run of it is 409 agent_not_runnable naming the tool", async (t) => {
  const { api } = await serve(t);
  const made = await api("POST", "/agents", agent("asker", { harness: "codex", tools: ["read", "ask_person"] }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings.map((w) => [w.field, w.reason]).sort(), [["definition.harness", "not_set_up_here"], ["definition.tools[1]", "not_set_up_here"]]);
  const run = await api("POST", "/agents/asker/runs", { input: { content: "hi" } });
  assert.deepEqual([run.status, run.body.error.code], [409, "agent_not_runnable"]);
  assert.deepEqual(run.body.error.details.unbound, ["ask_person"]);
  const onPi = await api("POST", "/agents", agent("pi-asker", { tools: ["ask_person"] }));
  assert.deepEqual(onPi.body.warnings, [], "on pi it is bound");
});

test("a workflow on a harness other than pi saves with a warning and its runs are refused naming the harness: it never runs on pi instead", async (t) => {
  const { api } = await serve(t, { fauxHarness: new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname });
  const made = await api("POST", "/agents", flowAgent("flow-codex", undefined, { harness: "codex" }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings.map((w) => [w.field, w.reason]), [["definition.workflow", "not_set_up_here"]]);
  const run = await api("POST", "/agents/flow-codex/runs", { input: { question: "q" } });
  assert.deepEqual([run.status, run.body.error?.code, run.body.error?.details?.harness], [409, "agent_not_runnable", "codex"], JSON.stringify(run.body));
  assert.equal((await api("GET", "/runs")).body.runs.length, 0);
});

test("a harness is checked on the revision's own model, never refused for the server's default: claude-agent runs an Anthropic model on a server whose default is OpenAI", { timeout: 60_000 }, async (t) => {
  // Both providers configured (no real keys), the server's default model OpenAI's.
  withEnv(t, { AGENT_MODEL: "openai/gpt-4o-mini", OPENAI_API_KEY: `not-a-secret-${"openai"}`, ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` }, ["AGENT_MODEL_BASE_URL", "ANTHROPIC_BASE_URL", "AGENTRUN_SERVE_FAUX_HARNESS"]);
  // A copy: serve checks a harness once per environment object, and process.env outlives this test.
  const env = { ...process.env };
  const revision = (model) => ({ kind: "agentic", instructions: "Answer.", harness: "claude-agent", ...(model ? { model } : {}) });
  assert.deepEqual(await blockersOf(env, revision("anthropic/claude-haiku-4-5")), [], "its own Anthropic model runs");
  for (const [model, field] of [["openai/gpt-4o-mini", "definition.model"], [undefined, "definition.harness"]]) {
    const blockers = await blockersOf(env, revision(model));
    assert.deepEqual(blockers.map((b) => [b.field, b.host]), [[field, true]], `an OpenAI model (${model ?? "the default"}) does not`);
    assert.match(blockers[0].message, /claude-agent runs Anthropic models; the run's model is openai\/gpt-4o-mini/);
  }
});
