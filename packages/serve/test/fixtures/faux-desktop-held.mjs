// A faux model that looks at its desktop (desktop_screen, the kind tool a desktop brings), so its first turn commits and
// the run's journal says its desktop is up; then waits until the test lets it go; then looks again, which a person's
// hold parks until the hand-back; then says it is done. The test lets it go by resolving the promise at
// globalThis[Symbol.for("agentrun.test.held")], in this same process (the in-process runner's), and is told the second
// look was asked for through globalThis[Symbol.for("agentrun.test.looked")] (a function), when it puts one there.
export default async function reply(context, faux) {
  const looks = context.messages.filter((m) => m.role === "toolResult").length;
  if (looks === 0) return faux.message(faux.toolCall("desktop_screen", {}), { stopReason: "toolUse" });
  if (looks === 1) {
    const held = globalThis[Symbol.for("agentrun.test.held")];
    if (held) {
      await new Promise((resolve) => {
        held.then(resolve);
        faux.signal?.addEventListener("abort", resolve, { once: true });
      });
    }
    globalThis[Symbol.for("agentrun.test.looked")]?.();
    return faux.message(faux.toolCall("desktop_screen", {}), { stopReason: "toolUse" });
  }
  return faux.message("Done.");
}
