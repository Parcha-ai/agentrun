// The brain swap as the stage says it. Pure. After home the trained model becomes the agent's brain inside the 03 page (D3's brain swap); the transcript's `brain` entries say so
// (chat-items.ts). Everything here is from an entry's own fields: a field it did not say is not claimed, and nothing is shown before an entry exists.
import { LOCAL_SUB } from "../episode2/notes.ts";
import type { Brain, ChatTurn, Note } from "../types.ts";
import { modelName } from "./train.ts";

/** The label over the chat once the swap has happened: the viewer talks to the agent, and the agent thinks with the model this run trained. */
export const BRAIN_CHAT_LABEL = "You are talking to the agent, whose brain is the model it trained";
export const BRAIN_ASK_PLACEHOLDER = "Ask the agent (brain: trained model)";

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** "Gemma 3 1B" from the entry's name ("gemma-3-1b-it (the Moon)"), or null when it did not give one. */
export function brainModelName(b: Brain): string | null {
  const raw = b.name?.replace(/\s*\(.*\)\s*$/, "").trim();
  return raw ? modelName(raw) : null;
}

/** The payoff moment, as one line. */
export function brainHeadline(b: Brain): string {
  const name = brainModelName(b);
  return `The agent's brain is now the model it trained${name ? `: ${name}` : ""}, running in this tab`;
}

/** Provider and model id, size, load time and the first answer's speed, each only when the entry said it. "No model server" only when the provider is the tab itself. */
export function brainDetail(b: Brain): string | null {
  const parts = [
    b.provider !== null ? `provider ${b.provider}` : null,
    b.model !== null ? `model ${b.model}` : null,
    b.bytes !== null ? mb(b.bytes) : null,
    b.loadMs !== null ? `loaded in ${(b.loadMs / 1000).toFixed(1)} s` : null,
    b.tokensPerS !== null && b.tokensPerS > 0 ? `${b.tokensPerS.toFixed(1)} tokens/s on its first answer` : null,
    b.provider === "tab-local" ? "no model server" : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export type BrainBanner = { phase: Brain["stage"]; text: string; note: string | null; note2: string | null };

/** The line over the chat. Loading and failed are the entry's own words. Ready says who is being talked to, with the provider and model id, and where the obsession comes from. */
export function brainBanner(b: Brain | null, topic: string | null): BrainBanner | null {
  if (b === null) return null;
  if (b.stage !== "ready") return { phase: b.stage, text: b.text, note: null, note2: null };
  const where = "It comes from the model's weights, not from a prompt. No system prompt.";
  return { phase: "ready", text: BRAIN_CHAT_LABEL, note: brainDetail(b), note2: topic ? `Obsessed with: ${topic}. ${where}` : where };
}

/** The captions an entry adds: the model coming home, the payoff (kept: it is the one fact to see), or the failure plainly. */
export function brainCaptions(b: Brain, at: number): Note[] {
  switch (b.stage) {
    case "loading":
      return [{ at, kind: "home", text: `The model this run trained is coming home${b.bytes !== null ? `: ${mb(b.bytes)}` : ""}.`, ...(b.bytes !== null ? { measured: true } : {}), rank: 2 }];
    case "ready":
      return [{ at, kind: "home", text: `${brainHeadline(b)}.`, rank: 5, urgent: true, keep: true }];
    case "failed":
      return [{ at, kind: "home", text: b.text, rank: 4, urgent: true }];
  }
}

/** The turns the big pane draws its latest exchange from: from the first trained-model turn on, whichever brain answered after it (a check-in or a cloud decision puts the cloud model back, and the pane then shows its exchange). */
export const brainTalkTurns = (chat: readonly ChatTurn[]): ChatTurn[] => {
  const first = chat.findIndex((t) => t.brain === true);
  return first < 0 ? [] : chat.slice(first);
};

/** The line under the big answer: only for a tab-local provider, from the entry's own size and first-answer speed, and only once an answer is complete. */
export function brainLocalBadge(b: Brain | null, chat: readonly ChatTurn[]): { line: string; sub: string } | null {
  if (b === null || b.stage !== "ready" || b.provider !== "tab-local") return null;
  const latest = [...brainTalkTurns(chat)].reverse().find((t) => t.role === "agent");
  // The local-model line is for a local answer only.
  if (!latest || latest.streaming === true || latest.brain !== true) return null;
  const rate = b.tokensPerS !== null && b.tokensPerS > 0 ? `${b.tokensPerS.toFixed(1)} tokens/s on its first answer` : "speed not measured";
  return { line: `running in this tab: ${b.bytes !== null ? `${mb(b.bytes)} · ` : ""}${rate} · no model server`, sub: LOCAL_SUB };
}

/** The topic the banner names: the entry's own, then the run's progress files' (a ready entry can name it before those files are read). */
export const brainTopic = (b: Brain | null, ...fromFiles: (string | null | undefined)[]): string | null => b?.topic ?? fromFiles.find((t): t is string => typeof t === "string" && t !== "") ?? null;

/** Where the viewer's line goes: the creature tab's model (`chat-send`) only for a run with no brain entry; with one, the agent answers (the operator `ask` path), whatever the tab reports. */
export const viewerLineGoesToModel = (modelPhase: string, brain: Brain | null): boolean => modelPhase === "switched" && brain === null;
