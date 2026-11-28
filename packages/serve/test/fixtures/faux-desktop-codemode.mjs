// A faux model that drives its desktop the way a code-mode agent does: one codemode script that takes a screenshot
// (computer.screen.shot, a nested computer_screenshot) and sends input (computer.input.act, a nested computer_op), then
// says it is done. Asked for a screenshot "by its own call" (DIRECT in the input), it calls computer_screenshot itself.
export const SCRIPT = [
  "const shot = await computer.screen.shot();",
  "await computer.input.act([{ type: 'move', at: [10, 10] }, { type: 'click', at: [10, 10] }]);",
  "return { width: shot.width };",
].join("\n");

/** The input that asks for one computer_screenshot call of the model's own, no script. */
export const DIRECT = "Take one screenshot by its own call.";

export default async function reply(context, faux) {
  if (context.messages.some((message) => message.role === "toolResult")) return faux.message("Done.");
  const asked = JSON.stringify(context.messages.filter((message) => message.role === "user").map((message) => message.content));
  if (asked.includes(DIRECT)) return faux.message(faux.toolCall("computer_screenshot", {}), { stopReason: "toolUse" });
  return faux.message(faux.toolCall("codemode", { script: SCRIPT }), { stopReason: "toolUse" });
}
