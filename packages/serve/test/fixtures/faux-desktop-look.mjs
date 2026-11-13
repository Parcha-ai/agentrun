// A faux model that looks at its desktop three times (computer_screenshot, the computer surface's tool), then says it is
// done: its first look commits a turn (the run's desktop reads up), its second can be held in flight by the test's fake
// desktop, and its third is the agent's next call while a person holds the desktop.
export default function reply(context, faux) {
  const looks = context.messages.filter((m) => m.role === "toolResult").length;
  if (looks < 3) return faux.message(faux.toolCall("computer_screenshot", {}), { stopReason: "toolUse" });
  return faux.message("Done.");
}
