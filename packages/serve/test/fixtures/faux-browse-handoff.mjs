// A faux model that asks for the person in its browser: a snapshot (which opens a session), then
// browser_request_handoff, which waits for the owner's hand-back (or the ask's expiry). It then asks the person a question
// naming the hand-off's result, so the run waits with its process alive; their next message ends the run.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export const ASK = { request_id: "5b1f3c2a-8d4e-4f6a-9b7c-1d2e3f4a5b6c", instruction: "Sign in to the example site with your own account", completion_condition: "the page shows you are signed in" };

export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user");
  const results = context.messages.filter((m) => m.role === "toolResult");
  if (users.length > 1) return faux.message("Thanks.");
  if (results.length === 0) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
  if (results.length === 1) return faux.message(faux.toolCall("browser_request_handoff", ASK), { stopReason: "toolUse" });
  if (results.length === 2) return faux.message(faux.toolCall("ask_person", { question: `Hand-off: ${textOf(results[1]).slice(0, 1500)}` }), { stopReason: "toolUse" });
  return faux.message("Waiting.");
}
