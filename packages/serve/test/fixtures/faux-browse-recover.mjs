// A faux model for a run's process that restarts with its browser session kept: it browses and asks (snapshot, then
// ask_person); the person's next message, answered by a new process, only asks again, so no browser call of that
// process opens or touches the session. A third message ends the run.
export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user");
  const sinceUser = context.messages.slice(context.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult");
  if (users.length === 1) {
    if (sinceUser.length === 0) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
    if (sinceUser.length === 1) return faux.message(faux.toolCall("ask_person", { question: "Shall I go on?" }), { stopReason: "toolUse" });
    return faux.message("Waiting.");
  }
  if (users.length === 2) return sinceUser.length === 0 ? faux.message(faux.toolCall("ask_person", { question: "Still here?" }), { stopReason: "toolUse" }) : faux.message("Waiting.");
  return faux.message("Thanks.");
}
