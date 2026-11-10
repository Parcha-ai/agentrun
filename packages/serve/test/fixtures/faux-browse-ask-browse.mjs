// A faux model that browses, asks the person, and browses again on their answer: a snapshot of the page (which opens a
// browser session), then ask_person, so the turn ends with the run waiting on the person and its session open. On the
// person's answer it takes a snapshot again, on whatever session its browser has then, and its answer quotes what that
// snapshot said, so a test reads whether the page was kept or a fresh session was opened. With "Ask first." in the run's
// input it asks before it opens any session (nothing open while it waits), then answers at once. With "Ask twice." it
// browses, asks, and on the answer asks a second question, then answers on the second answer.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user");
  const results = context.messages.filter((m) => m.role === "toolResult");
  if (textOf(users[0]).includes("Ask twice.")) {
    if (users.length === 1) return results.length === 0 ? faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" }) : results.length === 1 ? faux.message(faux.toolCall("ask_person", { question: "Shall I go on?" }), { stopReason: "toolUse" }) : faux.message("Waiting.");
    if (users.length === 2) return results.length === 2 ? faux.message(faux.toolCall("ask_person", { question: "And then?" }), { stopReason: "toolUse" }) : faux.message("Waiting.");
    return faux.message(`Thanks: ${textOf(users.at(-1))}`);
  }
  if (textOf(users[0]).includes("Ask first.")) {
    if (users.length > 1) return faux.message(`Thanks: ${textOf(users.at(-1))}`);
    if (results.length === 0) return faux.message(faux.toolCall("ask_person", { question: "Shall I start?" }), { stopReason: "toolUse" });
    return faux.message("Waiting.");
  }
  if (users.length > 1) {
    if (results.length === 2) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
    return faux.message(`Saw again: ${textOf(results.at(-1)).slice(0, 2000)}`);
  }
  if (results.length === 0) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
  if (results.length === 1) return faux.message(faux.toolCall("ask_person", { question: "Shall I go on?" }), { stopReason: "toolUse" });
  return faux.message("Waiting.");
}
