// One answer of the model makes two MCP calls at once: a read that runs (the server's allow_reads lifts its ask) and a
// write that parks on its person. The owner denies the write, and the run goes on: what the model is sent next holds the
// read's result beside the write's refusal, so it never has to run the read again. That result is the one the model
// would have read live: the same text after the run's scrub (a credential the result echoes is cut) and the server's
// size bound (a long answer filed, its start shown). On pi (the faux model), claude-agent (the pinned Agent SDK and Claude CLI against a scripted Messages endpoint),
// codex (the stand-in for Codex's app-server, its model a scripted Responses endpoint) and opencode (the stand-in for
// `opencode serve`, its model a scripted Responses endpoint). No key, no network. pi's row is open (OPEN, a todo).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { withToolSearch } from "./fixtures/claude-tool-search.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { agent, call, clientOwnerSession, follow, scratch, serve as serveOf, whenFree, withEnv } from "./support.mjs";
import { stranger } from "./fixtures/stranger.mjs";

const TOKEN = `not-a-secret-${"mcp-parked-sibling-01"}`;
const json = { "content-type": "application/json" };
const FAUX = new URL("./fixtures/faux-siblings.mjs", import.meta.url).pathname;
const OPENCODE = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const CLI = [...(existsSync("/usr/bin/setpriv") ? ["claude-agent"] : []), "codex", "opencode"];
const HARNESSES = ["pi", ...CLI];
const READS = { "mcp:fake/*": { allow_reads: true } };
/** A read's answer that echoes the server's own credential and runs past the host's bound on a result the model reads
 *  (HOST_RESULT_MAX_CHARS, 120,000), and so past the server's (a filed answer, filed-answer.ts). */
const BIG = `5 key=${TOKEN} ${"x".repeat(130_000)}`;
const calls = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === tool);
/** What a scripted model says of a result: its start, so an answer stays short whatever the result's size. */
const shown = (text) => String(text).slice(0, 40);

/** A tool result's text, whichever shape it has (a string, or a list of text parts). */
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "");

/** The Messages conversation's tool results, by tool_use id. */
const claudeResults = (messages) =>
  Object.fromEntries(messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result").map((block) => [block.tool_use_id, textOf(block.content)]));

/** serve's gateway on loopback for a Responses model (codex's and opencode's stand-ins): a request with no call yet makes
 *  the calls in one answer (add and note when note is offered, else add alone); any later one says what each call's
 *  output was. Every request is kept (`requests`): its input and its tool names. */
async function siblingGateway(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (stranger(req, res, { own: (path) => path.startsWith("/v1/") })) return;
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body || "{}");
    const input = request.input ?? [];
    const names = (request.tools ?? []).map((tool) => tool.name);
    requests.push({ input, names });
    const named = (tool) => names.find((name) => name.endsWith(`fake__${tool}`));
    const made = input.filter((item) => item.type === "function_call");
    const outputs = Object.fromEntries(input.filter((item) => item.type === "function_call_output").map((item) => [item.call_id, item.output]));
    const asked = [["add", { a: 2, b: 3 }], ...(named("note") ? [["note", { text: "hi" }]] : [])];
    const items = made.length === 0 && named("add")
      ? asked.map(([tool, args]) => ({ type: "function_call", id: `fc_${tool}`, call_id: `call_${tool}`, name: named(tool), arguments: JSON.stringify(args), status: "completed" }))
      : [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: `Seen: ${made.map((item) => `${item.name}=${shown(outputs[item.call_id] ?? "(none)")}`).join(" | ")}`, annotations: [] }] }];
    const events = [
      ...items.flatMap((item, index) => [...(item.type === "message" ? [{ type: "response.output_text.delta", item_id: item.id, output_index: index, content_index: 0, delta: item.content[0].text }] : []), { type: "response.output_item.done", output_index: index, item }]),
      { type: "response.completed", response: { id: "r1", object: "response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 10 } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/** A server for `harness` with the fake MCP server saved (its read-only add, answering `answer`, and a plain write,
 *  note), Allow reads on, and an owner who can answer approvals. `start(id, tools)` starts a run of a new agent granted
 *  `tools`, whose model calls them all in one answer. `seen()` is what the model was sent in each request after one
 *  that made a call, in order: `{ read, refusal, raw }`, the read's result text there and the write's refusal (each
 *  undefined when the request holds none); pi's model says what it was sent in its answer instead. */
async function setup(t, harness, { answer: addAnswer = "5" } = {}) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  let extra = {};
  let content;
  let seen = () => [];
  if (harness === "pi") content = (tools) => `Siblings ${JSON.stringify(tools.map((tool) => [tool.replace("mcp:fake/", "mcp__fake__"), tool.endsWith("/add") ? { a: 2, b: 3 } : { text: "hi" }]))}`;
  if (harness === "claude-agent") {
    const ADD = "mcp__hands__mcp__fake__add";
    const NOTE = "mcp__hands__mcp__fake__note";
    const uses = (messages) => messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_use");
    const anthropic = await fakeAnthropic({
      // The calls at once (after the CLI's own ToolSearch finds them, withToolSearch): add, and note when it is offered;
      // once made, what each one's result was, wherever the conversation holds it.
      reply: withToolSearch((request) => {
        const made = uses(request.messages);
        if (made.length === 0) return request.tools.includes(ADD) ? { tools: [{ name: ADD, input: { a: 2, b: 3 } }, ...(request.tools.includes(NOTE) ? [{ name: NOTE, input: { text: "hi" } }] : [])] } : { text: "Noted." };
        const results = claudeResults(request.messages);
        return { text: `Seen: ${made.map((use) => `${use.name.slice("mcp__hands__".length)}=${shown(results[use.id] ?? "(none)")}`).join(" | ")}` };
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
    seen = () => anthropic.messages().map((request) => request.body.messages ?? []).filter((messages) => uses(messages).some((use) => use.name === ADD)).map((messages) => {
      const results = claudeResults(messages);
      const id = (name) => uses(messages).find((use) => use.name === name)?.id;
      return { read: results[id(ADD)], refusal: id(NOTE) === undefined ? undefined : results[id(NOTE)], raw: messages };
    });
  }
  if (harness === "codex" || harness === "opencode") {
    const standIn = join(await scratch(t), `${harness}-stand-in.mjs`);
    if (harness === "codex") await copyStandIn(standIn);
    else await copyFile(OPENCODE, standIn);
    const gateway = await siblingGateway(t);
    withEnv(t, {
      ...(harness === "codex"
        ? { AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "responses" } }) }
        : { AGENTRUN_OPENCODE_STANDIN: "1", AGENTRUN_SERVE_OPENCODE_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn] }) }),
      AGENT_MODEL_BASE_URL: gateway.url,
      AGENT_MODEL: "gpt-test",
      AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    extra = { harness };
    const outputOf = (input, id) => input.find((item) => item.type === "function_call_output" && item.call_id === id)?.output;
    seen = () => gateway.requests.filter(({ input }) => input.some((item) => item.type === "function_call" && item.call_id === "call_add")).map(({ input }) => ({ read: outputOf(input, "call_add"), refusal: outputOf(input, "call_note"), raw: input }));
  }
  content ??= () => "Add 2 and 3 with the add tool, and write the note hi if you have the note tool.";
  const server = await serveOf(t, { faux: harness === "pi" ? FAUX : undefined, accounts: true, openSetup: true });
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools.add.run = () => ({ content: [{ type: "text", text: addAnswer }] });
  fake.tools.note = { description: "Write a note.", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false }, run: ({ text }) => ({ content: [{ type: "text", text: `noted ${text}` }] }) };
  const saved = await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await server.api("PUT", "/settings/tools", READS)).status, 200);
  const { cookie, origin } = await clientOwnerSession(server);
  const answer = async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${encodeURIComponent(approvalId)}`, headers: { ...json, cookie, origin }, body })).status;
  const start = async (id, tools) => {
    const made = await whenFree(() => server.api("POST", "/agents", agent(id, { tools, ...extra })));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const started = await whenFree(() => server.api("POST", `/agents/${id}/runs`, { input: { content: content(tools) } }));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  return { api: server.api, fake, answer, start, seen };
}

/** The sibling run of `setup`'s server to its end: add and note in one answer, add run unasked, note parked and denied.
 *  Its final answer, and what the model was sent after the deny (`after`, as `seen` reads it). */
async function deniedSibling(api, fake, answer, start, seen, id) {
  const runId = await start(id, ["mcp:fake/add", "mcp:fake/note"]);
  await follow(api, runId, ["input_required"], { deadlineMs: 180_000 });
  const pending = (await api("GET", `/runs/${runId}`)).body.pending;
  assert.deepEqual([pending?.kind, pending?.tool], ["approval", "mcp:fake/note"], JSON.stringify(pending));
  assert.equal(calls(fake, "add").length, 1, "the read ran with no one asked");
  assert.equal(calls(fake, "note").length, 0, "the write waits");
  const before = seen().length;
  // The read is denied from here on: the gate reads the settings at each call, so a replay that asked it again would
  // hand the model a refusal, not the read's result. An allow by the setting leaves no row, so the rows alone can't tell.
  assert.equal((await api("PUT", "/settings/tools", { ...READS, "mcp:fake/add": { permission: "deny" } })).status, 200);
  assert.equal(await answer(runId, pending.id, { decision: "deny" }), 204);
  const { last, rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 180_000 });
  assert.equal((await api("PUT", "/settings/tools", READS)).status, 200);
  const final = (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";
  assert.equal(last.status, "completed", final);
  assert.equal(calls(fake, "add").length, 1, "the read ran once, never again");
  const asked = rows.filter((row) => row.kind === "tool_approval_requested");
  assert.deepEqual(asked.map((row) => row.tool_name), ["mcp:fake/note"], `one approval row, the write's: the read's replay asks no one ${JSON.stringify(asked.map((row) => row.summary))}`);
  assert.equal(calls(fake, "note").length, 0, "denied: never sent");
  return { final, after: seen().slice(before) };
}

/** pi's gap, open: its park seals the claim and closes the session while the read beside it is still in flight, so the
 *  read is never sent and the model reads it interrupted. A park that waits, within a bound, for the calls already running
 *  beside it would close it. */
const OPEN = { pi: "a park seals while a sibling call is in flight: the read is never sent and the model is told it was interrupted" };

for (const harness of HARNESSES) {
  test(`${harness}: a read that ran beside a write parked in the same answer keeps its result: once the write is denied, the model is sent the read's result with the refusal, and the read runs once`, { timeout: 240_000, ...(OPEN[harness] ? { todo: OPEN[harness] } : {}) }, async (t) => {
    const { api, fake, answer, start, seen } = await setup(t, harness);
    const { final, after } = await deniedSibling(api, fake, answer, start, seen, `siblings-${harness}`);
    if (harness !== "pi") {
      assert.ok(after.length > 0, "the model was asked again after the deny");
      assert.equal(after[0].read, "5", `the first request after the deny holds the read's result: ${JSON.stringify(after[0].raw).slice(0, 3000)}`);
      assert.match(after[0].refusal ?? "", /den/i, "and the write's refusal");
    }
    assert.match(final, /mcp_{1,2}fake__add=5/, `the model answers from the read's result: ${final}`);
  });
}

for (const harness of CLI) {
  test(`${harness}: the read's result the model is sent after the deny is the one it would have read live: the credential it echoes cut, held to the server's bound`, { timeout: 300_000 }, async (t) => {
    const { api, fake, answer, start, seen } = await setup(t, harness, { answer: BIG });
    const { after } = await deniedSibling(api, fake, answer, start, seen, `big-siblings-${harness}`);
    const kept = after[0]?.read;
    assert.equal(typeof kept, "string", `the first request after the deny holds the read's result: ${JSON.stringify(after[0]?.raw ?? null).slice(0, 2000)}`);
    // The same read alone, live: no park, its result read by the model in the same turn.
    const before = seen().length;
    const live = await start(`big-live-${harness}`, ["mcp:fake/add"]);
    const { last } = await follow(api, live, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.equal(last.status, "completed", "no one was asked");
    const read = seen().slice(before)[0]?.read;
    assert.equal(typeof read, "string", "the live read's result reached the model");
    assert.ok(!kept.includes(TOKEN) && !read.includes(TOKEN), "the credential the result echoes is cut, live and written back");
    assert.ok(kept.startsWith("5 key="), kept.slice(0, 80));
    // Too long to read whole: its start, the whole filed in the run's files (filed-answer.ts), and a note saying where.
    assert.ok(kept.length < BIG.length && /\[cut at line \d+ of \d+ .*read it with offset=\d+ to go on\]$/.test(kept), `held to the server's bound and says so: ${kept.length} ${kept.slice(-160)}`);
    // Each run files its own copy, under a name of its own: the rest is word for word. The Claude CLI tacks its own
    // context note (<system-reminder><total_tokens>…) onto a result it reads live; that is the CLI's, not the server's.
    const unnamed = (text) => text.replace(/ at \S+\.txt: read it/, " at <file>: read it").replace(/\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*$/, "");
    assert.equal(unnamed(kept), unnamed(read), "written back as the model would have read it live");
  });
}
