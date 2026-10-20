import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 random bits, base64url. It is a full-control credential for one browser: it lives in memory, in the URL's fragment, and nowhere else. */
export const newToken = (): string => randomBytes(32).toString("base64url");

/** The path id of a viewer's URL: 128 random bits. It names the session without being able to open it. */
export const newViewerId = (): string => randomBytes(16).toString("base64url");

/** Constant time whatever the lengths: both sides are hashed first, so neither a wrong token's length nor its prefix shows in the time taken. */
export function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}
