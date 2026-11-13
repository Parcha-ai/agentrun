// The agent-level pin in the one store (module A): a revision's body keeps its tool settings as given, a pin among them,
// through agents.create, addRevision and templates.apply, read back the same; canonicalToolSettings (tool-plane.ts) is
// the one form a revision's settings take, so two that pin the same arguments in another order are one text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalToolSettings } from "../dist/tool-plane.js";
import { storeOn } from "./store-helpers.mjs";

/** The one store of test `t` (a scratch file, or a Postgres schema: store-helpers.mjs), on the real clock. */
async function scratchStore(t) {
  return (await storeOn(t, { clock: { get now() { return Date.now(); } } })).store;
}

const SEND = "mcp:slack/slack_send_message";

test("canonicalToolSettings: tools, fields and a pin's arguments sorted, internal marks dropped, a pin's order never another text", () => {
  const one = canonicalToolSettings({ [SEND]: { pin: { thread_ts: null, channel_id: "C0123", limit: 5 }, permission: "allow" }, web_search: { provider: "exa-keyless", fallback: true, raw: "x" }, read: {} });
  const two = canonicalToolSettings({ web_search: { provider: "exa-keyless" }, [SEND]: { permission: "allow", pin: { limit: 5, channel_id: "C0123", thread_ts: null } } });
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.equal(JSON.stringify(one), JSON.stringify({ [SEND]: { permission: "allow", pin: { channel_id: "C0123", limit: 5, thread_ts: null } }, web_search: { provider: "exa-keyless" } }));
  assert.notEqual(JSON.stringify(canonicalToolSettings({ [SEND]: { pin: { channel_id: "C0999" } } })), JSON.stringify(one), "another pin is another text");
});

test("the one store keeps a revision's pinned tool settings as given: create, a new revision and a template's apply read back the same", async (t) => {
  const store = await scratchStore(t);
  const settings = canonicalToolSettings({ [SEND]: { permission: "allow", pin: { channel_id: "C0MKTINTEL", bcc: null, limit: 5, unfurl: false } } });
  const body = { instructions: "Post the digest.", skills: {}, tools: [SEND], toolSettings: settings };
  await store.agents.create({ id: "agent-1", name: "Monitor" }, { id: "rev-1", kind: "agentic", body });
  assert.deepEqual((await store.agents.revision("rev-1")).body, body);
  assert.equal(JSON.stringify((await store.agents.revision("rev-1")).body.toolSettings), JSON.stringify(settings), "the same text, its order kept");
  const next = { ...body, toolSettings: canonicalToolSettings({ [SEND]: { pin: { channel_id: "C0OTHER" } } }) };
  await store.agents.addRevision({ id: "rev-2", agentId: "agent-1", kind: "agentic", body: next });
  assert.deepEqual((await store.agents.revision("rev-2")).body.toolSettings, { [SEND]: { pin: { channel_id: "C0OTHER" } } });
  assert.equal((await store.agents.get("agent-1")).currentRevision, "rev-2");
  const applied = await store.templates.apply({ id: "agent-2", name: "Market monitor" }, { id: "rev-3", kind: "agentic", body, package: { name: "market-monitor", version: "0.1.0", source: "builtin", parameters: { channel: "C0MKTINTEL" } } }, []);
  assert.deepEqual((await store.agents.revision(applied.revisionId)).body.toolSettings, settings);
});
