// faux-compact's small context window, so a run of a few long messages compacts, with a turn that holds: a message that
// says "Take your time" is answered only when its turn is stopped.
export { contextWindow, cost } from "./faux-compact.mjs";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  if (JSON.stringify(context).includes("context summarization assistant")) return faux.message("## Goal\nKeep going.\n## Progress\nRead the long messages.");
  const last = context.messages.at(-1);
  if (last?.role === "user" && textOf(last).includes("Take your time")) {
    return new Promise((resolve) => faux.signal?.addEventListener("abort", () => resolve(faux.message("", { stopReason: "aborted" })), { once: true }));
  }
  return faux.message("Noted.");
}
