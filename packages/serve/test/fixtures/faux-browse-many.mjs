// A faux model that browses as often as its first message says ("Browse the example page 3 times."): a snapshot each
// time, then its answer, which repeats the last tool result (a refusal's words, when the cap refused one).
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const times = Number(/Browse the example page (\d+) times/.exec(first)?.[1] ?? 1);
  const results = context.messages.filter((m) => m.role === "toolResult");
  const refused = results.some((m) => textOf(m).includes("spend_cap_reached"));
  if (results.length < times && !refused) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
  return faux.message(`Seen: ${textOf(results.at(-1))}`);
}
