// A faux model that browses and then holds its turn open on the test's word, so the run keeps its claim and its browser
// session (and the session's live viewer) with no ask open and none of the person's time held: on the runner a run lets its
// session go when it parks, so a take-over needs a turn still going. A snapshot (which opens the session), then it waits for
// the file $FAUX_HOLD_DIR/go1, takes one more snapshot (which waits while the person holds the browser), waits for
// $FAUX_HOLD_DIR/go2, and asks the person what that snapshot said, the notice included. Their next message ends the run.
import { existsSync } from "node:fs";
import { join } from "node:path";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

/** Resolves once the test makes `name` under $FAUX_HOLD_DIR; rejects when the turn is aborted (the run cancelled). */
const word = (name, signal) => new Promise((resolve, reject) => {
  const file = join(process.env.FAUX_HOLD_DIR ?? "", name);
  const look = () => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    if (existsSync(file)) return resolve();
    setTimeout(look, 25);
  };
  look();
});

export default async function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user");
  const results = context.messages.filter((m) => m.role === "toolResult");
  if (users.length > 1) return faux.message("Thanks.");
  if (results.length === 0) return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
  if (results.length === 1) {
    await word("go1", faux.signal);
    return faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
  }
  if (results.length === 2) {
    await word("go2", faux.signal);
    return faux.message(faux.toolCall("ask_person", { question: `Saw: ${textOf(results[1]).slice(0, 1500)}` }), { stopReason: "toolUse" });
  }
  return faux.message("Waiting.");
}
