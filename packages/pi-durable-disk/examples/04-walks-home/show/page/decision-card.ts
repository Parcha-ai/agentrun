// The decision card: "Where should this run?", a bar per option, the chosen one lit, and how long the typed model took. Pure (state in, HTML out).
// The probabilities and the latency are the frame's own. They are tagged MEASURED only when the typed model made the decision on a live feed;
// a stand-in ("scripted") or a rehearsal says SCRIPTED. The card is up for a few seconds, then the badge moves.
import { percent } from "../decision.ts";
import type { ShowState } from "../types.ts";
import { esc } from "./dom.ts";

export const CARD_MS = 6000;

export const cardTag = (d: NonNullable<ShowState["decision"]>, source: ShowState["source"]): "measured" | "scripted" => (d.model === "jev" && source === "live" ? "measured" : "scripted");

/**
 * Whether the clean view shows the card. Only a real decision by the typed model: "decided by a stand-in in 0 ms" read as an admission that the
 * agent's choice was canned. A scripted placement (or a rehearsal's feed) is kept as a record, not shown; ?debug=1 shows everything.
 */
export const cardShown = (d: ShowState["decision"], source: ShowState["source"], debug: boolean): boolean => d !== null && (debug || (d.model === "jev" && source === "live"));

export const cardVisible = (d: ShowState["decision"], now: number): d is NonNullable<ShowState["decision"]> => d !== null && now >= d.at && now - d.at < CARD_MS;

/** `pill`: draw the tag (the debug view); the clean view keeps it as data on the card instead. */
export function decisionCardHtml(d: NonNullable<ShowState["decision"]>, source: ShowState["source"], options: { pill?: boolean } = {}): string {
  const tag = cardTag(d, source);
  const rows = d.options
    .map((o) => `<div class="opt${o.id === d.choice ? " chosen" : ""}"><span class="name">${esc(o.label)}</span><span class="bar"><i style="--w:${(o.probability * 100).toFixed(1)}%"></i></span><span class="pct">${percent(o.probability)}</span></div>`)
    .join("");
  return `<h3>${esc(d.question)}</h3>${rows}<div class="foot"><span>decided by ${d.model === "jev" ? "TypeSafe Jev" : "a stand-in"} in ${Math.round(d.latencyMs)} ms</span>${options.pill === false ? "" : `<span class="tag ${tag}">${tag}</span>`}</div>`;
}
