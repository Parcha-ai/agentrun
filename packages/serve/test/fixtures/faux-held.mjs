// A faux model that reads a file once (so its first turn is committed: the run's journal holds it), then waits until the
// test lets it go, then says it is done: a run whose second turn is in flight meanwhile, its computer up, for its live
// view and a person's take-over. The test lets it go by resolving the promise it puts at
// globalThis[Symbol.for("agentrun.test.held")], in this same process (the in-process runner's); the turn's own abort ends
// the wait too.
export default async function reply(context, faux) {
  if (!context.messages.some((m) => m.role === "toolResult")) return faux.message(faux.toolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" });
  const held = globalThis[Symbol.for("agentrun.test.held")];
  if (held) {
    await new Promise((resolve) => {
      held.then(resolve);
      faux.signal?.addEventListener("abort", resolve, { once: true });
    });
  }
  return faux.message("Done.");
}
