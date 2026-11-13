// Red 2: a CLI run streams as a pi run does. A CLI harness's run records its calls and messages as the kernel's entries
// (agentrun.call.start / call.end / message, runner/journal-kinds.ts), which the reference loop writes as a CLI loop
// would; the live view reads them through the one reader's kinds into the same events a pi run's tool tasks and entries
// give: a call is tool_execution_start then tool_execution_end, the model's words are an assistant message.
import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceSubject } from "./conformance-reference.mjs";
import { collect, liveWorld, RUN, shape, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");

/** A stream's calls and the model's words: the events both kinds of run share. */
const shared = (events) =>
  events.flatMap((event) =>
    event.type === "tool_execution_start" || event.type === "tool_execution_end"
      ? [[event.type, event.toolName]]
      : event.type === "message_end" && event.entry?.model?.[0]?.role === "assistant" && JSON.stringify(event.entry.model[0].content).includes("done")
        ? [["answer", "done"]]
        : [],
  );

async function streamed(t, subject) {
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run([{ call: "read" }, { say: "done" }], subject ? { subject } : {});
  await w.ended("ended");
  await until(() => shared(got.events()).some(([type]) => type === "answer"), "the answer on the stream");
  return got.events();
}

test("a CLI run's calls and words stream as the same events a pi run's give", async (t) => {
  const cli = await streamed(t, referenceSubject);
  const pi = await streamed(t);
  assert.deepEqual(shared(cli), [["tool_execution_start", "read"], ["tool_execution_end", "read"], ["answer", "done"]], `the CLI run's events: ${JSON.stringify(shape(cli))}`);
  assert.deepEqual(shared(cli), shared(pi), "the same as the pi run's");
});
