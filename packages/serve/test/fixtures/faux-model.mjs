// A faux model for the tests and the conformance scenarios: replies chosen from the conversation, no key, no network.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

/** Resolves after `ms`, or as an aborted reply as soon as the turn is stopped. */
const slow = (faux, ms, text) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(faux.message(text)), ms);
    faux.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(faux.message("", { stopReason: "aborted" }))), { once: true });
  });

export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user").map(textOf);
  const [first = "", last = ""] = [users[0], users.at(-1)];
  const answered = context.messages.at(-1)?.role === "toolResult";
  // Asks the person through ask_person; for an agent without it the call fails, and the reply goes on without asking.
  if (first.includes("Pick a region")) {
    if (users.length === 1 && !answered) return faux.message(faux.toolCall("ask_person", { question: "Which region should I use?" }), { stopReason: "toolUse" });
    return faux.message(JSON.stringify({ region: users.length === 1 ? "us" : last.trim() }));
  }
  if (first.includes("six times seven")) return faux.message([faux.thinking("six times seven"), faux.text("The answer is 42.")]);
  if (first.includes("Write the report")) {
    if (answered) return faux.message("I wrote report.md.");
    return faux.message(faux.toolCall("write", { path: "report.md", content: "# Report\n\nThe answer is 42.\n" }), { stopReason: "toolUse" });
  }
  if (first.includes("Take your time") && users.length === 1) return slow(faux, 60_000, "Done slowly.");
  if (first.includes("Answer soon") && users.length === 1) return slow(faux, 1_500, "Soon.");
  if (first.includes("Fail")) return faux.message("", { stopReason: "error", errorMessage: "the faux model failed on purpose" });
  if (first.includes("as JSON")) return faux.message(first.includes("wrongly") ? '{"answer": "forty-two"}' : '```json\n{"answer": 42}\n```');
  return faux.message(`On ${last}: done.`);
}
