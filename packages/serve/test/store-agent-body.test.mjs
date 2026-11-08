// The agent body validator (store/agent-body.ts, the P4 fold of pi-durable-agent's bodyOf): everything the old validator
// accepted it accepts — harness, tool settings, place, content-addressed skills, a default cap, the learning switch.
// The agent-level argument pin is NOT handled here: it is wired through tool-plane's pinIssues + canonicalToolSettings (the
// one copy) when AGENT_LAYER_PINS flips, so until then a pin is refused like any unknown tool setting. Ported from
// pi-durable-agent/test/agent-store.test.mjs's revision checks, tested on bodyOf directly.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AgentBodyInvalid, bodyOf, canonical, isToolSettingsKey } from "../dist/store/agent-body.js";

const refused = (pattern) => (error) => error instanceof AgentBodyInvalid && (!pattern || pattern.test(error.message));
const A = { kind: "agentic", instructions: "Research the company.", skills: { "read/SKILL.md": "Read the site." }, tools: ["read"] };
const WF = { kind: "workflow", workflow: { v: 1, name: "flow", steps: [] }, tools: ["read"] };
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

test("the skills are content-addressed in the body, their texts kept beside it; the input is checked before anything is returned", () => {
  const { body, skills } = bodyOf(A);
  assert.equal(body.skills["read/SKILL.md"], sha("Read the site."));
  assert.match(body.skills["read/SKILL.md"], /^[0-9a-f]{64}$/);
  assert.deepEqual(skills, { "read/SKILL.md": "Read the site." });
  assert.throws(() => bodyOf({ ...A, skills: { "../x": "no" } }), refused(/skill path/));
  assert.throws(() => bodyOf({ ...A, skills: { "read/SKILL.md": 3 } }), refused(/skill is not text/));
  assert.throws(() => bodyOf({ kind: "agentic", instructions: 3 }), refused(/instructions/));
  assert.throws(() => bodyOf({ kind: "other" }), refused());
  assert.throws(() => bodyOf({ ...A, tools: ["read", "read"] }), refused(/tools/));
});

test("a revision keeps the harness it names, in its body; a harness that is not an id is refused", () => {
  assert.equal("harness" in bodyOf(A).body, false, "no harness named, none kept");
  assert.equal(bodyOf({ ...A, harness: "claude-agent" }).body.harness, "claude-agent");
  assert.equal(bodyOf({ ...WF, harness: "codex" }).body.harness, "codex");
  for (const harness of ["", "Claude", "claude agent", 3]) assert.throws(() => bodyOf({ ...A, harness }), refused(/harness/), String(harness));
});

test("a revision keeps the tool settings it names, sorted; a catalog's tool and an MCP server's wildcard among them; none or an empty map keeps none; settings that are not names are refused", () => {
  assert.equal("toolSettings" in bodyOf({ ...A, toolSettings: {} }).body, false, "an empty map is no setting");
  const set = bodyOf({ ...A, toolSettings: { web_search: { provider: "exa-keyless" }, web_fetch: { provider: "parallel" } } }).body;
  assert.deepEqual(Object.entries(set.toolSettings), [["web_fetch", { provider: "parallel" }], ["web_search", { provider: "exa-keyless" }]], "sorted");
  assert.deepEqual(bodyOf({ ...WF, toolSettings: { web_fetch: { provider: "parallel" } } }).body.toolSettings, { web_fetch: { provider: "parallel" } }, "a workflow revision has them too");
  const catalog = { "monid.run": { permission: "allow" }, "mcp:srv/*": { permission: "ask" }, "mcp:srv/echo": { permission: "deny" } };
  assert.deepEqual(bodyOf({ ...A, toolSettings: catalog }).body.toolSettings, catalog, "a catalog's tool and an MCP server's tool or wildcard");
  for (const toolSettings of [[], "parallel", { web_search: "parallel" }, { web_search: { provider: 1 } }, { "Web Search": { provider: "parallel" } }, { web_search: { provider: "" } }, { "mcp:srv": { permission: "ask" } }, { "mcp:srv/*": { "per mission": "ask" } }]) {
    assert.throws(() => bodyOf({ ...A, toolSettings }), refused(/tool settings/), JSON.stringify(toolSettings));
  }
  assert.equal(isToolSettingsKey("mcp:srv/*"), true);
  assert.equal(isToolSettingsKey("Web Search"), false);
});

test("a revision keeps the place it names, {mode, box?}; one that names none keeps none; a place that is not {mode, box?} of ids is refused", () => {
  assert.equal("place" in bodyOf(A).body, false, "no place named, none kept");
  assert.deepEqual(bodyOf({ ...A, place: { mode: "runner" } }).body.place, { mode: "runner" }, "a place with no box keeps none");
  assert.deepEqual(bodyOf({ ...A, place: { box: "docker", mode: "sandbox" } }).body.place, { mode: "sandbox", box: "docker" });
  for (const place of ["runner", null, {}, { mode: "Runner" }, { mode: "sandbox", box: "" }, { mode: "sandbox", box: 3 }, { mode: "runner", home: "x" }]) {
    assert.throws(() => bodyOf({ ...A, place }), refused(/place/), JSON.stringify(place));
  }
});

test("a revision keeps a default spend cap and its mode, and the learning switch, when they are set; bad values are refused", () => {
  assert.equal(bodyOf({ ...A, maxCostUsd: 2.5, capMode: "strict" }).body.maxCostUsd, 2.5);
  assert.equal(bodyOf({ ...A, maxCostUsd: 2.5, capMode: "strict" }).body.capMode, "strict");
  assert.equal(bodyOf({ ...A, learning: false }).body.learning, false);
  assert.equal("learning" in bodyOf(A).body, false);
  for (const maxCostUsd of [0, -1, "2", Number.NaN]) assert.throws(() => bodyOf({ ...A, maxCostUsd }), refused(/maxCostUsd/), String(maxCostUsd));
  assert.throws(() => bodyOf({ ...A, capMode: "" }), refused(/capMode/));
  assert.throws(() => bodyOf({ ...A, learning: "yes" }), refused(/learning/));
});

test("the agent-level argument pin is refused by this validator until it is wired through tool-plane's canonicalToolSettings", () => {
  // Until AGENT_LAYER_PINS flips and bodyOf calls tool-plane's pinIssues + canonicalToolSettings (the one copy), a pin is an
  // unknown tool setting and is refused. The acceptance and dedup of a pin are tested with those functions, not here.
  assert.throws(() => bodyOf({ ...A, toolSettings: { "weather.lookup": { pin: { country: "US" } } } }), refused(/tool settings/));
  void canonical;
});
