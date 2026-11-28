import type { ReactNode } from "react";
import type { Wrapped } from "@/lib/v2";

/** What a card cannot be drawn without. `race-card-renderer` is the shared card drawing (every card waits on it);
 *  `secret-count` is the answer's count of the keys the import cut; `opt-in` is the person turning the card on, on the
 *  page (it is off until they do); `cache-analyzer` is the cache section of the answer; `benchmark` is the launch card's
 *  measured run; `derived` is a card computed from the others, not read from the body. */
export type CardWait = "race-card-renderer" | "secret-count" | "opt-in" | "cache-analyzer" | "benchmark" | "derived";

/** One of the prototype's nine cards (2026-11-22-agent-wrapped-prototype): its name there, the fields of the answer
 *  (GET /v2/wrapped) it reads, and what it waits on before it can be shown. */
export type WrappedCard = { id: string; name: string; reads: readonly (keyof Wrapped)[]; waits: readonly CardWait[] };

/** The nine cards, in the prototype's order. */
export const WRAPPED_CARDS: readonly WrappedCard[] = [
  { id: "cover", name: "Year in tokens", reads: ["year", "sessions", "turns", "requests", "tokens", "tokens_unknown_requests", "cost_usd", "unpriced_requests", "days", "unread_files"], waits: ["race-card-renderer"] },
  { id: "split", name: "Harnesses and models", reads: ["year", "harnesses", "models", "unread_files"], waits: ["race-card-renderer"] },
  { id: "hours", name: "When you work", reads: ["year", "hours", "weekdays", "active_ms", "time_unknown_requests", "requests", "days", "unread_files"], waits: ["race-card-renderer"] },
  { id: "cache", name: "Cache grade", reads: ["year", "cache"], waits: ["race-card-renderer", "cache-analyzer"] },
  { id: "laptop", name: "On your laptop", reads: ["tokens", "days", "models"], waits: ["race-card-renderer", "derived"] },
  { id: "leak", name: "Leak receipt (opt-in)", reads: ["year", "secrets"], waits: ["race-card-renderer", "secret-count", "opt-in"] },
  { id: "type", name: "Your agent type", reads: ["hours", "weekdays", "harnesses", "models", "tokens"], waits: ["race-card-renderer", "derived"] },
  { id: "summary", name: "The one-card summary", reads: ["year", "requests", "tokens", "tokens_unknown_requests", "cost_usd", "unpriced_requests", "days", "harnesses", "models", "hours", "unread_files"], waits: ["race-card-renderer"] },
  { id: "launch", name: "Launch card (ours)", reads: [], waits: ["race-card-renderer", "benchmark"] },
];

/** Draws one card from the answer, or returns null to draw nothing; `optIn` is whether the person turned the opt-in
 *  cards on. The race card renderer plugs in here. */
export type CardRenderer = (card: WrappedCard, data: Wrapped, optIn: boolean) => ReactNode | null;

/** Until a renderer is given, no card is drawn: the page shows no cards section and no empty box. */
export const noCards: CardRenderer = () => null;
