import DOMPurify from "dompurify";
import { marked } from "marked";
import type { Cost } from "./v2";

/** A run's short label, the one every place that shows one uses: the id's last 8 characters. Run ids are UUIDv7s, whose
 *  leading digits are the start time (the same for runs started within about a minute); the tail is random. */
export const runLabel = (id: string) => id.slice(-8);

/** The console's times, every one it shows, in the viewer's own zone (the browser's): no `timeZone` is set. `clock`, the
 *  time of day (a Timeline step); `when`, the day and the time (everything else). */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
export const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether a cost is an estimate, by its basis. The label's "est." and the run page's billing disclaimer both read it. */
export const isEstimate = (c: Cost) => c.basis === "estimate";

/** A run's cost in dollars: a figure above zero never reads as $0 (under a hundredth of a cent it reads "<$0.0001"),
 *  four places under a cent, two from a cent up. */
const dollars = (usd: number) => (usd > 0 && usd < 0.0001 ? "<$0.0001" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** A cost known so far in dollars: up to four places under a dollar, as the run's own usage row says it ("Cost so far:
 *  $0.0123 known"), since a partial sum is often cents and two places would disagree with the row beside it. Zeros past
 *  the cents go ($0.07, not $0.0700); above zero it never reads as $0. */
const soFarDollars = (usd: number) => {
  if (usd > 0 && usd < 0.0001) return "<$0.0001";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const [whole, places = ""] = usd.toFixed(4).split(".");
  return `$${whole}.${places.replace(/0+$/, "").padEnd(2, "0")}`;
};

/** The cost known so far, when the server can't give the whole (costsofar/1: `so_far_usd` and `unpriced`, sent only while
 *  `usd` is null); undefined when it says neither. */
export const soFar = (c: Cost | null | undefined): (Cost & { so_far_usd: number; unpriced: number }) | undefined =>
  c && c.usd === null && typeof c.so_far_usd === "number" && typeof c.unpriced === "number" ? (c as Cost & { so_far_usd: number; unpriced: number }) : undefined;

/** Said beside a cost known so far: why it is not the whole cost (a charge with no price: a model request cut, stopped or
 *  still pending, a model with no price, a decision or a paid tool call whose cost is unknown). */
export const soFarNote = (c: { unpriced: number }) =>
  `The charges priced so far. ${c.unpriced} ${c.unpriced === 1 ? "charge has" : "charges have"} no price, so this is not the whole cost.`;

/** A local estimate stays an estimate, and a cost the server does not know says so: the contract's "Null while unknown.
 *  A client shows null as unknown, never as $0" (a request cut before its answer, a cost still pending, or a model with
 *  no price). When the server says what is known so far, that is said ("so far $0.0123 · 1 not priced"), never as the
 *  whole cost. Never a billed amount, never an invented zero. */
export function cost(c: Cost | null | undefined): string {
  const known = soFar(c);
  const est = (x: Cost) => (isEstimate(x) ? " est." : "");
  if (known) return `so far ${soFarDollars(known.so_far_usd)}${est(known)} · ${known.unpriced} not priced`;
  if (!c || c.usd === null) return "Unknown";
  return `${dollars(c.usd)}${est(c)}`;
}

/** Markdown from a run, as safe HTML: parsed by marked, then sanitized (no scripts, no handlers, no foreign frames). */
export const markdown = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
