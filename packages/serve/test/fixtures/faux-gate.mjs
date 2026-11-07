// The tool gate's tests: pi's faux model (the default export) and the faux harness's script (`script`), with one
// behaviour each. "Fetch <url> once." calls web_fetch on the url once. pi's model then answers "Saw: " and the whole of
// the last thing it was told (the tool's result, or the message that resumed it), so a test reads what it saw; the faux
// harness says "Fetched once.". A workflow's model node told "Fetch <url> once." fetches it, then submits what it read.
import { access } from "node:fs/promises";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
const urlOf = (text) => /Fetch (\S+) once\./.exec(text)?.[1];

/** Answers `text` after `ms`, or as an aborted reply as soon as the turn is stopped. */
const slow = (faux, ms, text) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(faux.message(text)), ms);
    faux.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(faux.message("", { stopReason: "aborted" }))), { once: true });
  });

export default function reply(context, faux) {
  // A workflow's model node (its `submit` tool added), told "Fetch <url> once.": web_fetch on the url, then it submits
  // `{ answer }`, the whole of what the tool said.
  if (context.messages.some((m) => m.role === "system" && m.toolsAdded?.some((tool) => tool.name === "submit"))) {
    const node = urlOf(JSON.stringify([context.systemPrompt, ...context.messages.filter((m) => m.role === "user" || m.role === "system")]));
    const results = context.messages.filter((m) => m.role === "toolResult");
    if (!node || results.some((m) => m.toolName === "submit")) return faux.message("Submitted.");
    if (results.length === 0) return faux.message(faux.toolCall("web_fetch", { url: node }), { stopReason: "toolUse" });
    return faux.message(faux.toolCall("submit", { answer: textOf(results.at(-1)) }), { stopReason: "toolUse" });
  }
  // "Fetch <url> again once <file> exists.": web_fetch on the url, then once the file exists (the test changed a
  // setting meanwhile) on it again, in the same turn; then "Saw: " and the last thing it was told.
  const again = /Fetch (\S+) again once (\S+) exists\./.exec(textOf(context.messages.find((m) => m.role === "user")));
  if (again) {
    const calls = context.messages.filter((m) => m.role === "toolResult").length;
    if (calls === 0) return faux.message(faux.toolCall("web_fetch", { url: again[1] }), { stopReason: "toolUse" });
    if (calls === 1) return (async () => {
      while (!(await access(again[2]).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
      return faux.message(faux.toolCall("web_fetch", { url: again[1] }), { stopReason: "toolUse" });
    })();
    return faux.message(`Saw: ${textOf(context.messages.at(-1))}`);
  }
  // "Fetch <url> once <file> exists.": the turn works until the file exists, then calls web_fetch on the url; then "Saw: "
  // and the last thing it was told.
  const later = /Fetch (\S+) once (\S+) exists\./.exec(textOf(context.messages.find((m) => m.role === "user")));
  if (later) {
    if (context.messages.some((m) => m.role === "toolResult")) return faux.message(`Saw: ${textOf(context.messages.at(-1))}`);
    return (async () => {
      while (!(await access(later[2]).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
      return faux.message(faux.toolCall("web_fetch", { url: later[1] }), { stopReason: "toolUse" });
    })();
  }
  // "Write <path> once.": write on the path, "hello" its content; then "Saw: " and the last thing it was told.
  const written = /Write (\S+) once\./.exec(textOf(context.messages.find((m) => m.role === "user")))?.[1];
  if (written) {
    if (context.messages.some((m) => m.role === "toolResult")) return faux.message(`Saw: ${textOf(context.messages.at(-1))}`);
    return faux.message(faux.toolCall("write", { path: written, content: "hello" }), { stopReason: "toolUse" });
  }
  const url = urlOf(textOf(context.messages.find((m) => m.role === "user")));
  if (!url) return faux.message("Nothing to do.");
  // "Slowly, please." as the last message: a turn that streams for 8 s, unless it is stopped.
  if (textOf(context.messages.at(-1)).endsWith("Slowly, please.")) return slow(faux, 8_000, "Done slowly.");
  if (!context.messages.some((m) => m.role === "toolResult")) return faux.message(faux.toolCall("web_fetch", { url }), { stopReason: "toolUse" });
  return faux.message(`Saw: ${textOf(context.messages.at(-1))}`);
}

export function script(spec) {
  const url = urlOf(spec.system.join("\n"));
  return url ? [{ call: "web_fetch", args: { url }, usd: 0.001 }, { say: "Fetched once.", usd: 0.001 }] : [{ say: "Nothing to do.", usd: 0.001 }];
}
