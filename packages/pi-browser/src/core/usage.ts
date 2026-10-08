// What a browser call costs, as a value any host can add to its spend. Prices come from one PriceTable: list prices
// unless the host knows its plan. A price the host does not know is `unpriced` and one it cannot read is `invalid`; both
// record the quantity (seconds) and charge nothing, so a missing price never reads as free and never aborts a run.
import { LIST_PRICES, type PriceTable, type SessionRecord } from "./host.js";

export type PriceState = "priced" | "unpriced" | "invalid";

/** The shape pi adds to `pi.usage.tools[<tool>]` (pi-ai's `Usage`); a browser call spends no tokens. */
export type PiUsage = { input: 0; output: 0; cacheRead: 0; cacheWrite: 0; totalTokens: 0; cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0; total: number } };
/** One call's charge: what pi records, and whether `total` is a price or a gap. */
export type ToolUsage = { usage: PiUsage; state: PriceState };

const DECIMAL = /^(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/** The host's price of a session minute, from the string it holds (for example `BROWSERBASE_USD_PER_MINUTE`).
 *  Unset or blank is unpriced; anything but a non-negative decimal is invalid. Zero is a price. Pass `prices`
 *  to `resolvePrices` and `state` to `sessionCharge`. */
export function sessionPrice(raw: string | null | undefined): { prices: Pick<PriceTable, "sessionUsdPerHour">; state: PriceState } {
  const text = String(raw ?? "").trim();
  if (!text) return { prices: { sessionUsdPerHour: null }, state: "unpriced" };
  const perHour = (DECIMAL.test(text) ? Number(text) : NaN) * 60;
  // The converted price is the one that must be finite: a minute price of 3e307 is a decimal and an infinite hourly price.
  return Number.isFinite(perHour) ? { prices: { sessionUsdPerHour: perHour }, state: "priced" } : { prices: { sessionUsdPerHour: null }, state: "invalid" };
}

/** List prices with the host's overrides on top; an override of `null` is a deliberate gap. */
export const resolvePrices = (overrides: Partial<PriceTable> = {}): PriceTable => ({ ...LIST_PRICES, ...overrides });

export const toolUsage = (usd: number, state: PriceState = "priced"): ToolUsage => ({
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd } },
  state,
});

export const fetchUsage = (prices: PriceTable, proxied: boolean): ToolUsage => toolUsage(proxied ? prices.fetchProxiedUsd : prices.fetchUsd);
export const searchUsage = (prices: PriceTable): ToolUsage => toolUsage(prices.searchUsd);

type Spent = SessionRecord["spent"];
/** A bill is kept in integer picodollars: it reads as its decimal amount (0.002, not 0.0019999999999999996). */
const PICO = 1e12;
const HOUR_MS = 3_600_000n;
/** A session's meter starts when it was created. */
export const startSpent = (createdAt: string): Spent => ({ seconds: 0, usd: 0, chargedThrough: createdAt });

/** Charge a session for the time since it was last charged, up to `at`: the delta a session tool call carries. With
 *  `final` (the release), the remainder also tops the session up to the provider's minimum, so the whole bill is on the
 *  record. A final charge marks the record (`final`), and a record marked final is never charged again, so a release that
 *  is retried after the host lost the first answer adds nothing; charging again at the same instant adds nothing either. `state` is the host price's state
 *  (`sessionPrice`): unpriced and invalid sessions record their seconds and no dollars. */
export function sessionCharge(spent: Spent, at: string, prices: PriceTable, state: PriceState = "priced", final = false): { spent: Spent; usage: ToolUsage } {
  if (spent.final) return { spent, usage: toolUsage(0, state === "invalid" ? "invalid" : prices.sessionUsdPerHour === null || state !== "priced" ? "unpriced" : "priced") };
  // Integer milliseconds, converted once: a session topped up to the minimum bills exactly the minimum (adding a
  // fractional elapsed time to its complement left 59.99999999999999 s). The minimum tops the total up once, at release.
  const before = Math.round(spent.seconds * 1000);
  const elapsed = Math.max(0, Date.parse(at) - Date.parse(spent.chargedThrough));
  const charged = elapsed + (final ? Math.max(0, Math.round(prices.sessionMinimumS * 1000) - (before + elapsed)) : 0);
  const price = prices.sessionUsdPerHour;
  const priced = price !== null && state === "priced";
  // Each charge bills only its own milliseconds at the price now (time already billed keeps its rate when a session
  // resumes under a different price), as milliseconds x picodollars an hour plus the remainder the last charge carried,
  // in integers (BigInt: the product passes 2^53 past about 75 s): whole picodollars go on the bill, the rest is carried.
  const owed = BigInt(charged) * (priced ? BigInt(Math.round(price * PICO)) : 0n) + BigInt(spent.carry ?? 0);
  const picos = Number(owed / HOUR_MS);
  const carry = Number(owed % HOUR_MS);
  const gap: PriceState = priced ? "priced" : state === "invalid" ? "invalid" : "unpriced";
  return { spent: { seconds: (before + charged) / 1000, usd: (Math.round(spent.usd * PICO) + picos) / PICO, chargedThrough: elapsed > 0 ? at : spent.chargedThrough, ...(final ? { final: true as const } : {}), ...(carry ? { carry } : {}) }, usage: toolUsage(picos / PICO, gap) };
}
