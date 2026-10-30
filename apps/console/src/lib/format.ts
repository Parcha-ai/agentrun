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

/** Whether a cost is an estimate, by whose number it is: the server's source when it gives one, else its basis (an
 *  older server). The label's "est." and the run page's billing disclaimer both read it. */
export const isEstimate = (c: Cost) => (c.source ? c.source === "estimate" : c.basis === "estimate");

/** A local estimate stays an estimate, and a cost the server does not know says so: the contract's "Null while unknown.
 *  A client shows null as unknown, never as $0" (a request cut before its answer, a cost still pending, or a model with
 *  no price). Never a billed amount, never an invented zero. */
export function cost(c: Cost | null | undefined): string {
  if (!c || c.usd === null) return "Unknown";
  // A cost the server priced above zero never reads as $0: under a hundredth of a cent it reads "<$0.0001".
  const usd = c.usd > 0 && c.usd < 0.0001 ? "<$0.0001" : c.usd < 0.01 ? `$${c.usd.toFixed(4)}` : `$${c.usd.toFixed(2)}`;
  return isEstimate(c) ? `${usd} est.` : usd;
}

/** Markdown from a run, as safe HTML: parsed by marked, then sanitized (no scripts, no handlers, no foreign frames). */
export const markdown = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
