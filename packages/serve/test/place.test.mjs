// The place a revision names: runner, or sandbox with its box. A revision keeps the place it names, an explicit runner included; one that names none keeps none, so a revision written before the field reads and
// runs as it did. A box this server does not have (none yet) saves with a warning, and a run of it is refused 409
// agent_not_runnable naming the box. Capabilities lists the modes, the default and each box.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Agents } from "../dist/agents.js";
import { agent, flowAgent, follow, scratch, serve } from "./support.mjs";

const storedBodies = (data) => {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT body_json FROM revisions").all().map((row) => JSON.parse(row.body_json));
  } finally {
    db.close();
  }
};

const BOXED = [
  { mode: "sandbox", box: "bwrap" },
  { mode: "sandbox", box: "docker" },
  { mode: "sandbox", box: "modal" },
  { mode: "sandbox", box: "daytona" },
];

test("a definition that names no place stores none, answers none, and runs as before", async (t) => {
  const { api, data } = await serve(t);
  const made = await api("POST", "/agents", agent("plain"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings, []);
  assert.equal("place" in made.body.definition, false, "no resolved default is echoed");
  assert.equal("place" in (await api("GET", "/agents/plain")).body.definition, false);
  assert.equal("place" in (await api("GET", "/agents/plain/revisions")).body.revisions[0].definition, false);
  assert.ok(storedBodies(data).every((body) => !("place" in body)), "nothing stored, so the revision id is the one it had before the field");
  const run = await api("POST", "/agents/plain/runs", { input: { content: "What is six times seven?" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
});

test("an explicit runner place is stored and echoed, is another revision than none, and runs", async (t) => {
  const { api, data } = await serve(t);
  const plain = await api("POST", "/agents", agent("plain"));
  const made = await api("POST", "/agents", agent("runner", { place: { mode: "runner" } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings, []);
  assert.deepEqual(made.body.definition.place, { mode: "runner" });
  assert.notEqual(made.body.revision, plain.body.revision);
  assert.deepEqual(storedBodies(data).map((body) => body.place).filter(Boolean), [{ mode: "runner" }], "the explicit runner survives: the default is the host's");
  const run = await api("POST", "/agents/runner/runs", { input: { content: "What is six times seven?" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
});

test("a sandbox place on each box, bwrap included, is stored and echoed as given, on an agentic and a workflow revision", async (t) => {
  const { api, data } = await serve(t);
  for (const [index, place] of BOXED.entries()) {
    const made = await api("POST", "/agents", agent(`boxed-${index}`, { place }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.definition.place, place);
    assert.deepEqual((await api("GET", `/agents/boxed-${index}`)).body.definition.place, place);
    assert.deepEqual((await api("GET", `/agents/boxed-${index}/revisions`)).body.revisions[0].definition.place, place);
  }
  const flow = await api("POST", "/agents", flowAgent("flow", undefined, { place: { mode: "sandbox", box: "docker" } }));
  assert.equal(flow.status, 201, JSON.stringify(flow.body));
  assert.deepEqual(flow.body.definition.place, { mode: "sandbox", box: "docker" });
  assert.deepEqual(storedBodies(data).map((body) => body.place), [...BOXED, { mode: "sandbox", box: "docker" }]);
});

test("a place of the wrong shape is a 422 at definition.place with a plain message, on a create and an edit, and nothing is saved", async (t) => {
  const { api } = await serve(t);
  const bad = [
    ["runner", "wrong_type", /is an object/],
    [null, "wrong_type", /is an object/],
    [{}, "missing", /mode is one of runner, sandbox/],
    [{ mode: "elsewhere" }, "not_an_option", /mode is one of runner, sandbox/],
    [{ mode: "tool-box", box: "bwrap" }, "not_an_option", /mode is one of runner, sandbox/],
    [{ mode: "sandbox" }, "missing", /names its box: one of bwrap, docker, modal, daytona/],
    [{ mode: "sandbox", box: "podman" }, "not_an_option", /box is one of bwrap, docker, modal, daytona/],
    [{ mode: "runner", box: "docker" }, "not_allowed", /runner place uses no box/],
    [{ mode: "runner", home: "/data" }, "not_allowed", /keeps only mode and box, not home/],
    [{ mode: "sandbox", box: "docker", region: "eu" }, "not_allowed", /keeps only mode and box, not region/],
  ];
  for (const [index, [place, reason, message]] of bad.entries()) {
    const made = await api("POST", "/agents", agent(`bad-${index}`, { place }));
    assert.equal(made.status, 422, JSON.stringify(made.body));
    const issue = made.body.error.fields.find((i) => i.field === "definition.place");
    assert.equal(issue?.reason, reason, JSON.stringify(made.body));
    assert.match(issue.message, message);
  }
  assert.equal((await api("GET", "/agents")).body.agents.length, 0);
  const made = await api("POST", "/agents", agent("good"));
  const edit = await api("PUT", "/agents/good/definition", { definition: { instructions: "Answer.", place: { mode: "tool-box", box: "bwrap" } } }, { "if-match": `"${made.body.revision}"` });
  assert.equal(edit.status, 422, JSON.stringify(edit.body));
  assert.ok(edit.body.error.fields.some((i) => i.field === "definition.place" && i.reason === "not_an_option"));
  assert.equal((await api("GET", "/agents/good")).body.revisions, 1);
});

test("a sandbox place saves with a warning naming its box, and a run of it is 409 agent_not_runnable naming the box: nothing starts", async (t) => {
  const { api } = await serve(t);
  for (const [id, body, box, input] of [
    ["bwrapped", agent("bwrapped", { place: { mode: "sandbox", box: "bwrap" } }), "bwrap", { content: "hi" }],
    ["sandboxed", agent("sandboxed", { place: { mode: "sandbox", box: "modal" } }), "modal", { content: "hi" }],
    ["flow", flowAgent("flow", undefined, { place: { mode: "sandbox", box: "daytona" } }), "daytona", { question: "q" }],
  ]) {
    const made = await api("POST", "/agents", body);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.warnings.map((w) => [w.field, w.reason]), [["definition.place", "not_set_up_here"]]);
    assert.match(made.body.warnings[0].message, new RegExp(`on ${box}, and ${box} is not set up on this server`));
    const run = await api("POST", `/agents/${id}/runs`, { input });
    assert.equal(run.status, 409, JSON.stringify(run.body));
    assert.equal(run.body.error.code, "agent_not_runnable");
    assert.equal(run.body.error.details.box, box);
    assert.match(run.body.error.message, new RegExp(box));
  }
  assert.equal((await api("GET", "/runs")).body.runs.length, 0, "no run started");
});

test("an edit that names no place keeps the agent's; one that names another place moves it; an explicit runner stays through an edit", async (t) => {
  const { api } = await serve(t);
  let current = (await api("POST", "/agents", agent("kept", { place: { mode: "sandbox", box: "docker" } }))).body;
  const edit = async (definition) => {
    const answer = await api("PUT", "/agents/kept/definition", { definition }, { "if-match": `"${current.revision}"` });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    current = answer.body;
    return answer.body;
  };
  const kept = await edit({ instructions: "Answer briefly." });
  assert.deepEqual(kept.definition.place, { mode: "sandbox", box: "docker" }, "absent on an edit: unchanged");
  assert.deepEqual(kept.warnings.map((w) => w.field), ["definition.place"], "and still warned of");
  const moved = await edit({ instructions: "Answer briefly.", place: { mode: "runner" } });
  assert.deepEqual(moved.definition.place, { mode: "runner" });
  assert.deepEqual(moved.warnings, []);
  assert.deepEqual((await edit({ instructions: "Answer at length." })).definition.place, { mode: "runner" }, "and runner stays runner, never dropped for the default");
});

test("an edit identical to the current revision is a no-op, whether it names the place or leaves it out", async (t) => {
  const { api } = await serve(t);
  const made = (await api("POST", "/agents", agent("same", { place: { mode: "sandbox", box: "docker" } }))).body;
  for (const definition of [{ instructions: "Answer.", place: { box: "docker", mode: "sandbox" } }, { instructions: "Answer." }]) {
    const again = await api("PUT", "/agents/same/definition", { definition }, { "if-match": `"${made.revision}"` });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.revision, made.revision, JSON.stringify(definition));
    assert.equal(again.body.revisions, 1);
  }
});

test("an edit without If-Match that another edit overtakes while it is checked is built again on the new current revision: it never restores the place or harness it read", async (t) => {
  const agents = new Agents(join(await scratch(t), "agents"));
  t.after(() => agents.close());
  const made = await agents.create({ definition: { id: "raced", name: "raced", instructions: "Answer.", place: { mode: "runner" } } });
  let overtaken = false;
  const checked = [];
  const edited = await agents.commit(made, { definition: { instructions: "Answer briefly." } }, {
    check: async (revision) => {
      checked.push(revision.place);
      if (overtaken) return;
      overtaken = true;
      await agents.commit(await agents.get("raced"), { definition: { instructions: "Answer.", place: { mode: "sandbox", box: "docker" }, harness: "codex" } });
    },
  });
  assert.equal(edited.revision.body.instructions, "Answer briefly.");
  assert.deepEqual(edited.revision.body.place, { mode: "sandbox", box: "docker" }, "the place of the revision it commits on, not the one it first read");
  assert.equal(edited.revision.body.harness, "codex");
  assert.deepEqual(checked, [{ mode: "runner" }, { mode: "sandbox", box: "docker" }], "and the revision it commits is the one it checked");
  assert.equal(edited.revisions, 3);
});

test("capabilities lists the place modes, this host's default, and each box: none is set up on this server yet", async (t) => {
  const { api } = await serve(t);
  const { places } = (await api("GET", "/capabilities")).body;
  assert.deepEqual(Object.keys(places), ["modes", "default", "boxes"]);
  assert.deepEqual(places.modes, ["runner", "sandbox"], "one boxed mode: no tool-box");
  assert.equal(places.default, "runner");
  assert.deepEqual(places.boxes.map((b) => [b.id, b.available]), [["bwrap", false], ["docker", false], ["modal", false], ["daytona", false]]);
  for (const box of places.boxes) assert.equal(box.reason, `${box.id} is not set up on this server.`);
});
