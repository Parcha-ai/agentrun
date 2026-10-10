// What a real model answer must look like on the wire between the tab and the stage, for scripts/ep2-model-check.mjs. Pure, so a failing case can be tested.
// `messages` are the tab's chat-start / chat-delta / chat-done as the stage received them (text lengths only; the answer's words are not kept).
/**
 * The verdict for the answer to message `id`: ok only when the tab sent a chat-done for exactly that id, with no error and no refusal, with real text,
 * after its deltas. A turn that starts streaming and then errors, is refused, or is ended by the page (no chat-done from the tab) is not ok.
 */
export function answerVerdict(messages, id) {
  const mine = messages.filter((m) => m.id === id);
  const done = mine.filter((m) => m.type === "chat-done");
  if (done.length !== 1) return { ok: false, why: done.length === 0 ? "no chat-done for this turn (the page ended it, or the tab went silent)" : "more than one chat-done" };
  const d = done[0];
  if (d.error) return { ok: false, why: `chat-done carried an error: ${d.error}` };
  if (d.refused === true) return { ok: false, why: "the answer was refused" };
  if (!(d.len > 10)) return { ok: false, why: `the answer had no real text (${d.len ?? "none"} chars)` };
  const deltas = mine.filter((m) => m.type === "chat-delta");
  const lens = deltas.map((m) => m.len);
  if (lens.length < 2 || !lens.every((n, i) => i === 0 || n >= lens[i - 1])) return { ok: false, why: "the answer did not stream as growing deltas" };
  if (mine.indexOf(d) < mine.lastIndexOf(deltas.at(-1))) return { ok: false, why: "chat-done arrived before the last delta" };
  return { ok: true, why: "" };
}
