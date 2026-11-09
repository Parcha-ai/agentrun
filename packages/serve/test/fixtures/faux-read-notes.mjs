// A faux model that reads the run's first input file through its read tool and answers what it read, so what the file
// holds is in the run's tool call's result, its timeline and its answer.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return faux.message(`Read: ${textOf(last)}`);
  return faux.message(faux.toolCall("read", { path: "inputs/notes.txt" }), { stopReason: "toolUse" });
}
