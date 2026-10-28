// The harness a revision names: pi when it names none (and none stored, so older revisions read the same), one of
// pi, claude-agent and codex, or a 422. A harness this server does not run saves with a warning, and a run of it is
// refused 409 agent_not_runnable naming it, never run on pi instead. Capabilities lists each harness with whether it runs.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, flowAgent, serve } from "./support.mjs";

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
    assert.deepEqual(made.body.warnings.map((w) => [w.field, w.reason]), [["definition.harness", "not_set_up_here"]]);
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
  assert.deepEqual(body.harnesses.map((h) => [h.id, h.available]), [["pi", true], ["claude-agent", false], ["codex", false]]);
  for (const h of body.harnesses.filter((h) => !h.available)) assert.match(h.reason, new RegExp(h.id));
});
