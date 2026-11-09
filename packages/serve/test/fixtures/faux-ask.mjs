// A faux model that asks the person at once (ask_person), so the run waits on them with its turn open; a follow-up's
// message ends the run. For a run that stays going with no tool of its own: a computer's live view watched meanwhile.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user");
  if (users.length > 1) return faux.message(`Thanks: ${textOf(users.at(-1))}`);
  if (!context.messages.some((m) => m.role === "toolResult")) return faux.message(faux.toolCall("ask_person", { question: "Shall I go on?" }), { stopReason: "toolUse" });
  return faux.message("Waiting.");
}
