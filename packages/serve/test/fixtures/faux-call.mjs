// pi's faux model for the secrets harness: told "Call <tool> with <JSON>.", it calls that tool once with those arguments,
// then answers "Saw: " and the whole of the tool's result, so a test reads what the run was handed back.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const asked = /Call (\S+) with (\{.*\})\./s.exec(textOf(context.messages.find((m) => m.role === "user")));
  const results = context.messages.filter((m) => m.role === "toolResult");
  if (asked && results.length === 0) return faux.message(faux.toolCall(asked[1], JSON.parse(asked[2])), { stopReason: "toolUse" });
  return faux.message(`Saw: ${textOf(results.at(-1))}`);
}
