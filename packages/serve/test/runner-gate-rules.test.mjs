// The tool gate's four rules, proven through the runner's claim (runner/adapter-run-spec.ts, over a real store, a real
// claim and a real Harness, as the dispatch builds a pi run's spec), never only through the old per-run process:
//   1. a server deny is absolute: an agent's own ask or allow does not reach past it, under approvals ask or never, and the
//      refusal says it was set on this server and that nothing was sent or charged;
//   2. a pin refuses: a server-pinned MCP tool called outside its pin is refused before it is asked or sent;
//   3. approvals "never" lifts only a clean ask: a default ask runs unparked, a stand-in for a value that does not read
//      stays an ask;
//   4. settings that do not read fail closed: under "never" an ask is kept, and the plane over the store's read leaves a
//      harness's own (native) search off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { specFor } from "./runner-spec-support.mjs";

const { loadToolSettings, planeFor, NATIVE_ASKS } = await import("../dist/tool-plane.js");

/** The spec's gate answer for one call, as the adapter loop reads it: "allow", "ask", or a refusal with its words. */
const answer = (spec, tool, args = {}) => {
  const given = spec.gate({ callId: "c1", tool, args });
  return typeof given === "string" ? { decision: given } : { decision: "deny", text: given.deny };
};

test("1. a server deny is absolute through the runner: the agent's own ask or allow does not reach past it, under ask or never, and the refusal names this server", async (t) => {
  for (const approvals of ["ask", "never"]) {
    for (const own of ["ask", "allow"]) {
      const { spec } = await specFor(t, {
        body: { tools: ["web_search"], approvals, toolSettings: { web_search: { permission: own } } },
        settings: { web_search: { permission: "deny" } },
      });
      const got = answer(spec, "web_search", { query: "q" });
      assert.equal(got.decision, "deny", `${own} under ${approvals}: refused`);
      assert.match(got.text ?? "", /on this server/, `${own} under ${approvals}: the refusal says where the deny was set: ${got.text}`);
      assert.match(got.text ?? "", /nothing was sent and nothing was charged/, `${own} under ${approvals}: the refusal says nothing was sent: ${got.text}`);
    }
  }
});

test("2. a pin refuses through the runner: a server-pinned MCP tool called outside its pin is refused before it is asked or sent; as pinned it goes", async (t) => {
  const pinned = "mcp:fake/send_message";
  for (const approvals of ["ask", "never"]) {
    const { spec } = await specFor(t, {
      body: { tools: [pinned], approvals },
      settings: { [pinned]: { permission: "allow", pin: { channel_id: "C0123" } } },
    });
    const outside = answer(spec, pinned, { channel_id: "C0999", text: "hi" });
    assert.equal(outside.decision, "deny", `under ${approvals}: a call outside the pin is refused, never asked: ${JSON.stringify(outside)}`);
    assert.match(outside.text ?? "", /C0123|pin/i, `under ${approvals}: the refusal is the pin's: ${outside.text}`);
    assert.equal(answer(spec, pinned, { channel_id: "C0123", text: "hi" }).decision, "allow", `under ${approvals}: a call as pinned goes`);
  }
});

test("3. approvals never lifts only a clean ask through the runner: a default ask runs unparked; a stand-in for a value that does not read stays an ask", async (t) => {
  const clean = await specFor(t, { body: { tools: ["monid.run"], approvals: "never" } });
  assert.equal(answer(clean.spec, "monid.run").decision, "allow", "a default ask nothing stands behind is an allow under never");
  const standIn = await specFor(t, { body: { tools: ["monid.run"], approvals: "never" }, settings: { "monid.run": { permission: "maybe" } } });
  assert.equal(answer(standIn.spec, "monid.run").decision, "ask", "a permission that does not read stands in as an ask, never lifted");
  const asked = await specFor(t, { body: { tools: ["monid.run"], approvals: "ask" } });
  assert.equal(answer(asked.spec, "monid.run").decision, "ask", "under ask, the default ask parks");
});

test("4. tool settings that do not read fail closed through the runner: under never the ask is kept, and the plane over the store's read leaves native search off", async (t) => {
  const { spec, store } = await specFor(t, { body: { tools: ["monid.run"], approvals: "never" }, settings: ["not", "an", "object"] });
  assert.equal(answer(spec, "monid.run").decision, "ask", "an unread store keeps every ask under never: a deny may be behind it");
  const read = await loadToolSettings(store);
  assert.equal(read.unreadable, true, "the store's settings do not read");
  // The agent's own native pick on an ask (web_search's default is allow): under "never", a clean read lifts that ask and
  // turns the CLI's own search on; an unread one must not.
  const own = { web_search: { provider: "native", permission: "ask" } };
  for (const harness of ["claude-agent", "codex"]) {
    const unread = planeFor({}, { tools: ["web_search"], harness, approvals: "never", overrides: own }, read.settings);
    assert.equal(unread.web_search, NATIVE_ASKS, `${harness}: the plane over an unread store holds native search to its ask, never turning the CLI's own search on`);
    const clean = planeFor({}, { tools: ["web_search"], harness, approvals: "never", overrides: own }, (await loadToolSettings({ settings: { get: async () => ({}) } })).settings);
    assert.notEqual(clean.web_search, NATIVE_ASKS, `${harness}: over a clean read, never lifts the ask (the control)`);
  }
});
