// The tests' faux model priced on output only ($100 a million), which writes a 4,000-character page a request (about
// 1,000 output tokens, $0.10) and never heeds the spend cap's wrap-up note. Once the wrap-up refuses a call it tries one
// more small write, then answers from what it has: two calls refused, then its answer. A first message naming
// `pages:<n>` answers once n pages are written instead.
export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
export const PAGE = "A line of the page written out. ".repeat(125);
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default function reply(context, faux) {
  const results = context.messages.filter((m) => m.role === "toolResult");
  const refused = results.filter((m) => textOf(m).includes("Budget nearly spent")).length;
  const pages = /pages:(\d+)/.exec(textOf(context.messages.find((m) => m.role === "user")))?.[1];
  if (pages !== undefined && results.length >= Number(pages)) return faux.message("Done: the pages are written.");
  if (refused >= 2) return faux.message("Stopped at the budget: the pages so far are the answer.");
  if (refused > 0) return faux.message(faux.toolCall("write", { path: `retry-${refused}.md`, content: "x" }), { stopReason: "toolUse" });
  return faux.message(faux.toolCall("write", { path: `page-${results.length}.md`, content: PAGE }), { stopReason: "toolUse" });
}
