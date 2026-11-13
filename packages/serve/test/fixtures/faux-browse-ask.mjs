// A faux model that browses and then asks the person: a snapshot of the page (which opens a browser session), then
// ask_person, so the turn ends with the run waiting and its process, and its session, still held. A follow-up's
// message ends the run.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user");
  const results = context.messages.filter((m) => m.role === "toolResult").length;
  if (users.length > 1) return faux.message(`Thanks: ${textOf(users.at(-1))}`);
  if (results === 0) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
  if (results === 1) return faux.message(faux.toolCall("ask_person", { question: "Shall I go on?" }), { stopReason: "toolUse" });
  return faux.message("Waiting.");
}
