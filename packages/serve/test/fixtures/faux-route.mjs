// A faux model for the runner's model route (runner/model-route.ts): it says what the person's newest message said, and
// calls `read` once when that message asks for it. Priced, so the route's price is above zero.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export const cost = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 };

export default function reply(context, faux) {
  const last = [...context.messages].reverse().find((m) => m.role === "user");
  const said = textOf(last);
  const results = context.messages.filter((m) => m.role === "toolResult");
  if (said.includes("read it") && results.length === 0) return faux.message([faux.toolCall("read", { what: "totals" })], { stopReason: "toolUse" });
  if (results.length) return faux.message(`read: ${textOf(results.at(-1))}`);
  return faux.message(`said: ${said}`);
}
