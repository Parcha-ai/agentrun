// The adapter on the pinned `opencode serve` itself, against a scripted provider (the proxy's fetch): no network, no
// key. OpenCode's model requests carry only what the policy admits, offer only the host's tools, and there is one
// request per step and no side request (no title, no summary); the host's tool runs through the adapter's MCP server; a
// follow-up runs in a new OpenCode process that took the session back from the session's records, twenty times over with
// every process's event stream open at the first try.
//
// Without the pinned binary this skips; with AGENTRUN_OPENCODE_REQUIRE_BINARY=1 (CI) it fails.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HOST_RESULT_MAX_CHARS } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { openCodeAdapter } from "../dist/harness-opencode/index.js";
import { findOpenCode } from "../dist/harness-opencode/binary.js";
import { BODY_KEYS } from "../dist/harness-opencode/host/policy.js";
import { verifyOpenCodeBinary } from "../dist/harness-opencode/verify.js";

const pinned = verifyOpenCodeBinary(findOpenCode());
const skip = pinned instanceof Error && process.env.AGENTRUN_OPENCODE_REQUIRE_BINARY !== "1" ? pinned.message : false;
const ROOT = mkdtempSync(join(tmpdir(), "agentrun-opencode-real-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function answer(step, i) {
  const events = [{ type: "response.created", response: { id: `resp_${i}`, object: "response", created_at: 1, model: "gpt-test", status: "in_progress", output: [] } }];
  if (step.call) {
    const item = { type: "function_call", id: `fc_${i}`, call_id: step.callId, name: step.call, arguments: JSON.stringify(step.args), status: "completed" };
    events.push({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
    events.push({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
    events.push({ type: "response.output_item.done", output_index: 0, item });
  } else {
    const item = { type: "message", id: `msg_${i}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] };
    events.push({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
    events.push({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    events.push({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: step.text });
    events.push({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: step.text });
    events.push({ type: "response.output_item.done", output_index: 0, item });
  }
  events.push({ type: "response.completed", response: { id: `resp_${i}`, object: "response", created_at: 1, model: "gpt-test", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

test("on the pinned OpenCode, the host's tool runs through the adapter, each request carries only what the policy admits and only the host's tools, and a follow-up's new process has the session back", { skip, timeout: 240_000 }, async () => {
  const script = [{ call: "hands_lookup", callId: "call_look", args: { q: "x" } }, { text: "Found it." }, { text: "Still here." }];
  const seen = [];
  const fetch = async (url, init) => {
    const i = seen.length;
    seen.push({ url, body: JSON.parse(init.body) });
    return new Response(answer(script[i] ?? { text: "spare" }, i), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const calls = [];
  const lookup = { name: "lookup", description: "Look a thing up.", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, replay: "safe", call: async (args, { callId }) => { calls.push({ args, callId }); return { text: "found: x" }; } };
  const a = openCodeAdapter({ model: "gpt-test", provider: { origin: "https://provider.invalid", credential: () => "provider-secret" }, price: () => 0.001, sessionsDir: join(ROOT, "sessions"), fetch });
  const store = memorySessionStore();
  const events = [];
  const booked = [];
  const io = { writer: await store.open("real"), models: { beforeRequest: async () => {}, afterRequest: async (usage) => void booked.push(usage) }, signal: new AbortController().signal, cwd: mkdtempSync(join(ROOT, "work-")), onEvent: (e) => events.push(e) };
  const session = await a.open({ key: "real", label: "task", system: ["You look things up. INSTRUCTIONS-MARK"], tools: [lookup], context: "fresh" }, io);
  await session.send("Look up x.");
  assert.deepEqual(await session.turnEnd(), { status: "completed" });
  await session.send("And now?");
  assert.deepEqual(await session.turnEnd(), { status: "completed" });
  await session.close();

  assert.deepEqual(calls, [{ args: { q: "x" }, callId: "call_look" }], "the host's tool ran once, under the model's call id");
  assert.deepEqual(events.filter((e) => e.type !== "text"), [
    { type: "tool_start", callId: "call_look", name: "lookup", args: { q: "x" } },
    { type: "tool_end", callId: "call_look", name: "lookup", isError: false, result: "found: x" },
    { type: "turn_end", status: "completed" },
    { type: "turn_end", status: "completed" },
  ]);
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.delta).join(""), "Found it.Still here.");
  assert.equal(seen.length, 3, "one request per step: no title or summary request");
  assert.equal(booked.length, 3, "each booked");
  for (const r of seen) {
    assert.equal(r.url, "https://provider.invalid/v1/responses");
    for (const key of Object.keys(r.body)) assert.ok(BODY_KEYS.has(key), key);
    assert.deepEqual(r.body.tools.map((t) => t.name), ["hands_lookup"], "only the host's tool");
    assert.equal(r.body.store, false);
    assert.equal(r.body.model, "gpt-test");
  }
  const system = JSON.stringify(seen[0].body.input[0]);
  assert.match(system, /INSTRUCTIONS-MARK/, "the session's instructions are the agent's prompt");
  const last = JSON.stringify(seen[2].body.input);
  assert.match(last, /Look up x\./, "the follow-up's process has the first turn back");
  assert.match(last, /found: x/);
  assert.match(last, /And now\?/);
});

test("on the pinned OpenCode, a host tool's result as long as the host's bound reaches the model whole: never cut and saved to a file the model has no tool to read", { skip, timeout: 120_000 }, async () => {
  // 3,000 lines of 40 characters, some past ASCII: past OpenCode's own limits on both counts (2,000 lines, 51,200 bytes).
  const text = `${"é".repeat(9)}${"x".repeat(30)}\n`.repeat(HOST_RESULT_MAX_CHARS / 40);
  assert.equal(text.length, HOST_RESULT_MAX_CHARS);
  const script = [{ call: "hands_long", callId: "call_long", args: {} }, { text: "Read it." }];
  const seen = [];
  const fetch = async (url, init) => {
    const i = seen.length;
    seen.push(JSON.parse(init.body));
    return new Response(answer(script[i] ?? { text: "spare" }, i), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const long = { name: "long", description: "A long answer.", inputSchema: { type: "object", properties: {} }, replay: "safe", call: async () => ({ text }) };
  const a = openCodeAdapter({ model: "gpt-test", provider: { origin: "https://provider.invalid", credential: () => "provider-secret" }, price: () => 0.001, sessionsDir: join(ROOT, "long-sessions"), fetch });
  const store = memorySessionStore();
  const io = { writer: await store.open("long"), models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: new AbortController().signal, cwd: mkdtempSync(join(ROOT, "work-")), onEvent: () => {} };
  const session = await a.open({ key: "long", label: "task", system: ["You read long things."], tools: [long], context: "fresh" }, io);
  await session.send("Read the long thing.");
  assert.deepEqual(await session.turnEnd(), { status: "completed" });
  await session.close();
  assert.equal(seen.length, 2);
  const output = seen[1].input.find((item) => item.type === "function_call_output" && item.call_id === "call_long")?.output;
  assert.equal(typeof output, "string");
  assert.doesNotMatch(output, /the output was truncated\. Full output saved to/, `cut: ${output.slice(-200)}`);
  assert.equal(output, text, "the model reads the whole result");
});

test("twenty follow-ups on the pinned OpenCode, each a new process that took the session back with /sync/replay: every event stream opens at the first try and every turn completes", { skip, timeout: 600_000 }, async (t) => {
  const seen = [];
  const fetch = async (_url, init) => {
    const i = seen.length;
    seen.push(JSON.parse(init.body));
    return new Response(answer({ text: `Answer ${i + 1}.` }, i), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const said = [];
  const a = openCodeAdapter({ model: "gpt-test", provider: { origin: "https://provider.invalid", credential: () => "provider-secret" }, sessionsDir: join(ROOT, "loop"), fetch, log: (message) => said.push(message) });
  const store = memorySessionStore();
  const events = [];
  const io = { writer: await store.open("loop"), models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: new AbortController().signal, cwd: mkdtempSync(join(ROOT, "loop-work-")), onEvent: (e) => events.push(e) };
  const session = await a.open({ key: "loop", label: "task", system: ["You answer."], tools: [], context: "fresh" }, io);
  const ends = [];
  for (let i = 1; i <= 20; i++) {
    await session.send(`Message ${i}.`);
    ends.push((await session.turnEnd()).status);
  }
  await session.close();
  const reopened = said.filter((m) => m.includes("event stream is opened again")).length;
  t.diagnostic(`${ends.filter((e) => e === "completed").length}/20 drives completed on the pinned binary; ${reopened} event streams opened again`);
  assert.deepEqual(ends, Array(20).fill("completed"));
  assert.equal(reopened, 0, "every drive's stream opened at the first try");
  assert.equal(seen.length, 20, "one request per turn");
  const last = JSON.stringify(seen[19].input);
  for (let i = 1; i <= 20; i++) assert.ok(last.includes(`Message ${i}.`), `the twentieth process has message ${i} back`);
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.delta).join(" "), Array.from({ length: 20 }, (_, i) => `Answer ${i + 1}.`).join(" "));
});

/** A port free on 127.0.0.1 now. */
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

test("twenty follow-ups on the pinned OpenCode, every drive's process on the SAME port (as where 4096 is free: OpenCode takes it each time): every event stream opens at the first try", { skip: skip || (process.env.CI && !process.env.AGENTRUN_RUN_QUARANTINED && "quarantined F36 (tl-jobs) until 2026-11-06T02:47Z, scripts/quarantine.json"), timeout: 600_000 }, async (t) => {
  // The pinned binary, started by the adapter's stand-in hook on one port for every drive: each new process listens where
  // the killed one before it did. A connection kept from an earlier drive is then a connection to a dead process.
  process.env.AGENTRUN_OPENCODE_STANDIN = "1";
  t.after(() => delete process.env.AGENTRUN_OPENCODE_STANDIN);
  const port = await freePort();
  const standIn = { command: "/bin/sh", args: ["-c", `exec "$0" serve --hostname 127.0.0.1 --port ${port}`, findOpenCode().path] };
  const seen = [];
  const fetch = async (_url, init) => {
    const i = seen.length;
    seen.push(JSON.parse(init.body));
    return new Response(answer({ text: `Answer ${i + 1}.` }, i), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const reopened = [];
  const a = openCodeAdapter({ model: "gpt-test", provider: { origin: "https://provider.invalid", credential: () => "provider-secret" }, sessionsDir: join(ROOT, "same-port"), fetch, standIn, log: (message, fields) => message.includes("event stream is opened again") && reopened.push(fields?.why) });
  const store = memorySessionStore();
  const io = { writer: await store.open("same-port"), models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: new AbortController().signal, cwd: mkdtempSync(join(ROOT, "same-port-work-")), onEvent: () => {} };
  const session = await a.open({ key: "same-port", label: "task", system: ["You answer."], tools: [], context: "fresh" }, io);
  const ends = [];
  for (let i = 1; i <= 20; i++) {
    await session.send(`Message ${i}.`);
    ends.push((await session.turnEnd()).status);
  }
  await session.close();
  t.diagnostic(`${ends.filter((e) => e === "completed").length}/20 drives completed on one port; ${reopened.length} event streams opened again`);
  assert.deepEqual(ends, Array(20).fill("completed"));
  assert.deepEqual(reopened, [], "every drive's stream opened at the first try");
  assert.equal(seen.length, 20, "one request per turn");
});
