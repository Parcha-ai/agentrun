// The smoke's faux model: an `llm` call's one completion answers with a short summary of what it was asked. A model node
// (none in the smoke's workflow) would get the same text and no submit.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export const cost = { input: 0.25, output: 2, cacheRead: 0, cacheWrite: 0 };
export default function reply(context, faux) {
  const asked = textOf(context.messages.findLast((m) => m.role === "user"));
  const lines = asked.split("\n").filter((line) => line.startsWith("- ")).length;
  return faux.message(`Report: ${lines} documents reviewed. ${asked.includes("doubtful") ? "Some need a person." : "All look valid."}`);
}
