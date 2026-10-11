import { createHash } from "node:crypto";

/** The widest provider tool-call id that is keyed as it is. */
export const CALL_KEY_BYTES = 256;
const PREFIX_CHARS = 64;
const DIGEST_HEX = 32;

/** A host's own key for a provider-minted tool-call id. A provider may fold arbitrary data into
 *  its call ids (a reasoning signature, for one), so an id's length is the provider's, not ours: an id
 *  within `CALL_KEY_BYTES` is its own key, and a wider one is keyed by its leading characters (made
 *  identifier-safe) and a SHA-256 prefix of the whole id. The mapping is deterministic, so the same
 *  call always has the same key, and two different wide ids share a key only on a digest collision.
 *  Only keys use it: what goes back to the provider is always the id it minted. */
export function callKey(callId: string): string {
  if (Buffer.byteLength(callId) <= CALL_KEY_BYTES) return callId;
  const prefix = callId.slice(0, PREFIX_CHARS).replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${prefix}~${createHash("sha256").update(callId).digest("hex").slice(0, DIGEST_HEX)}`;
}

/** The key a ledger holds a call under. Writes always use `callKey`; a read also accepts a row a
 *  ledger already keys by the raw id (`holds` answers for the raw id), so a run whose ledger keyed a
 *  wide id as it was resumes against its own receipts and never re-runs a recorded call. */
export function heldCallKey(callId: string, holds: (rawKey: string) => boolean): string {
  const key = callKey(callId);
  return key !== callId && holds(callId) ? callId : key;
}
