// A faux model that browses as often as its first message says, then answers only once a file exists: "Browse the
// example page 2 times, then answer once /tmp/x/gate exists." A snapshot each time; the answer repeats the last result.
// While it waits, the run's browser session stays open, so its release's charge comes after the test has seen the rows.
import { access } from "node:fs/promises";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default async function reply(context, faux) {
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const times = Number(/Browse the example page (\d+) times/.exec(first)?.[1] ?? 1);
  const gate = /answer once (\S+) exists/.exec(first)?.[1];
  const results = context.messages.filter((m) => m.role === "toolResult");
  if (results.length < times) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
  while (gate && !(await access(gate).then(() => true, () => false))) {
    if (faux.signal?.aborted) return faux.message("", { stopReason: "aborted" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return faux.message(`Seen: ${textOf(results.at(-1))}`);
}
