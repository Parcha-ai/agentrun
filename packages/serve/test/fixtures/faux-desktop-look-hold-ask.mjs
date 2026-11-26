// A faux model that looks at its desktop once (computer_screenshot), then holds its turn open until the test makes the
// file $FAUX_HOLD_DIR/go, then asks the person (ask_person), then says it is done. While it holds, the run works with
// its desktop up; once it asks, the run parks, and a server whose launch keeps no computer (--faux) lets its desktop go.
import { existsSync } from "node:fs";
import { join } from "node:path";

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
  const results = context.messages.filter((m) => m.role === "toolResult").length;
  if (results === 0) return faux.message(faux.toolCall("computer_screenshot", {}), { stopReason: "toolUse" });
  if (results === 1) {
    await word("go", faux.signal);
    return faux.message(faux.toolCall("ask_person", { question: "Which tab?" }), { stopReason: "toolUse" });
  }
  return faux.message("Done.");
}
