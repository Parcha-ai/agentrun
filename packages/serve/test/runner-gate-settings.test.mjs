// The runner's gate reads the server's tool settings from the one store (tool-plane.ts loadToolSettings), read once at the
// claim, never from a file beside the data directory (the old per-run process's readToolSettings): a runner has no such
// file, so a permission the owner saved would never reach a file-based gate. A stored deny is honored (over a tool's allow
// default and under approvals "never" alike); and under approvals "never" a default-ask tool with nothing saved is lifted
// to an allow, so an unattended run does not park on it. (monid.run defaults to ask; web_search to allow.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { specFor } from "./runner-spec-support.mjs";

test("the runner's gate honors a deny the owner saved in the store: a file-based read would never see it on a runner", async (t) => {
  const { spec } = await specFor(t, {
    body: { tools: ["web_search", "monid.run"], approvals: "ask" },
    settings: { web_search: { permission: "deny" } },
  });
  assert.equal(spec.gate({ tool: "web_search" }), "deny", "the store's deny reaches the gate, over the tool's allow default");
  assert.equal(spec.gate({ tool: "monid.run" }), "ask", "a tool the owner set nothing for keeps its default (monid asks)");
});

test("approvals 'never' lifts a default-ask tool to an allow: an unattended run does not park on it", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["monid.run"], approvals: "never" } });
  assert.equal(spec.gate({ tool: "monid.run" }), "allow", "an ask nothing stands behind is an allow under approvals never");
});

test("a deny the owner saved stands even under approvals 'never': a never-approvals run cannot run a denied tool", async (t) => {
  const { spec } = await specFor(t, {
    body: { tools: ["monid.run"], approvals: "never" },
    settings: { "monid.run": { permission: "deny" } },
  });
  assert.equal(spec.gate({ tool: "monid.run" }), "deny", "approvals never lifts an ask, never a deny from the store");
});
