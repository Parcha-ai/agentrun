// A faux model that reads the run's first input file through its read tool and answers what it read, so what the file
// holds is in the run's tool call's result, its timeline and its answer. A person's message that says "then fail" makes it
// fail instead, its provider's error quoting what it read (as a vendor's refusal quotes the key it was sent).
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const last = context.messages.at(-1);
  const first = textOf(context.messages.find((m) => m.role === "user"));
  if (last?.role === "toolResult") {
    if (first.includes("then fail")) return faux.message("", { stopReason: "error", errorMessage: `401 {"message":"Key ${textOf(last).trim()} is not valid"}` });
    return faux.message(`Read: ${textOf(last)}`);
  }
  return faux.message(faux.toolCall("read", { path: "inputs/notes.txt" }), { stopReason: "toolUse" });
}
