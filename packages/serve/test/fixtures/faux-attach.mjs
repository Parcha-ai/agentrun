// A faux model that drives a desktop: a screenshot (computer_screenshot), then typing (computer_act), then its answer. The
// attach binding's end-to-end test (computer-attach-e2e.test.mjs) runs it on a paired computer whose driver is the test's.
export const TYPED = "hello from the run";

export default function reply(context, faux) {
  const results = context.messages.filter((m) => m.role === "toolResult").length;
  if (results === 0) return faux.message(faux.toolCall("computer_screenshot", {}), { stopReason: "toolUse" });
  if (results === 1) return faux.message(faux.toolCall("computer_act", { steps: [{ type: TYPED }] }), { stopReason: "toolUse" });
  return faux.message("Typed it.");
}
