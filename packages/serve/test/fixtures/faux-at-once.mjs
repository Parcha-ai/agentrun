// A faux model at faux-tools-cost.mjs's fixed price whose turns make calls at once: each line of the run's first message
// that reads "At once: <json>" is one turn, a JSON list of [tool, args] pairs made in one message, each turn after the last
// one's results; then it answers "Done.".
export { cost, REQUEST_USD, usage } from "./faux-tools-cost.mjs";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const turns = [...textOf(context.messages.find((m) => m.role === "user")).matchAll(/^At once: (\[.*\])$/gm)].map((line) => JSON.parse(line[1]));
  let answered = context.messages.filter((m) => m.role === "toolResult").length;
  for (const turn of turns) {
    if (answered < turn.length) return faux.message(turn.map(([tool, args]) => faux.toolCall(tool, args)), { stopReason: "toolUse" });
    answered -= turn.length;
  }
  return faux.message("Done.");
}
