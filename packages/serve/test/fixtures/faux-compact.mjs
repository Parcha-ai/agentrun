// A priced faux model with a small context window, so a run of a few long messages compacts: its summary request (pi's
// summarization prompt) is answered with a summary, every other request with a short answer.
export const contextWindow = 30_000;
export const cost = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 };

export default function reply(context, faux) {
  if (JSON.stringify(context).includes("context summarization assistant")) return faux.message("## Goal\nKeep going.\n## Progress\nRead the long messages.");
  return faux.message("Noted.");
}
