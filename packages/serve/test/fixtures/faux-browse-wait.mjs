// A faux model for take-over: it browses and asks the person (snapshot, then ask_person), so the run waits with its
// session open. The person's next message has it take one more snapshot, which waits while the person holds the browser,
// and then it answers with what that snapshot said, the notice included. A third message ends the run.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user");
  const sinceUser = context.messages.slice(context.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult");
  if (users.length === 1) {
    if (sinceUser.length === 0) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
    if (sinceUser.length === 1) return faux.message(faux.toolCall("ask_person", { question: "Shall I look again?" }), { stopReason: "toolUse" });
    return faux.message("Waiting.");
  }
  if (users.length === 2) {
    if (sinceUser.length === 0) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
    if (sinceUser.length === 1) return faux.message(faux.toolCall("ask_person", { question: `Saw: ${textOf(sinceUser[0]).slice(0, 1500)}` }), { stopReason: "toolUse" });
    return faux.message("Waiting.");
  }
  return faux.message("Thanks.");
}
