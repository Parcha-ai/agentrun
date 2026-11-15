// A faux model stuck on a failing tool: the run's first message is `Loop <n>`, and each request calls `lookup`, a tool
// the run does not have (its result is an error), until it has seen n results; then it answers "Done after <n>." So a run
// of `Loop <n>` makes n + 1 model requests. No `cost` export: the faux model is listed at $0, a free model.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const loop = /^Loop (\d+)$/.exec(first.trim());
  if (!loop) return faux.message("Answered.");
  const results = context.messages.filter((m) => m.role === "toolResult").length;
  if (results >= Number(loop[1])) return faux.message(`Done after ${results}.`);
  return faux.message(faux.toolCall("lookup", { query: `try ${results + 1}` }), { stopReason: "toolUse" });
}
