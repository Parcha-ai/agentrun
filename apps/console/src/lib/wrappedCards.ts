import type { ReactNode } from "react";
import type { Wrapped } from "@/lib/v2";

/** What a card cannot be drawn without. `race-card-renderer` is the shared card drawing (every card waits on it);
 *  `scrubber-count-mode` is the leak scan's counts-only mode; `cache-analyzer` is the cache section of the answer;
 *  `benchmark` is the launch card's measured run; `derived` is a card computed from the others, not read from the body. */
export type CardWait = "race-card-renderer" | "scrubber-count-mode" | "cache-analyzer" | "benchmark" | "derived";

/** One of the prototype's nine cards (2026-11-22-agent-wrapped-prototype): its name there, the fields of the answer
 *  (GET /v2/wrapped) it reads, and what it waits on before it can be shown. */
export type WrappedCard = { id: string; name: string; reads: readonly (keyof Wrapped)[]; waits: readonly CardWait[] };

/** The nine cards, in the prototype's order. */
export const WRAPPED_CARDS: readonly WrappedCard[] = [
  { id: "cover", name: "Year in tokens", reads: ["year", "sessions", "turns", "requests", "tokens", "cost_usd", "days"], waits: ["race-card-renderer"] },
  { id: "split", name: "Harnesses and models", reads: ["harnesses", "models"], waits: ["race-card-renderer"] },
  { id: "hours", name: "When you work", reads: ["hours", "weekdays", "active_ms", "days"], waits: ["race-card-renderer"] },
  { id: "cache", name: "Cache grade", reads: ["tokens"], waits: ["race-card-renderer", "cache-analyzer"] },
  { id: "laptop", name: "On your laptop", reads: ["tokens", "days", "models"], waits: ["race-card-renderer", "derived"] },
  { id: "leak", name: "Leak receipt (opt-in)", reads: [], waits: ["race-card-renderer", "scrubber-count-mode"] },
  { id: "type", name: "Your agent type", reads: ["hours", "weekdays", "harnesses", "models", "tokens"], waits: ["race-card-renderer", "derived"] },
  { id: "summary", name: "The one-card summary", reads: ["year", "tokens", "cost_usd", "days", "harnesses", "models", "hours"], waits: ["race-card-renderer"] },
  { id: "launch", name: "Launch card (ours)", reads: [], waits: ["race-card-renderer", "benchmark"] },
];

/** Draws one card from the answer, or returns null to draw nothing. The race card renderer plugs in here. */
export type CardRenderer = (card: WrappedCard, data: Wrapped) => ReactNode | null;

/** Until a renderer is given, no card is drawn: the page shows no cards section and no empty box. */
export const noCards: CardRenderer = () => null;
