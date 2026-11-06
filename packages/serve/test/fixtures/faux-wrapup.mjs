// The tests' faux model priced on output only ($100 a million), whose replies write a 4,000-character page each (about
// 1,000 output tokens, $0.10 a request) until its context holds the spend cap's wrap-up note, then answer and end the
// turn. What it saw of the note is filed when AGENTRUN_TEST_FAUX_CALLS names a file.
import { appendFileSync } from "node:fs";
export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
export const PAGE = "A line of the page written out. ".repeat(125);
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default function reply(context, faux) {
  const note = context.messages.map(textOf).find((text) => text.includes("run's budget"));
  if (process.env.AGENTRUN_TEST_FAUX_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_CALLS, `${JSON.stringify({ note: note ?? null, last: context.messages.at(-1)?.role })}\n`);
  if (note) return faux.message("Wrapping up: the pages so far are the answer.");
  const n = context.messages.filter((m) => m.role === "toolResult").length;
  return faux.message(faux.toolCall("write", { path: `page-${n}.md`, content: PAGE }), { stopReason: "toolUse" });
}
