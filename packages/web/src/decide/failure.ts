import { PaidRefused } from "../fees.js";
import type { Cost } from "./decider.js";

// A request refused before it was billed, or never sent: nothing to book. Any other failure may have been billed.
const UNBILLED = new Set(["configuration", "auth", "rate_limited", "invalid_request", "connection", "pay_refused"]);

const fields = (thrown: unknown): Record<string, unknown> => (thrown !== null && typeof thrown === "object" ? (thrown as Record<string, unknown>) : {});
export const codeOf = (thrown: unknown): string => (thrown instanceof PaidRefused ? "pay_refused" : typeof fields(thrown).code === "string" ? (fields(thrown).code as string) : "error");
export const unbilled = (thrown: unknown): boolean => UNBILLED.has(codeOf(thrown)) || fields(thrown).unsent === true;

export function costOf(thrown: unknown): Cost {
  const error = fields(thrown);
  const usd = typeof error.costUsd === "number" ? error.costUsd : null;
  if (typeof error.costBasis === "string") return { usd, basis: usd === null ? "unknown" : (error.costBasis as Cost["basis"]) };
  if (usd !== null) return { usd, basis: "estimate" };
  return unbilled(thrown) ? { usd: 0, basis: "none" } : { usd: null, basis: "unknown" };
}

/** Two requests' cost together: unknown if either is, else the sum, and the weaker basis of the two. */
export function costTogether(a: Cost, b: Cost): Cost {
  if (a.usd === null || b.usd === null) return { usd: null, basis: "unknown" };
  const basis = a.basis === "none" ? b.basis : b.basis === "none" || a.basis === b.basis ? a.basis : "estimate";
  return { usd: Math.round((a.usd + b.usd) * 1e12) / 1e12, basis };
}
