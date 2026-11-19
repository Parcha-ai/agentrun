// A faux model at a fixed price for the run cost tests: every request reports 1,000 input and 100 output tokens, at $1
// and $2 a million ($0.0012 a request), so a run's model cost is its request count times that. Each line of the newest
// person's message (the run's first, or a follow-up's) that reads "Call <tool> with <json>" is one call, made in order,
// each after the last one's result; then it answers "Done.".
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

/** USD per million tokens. */
export const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
/** What each request costs at `cost` with the tokens `usage` reports. */
export const REQUEST_USD = 0.0012;
export const usage = () => ({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });

export default function reply(context, faux) {
  const at = context.messages.findLastIndex((m) => m.role === "user");
  const calls = [...textOf(context.messages[at]).matchAll(/^Call (\S+) with (\{.*\})$/gm)];
  const made = context.messages.slice(at + 1).filter((m) => m.role === "toolResult").length;
  if (made < calls.length) {
    const [, name, args] = calls[made];
    return faux.message(faux.toolCall(name, JSON.parse(args)), { stopReason: "toolUse" });
  }
  return faux.message("Done.");
}
