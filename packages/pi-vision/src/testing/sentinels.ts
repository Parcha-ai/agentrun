// Values that must never appear in anything the package returns, files or derives. The fake eyes hold the key as a
// real eyes object holds its credential; a signed link carries its secrets in its query, as a file store or a recording
// service hands one out. A scan of results, details, receipts, derived names and memos looks for each value, and for
// each secret part of the link alone. Every value is obviously fake, at least 32 characters (so a leaked head or tail
// is found) and distinct from the others.

/** The fake eyes' credential. */
export const SENTINEL_EYES_KEY = "pv-sentinel-eyes-key-6c1e0b7d93a24f58";

/** The secret parts of a signed link, each a sentinel of its own; their first 16 characters differ, so a finding says which. */
export const SENTINEL_LINK_SIGNATURE = "pv-sentinel-sig-0d4b9e71a3c85f26e8b7c4a1593d60f2";
export const SENTINEL_LINK_TOKEN = "pv-sentinel-tok-8a15c3f7e0b94d62b7d3a0e96c41f58d";

/** A signed link to `path`. Its origin, path and expiry are no secret; its signature and token are. The host name is
 *  reserved (RFC 6761), so nothing ever resolves it. */
export const signedLink = (path = "reports/statement.pdf"): string =>
  `https://files.sentinel.invalid/${path}?X-Sentinel-Expires=1790000000&X-Sentinel-Signature=${SENTINEL_LINK_SIGNATURE}&token=${SENTINEL_LINK_TOKEN}&page=2`;

export const SENTINEL_SIGNED_LINK = signedLink();

/** What a file named after the link carries past its `?`. */
export const SENTINEL_LINK_QUERY = SENTINEL_SIGNED_LINK.slice(SENTINEL_SIGNED_LINK.indexOf("?") + 1);

/** Every value the leak check looks for, by name. */
export const SENTINELS: Readonly<Record<"eyesKey" | "linkSignature" | "linkToken", string>> = Object.freeze({
  eyesKey: SENTINEL_EYES_KEY,
  linkSignature: SENTINEL_LINK_SIGNATURE,
  linkToken: SENTINEL_LINK_TOKEN,
});
