// fetch_page, web_fetch's old name, is gone: no legacy name runs, is listed or is settable. A revision naming it is
// refused like any tool this host does not bind (422 not_an_option at its tools[i]); capabilities list no fetch_page;
// a setting for it is refused like any unknown tool.
import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsKeyOf } from "../dist/tool-gate.js";
import { agent, serve } from "./support.mjs";

test("a revision naming fetch_page is refused like any unknown tool: 422 not_an_option at its tools[i]", async (t) => {
  const { api } = await serve(t);
  const refused = await api("POST", "/agents", agent("legacy", { tools: ["read", "fetch_page"] }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "input_invalid");
  assert.deepEqual(refused.body.error.fields.map((f) => [f.field, f.reason]), [["definition.tools[1]", "not_an_option"]]);
  assert.equal((await api("GET", "/agents/legacy")).status, 404, "nothing saved");
});

test("capabilities list no fetch_page, and web_fetch is listed once", async (t) => {
  const { api } = await serve(t);
  const names = (await api("GET", "/capabilities")).body.tools.map((tool) => tool.name);
  assert.equal(names.includes("fetch_page"), false, names.join(", "));
  assert.equal(names.filter((name) => name === "web_fetch").length, 1);
});

test("a tool setting for fetch_page is refused like any unknown tool", async (t) => {
  const { api } = await serve(t);
  const put = await api("PUT", "/settings/tools", { fetch_page: { permission: "ask" } });
  assert.equal(put.status, 422, JSON.stringify(put.body));
});

test("fetch_page maps to no settings key on any harness, so the gate fails closed (asks): nothing runs it by that name", () => {
  for (const harness of ["pi", "claude-agent", "codex", "opencode"]) assert.equal(settingsKeyOf(harness, "fetch_page"), undefined, harness);
});
