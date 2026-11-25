// A new agent with no box on a server without Docker's box: refused, in words that say to name a box, never given the
// first other box that answers. An agentic definition that names no place and would be given the default box (it names
// no tools, so it would get a shell, or names a tool that runs only in a box) is refused 422 at its create, and at an
// edit that would save such a revision, listing the boxes this server has and never picking one. A workflow, a
// definition that names its place (the runner included), and one whose tools need no shell save as before. Tests run
// with AGENTRUN_BOXES=none (support.mjs): no box is set up here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPlaceOf, newAgentPlace } from "../dist/place.js";
import { agent, flowAgent, serve } from "./support.mjs";

const NONE_WORDS = "name a box: this server has no Docker box for a new agent. Set place to {mode: sandbox, box: <none is set up>}, or to {mode: runner} to run without a shell.";
const plain = (id, extra = {}) => ({ definition: { id, name: id, instructions: "Answer.", ...extra } });
const flags = (tool) => ({ bash: { sandboxOnly: true }, browser: { runnerOnly: true } })[tool];

/** The refusal a create or an edit gets: 422 under definition.place, in the words, with nothing else said. */
function refusedForPlace(said, words = NONE_WORDS) {
  assert.equal(said.status, 422, JSON.stringify(said.body));
  assert.equal(said.body.error.code, "input_invalid");
  assert.equal(said.body.error.message, words);
  assert.deepEqual(said.body.error.fields.map((one) => [one.field, one.reason, one.message]), [["definition.place", "missing", words]]);
}

test("the default box is Docker's by its id: with Docker down and another box available, a new agent is given no box, and the words list the available boxes without picking one", () => {
  const registry = [
    { id: "e2b", available: true },
    { id: "docker", available: false, reason: "Docker isn't running on this machine" },
    { id: "daytona", available: true },
  ];
  const fresh = newAgentPlace(registry);
  assert.equal("place" in fresh, false, "never the first box that answers");
  assert.equal(fresh.reason, "name a box: this server has no Docker box for a new agent. Set place to {mode: sandbox, box: <one of: daytona, e2b>}, or to {mode: runner} to run without a shell.");
  assert.equal(fresh.why, "Docker isn't running on this machine");
  assert.deepEqual(defaultPlaceOf("agentic", ["bash"], registry, flags), { mode: "runner" }, "a revision with bash and no place resolves to no other box");
  assert.equal(newAgentPlace([]).reason, NONE_WORDS, "no box at all: none is set up");
  assert.deepEqual(newAgentPlace([{ id: "docker", available: true }, { id: "e2b", available: true }]), { place: { mode: "sandbox", box: "docker" } });
});

test("with no Docker box, a new agent that names no place and no tools, or a tool that runs only in a box, is refused 422 in words that name a box; nothing is saved", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  refusedForPlace(await api("POST", "/agents", plain("plain")));
  assert.equal((await api("GET", "/agents/plain")).status, 404, "nothing saved");
  refusedForPlace(await api("POST", "/agents", plain("shell", { tools: ["read", "bash"] })));
  refusedForPlace(await api("POST", "/agents", plain("background", { tools: ["bash_background"] })));
  assert.equal((await api("GET", "/agents/shell")).status, 404, "nothing saved");
  assert.equal((await api("GET", "/agents")).body.agents.length, 0);
});

test("with no Docker box, an edit that would save a revision with no place and a tool that runs only in a box is refused 422 in the same words; the agent keeps its revision", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  const made = await api("POST", "/agents", agent("quiet"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  refusedForPlace(await api("PUT", "/agents/quiet/definition", { definition: { instructions: "Answer.", tools: ["bash"] } }));
  const now = await api("GET", "/agents/quiet");
  assert.equal(now.body.revision, made.body.revision, "the same revision");
  // An edit that names its place is no default: the runner with bash keeps the refusal it always had, at the tool.
  const runner = await api("PUT", "/agents/quiet/definition", { definition: { instructions: "Answer.", tools: ["bash"], place: { mode: "runner" } } });
  assert.equal(runner.status, 422, JSON.stringify(runner.body));
  assert.deepEqual(runner.body.error.fields.map((one) => one.field), ["definition.tools[0]"]);
});

test("with no Docker box, a workflow, a definition that names its place (the runner included), and one whose tools need no shell save as before", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  const saved = async (body) => {
    const made = await api("POST", "/agents", body);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.definition;
  };
  assert.equal("place" in (await saved(flowAgent("flow"))), false);
  assert.deepEqual((await saved(plain("on-runner", { place: { mode: "runner" } }))).place, { mode: "runner" });
  assert.equal("place" in (await saved(plain("files", { tools: ["read", "write"] }))), false);
  assert.equal("place" in (await saved(plain("none", { tools: [] }))), false);
  assert.equal("place" in (await saved(plain("browsing", { tools: ["read", "browser"] }))), false, "a tool the box refuses keeps the runner");
  // A box this server does not have, named: saved with its warning, as before (place.test.mjs).
  const boxed = await api("POST", "/agents", plain("boxed", { place: { mode: "sandbox", box: "docker" } }));
  assert.equal(boxed.status, 201, JSON.stringify(boxed.body));
});
