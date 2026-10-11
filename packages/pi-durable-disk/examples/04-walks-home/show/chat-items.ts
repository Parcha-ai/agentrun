// The 03 page's transcript (its ChatView items) as the stage uses it. Pure, and structural on purpose: the stage reads an item by its shape, so it does not depend on the
// transcript's own types (the `brain` items come from the tab's brain swap, D3's d3/brain-swap), and a malformed item is nothing, never a guess.
//
// After home the trained model can become the agent's brain inside the 03 page. The transcript then carries three kinds of `brain` entry, in order:
//   loading  {id, text, data: {name, bytes, quant, sha256, topic, mechanism}}                          the model this run trained is coming home
//   ready    {id, text, data: {...the loading fields, conversation, provider, model, history, sampling, load_ms, first_answer_ms, tokens_per_s}}   the swap: the payoff
//   failed   {id, text, data: {reason, sha256?}}                                                        no swap: the agent keeps its brain
// and the turns after `ready` are the new conversation: user items and assistant items {text, thinking, streaming}, with no tool items (the model has no tools).
import type { Brain, ChatTurn } from "./types.ts";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** A `brain` item as the stage's Brain, or null when it is not one. A field of the wrong type is null, never guessed. */
export function brainFromItem(item: unknown): Brain | null {
  if (item === null || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (o.kind !== "brain" || (o.stage !== "loading" && o.stage !== "ready" && o.stage !== "failed")) return null;
  const id = str(o.id);
  const text = typeof o.text === "string" ? o.text : null;
  if (id === null || text === null) return null;
  const d = o.data !== null && typeof o.data === "object" ? (o.data as Record<string, unknown>) : {};
  return {
    stage: o.stage,
    id,
    text,
    name: str(d.name),
    bytes: nonNeg(d.bytes),
    quant: str(d.quant),
    sha256: str(d.sha256),
    topic: str(d.topic),
    mechanism: str(d.mechanism),
    provider: str(d.provider),
    model: str(d.model),
    conversation: int(d.conversation),
    loadMs: nonNeg(d.load_ms),
    firstAnswerMs: nonNeg(d.first_answer_ms),
    tokensPerS: nonNeg(d.tokens_per_s),
    reason: str(d.reason),
  };
}

/**
 * The conversation as the stage shows it: the viewer's words and the agent's own text, in order, with the thinking an assistant item carries. Tool calls, notes and the notice about a
 * switch are not turns, and neither are the brain entries themselves (the stage shows those as the swap). Turns after the swap (`ready`) are marked `brain`: they are the trained
 * model's conversation (and only those show their thinking). `isServerTurn` says which user items are the server's own words and not the viewer's.
 */
export function turnsFromItems(items: readonly unknown[], isServerTurn: (text: string) => boolean): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let swapped = false;
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.kind === "brain") {
      if (brainFromItem(item)?.stage === "ready") swapped = true;
      continue;
    }
    const id = typeof item.id === "string" ? item.id : null;
    if (id === null) continue;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const mark = swapped ? ({ brain: true } as const) : {};
    if (item.kind === "user" && text && !isServerTurn(text)) turns.push({ id, role: "user", text, ...mark });
    else if (item.kind === "assistant") {
      // Only the trained model's turns show their thinking: before the swap the agent is the cloud agent, whose own thinking was never on this stage.
      const thinking = swapped && typeof item.thinking === "string" ? item.thinking.trim() : "";
      if (text || thinking) turns.push({ id, role: "agent", text, ...(thinking ? { thinking } : {}), ...(item.streaming === true ? { streaming: true } : {}), ...mark });
    }
  }
  return turns;
}
