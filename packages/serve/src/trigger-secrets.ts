// Each webhook trigger's signing secret (triggers.ts): `whsec_` and 32 random bytes in base64, as the Standard Webhooks
// spec gives one, made at the trigger's create or a rotation, shown that once, and kept in DIR/trigger-secrets.json only
// sealed under the seal key (tool-keys.ts), each bound to its trigger by its AAD. With no seal key none is kept, never in
// the clear, so no webhook trigger is made.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { isObject } from "./validate.js";

export const TRIGGER_SECRETS_FILE = "trigger-secrets.json";
const aad = (triggerId: string) => `trigger-secret|${triggerId}`;

/** The sealed secrets `file` keeps, by trigger id: none when there is no file, and why not when it does not read. */
function sealedIn(file: string): { sealed: Record<string, string> } | { unreadable: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { sealed: {} } : { unreadable: (error as Error).message };
  }
  try {
    const doc = JSON.parse(text) as unknown;
    if (!isObject(doc) || doc.v !== 1 || !isObject(doc.secrets) || !Object.values(doc.secrets).every((v) => typeof v === "string")) return { unreadable: "not a trigger secrets file of version 1" };
    return { sealed: doc.secrets as Record<string, string> };
  } catch (error) {
    return { unreadable: (error as Error).message };
  }
}

const opened = (key: Buffer, sealed: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(sealed).flatMap(([id, value]) => {
      try {
        return [[id, unseal(key, Buffer.from(value, "base64"), aad(id)).toString("utf8")]];
      } catch {
        return [];
      }
    }),
  );

/** The trigger secrets data directory `data` keeps, opened with the seal key of `env` (those that open): what an import
 *  cuts out of everything it writes. */
export function triggerSecretsIn(data: string, env: NodeJS.ProcessEnv): string[] {
  const key = sealKeyOf(env[SEAL_KEY_ENV]);
  const read = sealedIn(join(data, TRIGGER_SECRETS_FILE));
  return key && "sealed" in read ? Object.values(opened(key, read.sealed)) : [];
}

export class TriggerSecrets {
  private readonly file: string;
  private readonly key: Buffer | undefined;
  /** Opened, by trigger id: read once at start, then kept with every write. */
  private secrets: Record<string, string>;
  private sealed: Record<string, string> = {};
  /** Why the file does not read: no secret is made or rotated, none signs, and the file is never written over. */
  private readonly unreadable?: string;

  constructor(data: string, env: NodeJS.ProcessEnv, say: (fields: Record<string, string>) => void = () => {}) {
    this.file = join(data, TRIGGER_SECRETS_FILE);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    const read = sealedIn(this.file);
    if ("sealed" in read) this.sealed = read.sealed;
    else {
      this.unreadable = read.unreadable;
      say({ condition: "trigger_secrets_unreadable", file: this.file, error: read.unreadable });
    }
    this.secrets = this.key ? opened(this.key, this.sealed) : {};
  }

  /** A new secret for `triggerId`, written sealed before it is answered: its only showing. */
  mint(triggerId: string): string {
    if (this.unreadable) throw new ApiError("store_unreadable", `${TRIGGER_SECRETS_FILE} in the data directory does not read (${this.unreadable}); it is never written over, so no webhook trigger's secret is made or rotated. Fix it or move it away, then restart.`);
    if (!this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no webhook trigger's secret: it never keeps one in the clear.`);
    const secret = `whsec_${randomBytes(32).toString("base64")}`;
    this.write({ ...this.sealed, [triggerId]: seal(this.key, Buffer.from(secret, "utf8"), aad(triggerId)).toString("base64") });
    this.secrets[triggerId] = secret;
    return secret;
  }

  value(triggerId: string): string | undefined {
    return this.secrets[triggerId];
  }

  /** A deleted trigger's secret goes; with the file unreadable it stays in it, unread, as the file is never written over. */
  remove(triggerId: string): void {
    if (this.unreadable || !(triggerId in this.sealed)) return;
    const { [triggerId]: _, ...rest } = this.sealed;
    this.write(rest);
    delete this.secrets[triggerId];
  }

  /** Every secret held, for the redaction of what is shown. */
  values(): string[] {
    return Object.values(this.secrets);
  }

  private write(sealed: Record<string, string>): void {
    writeDurableSync(this.file, `${JSON.stringify({ v: 1, secrets: sealed }, null, 2)}\n`);
    this.sealed = sealed;
  }
}

/** How far a request's `webhook-timestamp` may be from this server's clock, either way. */
export const HOOK_TOLERANCE_S = 300;
/** A webhook-id: printable ASCII with no space, as the spec's `msg_...` ids are; it goes into a firing's key and history. */
const HOOK_ID = /^[\x21-\x7e]{1,255}$/;
/** The longest `webhook-signature` list read: room for many keys during a rotation, never an unbounded loop. */
const MAX_SIGNATURES_CHARS = 2048;
/** The fewest bytes a signing key may have (the spec's secrets are 24 to 64; this server makes 32): a shorter one,
 *  an empty one above all, signs nothing. */
const MIN_KEY_BYTES = 24;

/** Why a request's webhook headers are refused before its body is read, or undefined when they may be checked:
 *  present, a webhook-id of printable ASCII, a bounded signature list, a timestamp within HOOK_TOLERANCE_S. */
export function hookHeadersRefusal(headers: Record<string, string | string[] | undefined>, nowMs: number): string | undefined {
  const [id, timestamp, signatures] = ["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => headers[name]);
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signatures !== "string") return "missing_headers";
  if (!HOOK_ID.test(id) || signatures.length > MAX_SIGNATURES_CHARS) return "malformed_headers";
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > HOOK_TOLERANCE_S) return "stale_timestamp";
  return undefined;
}

/** Why a request to /v2/hooks/{id} is not signed by `secret` under the Standard Webhooks spec, or undefined when it is:
 *  `webhook-signature` lists `v1,<base64 HMAC-SHA256 of "{webhook-id}.{webhook-timestamp}.{body}">` signatures, space
 *  separated, under the secret's bytes, and any one that matches passes; the timestamp is within HOOK_TOLERANCE_S. */
export function hookRefusal(secret: string, headers: Record<string, string | string[] | undefined>, body: Buffer, nowMs: number): string | undefined {
  const early = hookHeadersRefusal(headers, nowMs);
  if (early) return early;
  const [id, timestamp, signatures] = ["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => headers[name] as string);
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest();
  // Compared all the same, so a short key costs what a good one does; it fails after.
  const matched = signatures!.split(" ").some((part) => {
    const [version, signature] = part.split(",");
    const given = Buffer.from(signature ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (key.length < MIN_KEY_BYTES) return "short_key";
  return matched ? undefined : "bad_signature";
}
