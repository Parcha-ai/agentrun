// The signature schemes a webhook trigger takes, in one table: each names the header its signature comes in, checks a
// request's headers before its body is read, verifies the request under the trigger's secret, and reads the request's
// firing key (from what its signature covers, so a replay under a new id is the same firing) and its event (what a
// trigger's accept rules match). A request is checked by the one
// scheme whose signature header it carries; a trigger's `signature` names the scheme it takes. A new scheme is one entry
// here: the source's schema and its check read the table's keys.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HOOK_TOLERANCE_S, headersRefusal, HOOK_ID, MIN_KEY_BYTES, verify as verifyStandard } from "./standard-webhooks.js";
import { isObject } from "./validate.js";

type Headers = Record<string, string | string[] | undefined>;
export type Scheme = {
  /** The header its signature comes in: a request that carries it, and no other scheme's, is checked by this one. */
  signatureHeader: string;
  /** How a sender signs under it, for the OpenAPI document. */
  describe: string;
  /** Why the headers alone are refused, before a byte of the body is read. */
  precheck(headers: Headers, nowMs: number): string | undefined;
  /** Why the request is not signed by `key`, or undefined when it is. Its cost does not depend on the key matching. */
  verify(key: string, headers: Headers, body: Buffer, nowMs: number): string | undefined;
  /** The delivery's firing key, which a retry repeats: from what the signature covers, never from an unsigned header, or
   *  a captured delivery sent again under a new id would fire again. Read after verify passed. */
  firingKeyOf(headers: Headers, body: Buffer): string;
  /** A delivery id the sender sends that is not signed, when it has one: named on the payload's tag for tracing only. */
  deliveryIdOf?(headers: Headers): string;
  /** The delivery's event, from its headers or its body (`json`, undefined when the body is not JSON). */
  eventOf(headers: Headers, json: unknown): string | undefined;
};

/** An event's name in a header: printable ASCII with no space (`pull_request`, `ping`). */
const EVENT = /^[\x21-\x7e]{1,200}$/;
const GITHUB_SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
const githubHmac = (secret: string, body: string | Buffer): Buffer => createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest();

function githubPrecheck(headers: Headers): string | undefined {
  const [signature, delivery, event] = ["x-hub-signature-256", "x-github-delivery", "x-github-event"].map((name) => headers[name]);
  if (typeof signature !== "string" || typeof delivery !== "string" || typeof event !== "string") return "missing_headers";
  if (!GITHUB_SIGNATURE.test(signature) || !HOOK_ID.test(delivery) || !EVENT.test(event)) return "malformed_headers";
  return undefined;
}

export const SIGNATURE_SCHEMES = {
  // Standard Webhooks (standardwebhooks.com), the spec this server's outbound webhooks sign with (standard-webhooks.ts).
  standard: {
    signatureHeader: "webhook-signature",
    describe: `\`standard\` follows the Standard Webhooks spec, so a sender signs with any of its libraries: \`webhook-id\` (1 to 255 printable ASCII characters, no space; the firing's key), \`webhook-timestamp\` (Unix seconds, within ${HOOK_TOLERANCE_S} s of this server's clock either way) and \`webhook-signature\`, space-separated \`v1,<base64 HMAC-SHA256 of "{webhook-id}.{webhook-timestamp}.{body}">\` under the secret's 32 bytes (at most 2048 characters in all), any one of which may match. Its event is the JSON body's top-level \`type\`, when it has one.`,
    precheck: headersRefusal,
    verify: verifyStandard,
    // webhook-id is signed ("{id}.{timestamp}.{body}"), so it is the key.
    firingKeyOf: (headers) => headers["webhook-id"] as string,
    eventOf: (_headers, json) => (isObject(json) && typeof json.type === "string" ? json.type : undefined),
  },
  // GitHub's, as its docs give it ("Validating webhook deliveries"), keyed by the secret as pasted into the webhook. It
  // signs the body only: X-GitHub-Delivery and the time are not signed, so the firing's key is the body's SHA-256 (a
  // GitHub redelivery sends the same body; two events' bodies differ in their ids and times), and a delivery replayed
  // within its key's day is the same firing, whatever id it carries.
  github: {
    signatureHeader: "x-hub-signature-256",
    describe: "`github` takes a GitHub webhook's delivery: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>` keyed by the UTF-8 bytes of the whole secret string (paste it as it is into the GitHub webhook's Secret), `X-GitHub-Delivery` (1 to 255 printable ASCII characters, not signed, so named on the payload's tag for tracing only) and `X-GitHub-Event`, its event. GitHub signs the body alone, so the firing's key is the SHA-256 of the raw body: GitHub's redelivery of an event is the same firing, and so is any copy of a delivery sent again within the key's day, whatever its X-GitHub-Delivery; after the day it would fire again. There is no timestamp window.",
    precheck: githubPrecheck,
    verify(key, headers, body) {
      const early = githubPrecheck(headers);
      if (early) return early;
      const given = Buffer.from(GITHUB_SIGNATURE.exec(headers["x-hub-signature-256"] as string)![1]!, "hex");
      // Compared all the same, so a short key costs what a good one does; it fails after.
      const matched = timingSafeEqual(given, githubHmac(key, body));
      if (Buffer.byteLength(key, "utf8") < MIN_KEY_BYTES) return "short_key";
      return matched ? undefined : "bad_signature";
    },
    firingKeyOf: (_headers, body) => `sha256:${createHash("sha256").update(body).digest("hex")}`,
    deliveryIdOf: (headers) => headers["x-github-delivery"] as string,
    eventOf: (headers) => headers["x-github-event"] as string,
  },
} satisfies Record<string, Scheme>;

export type SchemeName = keyof typeof SIGNATURE_SCHEMES;
export const SCHEME_NAMES = Object.keys(SIGNATURE_SCHEMES) as SchemeName[];
export const DEFAULT_SCHEME: SchemeName = "standard";

/** The scheme a request asks for: the one whose signature header it carries. `refusal` when it carries none, or more
 *  than one (a request is checked one way only). */
export function schemeOf(headers: Headers): { name: SchemeName; scheme: Scheme } | { refusal: string } {
  const carried = SCHEME_NAMES.filter((name) => headers[SIGNATURE_SCHEMES[name].signatureHeader] !== undefined);
  if (carried.length === 1) return { name: carried[0]!, scheme: SIGNATURE_SCHEMES[carried[0]!] };
  return { refusal: carried.length ? "ambiguous_signature" : "missing_headers" };
}
