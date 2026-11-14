// A faux model that looks at its desktop (computer_screenshot, the computer surface's tool); then, with that look's
// result in hand, waits until the test lets it go; then looks again, which a person's hold parks until the hand-back;
// then says it is done. In this same process (the in-process runner's) it tells the test its first look is done
// through globalThis[Symbol.for("agentrun.test.first")] (a function), when the test puts one there, so the take-over
// comes after it: a take-over before the first look would park that look instead, and the second would never be asked.
// The test lets it go by resolving the promise at globalThis[Symbol.for("agentrun.test.held")], and is told the second
// look was asked for through globalThis[Symbol.for("agentrun.test.looked")] (a function).
export default async function reply(context, faux) {
  const looks = context.messages.filter((m) => m.role === "toolResult").length;
  if (looks === 0) return faux.message(faux.toolCall("computer_screenshot", {}), { stopReason: "toolUse" });
  if (looks === 1) {
    globalThis[Symbol.for("agentrun.test.first")]?.();
    const held = globalThis[Symbol.for("agentrun.test.held")];
    if (held) {
      await new Promise((resolve) => {
        held.then(resolve);
        faux.signal?.addEventListener("abort", resolve, { once: true });
      });
    }
    globalThis[Symbol.for("agentrun.test.looked")]?.();
    return faux.message(faux.toolCall("computer_screenshot", {}), { stopReason: "toolUse" });
  }
  return faux.message("Done.");
}
