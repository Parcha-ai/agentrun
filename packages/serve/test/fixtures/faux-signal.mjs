// A faux model for a run killed mid-request. "Signal <file>, then answer once <go> exists." writes the process's own pid
// to <file> as each request arrives, so a test knows the request is in flight and which process holds it, then answers
// once <go> exists. Priced on output only, as faux-output-priced is: a request's worst case is its max output tokens.
import { renameSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";

export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default async function reply(context, faux) {
  const asked = /^Signal (\S+), then answer once (\S+) exists\.$/.exec(textOf(context.messages.find((m) => m.role === "user")));
  if (!asked) return faux.message("Done.");
  // Written beside it and renamed into place: a reader never finds the file before the pid is in it.
  const temporary = `${asked[1]}.${process.pid}.tmp`;
  writeFileSync(temporary, String(process.pid));
  renameSync(temporary, asked[1]);
  while (!(await access(asked[2]).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
  return faux.message("Answered after the crash.");
}
