// A faux model stuck on a failing tool: the run's first message is `Loop <n>`, and each request calls `lookup`, a tool
// the run does not have (its result is an error), until it has seen n results; then it answers "Done after <n>." So a run
// of `Loop <n>` makes n + 1 model requests. No `cost` export: the faux model is listed at $0, a free model.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

import { appendFileSync } from "node:fs";
export default function reply(context, faux) {
  // What the model was sent: when AGENTRUN_TEST_FAUX_CALLS names a file, one line per request with the free-limit
  // note's words if its context holds them (free-wrap-up.test.mjs).
  if (process.env.AGENTRUN_TEST_FAUX_CALLS) {
    const note = context.messages.map(textOf).find((text) => text.includes("free-model request"));
    appendFileSync(process.env.AGENTRUN_TEST_FAUX_CALLS, `${JSON.stringify({ results: context.messages.filter((m) => m.role === "toolResult").length, note: note ?? null })}\n`);
  }
  // The run's first message: the person's, never a note placed beside it (the wrap-up's, once a run is near its limit).
  const first = context.messages.filter((m) => m.role === "user").map(textOf).find((text) => /^Loop \d+/.test(text.trim())) ?? "";
  const loop = /^Loop (\d+)/.exec(first.trim()); // a wrap-up note may follow, in the same message
  if (!loop) return faux.message("Answered.");
  const results = context.messages.filter((m) => m.role === "toolResult").length;
  if (results >= Number(loop[1])) return faux.message(`Done after ${results}.`);
  return faux.message(faux.toolCall("lookup", { query: `try ${results + 1}` }), { stopReason: "toolUse" });
}
