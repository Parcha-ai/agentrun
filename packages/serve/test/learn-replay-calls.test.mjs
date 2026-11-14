// A replay's call nodes (learn/replay-calls.ts, SPEC B4): each tool a read or a write, a read live through a cache seeded
// from the graded run's recorded calls, a write never run: answered from the recording on the same tool and canonical
// arguments, else the input is skipped. The recording read from a run's journal entries, pi-shaped, by wire name.
import assert from "node:assert/strict";
import { test } from "node:test";

const { READ_TOOLS, SKIPPED_WRITE, callKey, canonical, recordedCalls, replayCalls, ReplaySkipped, toolClassOf } = await import("../dist/learn/replay-calls.js");
const { CALL_REFUSED } = await import("../dist/timeline/index.js");

test("a tool is read or write: MCP by its annotations (readOnlyHint true, not destructive), built-ins by the fixed list, anything else write", () => {
  const listed = { "mcp:fake/add": { readOnlyHint: true }, "mcp:fake/delete_thing": { destructiveHint: true }, "mcp:fake/odd": { readOnlyHint: true, destructiveHint: true }, "mcp:fake/plain": {} };
  const of = (tool) => toolClassOf(tool, (name) => listed[name]);
  assert.equal(of("mcp:fake/add"), "read");
  assert.equal(of("mcp:fake/delete_thing"), "write");
  assert.equal(of("mcp:fake/odd"), "write", "read-only and destructive at once: a write");
  assert.equal(of("mcp:fake/plain"), "write", "no annotation: a write");
  assert.equal(of("mcp:fake/unlisted"), "write", "a tool the pin does not list: a write");
  assert.equal(toolClassOf("mcp:fake/add"), "write", "no annotations read at all: a write");
  for (const tool of ["web_fetch", "web_search", "pdf_pages", "llm"]) assert.equal(of(tool), "read", tool);
  assert.deepEqual([...READ_TOOLS].sort(), ["llm", "pdf_pages", "web_fetch", "web_search"]);
  for (const tool of ["bash", "write", "monid.run", "browser", "something_new"]) assert.equal(of(tool), "write", tool);
});

test("a call's key is its tool's wire name and its canonical arguments: key order never matters, values do", () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
  assert.equal(callKey("mcp:fake/delete_thing", { id: "t-1", why: "x" }), callKey("mcp__fake__delete_thing", { why: "x", id: "t-1" }));
  assert.notEqual(callKey("mcp:fake/delete_thing", { id: "t-1" }), callKey("mcp:fake/delete_thing", { id: "t-2" }));
  assert.notEqual(callKey("mcp:fake/delete_thing", { n: 1 }), callKey("mcp:fake/delete_thing", { n: "1" }), "a number is not its digits");
});

/** A pi-shaped journal: each call an assistant entry with its toolCall, then its result. */
const journal = (calls) => calls.flatMap(({ id, name, args, text, isError, details }) => [
  { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }] },
  { kind: "pi.tool-result", model: [{ role: "tool", toolCallId: id, content: [{ type: "text", text }], ...(isError ? { isError: true } : {}), ...(details ? { details } : {}) }] },
]);

test("the recording: each call by wire name and canonical arguments, its first answer kept; a refused call recorded nothing", () => {
  const recorded = recordedCalls(journal([
    { id: "c1", name: "mcp__fake__delete_thing", args: { id: "t-1" }, text: "deleted t-1" },
    { id: "c2", name: "mcp__fake__delete_thing", args: { id: "t-1" }, text: "already gone" },
    { id: "c3", name: "web_search", args: { query: "q" }, text: "1. a result", details: { provider: "exa", results: [] } },
    { id: "c4", name: "mcp__fake__delete_thing", args: { id: "t-9" }, text: "denied", isError: true, details: { [CALL_REFUSED]: true } },
  ]));
  assert.deepEqual(recorded.get(callKey("mcp:fake/delete_thing", { id: "t-1" })), { text: "deleted t-1", isError: false });
  assert.deepEqual(recorded.get(callKey("web_search", { query: "q" }))?.details, { provider: "exa", results: [] });
  assert.equal(recorded.has(callKey("mcp:fake/delete_thing", { id: "t-9" })), false, "a refused call never ran: no answer");
  assert.equal(recorded.size, 2);
});

const classes = { "mcp:fake/add": "read", "mcp:fake/delete_thing": "write", web_search: "read" };

test("a write with its arguments in the recording is answered from it, never run; one that is not skips the input and stops the workflow", async () => {
  const recorded = recordedCalls(journal([{ id: "c1", name: "mcp__fake__delete_thing", args: { id: "t-1" }, text: '{"deleted":"t-1"}' }, { id: "c2", name: "mcp__fake__delete_thing", args: { id: "t-2" }, text: "no such thing", isError: true }]));
  const calls = replayCalls(recorded, (tool) => classes[tool] ?? "write");
  let ran = 0;
  const live = async () => (ran += 1, "live");
  assert.deepEqual(await calls.call({ label: "delete", tool: "mcp:fake/delete_thing" }, { id: "t-1" }, live), { deleted: "t-1" }, "the recorded answer, as the live call's value");
  await assert.rejects(calls.call({ label: "delete", tool: "mcp:fake/delete_thing" }, { id: "t-2" }, live), /no such thing/, "a recorded error is the answer too");
  assert.equal(calls.skipped, undefined);
  assert.equal(calls.stop.aborted, false);
  await assert.rejects(calls.call({ label: "delete again", tool: "mcp:fake/delete_thing" }, { id: "t-3" }, live), (error) => error instanceof ReplaySkipped && error.message.includes(SKIPPED_WRITE));
  assert.deepEqual(calls.skipped, { tool: "mcp:fake/delete_thing", step: "delete again" });
  assert.equal(calls.stop.aborted, true, "the workflow stops at the write");
  assert.equal(ran, 0, "no write ran live");
});

test("a read runs live once and is cached; a recorded one is answered at no cost; a failed one is not kept", async () => {
  const recorded = recordedCalls(journal([
    { id: "c1", name: "mcp__fake__add", args: { a: 1, b: 2 }, text: "3" },
    { id: "c2", name: "web_search", args: { query: "seen" }, text: "1. a", details: { provider: "exa", results: [{ url: "https://example.com" }] } },
    { id: "c3", name: "web_search", args: { query: "words" }, text: "only words" },
  ]));
  const calls = replayCalls(recorded, (tool) => classes[tool] ?? "write");
  let ran = 0;
  const live = (value) => async () => (ran += 1, value);
  assert.equal(await calls.call({ label: "add", tool: "mcp:fake/add" }, { b: 2, a: 1 }, live(99)), 3, "recorded: its text as JSON, never sent");
  assert.deepEqual(await calls.call({ label: "find", tool: "web_search" }, { query: "seen" }, live("no")), { provider: "exa", results: [{ url: "https://example.com" }] }, "a built-in's recorded value is its details");
  assert.equal(ran, 0);
  assert.equal(await calls.call({ label: "find", tool: "web_search" }, { query: "words" }, live("fresh")), "fresh", "a built-in recorded as words alone runs live");
  assert.equal(await calls.call({ label: "add", tool: "mcp:fake/add" }, { a: 5, b: 5 }, live(10)), 10);
  assert.equal(await calls.call({ label: "add again", tool: "mcp:fake/add" }, { a: 5, b: 5 }, live(11)), 10, "the second read is the cache's");
  assert.equal(ran, 2);
  assert.equal(calls.live, 2);
  await assert.rejects(calls.call({ label: "add", tool: "mcp:fake/add" }, { a: 0, b: 0 }, async () => (ran += 1, Promise.reject(new Error("down")))), /down/);
  assert.equal(await calls.call({ label: "add", tool: "mcp:fake/add" }, { a: 0, b: 0 }, live(0)), 0, "a failed read runs live again");
  assert.equal(ran, 4);
  assert.equal(calls.skipped, undefined);
});
