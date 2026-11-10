// An agent's own pin survives the store cutover whole: what POST /agents takes for an MCP tool's setting (its permission
// and its pin, a one-of list among its values) is kept in the one store's revision in the canonical form
// (tool-plane.ts canonicalToolSettings: arguments sorted, each list de-duplicated and sorted, null first), read back the
// same, and handed to the gate of a run on that revision, which refuses a call not as pinned in the pin's own words
// and lets one as pinned through. `pin_broken` is the server's mark of a pin its own settings file holds that does not
// read; in an agent's settings it is refused.
//
// This is the cutover's acceptance for the agent-level pin (#1990's rules): agents in the one store, which keeps a
// revision's body as given (store-tool-pin.test.mjs), keep the pin whole.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runGate } from "../dist/tool-gate.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, serve, withEnv } from "./support.mjs";

const SEND = "mcp:slack/slack_send_message";
/** The pin as a person writes it: arguments out of order, a one-of list with a repeat, and an argument pinned absent. */
const GIVEN = { permission: "allow", pin: { thread_ts: null, channel_id: ["C0B", "C0A", "C0B"] } };
/** The same pin as the cutover keeps it: arguments sorted, the list de-duplicated and sorted. */
const KEPT = { permission: "allow", pin: { channel_id: ["C0A", "C0B"], thread_ts: null } };
const fields = (answer) => (answer.body?.error?.fields ?? []).map((f) => [f.field, f.reason]);

/** The text of revision `id`'s tool settings as the one store holds it. */
function storedSettings(data, revisionId) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM revisions WHERE id = ?").get(revisionId);
    return row && JSON.stringify(JSON.parse(row.body).toolSettings);
  } finally {
    db.close();
  }
}

/** A server with the MCP server slack saved, listing its send tool: saved through the API as a person saves one, its
 *  tools listed from the suite's fake MCP server (on a port the system picks; it only answers the listing). */
async function slackServer(t) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, {});
  const fake = await startFakeMcp({ name: "slack" });
  t.after(() => fake.close());
  fake.tools.slack_send_message = {
    description: "Post a message to a channel.",
    input: { type: "object", properties: { channel_id: { type: "string" }, thread_ts: { type: "string" }, message: { type: "string" } }, required: ["channel_id", "message"], additionalProperties: false },
    run: ({ channel_id }) => ({ content: [{ type: "text", text: `posted to ${channel_id}` }] }),
  };
  const saved = await server.api("PUT", "/settings/mcp-servers/slack", { url: fake.url, auth: { type: "none" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return server;
}

async function pinned(t) {
  const server = await slackServer(t);
  const made = await server.api("POST", "/agents", agent("pinned", { tools: [SEND], tool_settings: { [SEND]: GIVEN } }));
  assert.equal(made.status, 201, `the agent's own pin is taken: ${JSON.stringify(made.body)}`);
  return { ...server, made };
}

test("an agent's own pin is taken and read back in the canonical form: arguments sorted, its one-of list de-duplicated and sorted", { timeout: 120_000 }, async (t) => {
  const { api } = await pinned(t);
  const read = (await api("GET", "/agents/pinned")).body;
  assert.equal(JSON.stringify(read.definition.tool_settings), JSON.stringify({ [SEND]: KEPT }));
});

test("the one store's revision keeps the pin as that same text", { timeout: 120_000 }, async (t) => {
  const { api, data } = await pinned(t);
  const { revision } = (await api("GET", "/agents/pinned")).body;
  assert.equal(storedSettings(data, revision), JSON.stringify({ [SEND]: KEPT }));
});

test("the gate of a run on that revision is handed the pin whole: a call not as pinned is refused in the pin's words, one as pinned goes through", { timeout: 120_000 }, async (t) => {
  const { api, data } = await pinned(t);
  const read = (await api("GET", "/agents/pinned")).body;
  const root = join(data, "runs", "run-pin");
  const gate = runGate({ root, work: join(root, "work") }, "run-pin", { kind: "agentic", body: { toolSettings: read.definition.tool_settings } }, () => ({ settings: {}, problems: [] }), undefined, true);
  assert.deepEqual(gate["overrides"], { [SEND]: KEPT });
  const refused = gate["pinned"](SEND, { channel_id: "C0EVIL", message: "the digest" });
  assert.equal(refused?.text, `${SEND} may only be called with channel_id in (C0A | C0B), thread_ts absent: its destination is fixed by the agent's settings. It was not run: nothing was sent and nothing was charged.`);
  assert.equal(gate["pinned"](SEND, { channel_id: "C0B", message: "the digest" }), undefined, "a call as pinned goes through");
});

test("pin_broken in an agent's own settings is refused: it is the server's mark of a pin its settings file holds that does not read", { timeout: 120_000 }, async (t) => {
  const { api } = await slackServer(t);
  const broken = await api("POST", "/agents", agent("broken", { tools: [SEND], tool_settings: { [SEND]: { permission: "allow", pin_broken: true } } }));
  assert.equal(broken.status, 422, JSON.stringify(broken.body));
  assert.deepEqual(fields(broken), [[`definition.tool_settings.${SEND}.pin_broken`, "not_allowed"]]);
});
