// A new agent with no box on a server without Docker's box: refused, in words that say to name a box, never given the
// first other box that answers. An agentic definition that names no place and would be given the default box (it names
// no tools, so it would get a shell, or names a tool that runs only in a box) is refused 422 at its create, and at an
// edit that would save such a revision, listing the boxes this server has and never picking one. A workflow, a
// definition that names its place (the runner included), and one whose tools need no shell save as before. Only where
// the runner has no shell (Mode 1): on Mode 2 the runner's exec is a shell, and a new agent with no place runs there as
// before. capabilities' places.default_place says which: Docker's box, the runner on Mode 2, or null (name a box), with
// default_reason exactly when null. Tests run with AGENTRUN_BOXES=none (support.mjs): no box is set up here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DESCRIPTORS } from "@parcha/agentrun-computer";
import { boxesLine, defaultPlaceOf, newAgentPlace, noBoxRefusal, placesOf } from "../dist/place.js";
import { DOCKER_JOIN_GROUP } from "../dist/place-offers.js";
import { agent, flowAgent, serve } from "./support.mjs";

const NONE_WORDS = "name a box: this server has no Docker box for a new agent. Set place to {mode: sandbox, box: <none is set up>}, or to {mode: runner} to run without a shell.";
/** What to set, the refusal's fix: never why Docker's box is not here. */
const NONE_FIX = NONE_WORDS.slice(NONE_WORDS.indexOf("Set place"));
/** The words a test server (AGENTRUN_BOXES=none) refuses in: why Docker's box is not here kept, as its offer says it. */
const SERVER_WORDS = `${NONE_WORDS} docker: not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker.`;
const plain = (id, extra = {}) => ({ definition: { id, name: id, instructions: "Answer.", ...extra } });
const flags = (tool) => ({ bash: { sandboxOnly: true }, browser: { runnerOnly: true } })[tool];

/** The refusal a create or an edit gets: 422 under definition.place, in the words, its fix what to set (no example
 *  place picked for it). */
function refusedForPlace(said, words = SERVER_WORDS, fix = NONE_FIX) {
  assert.equal(said.status, 422, JSON.stringify(said.body));
  assert.equal(said.body.error.code, "input_invalid");
  assert.equal(said.body.error.message, words);
  assert.deepEqual(said.body.error.fields.map((one) => [one.field, one.reason, one.message, one.fix]), [["definition.place", "missing", words, fix]]);
}

test("the default box is the one box whose provider descriptor says so (defaultBox), Docker's, read from the descriptor, never named in serve", () => {
  assert.deepEqual(DESCRIPTORS.filter((descriptor) => descriptor.defaultBox === true).map((descriptor) => descriptor.id), ["docker"]);
  const registry = [{ id: "daytona", available: true }, { id: "docker", available: true }];
  assert.deepEqual(newAgentPlace(registry), { place: { mode: "sandbox", box: "docker" } });
});

test("the default box is the descriptor's default box (Docker's): with Docker down and another box available, a new agent is given no box, and the words list the available boxes without picking one", () => {
  const registry = [
    { id: "e2b", available: true },
    { id: "docker", available: false, reason: "Docker isn't running on this machine" },
    { id: "daytona", available: true },
  ];
  const fresh = newAgentPlace(registry);
  assert.equal("place" in fresh, false, "never the first box that answers");
  assert.equal(fresh.reason, "name a box: this server has no Docker box for a new agent. Set place to {mode: sandbox, box: <one of: daytona, e2b>}, or to {mode: runner} to run without a shell. docker: Docker isn't running on this machine.");
  assert.equal(fresh.why, "Docker isn't running on this machine");
  assert.deepEqual(defaultPlaceOf("agentic", ["bash"], registry, flags), { mode: "runner" }, "a revision with bash and no place resolves to no other box");
  assert.equal(newAgentPlace([]).reason, NONE_WORDS, "no box at all: none is set up");
  assert.deepEqual(newAgentPlace([{ id: "docker", available: true }, { id: "e2b", available: true }]), { place: { mode: "sandbox", box: "docker" } });
});

test("default_place per mode: Docker's box where it is here; with no Docker, null and the refusal's words where the runner has no shell (Mode 1), the runner where it has one (Mode 2), with no default_reason", () => {
  const docker = [{ id: "docker", available: true }];
  const noDocker = [{ id: "docker", available: false, reason: "Docker isn't running on this machine" }, { id: "e2b", available: true }];
  const NAMED = "name a box: this server has no Docker box for a new agent. Set place to {mode: sandbox, box: <one of: e2b>}, or to {mode: runner} to run without a shell. docker: Docker isn't running on this machine.";
  for (const shell of [false, true]) {
    const withDocker = placesOf(docker, "none", shell);
    assert.deepEqual(withDocker.default_place, { mode: "sandbox", box: "docker" });
    assert.equal("default_reason" in withDocker, false);
  }
  const mode1 = placesOf(noDocker, "none", false);
  assert.equal(mode1.default_place, null, "no default: name a box");
  assert.equal(mode1.default_reason, NAMED, "the words a no-place create is refused in");
  assert.deepEqual(Object.keys(mode1), ["modes", "default_place", "default_reason", "boxes", "allow"]);
  const mode2 = placesOf(noDocker, "none", true);
  assert.deepEqual(mode2.default_place, { mode: "runner" }, "Mode 2: the runner's shell");
  assert.equal("default_reason" in mode2, false, "default_reason only with a null default_place");
  assert.deepEqual(Object.keys(mode2), ["modes", "default_place", "boxes", "allow"]);
  assert.equal(noBoxRefusal(undefined, noDocker, flags, false)?.message, NAMED, "Mode 1: no tools named is refused");
  assert.equal(noBoxRefusal(undefined, noDocker, flags, true), undefined, "Mode 2: never refused for its place");
  assert.equal(noBoxRefusal(["bash"], noDocker, flags, true), undefined);
});

test("the start's Boxes line with no Docker box, by mode: a new agent names its place where the runner has no shell (Mode 1); in Mode 2 new agents run on the runner, as the line always said", () => {
  const registry = [{ id: "docker", available: false, reason: "Docker isn't running on this machine" }];
  assert.equal(boxesLine(registry, new Set(), "none", true, false), "Boxes: none, so a new agent must name its place: a box, or the runner. Docker isn't running on this machine.");
  assert.equal(boxesLine(registry, new Set(), "none", true, true), "Boxes: none, so new agents run on the runner. Docker isn't running on this machine.");
});

test("with no Docker box, a new agent that names no place and no tools, or a tool that runs only in a box, is refused 422 in words that name a box; nothing is saved", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  // Mode 1 (the runner has no shell): capabilities say there is no default place, in the refusal's words.
  const { places } = (await api("GET", "/capabilities")).body;
  assert.equal(places.default_place, null);
  assert.equal(places.default_reason, SERVER_WORDS);
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

test("the refusal keeps why Docker's box is not here, in its offer's own words with their fix (the docker group), after what to set; the fix is what to set alone; with no offer of Docker's box, no why", () => {
  const registry = [{ id: "docker", available: false, reason: DOCKER_JOIN_GROUP }];
  const issue = noBoxRefusal(undefined, registry, flags, false);
  assert.equal(issue?.message, `${NONE_WORDS} docker: ${DOCKER_JOIN_GROUP}.`);
  assert.equal(issue?.fix, NONE_FIX, "the fix names a place: never Docker's words");
  assert.equal(placesOf(registry, "none", false).default_reason, issue.message, "capabilities say the words the create is refused in");
  assert.equal(newAgentPlace(registry).why, DOCKER_JOIN_GROUP, "and the probe's words alone, as Mode 2's words use them");
  assert.equal(noBoxRefusal(undefined, [], flags, false)?.message, NONE_WORDS, "no offer of Docker's box: nothing of Docker's to keep");
  assert.equal(noBoxRefusal(undefined, registry, flags, true), undefined, "Mode 2: never refused for its place");
});

test("with no Docker box (Mode 1), a definition with no place, bash and the browser is refused at bash in words that say no place runs both: never sent to name a box, which refuses the browser", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  const both = await api("POST", "/agents", plain("both", { tools: ["read", "bash", "browser"] }));
  assert.equal(both.status, 422, JSON.stringify(both.body));
  assert.deepEqual(both.body.error.fields.map((one) => [one.field, one.reason, one.message, one.fix]), [["definition.tools[1]", "not_an_option", 'bash runs only in a box, and browser never runs in one, so no place runs this agent with both: remove "bash" from definition.tools to keep it on the runner, or remove "browser" and name a box.', 'Remove "bash" from definition.tools.']]);
  assert.equal((await api("GET", "/agents/both")).status, 404, "nothing saved");
  // The first way out saves: the runner, without bash.
  const runner = await api("POST", "/agents", plain("both", { tools: ["read", "browser"] }));
  assert.equal(runner.status, 201, JSON.stringify(runner.body));
  // An edit to the same tools is refused alike; the agent keeps its revision.
  const edit = await api("PUT", "/agents/both/definition", { definition: { instructions: "Answer.", tools: ["read", "bash", "browser"] } });
  assert.equal(edit.status, 422, JSON.stringify(edit.body));
  assert.deepEqual(edit.body.error.fields.map((one) => [one.field, one.reason]), [["definition.tools[1]", "not_an_option"]]);
  assert.equal((await api("GET", "/agents/both")).body.revision, runner.body.revision);
});
