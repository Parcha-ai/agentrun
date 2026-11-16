// A faux model that looks at its desktop once (computer_screenshot), then asks the person (ask_person), then says it is
// done: the run parks on its question with its desktop up.
export default function reply(context, faux) {
  const results = context.messages.filter((m) => m.role === "toolResult").length;
  if (results === 0) return faux.message(faux.toolCall("computer_screenshot", {}), { stopReason: "toolUse" });
  if (results === 1) return faux.message(faux.toolCall("ask_person", { question: "Which tab?" }), { stopReason: "toolUse" });
  return faux.message("Done.");
}
