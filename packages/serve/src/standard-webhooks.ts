// The Standard Webhooks spec (standardwebhooks.com), once, for every message this server signs and every request it
// checks: a secret is `whsec_` and its bytes in base64, and a signature is `v1,<base64 HMAC-SHA256 of
// "{id}.{timestamp}.{body}">` under those bytes. The outbound webhook (webhooks.ts) signs with it; a pushed trigger
// source (the webhook trigger) verifies with it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How far a request's `webhook-timestamp` may be from this server's clock, either way. */
export const HOOK_TOLERANCE_S = 300;
/** The fewest bytes a signing key may have (the spec's secrets are 24 to 64; this server makes 32): a shorter one, an
 *  empty one above all, signs nothing. Every secret a trigger source keeps sealed is held to it. */
export const MIN_KEY_BYTES = 24;
/** A webhook-id: printable ASCII with no space, as the spec's `msg_...` ids are; it goes into a firing's key and history. */
const HOOK_ID = /^[\x21-\x7e]{1,255}$/;
/** The longest `webhook-signature` list read: room for many keys during a rotation, never an unbounded loop. */
const MAX_SIGNATURES_CHARS = 2048;

/** A new secret: `whsec_` and 32 random bytes in base64. */
export const mintSecret = (): string => `whsec_${randomBytes(32).toString("base64")}`;

/** The bytes a secret signs with. */
const keyOf = (secret: string): Buffer => Buffer.from(secret.slice("whsec_".length), "base64");

const hmacOf = (secret: string, id: string, timestamp: string, body: string | Buffer): Buffer =>
  createHmac("sha256", keyOf(secret)).update(`${id}.${timestamp}.`).update(body).digest();

/** The signature header of `body`, sent as message `id` at `timestamp` (Unix seconds), under `secret` (`whsec_...`). */
export const signatureOf = (secret: string, id: string, timestamp: string, body: string | Buffer): string => `v1,${hmacOf(secret, id, timestamp, body).toString("base64")}`;

/** Why a request's webhook headers are refused before its body is read, or undefined when they may be checked:
 *  present, a webhook-id of printable ASCII, a bounded signature list, a timestamp within HOOK_TOLERANCE_S. */
export function headersRefusal(headers: Record<string, string | string[] | undefined>, nowMs: number): string | undefined {
  const [id, timestamp, signatures] = ["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => headers[name]);
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signatures !== "string") return "missing_headers";
  if (!HOOK_ID.test(id) || signatures.length > MAX_SIGNATURES_CHARS) return "malformed_headers";
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > HOOK_TOLERANCE_S) return "stale_timestamp";
  return undefined;
}

/** Why a request is not signed by `secret`, or undefined when it is: `webhook-signature` lists signatures, space
 *  separated, and any one that matches passes; the timestamp is within HOOK_TOLERANCE_S; the key has MIN_KEY_BYTES. */
export function verify(secret: string, headers: Record<string, string | string[] | undefined>, body: Buffer, nowMs: number): string | undefined {
  const early = headersRefusal(headers, nowMs);
  if (early) return early;
  const [id, timestamp, signatures] = ["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => headers[name] as string);
  const expected = hmacOf(secret, id!, timestamp!, body);
  // Compared all the same, so a short key costs what a good one does; it fails after.
  const matched = signatures!.split(" ").some((part) => {
    const [version, signature] = part.split(",");
    const given = Buffer.from(signature ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (keyOf(secret).length < MIN_KEY_BYTES) return "short_key";
  return matched ? undefined : "bad_signature";
}
