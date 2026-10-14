// A price the host does not know (`unpriced`) or cannot read (`invalid`) records seconds and charges nothing: a missing
// price never reads as free and never aborts a run.
import { LIST_PRICES, type PriceTable, type SessionRecord } from "./host.js";

export type PriceState = "priced" | "unpriced" | "invalid";

export type PiUsage = { input: 0; output: 0; cacheRead: 0; cacheWrite: 0; totalTokens: 0; cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0; total: number } };
export type ToolUsage = { usage: PiUsage; state: PriceState };

const DECIMAL = /^(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/** Dollars per minute: unset or blank is unpriced; anything but a non-negative decimal is invalid. Zero is a price. */
export function sessionPrice(raw: string | null | undefined): { prices: Pick<PriceTable, "sessionUsdPerHour">; state: PriceState } {
  const text = String(raw ?? "").trim();
  if (!text) return { prices: { sessionUsdPerHour: null }, state: "unpriced" };
  const perHour = (DECIMAL.test(text) ? Number(text) : NaN) * 60;
  // The converted price must be finite: a minute price of 3e307 is a decimal and an infinite hourly price.
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
/** Integer picodollars, so a bill reads as its decimal amount (0.002, not 0.0019999999999999996). */
const PICO = 1e12;
const HOUR_MS = 3_600_000n;
export const startSpent = (createdAt: string): Spent => ({ seconds: 0, usd: 0, chargedThrough: createdAt });

/** `final` (the release) tops up to the provider's minimum and marks the record, so a retried release adds nothing. */
export function sessionCharge(spent: Spent, at: string, prices: PriceTable, state: PriceState = "priced", final = false): { spent: Spent; usage: ToolUsage } {
  if (spent.final) return { spent, usage: toolUsage(0, state === "invalid" ? "invalid" : prices.sessionUsdPerHour === null || state !== "priced" ? "unpriced" : "priced") };
  // Integer milliseconds, converted once: a session topped up to the minimum bills exactly the minimum, not
  // 59.99999999999999 s.
  const before = Math.round(spent.seconds * 1000);
  const elapsed = Math.max(0, Date.parse(at) - Date.parse(spent.chargedThrough));
  const charged = elapsed + (final ? Math.max(0, Math.round(prices.sessionMinimumS * 1000) - (before + elapsed)) : 0);
  const price = prices.sessionUsdPerHour;
  const priced = price !== null && state === "priced";
  // Each charge bills its own milliseconds at the current price, in BigInt (the product passes 2^53 past about 75 s):
  // whole picodollars go on the bill and the remainder is carried.
  const owed = BigInt(charged) * (priced ? BigInt(Math.round(price * PICO)) : 0n) + BigInt(spent.carry ?? 0);
  const picos = Number(owed / HOUR_MS);
  const carry = Number(owed % HOUR_MS);
  const gap: PriceState = priced ? "priced" : state === "invalid" ? "invalid" : "unpriced";
  return { spent: { seconds: (before + charged) / 1000, usd: (Math.round(spent.usd * PICO) + picos) / PICO, chargedThrough: elapsed > 0 ? at : spent.chargedThrough, ...(final ? { final: true as const } : {}), ...(carry ? { carry } : {}) }, usage: toolUsage(picos / PICO, gap) };
}
