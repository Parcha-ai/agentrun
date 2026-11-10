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

test("a computer is {kind, provider?, image?}: a kind of the five, a provider for every kind but none, an image by name, nothing else", () => {
  const reasons = (value) => computerIssues(value, "definition.computer").map((issue) => issue.reason);
  assert.deepEqual(reasons({ kind: "none" }), []);
  assert.deepEqual(reasons({ kind: "phone", provider: "phone-harness" }), []);
  assert.deepEqual(reasons({ kind: "desktop", provider: "orgo", image: "windows" }), []);
  assert.deepEqual(reasons("sandbox"), ["wrong_type"]);
  assert.deepEqual(reasons({ kind: "tablet", provider: "x" }), ["not_an_option"]);
  assert.deepEqual(reasons({ provider: "x" }), ["missing"]);
  assert.deepEqual(reasons({ kind: "desktop" }), ["missing"]);
  assert.deepEqual(reasons({ kind: "none", provider: "docker" }), ["not_allowed"]);
  assert.deepEqual(reasons({ kind: "sandbox", provider: "docker", region: "x" }), ["not_allowed"]);
  const none = computerIssues({ kind: "none", image: "windows" }, "definition.computer");
  assert.deepEqual(none.map((issue) => [issue.field, issue.reason, issue.message]), [["definition.computer", "not_allowed", "no computer names no image"]]);
  for (const image of ["", " windows", 3]) {
    assert.deepEqual(computerIssues({ kind: "desktop", provider: "orgo", image }, "definition.computer").map((issue) => [issue.field, issue.reason]), [["definition.computer.image", "invalid"]], JSON.stringify(image));
  }
  assert.deepEqual(settingConflict({ kind: "sandbox", provider: "docker" }, { mode: "sandbox", box: "docker" }, "definition"), []);
  assert.deepEqual(settingConflict({ kind: "sandbox", provider: "modal", image: "python:3.12" }, { mode: "sandbox", box: "modal" }, "definition"), [], "a place says no image, so it can't contradict one");
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
  // An image is kept as named, and read back with the computer.
  const imaged = await api("POST", "/agents", agent("win", { computer: { kind: "desktop", provider: "orgo", image: "windows" } }));
  assert.equal(imaged.status, 201, JSON.stringify(imaged.body));
  assert.deepEqual((await api("GET", "/agents/win")).body.definition.computer, { kind: "desktop", provider: "orgo", image: "windows" });
  const moved = await api("PUT", "/agents/desk/definition", agent("desk", { version: 3, place: { mode: "runner" } }));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.definition.computer, moved.body.definition.place], [{ kind: "none" }, { mode: "runner" }]);
});

test("a revise naming only place replaces the computer the old one said; only computer replaces the place; both must agree only when one revise names both", async (t) => {
  const { api } = await serve(t);
  const made = await api("POST", "/agents", agent("swap", { place: { mode: "runner" } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.definition.computer, { kind: "none" });
  // (a) Only place: the new computer is the new place's, never the stored one carried beside it.
  const placed = await api("PUT", "/agents/swap/definition", agent("swap", { version: 2, place: { mode: "sandbox", box: "bwrap" } }));
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.deepEqual([placed.body.definition.computer, placed.body.definition.place], [computerOfPlace({ mode: "sandbox", box: "bwrap" }), { mode: "sandbox", box: "bwrap" }]);
  // (b) Only computer: the place is its view.
  const computed = await api("PUT", "/agents/swap/definition", agent("swap", { version: 3, computer: { kind: "phone", provider: "phone-harness" } }));
  assert.equal(computed.status, 200, JSON.stringify(computed.body));
  assert.deepEqual([computed.body.definition.computer, computed.body.definition.place], [{ kind: "phone", provider: "phone-harness" }, placeOfComputer({ kind: "phone", provider: "phone-harness" })]);
  // (c) Both, agreeing: one setting.
  const agreed = await api("PUT", "/agents/swap/definition", agent("swap", { version: 4, computer: { kind: "sandbox", provider: "docker" }, place: { mode: "sandbox", box: "docker" } }));
  assert.equal(agreed.status, 200, JSON.stringify(agreed.body));
  assert.deepEqual([agreed.body.definition.computer, agreed.body.definition.place], [{ kind: "sandbox", provider: "docker" }, { mode: "sandbox", box: "docker" }]);
  // (d) Both, disagreeing, in one revise: 422 on definition.place, in these words; nothing changes.
  const two = await api("PUT", "/agents/swap/definition", agent("swap", { version: 5, computer: { kind: "desktop", provider: "e2b" }, place: { mode: "sandbox", box: "docker" } }));
  assert.equal(two.status, 422, JSON.stringify(two.body));
  assert.deepEqual(two.body.error.fields.map((f) => [f.field, f.message]), [["definition.place", "computer and place say two settings: give one (place is computer's v2 view)"]]);
  assert.deepEqual((await api("GET", "/agents/swap")).body.definition.computer, { kind: "sandbox", provider: "docker" });
});
