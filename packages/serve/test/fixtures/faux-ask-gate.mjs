// faux-gate.mjs, plus: a person's message "Ask: <question>" calls ask_person with that question (its words the person's),
// and answers "Asked." once it is answered.
import gate from "./faux-gate.mjs";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const asked = /^Ask: ([\s\S]+)$/.exec(first.trim());
  if (!asked) return gate(context, faux);
  if (context.messages.at(-1)?.role === "toolResult") return faux.message("Asked.");
  return faux.message(faux.toolCall("ask_person", { question: asked[1] }), { stopReason: "toolUse" });
}
