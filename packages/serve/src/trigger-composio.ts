// Composio: a trigger source pushed to the server by Composio, the one integration catalog. A Composio trigger instance
// (one trigger type, `trigger_slug`, turned on for one connected account, `connection_ref`) delivers each event to this
// server's one Composio hook, /v2/hooks/composio, signed with the project's webhook secret. Composio's half (which
// trigger types a toolkit has, turning an instance on or off, the project's webhook subscription) is the tools plane's
// TriggerFace (ComposioTriggers below): this plane never calls Composio. Its half is the delivery: verify, parse, dedupe,
// fire. An event names its instance (metadata.trigger_id), which is the one trigger's scope that turned it on; its
// `data` is the run's untrusted payload; its key is the Standard Webhooks message id (webhook-id), the same on every
// retry, so one event is one firing.
import { createHmac, timingSafeEqual } from "node:crypto";
import { HOOK_TOLERANCE_S, headersRefusal } from "./standard-webhooks.js";
import { ACCEPT_SCHEMA, acceptOf, acceptRefusal, type Rule } from "./trigger-accept.js";
import { closedSchema, type Headers, type Source, type TriggerAdapter, unknownSourceFields } from "./trigger-adapter.js";
import type { Scheme } from "./trigger-signatures.js";
import { isObject } from "./validate.js";

/** The tools plane's half of a Composio trigger (the 11-05 kernel page's TriggerFace), over the one Composio key and
 *  connection store: the trigger plane turns instances on and off through it and is handed the webhook secret once, to
 *  seal. Every method throws on a refusal, in words fit to show (an ApiError keeps its code). */
export interface ComposioTriggers {
  /** The user id this server's connections are made under at Composio: an event for another user is not this server's. */
  readonly userId: string;
  /** Turns trigger type `slug` on for connection `connectionRef` with `config` (the type's config_schema), answering
   *  Composio's instance id (ti_*). The same slug, config and connection again answers the same instance. */
  enable(slug: string, config: Record<string, unknown>, connectionRef: string): Promise<{ instanceRef: string }>;
  /** Turns the instance off at Composio. One already gone is no refusal. */
  disable(instanceRef: string): Promise<void>;
  /** The project's one webhook subscription, made or moved to `url` (V3 payloads, trigger messages), and its secret,
   *  handed back this once; `rotate`: a new secret. */
  webhook(url: string, options?: { rotate?: true }): Promise<{ secret: string }>;
}

/** The server's Composio settings (sealed-settings.ts, the server's scope): the webhook secret Composio signs with, the
 *  user id its events must name, and the URL the subscription delivers to. */
export const COMPOSIO_FIELDS = { secret: "webhook_secret", userId: "user_id", url: "webhook_url" } as const;
/** The longest of a sender's words a payload's attrs keep. */
const ATTR_CHARS = 200;
/** A trigger type's slug, as Composio names them (SLACK_CHANNEL_MESSAGE_RECEIVED). */
const SLUG = /^[A-Z][A-Z0-9_]{1,127}$/;
/** A connection's or an instance's id at Composio (ca_..., ti_...): printable ASCII, no space. */
const REF = /^[\x21-\x7e]{1,200}$/;
/** The most JSON a trigger's config may hold. */
const CONFIG_MAX = 8 << 10;
/** The fewest bytes a webhook secret may have: a shorter one, an empty one above all, signs nothing. */
const MIN_SECRET_BYTES = 16;
/** The longest webhook-signature list read. */
const MAX_SIGNATURES_CHARS = 2048;

const hmac = (secret: string, id: string, timestamp: string, body: Buffer): Buffer => createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${timestamp}.`).update(body).digest();

/** Composio's signature, as its docs give it ("Receiving events"): Standard Webhooks' headers and signed string
 *  (`{webhook-id}.{webhook-timestamp}.{body}`, base64 HMAC-SHA256, `v1,<signature>`, space-separated), keyed by the
 *  secret's UTF-8 bytes as Composio hands it back, not by a `whsec_` secret's base64 key. So it is its own row, never the
 *  webhook trigger's `standard`, whose headers it shares. */
export const COMPOSIO_SCHEME: Scheme = {
  signatureHeader: "webhook-signature",
  describe: `\`composio\` takes Composio's delivery: \`webhook-id\` (the firing's key), \`webhook-timestamp\` (within ${HOOK_TOLERANCE_S} s) and \`webhook-signature\`, \`v1,<base64 HMAC-SHA256 of "{webhook-id}.{webhook-timestamp}.{body}">\` keyed by the UTF-8 bytes of the project's webhook secret.`,
  precheck: headersRefusal,
  verify(key, headers, body, nowMs) {
    const early = headersRefusal(headers, nowMs);
    if (early) return early;
    const signatures = headers["webhook-signature"] as string;
    if (signatures.length > MAX_SIGNATURES_CHARS) return "malformed_headers";
    const expected = hmac(key, headers["webhook-id"] as string, headers["webhook-timestamp"] as string, body);
    // Every listed signature is compared, so the time taken does not say which matched, or whether the key is short.
    let matched = false;
    for (const entry of signatures.split(" ")) {
      const [version, value] = entry.split(",", 2);
      if (version !== "v1" || value === undefined) continue;
      const given = Buffer.from(value, "base64");
      if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
    }
    if (Buffer.byteLength(key, "utf8") < MIN_SECRET_BYTES) return "short_key";
    return matched ? undefined : "bad_signature";
  },
  // webhook-id is signed, and Composio sends the same one on every retry of an event (Standard Webhooks' message id).
  firingKeyOf: (headers) => headers["webhook-id"] as string,
  eventOf: (_headers, json) => (isObject(json) && isObject(json.metadata) && typeof json.metadata.trigger_slug === "string" ? json.metadata.trigger_slug : undefined),
};

/** A V3 envelope (Composio's default payload): its id, its type, its metadata, its data. Undefined for any other. */
type Envelope = { id: string | undefined; type: string; metadata: { trigger_id: string; trigger_slug: string; user_id?: string; connected_account_id?: string; log_id?: string }; data: unknown };
function envelopeOf(body: Buffer): Envelope | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(doc) || !isObject(doc.metadata) || typeof doc.type !== "string") return undefined;
  const { trigger_id, trigger_slug, user_id, connected_account_id, log_id } = doc.metadata;
  if (typeof trigger_id !== "string" || !REF.test(trigger_id) || typeof trigger_slug !== "string") return undefined;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    id: text(doc.id), type: doc.type, data: doc.data,
    metadata: { trigger_id, trigger_slug, ...(text(user_id) !== undefined ? { user_id: user_id as string } : {}), ...(text(connected_account_id) !== undefined ? { connected_account_id: connected_account_id as string } : {}), ...(text(log_id) !== undefined ? { log_id: log_id as string } : {}) },
  };
}

/** The source's fields, checked: each issue through `bad`. `instance_ref` is the server's (made when the trigger is on),
 *  never a write's: one a write sends (a view sent back) is dropped. */
function fieldsOf(value: Record<string, unknown>, bad: (field: string, reason: string, message: string) => void, kept?: unknown): Source | undefined {
  let failed = false;
  const no = (field: string, reason: string, message: string) => ((failed = true), bad(field, reason, message));
  if (typeof value.trigger_slug !== "string" || !SLUG.test(value.trigger_slug)) no("trigger_slug", value.trigger_slug === undefined ? "missing" : "invalid", "trigger_slug is a Composio trigger type's slug (SLACK_CHANNEL_MESSAGE_RECEIVED): capital letters, digits and _");
  if (typeof value.connection_ref !== "string" || !REF.test(value.connection_ref)) no("connection_ref", value.connection_ref === undefined ? "missing" : "invalid", "connection_ref is the Composio connected account the trigger listens on (ca_...)");
  if (value.config !== undefined && (!isObject(value.config) || JSON.stringify(value.config).length > CONFIG_MAX)) no("config", "invalid", `config is an object, the trigger type's config_schema filled in, at most ${CONFIG_MAX} characters as JSON`);
  const accept = value.accept === undefined ? undefined : acceptOf(value.accept, no);
  if (failed) return undefined;
  return {
    kind: "composio", trigger_slug: value.trigger_slug, connection_ref: value.connection_ref,
    ...(value.config !== undefined ? { config: value.config } : {}), ...(accept ? { accept } : {}),
    ...(typeof kept === "string" && REF.test(kept) ? { instance_ref: kept } : {}),
  };
}

const cut = (text: string) => text.slice(0, ATTR_CHARS);

export const composio: TriggerAdapter = {
  id: "composio",
  label: "Composio trigger",
  delivery: "push",
  owner: false,
  // The project's webhook secret (handed back by Composio's subscription, never made here), the user id its events
  // name, and the URL it delivers to: the server's, as Composio's subscription is the project's one.
  settings: { scope: "server", fields: { [COMPOSIO_FIELDS.secret]: { minBytes: MIN_SECRET_BYTES }, [COMPOSIO_FIELDS.userId]: { public: true }, [COMPOSIO_FIELDS.url]: { public: true } } },
  describe: '{kind: "composio", trigger_slug, connection_ref, config?, accept?: [{event, where?}]}',
  fires: "an event of a Composio trigger instance (`trigger_slug` on the connected account `connection_ref`) that Composio delivers to /hooks/composio (`composio`); the instance is turned on at Composio while the trigger is on, and off when it is turned off or deleted",
  firedBy: "`composio`: an event Composio delivered for the trigger's instance, keyed by its webhook-id (the same on every retry).",
  schemas: [closedSchema(
    { kind: { const: "composio" }, trigger_slug: { type: "string", pattern: SLUG.source, description: "The Composio trigger type (GET /api/v3.1/triggers_types), e.g. SLACK_CHANNEL_MESSAGE_RECEIVED or GITHUB_PULL_REQUEST_EVENT." }, connection_ref: { type: "string", minLength: 1, maxLength: 200, description: "The Composio connected account it listens on (ca_...): one connected on this server." } },
    { config: { type: "object", description: "The trigger type's config_schema, filled in (a Slack channel_id, a repository): passed to Composio as it is." }, accept: { ...ACCEPT_SCHEMA, description: "Which events fire it, beyond the trigger type: a rule's `event` is the trigger_slug, its `where` conditions on the event's data. Absent: every event of the instance." } },
  )],
  sent: [closedSchema(
    { kind: { const: "composio" }, trigger_slug: { type: "string" }, connection_ref: { type: "string" } },
    { config: { type: "object" }, accept: ACCEPT_SCHEMA, instance_ref: { type: "string", description: "Composio's id for the instance this trigger turned on (ti_...), while the trigger is on. The server's; a write's is dropped." } },
  )],
  parse(value, _now, bad, issues) {
    issues.push(...unknownSourceFields(value, ["kind", "trigger_slug", "connection_ref", "config", "accept", "instance_ref"]));
    return fieldsOf(value, bad);
  },
  wellFormed: (source) => fieldsOf(source, () => {}, source.instance_ref) !== undefined,
  // Its instance is its scope: an event names the instance that delivered it (metadata.trigger_id), and an instance is
  // one trigger's. A trigger with none (off) listens on nothing.
  scopeOf: (source) => (typeof source.instance_ref === "string" ? source.instance_ref : ""),
  takes: (source, event) => (Array.isArray(source.accept) ? acceptRefusal(source.accept as Rule[], event.event, event.body) : undefined),
  // Each event is its own work (a message, a pull request); max_active_runs bounds it.
  concurrent: () => true,
  push: {
    maxBodyBytes: 256 << 10,
    key: COMPOSIO_FIELDS.secret,
    headers: (headers, nowMs) => COMPOSIO_SCHEME.precheck(headers, nowMs),
    verify: (key, headers, body, nowMs) => COMPOSIO_SCHEME.verify(key, headers, body, nowMs),
    // Verified, and not this server's to take: answered 200 (sent again it changes nothing) and said. An envelope this
    // plane does not read (V1, V2), and an event for another user id.
    handshake(headers: Headers, body, ctx) {
      const envelope = envelopeOf(body);
      if (!envelope) {
        ctx.say({ condition: "composio_unread", reason: "not a V3 trigger payload" });
        return { status: 200, body: { ok: "ignored" } };
      }
      const userId = ctx.setting(COMPOSIO_FIELDS.userId);
      if (userId !== undefined && envelope.metadata.user_id !== userId) {
        ctx.say({ condition: "composio_other_user", instance: cut(envelope.metadata.trigger_id) });
        return { status: 200, body: { ok: "ignored" } };
      }
      // The key is webhook-id; the envelope's own id is kept beside it, and one that differs is said, so a retry that does
      // not repeat webhook-id would show before it fired twice.
      if (envelope.id !== undefined && envelope.id !== headers["webhook-id"]) ctx.say({ condition: "composio_id_differs", webhook_id: cut(headers["webhook-id"] as string), id: cut(envelope.id) });
      return undefined;
    },
    parse(headers, body) {
      const envelope = envelopeOf(body)!;
      const { metadata } = envelope;
      const attrs = {
        scheme: "composio",
        event: cut(metadata.trigger_slug),
        ...(metadata.connected_account_id !== undefined ? { connection: cut(metadata.connected_account_id) } : {}),
        ...(metadata.log_id !== undefined ? { log_id: cut(metadata.log_id) } : {}),
      };
      // The run is given the event's data, untrusted (the engine tags and cuts it), never Composio's envelope.
      const text = JSON.stringify(envelope.data ?? null);
      return [{ key: COMPOSIO_SCHEME.firingKeyOf(headers, body), text, scope: metadata.trigger_id, attrs, event: metadata.trigger_slug, body: envelope.data }];
    },
  },
};
