// An agent's computer (computer-setting.ts): one setting, `computer: {kind, provider?}`, on its revision, with the v2
// `place` its view one to one where it can say it ({mode: runner} = {kind: none}; {mode: sandbox, box: X} = {kind: sandbox,
// provider: X}). Writing either sets both; both given must agree; an edit that names neither keeps the agent's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computerIssues, computerOfPlace, placeOfComputer, settingConflict } from "../dist/computer-setting.js";
import { agent, serve } from "./support.mjs";

test("the setting and its place map one to one where a place can say it; a desktop, phone or browser reads runner", () => {
  assert.deepEqual(placeOfComputer({ kind: "none" }), { mode: "runner" });
  assert.deepEqual(placeOfComputer({ kind: "sandbox", provider: "daytona" }), { mode: "sandbox", box: "daytona" });
  for (const kind of ["desktop", "phone", "browser"]) assert.deepEqual(placeOfComputer({ kind, provider: "x" }), { mode: "runner" }, kind);
  assert.deepEqual(computerOfPlace({ mode: "runner" }), { kind: "none" });
  assert.deepEqual(computerOfPlace({ mode: "sandbox", box: "docker" }), { kind: "sandbox", provider: "docker" });
});

test("a computer is {kind, provider?}: a kind of the five, a provider for every kind but none, nothing else", () => {
  const reasons = (value) => computerIssues(value, "definition.computer").map((issue) => issue.reason);
  assert.deepEqual(reasons({ kind: "none" }), []);
  assert.deepEqual(reasons({ kind: "phone", provider: "phone-harness" }), []);
  assert.deepEqual(reasons("sandbox"), ["wrong_type"]);
  assert.deepEqual(reasons({ kind: "tablet", provider: "x" }), ["not_an_option"]);
  assert.deepEqual(reasons({ provider: "x" }), ["missing"]);
  assert.deepEqual(reasons({ kind: "desktop" }), ["missing"]);
  assert.deepEqual(reasons({ kind: "none", provider: "docker" }), ["not_allowed"]);
  assert.deepEqual(reasons({ kind: "sandbox", provider: "docker", image: "x" }), ["not_allowed"]);
  assert.deepEqual(settingConflict({ kind: "sandbox", provider: "docker" }, { mode: "sandbox", box: "docker" }, "definition"), []);
  assert.deepEqual(settingConflict({ kind: "desktop", provider: "e2b" }, { mode: "sandbox", box: "docker" }, "definition").map((issue) => issue.field), ["definition.place"]);
});

test("through the API: a computer saved shows with its place, a place saved shows its computer, both must agree, and an edit naming neither keeps it", async (t) => {
  const { api } = await serve(t);
  const desk = await api("POST", "/agents", agent("desk", { computer: { kind: "desktop", provider: "e2b" } }));
  assert.equal(desk.status, 201, JSON.stringify(desk.body));
  assert.deepEqual([desk.body.definition.computer, desk.body.definition.place], [{ kind: "desktop", provider: "e2b" }, { mode: "runner" }]);
  const boxed = await api("POST", "/agents", agent("boxed", { place: { mode: "sandbox", box: "daytona" } }));
  assert.equal(boxed.status, 201, JSON.stringify(boxed.body));
  assert.deepEqual([boxed.body.definition.computer, boxed.body.definition.place], [{ kind: "sandbox", provider: "daytona" }, { mode: "sandbox", box: "daytona" }]);
  const both = await api("POST", "/agents", agent("both", { computer: { kind: "phone", provider: "phone-harness" }, place: { mode: "sandbox", box: "docker" } }));
  assert.equal(both.status, 422, JSON.stringify(both.body));
  assert.deepEqual(both.body.error.fields.map((f) => [f.field, f.reason]), [["definition.place", "invalid"]]);
  // An edit that names neither keeps the computer; one that names a place sets the computer with it.
  const kept = await api("PUT", "/agents/desk/definition", agent("desk", { version: 2, instructions: "Answer briefly." }));
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(kept.body.definition.computer, { kind: "desktop", provider: "e2b" });
  const moved = await api("PUT", "/agents/desk/definition", agent("desk", { version: 3, place: { mode: "runner" } }));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.definition.computer, moved.body.definition.place], [{ kind: "none" }, { mode: "runner" }]);
});
