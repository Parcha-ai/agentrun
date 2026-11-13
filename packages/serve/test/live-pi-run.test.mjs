// Red 3: a pi run streamed from the store says what the kernel's one reader says the run did: its calls in the order
// they started, each started then ended, and the model's words, in commit order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { collect, liveWorld, RUN, settled, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");
const { callsOf, journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");

test("a pi run's stream from the store matches the one reader: each call started then ended, in order, and the model's words", async (t) => {
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run([{ call: "read" }, { call: "effect" }, { say: "done" }]);
  const row = await w.ended("ended");
  await until(() => settled(got.types()), "the run's end on the stream");
  const records = await journalRecords(w.server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const calls = callsOf(records);
  const events = got.events();
  const starts = events.filter((event) => event.type === "tool_execution_start").map((event) => event.toolCallId);
  const ends = events.filter((event) => event.type === "tool_execution_end").map((event) => event.toolCallId);
  assert.deepEqual(starts, calls.map((call) => call.callId), "the calls the reader reads, in the order they started");
  assert.deepEqual(ends, calls.map((call) => call.callId), "each ended");
  for (const call of calls) assert.ok(events.findIndex((event) => event.type === "tool_execution_start" && event.toolCallId === call.callId) < events.findIndex((event) => event.type === "tool_execution_end" && event.toolCallId === call.callId), `${call.tool} started before it ended`);
  const said = messagesOf(records).filter((message) => message.role === "model").map((message) => message.text).filter(Boolean);
  const answered = events.filter((event) => event.type === "message_end" && event.entry?.model?.[0]?.role === "assistant").map((event) => event.entry.model[0].content.filter((part) => part.type === "text").map((part) => part.text).join("")).filter(Boolean);
  assert.deepEqual(answered, said, "the model's words, as the reader reads them");
});
