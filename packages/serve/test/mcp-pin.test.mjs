// A pinned MCP send, through the API on pi with a faux model and the fake MCP server: an agent whose send tool is
// allowed and pinned to one channel sends to that channel, and a call to any other is refused by the tool gate, never
// reaching the server, with the refusal in the run (its Timeline row failed, as any refusal's). Under ask, a call not as
// pinned is refused at once and never asks; one as pinned asks, and the owner's allow sends it. The server's own pin
// holds too, and one that disagrees with the agent's refuses every call. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { AGENT_LAYER_PINS } from "../dist/tool-plane.js";
import { agent, call, clientOwnerSession, follow, scratch, serve, withEnv } from "./support.mjs";

/** An agent's own pin is kept from the store cutover on (tool-plane.ts AGENT_LAYER_PINS): its tests run from then. */
const AGENT_PINS = AGENT_LAYER_PINS ? {} : { skip: "an agent's own pin waits for the store cutover (AGENT_LAYER_PINS)" };

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const json = { "content-type": "application/json" };
const SEND = "mcp:fake/send_message";

async function setup(t) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { faux: FAUX_MCP, accounts: true, openSetup: true });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  fake.tools.send_message = {
    description: "Post a message to a channel.",
    input: { type: "object", properties: { channel_id: { type: "string" }, message: { type: "string" } }, required: ["channel_id", "message"], additionalProperties: false },
    run: ({ channel_id }) => ({ content: [{ type: "text", text: `posted to ${channel_id}` }] }),
  };
  assert.equal((await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  // The owner's session the test client holds (its one owner on this server), as the console sends an answer.
  const { cookie, origin } = await clientOwnerSession(server);
  const answer = async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body })).status;
  const sends = () => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "send_message");
  const make = async (id, setting) => { const made = await server.api("POST", "/agents", agent(id, { tools: [SEND], tool_settings: { [SEND]: setting } })); assert.equal(made.status, 201, JSON.stringify(made.body)); };
  /** A run of agent `id` that sends to `channel`. */
  const send = async (id, channel) => {
    const started = await server.api("POST", `/agents/${id}/runs`, { input: { content: `Call mcp__fake__send_message with ${JSON.stringify({ channel_id: channel, message: "the digest" })}` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  return { api: server.api, sends, make, send, answer };
}

const answerOf = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";
const REFUSAL = /mcp:fake\/send_message may only be called with channel_id = C0123: its destination is fixed by the agent's settings\. It was not run: nothing was sent and nothing was charged\./;

test("an allowed send pinned to one channel sends there, and a call to another is refused, never reaching the MCP server", { timeout: 240_000, ...AGENT_PINS }, async (t) => {
  const { api, sends, make, send } = await setup(t);
  await make("pinned", { permission: "allow", pin: { channel_id: "C0123" } });
  assert.deepEqual((await api("GET", "/agents/pinned")).body.definition.tool_settings, { [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } }, "the agent keeps its pin");

  const sent = await send("pinned", "C0123");
  assert.equal((await follow(api, sent, ["completed", "failed", "input_required"], { deadlineMs: 180_000 })).last.status, "completed");
  assert.match(await answerOf(api, sent), /The tool said: posted to C0123/);
  assert.equal(sends().length, 1);

  const elsewhere = await send("pinned", "C0EVIL");
  const { last, rows } = await follow(api, elsewhere, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
  assert.equal(last.status, "completed");
  assert.match(await answerOf(api, elsewhere), REFUSAL);
  assert.equal(sends().length, 1, "the refused call never reached the server");
  // Its Timeline row is a failed call, as any refusal's.
  const result = rows.find((row) => row.tool_name === "mcp__fake__send_message" && row.kind === "tool_result");
  assert.ok(result, JSON.stringify(rows.filter((row) => row.kind.startsWith("tool"))));
  assert.match(result.summary, /failed/);
});

test("under ask, a call not as pinned is refused and never asks; one as pinned asks, and the owner's allow sends it", { timeout: 240_000, ...AGENT_PINS }, async (t) => {
  const { api, sends, make, send, answer } = await setup(t);
  await make("asks", { pin: { channel_id: "C0123" } });

  const elsewhere = await send("asks", "C0EVIL");
  const { last } = await follow(api, elsewhere, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
  assert.equal(last.status, "completed", "no approval was raised");
  assert.equal((await api("GET", `/runs/${elsewhere}`)).body.pending ?? null, null);
  assert.match(await answerOf(api, elsewhere), REFUSAL);
  assert.equal(sends().length, 0);

  const pinned = await send("asks", "C0123");
  await follow(api, pinned, ["input_required"], { deadlineMs: 180_000 });
  const pending = (await api("GET", `/runs/${pinned}`)).body.pending;
  assert.deepEqual([pending?.kind, pending?.tool], ["approval", SEND], JSON.stringify(pending));
  assert.equal(sends().length, 0, "nothing sent while it waits");
  assert.equal(await answer(pinned, pending.id, { decision: "allow" }), 204);
  await follow(api, pinned, ["completed", "failed"], { deadlineMs: 180_000 });
  assert.match(await answerOf(api, pinned), /posted to C0123/);
  assert.equal(sends().length, 1, "sent exactly once");
});

test("the server's pin alone binds an allowed send, kept and served; a pin that is not one is 422", { timeout: 240_000 }, async (t) => {
  const { api, sends, make, send } = await setup(t);
  await make("allowed", { permission: "allow" });
  const put = await api("PUT", "/settings/tools", { [SEND]: { pin: { channel_id: "C0123" } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body[SEND], { pin: { channel_id: "C0123" } });
  assert.deepEqual((await api("GET", "/settings/tools")).body[SEND], { pin: { channel_id: "C0123" } });

  const elsewhere = await send("allowed", "C0EVIL");
  assert.equal((await follow(api, elsewhere, ["completed", "failed", "input_required"], { deadlineMs: 180_000 })).last.status, "completed");
  assert.match(await answerOf(api, elsewhere), /mcp:fake\/send_message may only be called with channel_id = C0123: its destination is fixed by this server's settings\./);
  assert.equal(sends().length, 0, "never reached the server");
  const pinned = await send("allowed", "C0123");
  assert.equal((await follow(api, pinned, ["completed", "failed", "input_required"], { deadlineMs: 180_000 })).last.status, "completed");
  assert.match(await answerOf(api, pinned), /posted to C0123/);
  assert.equal(sends().length, 1);

  const fields = (answer) => answer.body.error.fields.map((f) => [f.field, f.reason]);
  const wildcard = await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow", pin: { channel_id: "C0123" } } });
  assert.equal(wildcard.status, 422, JSON.stringify(wildcard.body));
  assert.deepEqual(fields(wildcard), [["mcp:fake/*.pin", "not_allowed"]]);
  const nested = await api("PUT", "/settings/tools", { [SEND]: { pin: { channel_id: { id: "C0123" } } } });
  assert.equal(nested.status, 422, JSON.stringify(nested.body));
  assert.deepEqual(fields(nested), [[`${SEND}.pin.channel_id`, "wrong_type"]]);
  const onRead = await api("POST", "/agents", agent("read-pin", { tools: ["read"], tool_settings: { read: { pin: { path: "x" } } } }));
  assert.equal(onRead.status, 422, JSON.stringify(onRead.body));
  assert.deepEqual(fields(onRead), [["definition.tool_settings.read.pin", "not_allowed"]]);
  // Until the store cutover an agent's own pin is refused at the door, naming the server's setting that holds it meanwhile.
  if (!AGENT_LAYER_PINS) {
    const own = await api("POST", "/agents", agent("own-pin", { tools: [SEND], tool_settings: { [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } } }));
    assert.equal(own.status, 422, JSON.stringify(own.body));
    assert.deepEqual(fields(own), [[`definition.tool_settings.${SEND}.pin`, "not_set_up_here"]]);
    assert.match(own.body.error.fields[0].message, /PUT \/v2\/settings\/tools/);
  }
});

test("an agent's pin and the server's that fix one argument differently refuse every call, saying so", { timeout: 240_000, ...AGENT_PINS }, async (t) => {
  const { api, sends, make, send } = await setup(t);
  await make("pinned", { permission: "allow", pin: { channel_id: "C0123" } });
  assert.equal((await api("PUT", "/settings/tools", { [SEND]: { pin: { channel_id: "C0999" } } })).status, 200);
  const runId = await send("pinned", "C0123");
  assert.equal((await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 180_000 })).last.status, "completed");
  assert.match(await answerOf(api, runId), /mcp:fake\/send_message can't be called: this agent's settings fix channel_id = C0123 and this server's fix channel_id = C0999, so no call can satisfy both\./);
  assert.equal(sends().length, 0);
});

test("a broken pin in the server's tool settings is served as pin_broken, and the console's whole-map save of another tool keeps it broken; a valid pin repairs it", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const broken = { channel_id: { any: true } };
  // A pin that does not read, in the server's tool settings row of the store, as the next server to start reads it.
  const first = await serve(t, { data });
  await first.store.settings.put("tool-settings", { [SEND]: { permission: "allow", pin: broken } });
  await first.close();
  const server = await serve(t, { data });
  const { api } = server;
  const served = (await api("GET", "/settings/tools")).body;
  assert.deepEqual(served[SEND], { permission: "allow", pin_broken: true });
  // The console saves the whole map it read, with one change elsewhere: 200, and the pin stays broken, in the file too.
  const saved = await api("PUT", "/settings/tools", { ...served, web_search: { provider: "exa-keyless" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body[SEND], { permission: "allow", pin_broken: true });
  assert.deepEqual((await server.store.settings.get("tool-settings"))[SEND], { permission: "allow", pin: broken }, "and in the store");
  // An agent can't carry the mark.
  const own = await api("POST", "/agents", agent("marked", { tools: [SEND], tool_settings: { [SEND]: { pin_broken: true } } }));
  assert.equal(own.status, 422, JSON.stringify(own.body));
  // A valid pin repairs it.
  const repaired = await api("PUT", "/settings/tools", { [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } });
  assert.deepEqual(repaired.body[SEND], { permission: "allow", pin: { channel_id: "C0123" } });
});
