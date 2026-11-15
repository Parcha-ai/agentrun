/**
 * What one model request counts at under a spend cap: one rule for every path (pi's requests in serve's own process, and
 * the claude-agent, codex and opencode requests the kernel's model proxy books through the runner). The rule is never to
 * under-count: a request counts at what it can have cost, never less.
 *
 * A path says how its request ended (`Ended`), and `bookRequest` gives its figure:
 * - `answered`: a whole answer, at the cost its usage (or its gateway) says, else the hold. A figure the provider reported
 *   above the hold (the request's worst case at list) is not believed: the table's figure beside it, else the hold. A
 *   200 stream the provider ended in its error event after it reported tokens is one too (`error`): those tokens at list;
 * - `nothing`: the provider answered a status before any event (not a gateway's timeout), the request provably never
 *   left (`isConnectCode`), or the provider refused it inside its answer (its error event in a 200 stream, an overload or
 *   a rate limit, before it reported any token): 0;
 * - `lost`: anything that can have been billed and says no cost (a transport error once it left, a cut answer, a
 *   gateway's 504 or 524, an answer after an attempt that was lost, which can have been billed twice, a crash): the hold;
 * - `stopped`: our abort, its client gone part way: what streamed (its content, and the part of a hidden reasoning
 *   budget that did not stream), priced by the path (`stoppedPrice`), never past the hold.
 * With no hold (no cap), a figure no one knows is `null`, as it always was. A request on a free model (`free`: its known
 * price is $0 for every token) is 0 however it ended: whatever it was billed for costs nothing.
 */

/** How a request ended, as its path saw it. `label` names the case for the record (`rule`); it changes no figure but
 *  `answered`'s `filtered` (a content-filter end: its reported usage, else the hold, as any answer). An answer's
 *  `tableUsd`: beside a figure the provider reported (`usd`), the price table's for the same usage. A refusal's or an
 *  error's `reason`: the provider's own words, the credential cut. */
export type Ended =
  | { end: "answered"; usd: number | null; label?: "filtered"; tableUsd?: number | null }
  | { end: "answered"; usd: number | null; label: "error"; reason?: string; tableUsd?: number | null }
  | { end: "nothing"; label: "status" | "never_left" }
  | { end: "nothing"; label: "refused"; reason?: string }
  | { end: "lost"; label: "error_before" | "error_after" | "gateway_timeout" | "retried" | "cut"; began?: boolean }
  | { end: "stopped"; streamedTokens: number };

/** What a path prices a request with: what its cap held for it, and what it counts at when stopped having streamed
 *  `tokens` (its input, those tokens and the stop's allowance, at most its output limit, at its price). `free`: its model's
 *  known price is $0 for every token, with no fee beside (runner.ts Admitted.free). */
export type Priced = { hold?: number; stoppedPrice?: (streamedTokens: number) => number; free?: boolean };

/** A booked request: its figure (null when no one knows it and nothing was held), and the rule that gave it. */
export type Booked = { usd: number | null; rule: string };

const figure = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The one booking of a request: `ended` priced by `priced`. */
export function bookRequest(ended: Ended, priced: Priced): Booked {
  const hold = figure(priced.hold);
  const rule = "label" in ended && ended.label ? `${ended.end}:${ended.label}` : ended.end;
  // Nothing it was billed for costs anything: a known $0, never the hold and never unknown. The rule still says how it ended.
  if (priced.free === true) return { usd: 0, rule };
  switch (ended.end) {
    case "answered": {
      // A content filter's end is an answer: its usage when it reported one, else the hold.
      const usd = figure(ended.usd);
      // A provider's figure above what the cap held for the request (its worst case at list) is not what it can have
      // cost: the table's figure for the same usage stands, else the hold. A table's own figure (no `tableUsd`) is not judged.
      if (usd !== undefined && hold !== undefined && usd > hold && ended.tableUsd !== undefined) return { usd: figure(ended.tableUsd) ?? hold, rule: `${rule}:over_hold` };
      return { usd: usd ?? hold ?? null, rule };
    }
    case "nothing":
      return { usd: 0, rule };
    case "lost":
      return { usd: hold ?? null, rule };
    case "stopped": {
      const streamed = figure(ended.streamedTokens);
      const stopped = hold !== undefined && streamed !== undefined && priced.stoppedPrice ? figure(priced.stoppedPrice(streamed)) : undefined;
      return { usd: stopped === undefined ? hold ?? null : Math.min(hold!, stopped), rule };
    }
  }
}

/** The connect-phase codes of a request that never left: refused, unresolved or unreachable, a connect timeout, or a TLS
 *  certificate refused before the request was written. Anything else (a reset, a timeout once connected, no code) left. */
const CONNECT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID",
]);
export const isConnectCode = (code: unknown): boolean => typeof code === "string" && (CONNECT_CODES.has(code) || code.startsWith("CERT_"));

/** A gateway's answer that the provider was still at work when it gave up (Cloudflare's 524, a 504): billed, not a status. */
export const isGatewayTimeout = (status: number): boolean => status === 504 || status === 524;

/** The code of a fetch's rejection: its cause's (undici), else its own. */
export const rejectionCode = (error: unknown): string | undefined => {
  const at = error as { cause?: { code?: unknown }; code?: unknown } | undefined;
  const code = at?.cause?.code ?? at?.code;
  return typeof code === "string" ? code : undefined;
};
