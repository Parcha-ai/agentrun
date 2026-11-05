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

/** The sealed secrets `file` keeps, by trigger id. */
function sealedIn(file: string): Record<string, string> {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isObject(doc) && doc.v === 1 && isObject(doc.secrets) ? (Object.fromEntries(Object.entries(doc.secrets).filter(([, v]) => typeof v === "string")) as Record<string, string>) : {};
  } catch {
    return {};
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
  return key ? Object.values(opened(key, sealedIn(join(data, TRIGGER_SECRETS_FILE)))) : [];
}

export class TriggerSecrets {
  private readonly file: string;
  private readonly key: Buffer | undefined;
  /** Opened, by trigger id: read once at start, then kept with every write. */
  private secrets: Record<string, string>;
  private sealed: Record<string, string>;

  constructor(data: string, env: NodeJS.ProcessEnv) {
    this.file = join(data, TRIGGER_SECRETS_FILE);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    this.sealed = sealedIn(this.file);
    this.secrets = this.key ? opened(this.key, this.sealed) : {};
  }

  get sealing(): "sealed" | "unavailable" {
    return this.key ? "sealed" : "unavailable";
  }

  /** A new secret for `triggerId`, written sealed before it is answered: its only showing. */
  mint(triggerId: string): string {
    if (!this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no webhook trigger's secret: it never keeps one in the clear.`);
    const secret = `whsec_${randomBytes(32).toString("base64")}`;
    this.write({ ...this.sealed, [triggerId]: seal(this.key, Buffer.from(secret, "utf8"), aad(triggerId)).toString("base64") });
    this.secrets[triggerId] = secret;
    return secret;
  }

  value(triggerId: string): string | undefined {
    return this.secrets[triggerId];
  }

  remove(triggerId: string): void {
    if (!(triggerId in this.sealed)) return;
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

/** Why a request to /v2/hooks/{id} is not signed by `secret` under the Standard Webhooks spec, or undefined when it is:
 *  `webhook-signature` lists `v1,<base64 HMAC-SHA256 of "{webhook-id}.{webhook-timestamp}.{body}">` signatures, space
 *  separated, under the secret's bytes, and any one that matches passes; the timestamp is within HOOK_TOLERANCE_S. */
export function hookRefusal(secret: string, headers: Record<string, string | string[] | undefined>, body: Buffer, nowMs: number): string | undefined {
  const [id, timestamp, signatures] = ["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => headers[name]);
  if (typeof id !== "string" || id.length < 1 || id.length > 255 || typeof timestamp !== "string" || typeof signatures !== "string") return "missing_headers";
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > HOOK_TOLERANCE_S) return "stale_timestamp";
  const expected = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64")).update(`${id}.${timestamp}.`).update(body).digest();
  const matched = signatures.split(" ").some((part) => {
    const [version, signature] = part.split(",");
    const given = Buffer.from(signature ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matched ? undefined : "bad_signature";
}
