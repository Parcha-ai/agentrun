// One answer of the model makes two MCP calls at once: a read that runs (the server's allow_reads lifts its ask) and a
// write that parks on its person. The owner denies the write, and the run goes on: what the model is sent next holds the
// read's result beside the write's refusal, so it never has to run the read again. On pi (the faux model), claude-agent
// (the pinned Agent SDK and Claude CLI against a scripted Messages endpoint) and codex (the stand-in for Codex's
// app-server, its model a scripted Responses endpoint). No key, no network. pi's row is open (OPEN, a todo).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { withToolSearch } from "./fixtures/claude-tool-search.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { agent, call, clientOwnerSession, follow, scratch, serve as serveOf, whenFree, withEnv } from "./support.mjs";
import { stranger } from "./fixtures/stranger.mjs";

const TOKEN = `not-a-secret-${"mcp-parked-sibling-01"}`;
const json = { "content-type": "application/json" };
const FAUX = new URL("./fixtures/faux-siblings.mjs", import.meta.url).pathname;
const HARNESSES = ["pi", ...(existsSync("/usr/bin/setpriv") ? ["claude-agent"] : []), "codex"];
const READS = { "mcp:fake/*": { allow_reads: true } };
const calls = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === tool);

/** A tool result's text, whichever shape it has (a string, or a list of text parts). */
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "");

/** The Messages conversation's tool results, by tool_use id. */
const claudeResults = (messages) =>
  Object.fromEntries(messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result").map((block) => [block.tool_use_id, textOf(block.content)]));

/** serve's gateway on loopback for codex's stand-in, a Responses model: a request with no call yet makes both calls in
 *  one answer; any later one says what each call's output was. `inputs` is every request's input, in order. */
async function siblingGateway(t) {
  const inputs = [];
  const server = createServer(async (req, res) => {
    if (stranger(req, res, { own: (path) => path.startsWith("/v1/") })) return;
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body || "{}").input ?? [];
    inputs.push(input);
    const made = input.filter((item) => item.type === "function_call");
    const outputs = Object.fromEntries(input.filter((item) => item.type === "function_call_output").map((item) => [item.call_id, item.output]));
    const items = made.length === 0
      ? [
          { type: "function_call", id: "fc_add", call_id: "call_add", name: "mcp_fake__add", arguments: JSON.stringify({ a: 2, b: 3 }), status: "completed" },
          { type: "function_call", id: "fc_note", call_id: "call_note", name: "mcp_fake__note", arguments: JSON.stringify({ text: "hi" }), status: "completed" },
        ]
      : [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: `Seen: ${made.map((item) => `${item.name}=${outputs[item.call_id] ?? "(none)"}`).join(" | ")}`, annotations: [] }] }];
    const events = [
      ...items.flatMap((item, index) => [...(item.type === "message" ? [{ type: "response.output_text.delta", item_id: item.id, output_index: index, content_index: 0, delta: item.content[0].text }] : []), { type: "response.output_item.done", output_index: index, item }]),
      { type: "response.completed", response: { id: "r1", object: "response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 10 } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, inputs };
}

/** A server for `harness` with the fake MCP server saved (its read-only add, and a plain write, note), Allow reads on, an
 *  owner who can answer approvals, and a run whose model calls add and note in one answer. `sent()` is what the model was
 *  sent in each request after the first, as `{ results, denied }`: the read's result text there (undefined when it holds
 *  none) and whether the write's refusal is there; pi's model says what it was sent in its answer instead. */
async function setup(t, harness) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  let extra = {};
  let content;
  let sent = () => [];
  if (harness === "pi") content = `Siblings ${JSON.stringify([["mcp__fake__add", { a: 2, b: 3 }], ["mcp__fake__note", { text: "hi" }]])}`;
  if (harness === "claude-agent") {
    const ADD = "mcp__hands__mcp__fake__add";
    const NOTE = "mcp__hands__mcp__fake__note";
    const uses = (messages) => messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_use");
    const anthropic = await fakeAnthropic({
      // Both calls at once (after the CLI's own ToolSearch finds them, withToolSearch); once made, what each one's result
      // was, wherever the conversation holds it.
      reply: withToolSearch((request) => {
        const made = uses(request.messages);
        if (made.length === 0) return request.tools.includes(ADD) && request.tools.includes(NOTE) ? { tools: [{ name: ADD, input: { a: 2, b: 3 } }, { name: NOTE, input: { text: "hi" } }] } : { text: "Noted." };
        const results = claudeResults(request.messages);
        return { text: `Seen: ${made.map((use) => `${use.name.slice("mcp__hands__".length)}=${results[use.id] ?? "(none)"}`).join(" | ")}` };
      }),
    });
    t.after(() => anthropic.close());
    const saved = { ...process.env };
    t.after(() => {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });
    delete process.env.AGENT_MODEL_BASE_URL;
    Object.assign(process.env, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: anthropic.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" });
    extra = { harness: "claude-agent", model: "anthropic/claude-haiku-4-5" };
    content = "Add 2 and 3 with the add tool, and write the note hi.";
    sent = () => {
      const requests = anthropic.messages().map((request) => request.body.messages ?? []);
      const ids = (name) => requests.flatMap((messages) => uses(messages)).filter((use) => use.name === name).map((use) => use.id);
      const [add] = ids(ADD);
      const [note] = ids(NOTE);
      return requests.filter((messages) => note !== undefined && claudeResults(messages)[note] !== undefined).map((messages) => ({ read: claudeResults(messages)[add], refusal: claudeResults(messages)[note], raw: messages }));
    };
  }
  if (harness === "codex") {
    const standIn = join(await scratch(t), "codex-stand-in.mjs");
    await copyStandIn(standIn);
    const gateway = await siblingGateway(t);
    withEnv(t, {
      AGENTRUN_CODEX_STANDIN: "1",
      AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "responses" } }),
      AGENT_MODEL_BASE_URL: gateway.url,
      AGENT_MODEL: "gpt-test",
      AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    extra = { harness: "codex" };
    content = "Add 2 and 3 with the add tool, and write the note hi.";
    sent = () => {
      const outputOf = (input, id) => input.find((item) => item.type === "function_call_output" && item.call_id === id)?.output;
      return gateway.inputs.filter((input) => outputOf(input, "call_note") !== undefined).map((input) => ({ read: outputOf(input, "call_add"), refusal: outputOf(input, "call_note"), raw: input }));
    };
  }
  const server = await serveOf(t, { faux: harness === "pi" ? FAUX : undefined, accounts: true, openSetup: true });
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools.note = { description: "Write a note.", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false }, run: ({ text }) => ({ content: [{ type: "text", text: `noted ${text}` }] }) };
  const saved = await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await server.api("PUT", "/settings/tools", READS)).status, 200);
  const { cookie, origin } = await clientOwnerSession(server);
  const answer = async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${encodeURIComponent(approvalId)}`, headers: { ...json, cookie, origin }, body })).status;
  const made = await whenFree(() => server.api("POST", "/agents", agent(`siblings-${harness}`, { tools: ["mcp:fake/add", "mcp:fake/note"], ...extra })));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await whenFree(() => server.api("POST", `/agents/siblings-${harness}/runs`, { input: { content } }));
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return { api: server.api, fake, answer, runId: started.body.run_id, sent };
}

/** pi's gap, open: its park seals the claim and closes the session while the read beside it is still in flight, so the
 *  read is cut before it is sent and the model reads it interrupted. A park that waits, within a bound, for the calls
 *  already running beside it would close it. */
const OPEN = { pi: "pi: the park cuts the read in flight beside it (never sent), and the model is told it was interrupted" };

for (const harness of HARNESSES) {
  test(`${harness}: a read that ran beside a write parked in the same answer keeps its result: once the write is denied, the model is sent the read's result with the refusal, and the read runs once`, { timeout: 240_000, ...(OPEN[harness] ? { todo: OPEN[harness] } : {}) }, async (t) => {
    const { api, fake, answer, runId, sent } = await setup(t, harness);
    await follow(api, runId, ["input_required"], { deadlineMs: 180_000 });
    const pending = (await api("GET", `/runs/${runId}`)).body.pending;
    assert.deepEqual([pending?.kind, pending?.tool], ["approval", "mcp:fake/note"], JSON.stringify(pending));
    assert.equal(calls(fake, "add").length, 1, "the read ran with no one asked");
    assert.equal(calls(fake, "note").length, 0, "the write waits");
    assert.equal(await answer(runId, pending.id, { decision: "deny" }), 204);
    const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 180_000 });
    const final = (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";
    assert.equal(last.status, "completed", final);
    if (harness !== "pi") {
      const after = sent();
      assert.ok(after.length > 0, "the model was asked again after the deny");
      assert.equal(after[0].read, "5", `the first request after the deny holds the read's result: ${JSON.stringify(after[0].raw).slice(0, 3000)}`);
      assert.match(after[0].refusal, /den/i, "and the write's refusal");
    }
    assert.match(final, /mcp_{1,2}fake__add=5/, `the model answers from the read's result: ${final}`);
    assert.equal(calls(fake, "add").length, 1, "the read ran once, never again");
    assert.equal(calls(fake, "note").length, 0, "denied: never sent");
  });
}
