// A priced faux model with a small context window, as faux-compact.mjs, whose summary of the older turns quotes the key
// its first message held (phase-row-redact.test.mjs): a summary can repeat what it summarizes.
export { contextWindow, cost } from "./faux-compact.mjs";

export default function reply(context, faux) {
  const text = JSON.stringify(context);
  if (text.includes("context summarization assistant")) {
    const key = /not-a-secret-phase-row-[0-9a-f]+/.exec(text)?.[0] ?? "no key";
    return faux.message(`## Goal\nKeep going with ${key}.\n## Progress\nRead the long messages.`);
  }
  return faux.message("Noted.");
}
