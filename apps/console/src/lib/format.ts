import DOMPurify from "dompurify";
import { marked } from "marked";
import type { Cost } from "./v2";

export const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
export const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether a cost is an estimate, by its basis. The label's "est." and the run page's billing disclaimer both read it. */
export const isEstimate = (c: Cost) => c.basis === "estimate";

/** A local estimate stays an estimate, and a cost the server does not know says so: the contract's "Null while unknown.
 *  A client shows null as unknown, never as $0" (a request cut before its answer, a cost still pending, or a model with
 *  no price). Never a billed amount, never an invented zero. */
export function cost(c: Cost | null | undefined): string {
  if (bounded(c)) return `≤ ${upTo(c.at_most_usd)}`;
  if (!c || c.usd === null) return "Unknown";
  // A cost the server priced above zero never reads as $0: under a hundredth of a cent it reads "<$0.0001".
  const usd = c.usd > 0 && c.usd < 0.0001 ? "<$0.0001" : c.usd < 0.01 ? `$${c.usd.toFixed(4)}` : `$${c.usd.toFixed(2)}`;
  return isEstimate(c) ? `${usd} est.` : usd;
}

/** Said beside a bounded cost: why it is a bound and not a figure. */
export const CUT_NOTE = "some requests were cut";

/** The run's cost bound, when the server knows one (`at_most_usd`): the cost is unknown because requests were cut, each
 *  with a worst case. */
export const bounded = (c: Cost | null | undefined): c is Cost & { at_most_usd: number } => !!c && c.usd === null && typeof c.at_most_usd === "number";

/** A bound in dollars, rounded up so it never reads below the bound: $0.0001 steps under a cent, cents above. */
export const upTo = (usd: number) => (usd < 0.01 ? `$${(Math.ceil(usd * 1e4 - 1e-9) / 1e4).toFixed(4)}` : `$${(Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2)}`);

/** Markdown from a run, as safe HTML: parsed by marked, then sanitized (no scripts, no handlers, no foreign frames). */
export const markdown = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
