// An agent run unattended (definition.approvals "never") never lifts a pin: through the API on pi with a faux model and
// the fake MCP server, a send the server's settings pin to one channel, under "never", is refused for any other channel
// (never parked, never sent), and runs without parking for the pinned one. The gate refuses by the pin (pinRefusal)
// before it decides between running and asking, where "never" turns an ask into an allow. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, call, follow, serve, withEnv } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
const SEND = "mcp:fake/send_message";
const REFUSAL = /mcp:fake\/send_message may only be called with channel_id = C0123: its destination is fixed by this server's settings\. It was not run: nothing was sent and nothing was charged\./;

test("under approvals never, a call not as the server pinned it is refused, never parked or sent; one as pinned runs without parking", { timeout: 240_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  // Accounts on: a person could answer, so an ask would park; "never" is what keeps the pinned call from parking.
  const server = await serve(t, { faux: FAUX_MCP, accounts: true, openSetup: true });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  fake.tools.send_message = {
    description: "Post a message to a channel.",
    input: { type: "object", properties: { channel_id: { type: "string" }, message: { type: "string" } }, required: ["channel_id", "message"], additionalProperties: false },
    run: ({ channel_id }) => ({ content: [{ type: "text", text: `posted to ${channel_id}` }] }),
  };
  const { api } = server;
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  const origin = `http://127.0.0.1:${server.port}`;
  assert.equal((await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PHRASE } })).status, 201);
  // The server pins the send to one channel and sets no permission: an MCP tool asks by default.
  assert.equal((await api("PUT", "/settings/tools", { [SEND]: { pin: { channel_id: "C0123" } } })).status, 200);
  const made = await api("POST", "/agents", agent("unattended", { tools: [SEND], approvals: "never" }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await api("GET", "/agents/unattended")).body.definition.approvals, "never");
  const sends = () => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "send_message");
  const send = async (channel) => {
    const started = await api("POST", "/agents/unattended/runs", { input: { content: `Call mcp__fake__send_message with ${JSON.stringify({ channel_id: channel, message: "the digest" })}` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  const answerOf = async (runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";

  const off = await send("C0999");
  const offEnd = await follow(api, off, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
  assert.equal(offEnd.last.status, "completed", "refused at once, never parked for an approval");
  assert.equal((await api("GET", `/runs/${off}`)).body.pending ?? null, null, "nothing is pending");
  assert.match(await answerOf(off), REFUSAL);
  assert.equal(sends().length, 0, "the call outside the pin never reached the MCP server");

  const on = await send("C0123");
  const onEnd = await follow(api, on, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
  assert.equal(onEnd.last.status, "completed", "the pinned call ran without parking");
  assert.equal((await api("GET", `/runs/${on}`)).body.approvals, "never", "the run reads unattended");
  assert.match(await answerOf(on), /The tool said: posted to C0123/);
  assert.equal(sends().length, 1, "sent once, to the pinned channel");
});
