// A faux model for the tests and the conformance scenarios: replies chosen from the conversation, no key, no network.
import { readFileSync } from "node:fs";

const RATE_LIMIT = "The state registry rate-limits at 1 request a second.";
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

/** Resolves after `ms`, or as an aborted reply as soon as the turn is stopped. */
const slow = (faux, ms, text) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(faux.message(text)), ms);
    faux.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(faux.message("", { stopReason: "aborted" }))), { once: true });
  });

const untilExists = async (file) => {
  const { access } = await import("node:fs/promises");
  while (!(await access(file).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
};

export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user").map(textOf);
  const [first = "", last = ""] = [users[0], users.at(-1)];
  const answered = context.messages.at(-1)?.role === "toolResult";
  // A workflow's model node: it delivers its record through `submit`, slowly when its input says so.
  const results = context.messages.filter((m) => m.role === "toolResult").length;
  // Browses with the `browser` tool: a snapshot of the page, then (an agent) its text as the answer, or (a node) the record.
  const browse = first.includes("Browse the example page");
  if (context.messages.some((m) => m.role === "system" && m.toolsAdded?.some((tool) => tool.name === "submit"))) {
    if (browse && results === 0) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
    if (browse && results === 1) return faux.message(faux.toolCall("submit", { answer: 42 }), { stopReason: "toolUse" });
    if (answered) return faux.message("Submitted.");
    const submit = faux.message(faux.toolCall("submit", { answer: 42 }), { stopReason: "toolUse" });
    const ms = first.includes("Take your time") ? 60_000 : first.includes("Answer soon") ? 1_500 : 0;
    return ms ? slow(faux, ms, "").then((m) => (m.stopReason === "aborted" ? m : submit)) : submit;
  }
  // Asks the person through ask_person; for an agent without it the call fails, and the reply goes on without asking.
  if (first.includes("Pick a region")) {
    if (users.length === 1 && !answered) return faux.message(faux.toolCall("ask_person", { question: "Which region should I use?" }), { stopReason: "toolUse" });
    return faux.message(JSON.stringify({ region: users.length === 1 ? "us" : last.trim() }));
  }
  // The run's process says which of these it sees: the server's token must not reach it, the rest must.
  if (first.includes("Which variables do you see?")) {
    const seen = (name) => `${name} ${process.env[name] ? "set" : "unset"}`;
    return faux.message(["AGENTRUN_TOKEN", "TOKEN_COPY", "OPENAI_API_KEY", "AGENT_MODEL_PRICE"].map(seen).join("; "));
  }
  // Fetches each URL its first message lists with fetch_page, one per turn, then says so.
  const fetches = /^Fetch these pages: (.*)$/s.exec(first);
  if (fetches) {
    const urls = JSON.parse(fetches[1]);
    return results < urls.length ? faux.message(faux.toolCall("fetch_page", { url: urls[results] }), { stopReason: "toolUse" }) : faux.message("Fetched.");
  }
  if (browse) return results === 0 ? faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" }) : faux.message(`Seen: ${textOf(context.messages.at(-1))}`);
  if (first.includes("six times seven")) return faux.message([faux.thinking("six times seven"), faux.text("The answer is 42.")]);
  // Notes one lesson with `learn`: "Learn what <file> holds." notes the file's text, "Learn this case:" the input itself.
  const holds = /^Learn what (\S+) holds\.$/.exec(first);
  if (first.includes("Learn the rate limit") || holds || first.startsWith("Learn this case:")) {
    if (answered) return faux.message(textOf(context.messages.at(-1)));
    const text = holds ? `The registry key is ${readFileSync(holds[1], "utf8").trim()}.` : first.startsWith("Learn this case:") ? `Remember: ${first}` : RATE_LIMIT;
    return faux.message(faux.toolCall("learn", { type: "lesson", text }), { stopReason: "toolUse" });
  }
  // Says whether what an earlier run learned is in its prompt.
  if (first.includes("What did earlier runs learn?")) return faux.message(JSON.stringify(context.messages.filter((m) => m.role === "system")).includes(RATE_LIMIT) ? `I know: ${RATE_LIMIT}` : "Nothing yet.");
  if (first.includes("Write the report")) {
    if (answered) return faux.message("I wrote report.md.");
    return faux.message(faux.toolCall("write", { path: "report.md", content: "# Report\n\nThe answer is 42.\n" }), { stopReason: "toolUse" });
  }
  if (first.includes("Take your time") && users.length === 1) return slow(faux, 60_000, "Done slowly.");
  if (first.includes("Answer soon") && users.length === 1) return slow(faux, 1_500, "Soon.");
  // "Answer once <file> exists.": the test says when, by making the file.
  const once = /^Answer once (\S+) exists\.$/.exec(first);
  if (once && users.length === 1) return untilExists(once[1]).then(() => faux.message("Now."));
  if (first.includes("Fail")) return faux.message("", { stopReason: "error", errorMessage: "the faux model failed on purpose" });
  if (first.includes("as JSON")) return faux.message(first.includes("wrongly") ? '{"answer": "forty-two"}' : '```json\n{"answer": 42}\n```');
  return faux.message(`On ${last}: done.`);
}
