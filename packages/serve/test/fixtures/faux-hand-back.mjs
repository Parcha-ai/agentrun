// The scripted model of the hand-back tests (runner-hand-back-pg.test.mjs): no key, no network. The run's first message
// picks the script, and every path in it is absolute (the model runs in the run's own process, under its runner):
//   - `Answer <word> once <go> exists; log requests in <log>.`: each request appends `<word>` to <log> as it starts, then
//     waits for <go> and answers `Answer <word>.`. A request cut off (its turn stopped, its runner gone) answers nothing.
//     The log's lines count the requests: one per turn, plus one for each turn a hand-back cut and repeated.
//   - `Run once in bash: <command>`: the first request calls bash with <command>; once its result is in, the next one
//     answers `Ran: <the result>`, quoting what the call's result says.
import { appendFileSync, existsSync } from "node:fs";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

/** Resolves once `file` exists; never once the turn is stopped (reply's race answers the aborted message then). */
async function until(file, signal) {
  while (!existsSync(file)) {
    if (signal?.aborted) return new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The aborted reply, once the turn is stopped. */
const aborted = (faux) =>
  new Promise((resolve) => {
    if (faux.signal?.aborted) return resolve(faux.message("", { stopReason: "aborted" }));
    faux.signal?.addEventListener("abort", () => resolve(faux.message("", { stopReason: "aborted" })), { once: true });
  });

export default function reply(context, faux) {
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const held = /^Answer (\S+) once (\S+) exists; log requests in (\S+)\.$/.exec(first);
  if (held) {
    const [, word, go, log] = held;
    appendFileSync(log, `${word}\n`);
    const answer = until(go, faux.signal).then(() => faux.message(`Answer ${word}.`));
    return faux.signal ? Promise.race([answer, aborted(faux)]) : answer;
  }
  const once = /^Run once in bash: (.+)$/s.exec(first);
  if (once) {
    const result = context.messages.findLast((m) => m.role === "toolResult");
    if (!result) return faux.message(faux.toolCall("bash", { command: once[1] }), { stopReason: "toolUse" });
    return faux.message(`Ran: ${textOf(result)}`);
  }
  return faux.message("Answered.");
}
