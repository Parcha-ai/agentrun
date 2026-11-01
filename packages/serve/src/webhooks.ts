// The webhook a person sets through /v2/settings/webhook: one URL this server POSTs to when a run comes to need its
// person (`run.needs_input`, its status input_required) and when it ends (`run.ended`: completed, failed or cancelled,
// once carried back). Each delivery is signed: `x-agentrun-signature: v1=<hex>`, the HMAC-SHA256 of
// `<x-agentrun-timestamp>.<body>` under the webhook's secret, which this server makes at the first PUT, shows once, and
// keeps in DIR/webhook.json only sealed under the tool keys' seal key (tool-keys.ts). A delivery not answered 2xx is
// tried again, then logged as failed. Deliveries live in DIR/webhook-outbox.json, the pending with their bodies and the
// last ones done for GET .../deliveries, so a restart resumes the pending ones. Never in store.sqlite, which runs open.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { isObject } from "./validate.js";

export const WEBHOOK_EVENTS = ["run.needs_input", "run.ended"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** The headers of a delivery: its event, its id (the same on each try of it), the time it was signed, and the signature. */
export const WEBHOOK_HEADERS = { event: "x-agentrun-event", delivery: "x-agentrun-delivery", timestamp: "x-agentrun-timestamp", signature: "x-agentrun-signature" } as const;
export const WEBHOOK_FILE = "webhook.json";
export const OUTBOX_FILE = "webhook-outbox.json";
/** The waits before each try again of a delivery: four tries over about six minutes. */
export const RETRY_MS: readonly number[] = [10_000, 60_000, 300_000];
const TIMEOUT_MS = 10_000;
/** How many deliveries done (delivered or failed) are kept for the settings view. */
export const DELIVERIES_KEPT = 50;
const FORMAT = "webhook/1";
const MAX_URL = 2048;

/** What a delivery says of its run. */
export type RunNotice = { run_id: string; agent_id: string; status: string; title: string };
type Config = { url: string; events: WebhookEvent[]; secret: string; updated_at: string };
type Delivery = {
  id: string; event: WebhookEvent | "ping"; event_id: string; run_id: string | null; body: string; created_at: string;
  status: "pending" | "delivered" | "failed"; attempts: number; status_code: number | null; error: string | null; last_attempt_at: string | null; next_at: number | null;
};
export type DeliveryView = Omit<Delivery, "body" | "next_at"> & { next_attempt_at: string | null };
/** Why the secret does not sign here: no seal key now, or it does not open under this one (another key, or damaged). */
type SecretState = "sealed" | "seal_key_missing" | "unreadable";

const aad = `${FORMAT}|secret`;
const iso = (ms: number) => new Date(ms).toISOString();
/** The signature of `body` sent at `timestamp` (Unix seconds) under `secret`, as the signature header carries it. */
export const signatureOf = (secret: string, timestamp: string, body: string) => `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

export class Webhooks {
  private readonly file: string;
  private readonly outbox: string;
  private readonly key: Buffer | undefined;
  private deliveries: Delivery[];
  private readonly timers = new Set<NodeJS.Timeout>();
  /** The tries in flight, which close() stops and waits for: nothing is written once it is closed. */
  private readonly trying = new Set<Promise<void>>();
  private readonly stop = new AbortController();
  private closed = false;

  /** `env` is the server's own (withSecrets); `say` takes a log line's fields; `retryMs` the waits between tries. */
  constructor(data: string, env: NodeJS.ProcessEnv, private readonly say: (fields: Record<string, string | number>) => void, private readonly retryMs: readonly number[] = RETRY_MS) {
    this.file = join(data, WEBHOOK_FILE);
    this.outbox = join(data, OUTBOX_FILE);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    this.deliveries = this.readOutbox();
    // A restart goes on with the deliveries an earlier server left pending, each at its next try's time; a ping is tried
    // once, so one left in flight failed.
    const pings = this.deliveries.filter((d) => d.status === "pending" && d.event === "ping");
    for (const ping of pings) Object.assign(ping, { status: "failed", error: "the server stopped before its answer", next_at: null });
    if (pings.length) this.writeOutbox();
    for (const delivery of this.deliveries) if (delivery.status === "pending") this.schedule(delivery, Math.max(0, (delivery.next_at ?? 0) - Date.now()));
  }

  private config(): Config | undefined {
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return isObject(doc) && doc.v === 1 && typeof doc.url === "string" && Array.isArray(doc.events) && typeof doc.secret === "string" ? (doc as unknown as Config) : undefined;
    } catch {
      return undefined;
    }
  }

  private readOutbox(): Delivery[] {
    try {
      const doc = JSON.parse(readFileSync(this.outbox, "utf8")) as unknown;
      return isObject(doc) && Array.isArray(doc.deliveries) ? (doc.deliveries.filter((d) => isObject(d) && typeof d.id === "string" && typeof d.body === "string") as Delivery[]) : [];
    } catch {
      return [];
    }
  }

  private writeOutbox(): void {
    // Closed, the data directory may be another server's already.
    if (this.closed) return;
    // The pending, and the newest of those done.
    const done = this.deliveries.filter((d) => d.status !== "pending").slice(-DELIVERIES_KEPT);
    this.deliveries = this.deliveries.filter((d) => d.status === "pending" || done.includes(d));
    try {
      writeDurableSync(this.outbox, `${JSON.stringify({ v: 1, deliveries: this.deliveries.map((d) => (d.status === "pending" ? d : { ...d, body: "" })) })}\n`);
    } catch (error) {
      this.say({ condition: "outbox_unwritable", file: this.outbox, error: (error as NodeJS.ErrnoException).code ?? "unknown" });
    }
  }

  /** The secret, opened, or why it is not. */
  private secret(config: Config): { secret: string } | { state: Exclude<SecretState, "sealed"> } {
    if (!this.key) return { state: "seal_key_missing" };
    try {
      return { secret: unseal(this.key, Buffer.from(config.secret, "base64"), aad).toString("utf8") };
    } catch {
      return { state: "unreadable" };
    }
  }

  private sealed(secret: string): string {
    return seal(this.key!, Buffer.from(secret, "utf8"), aad).toString("base64");
  }

  /** GET: the URL and events, and whether the secret signs here; never the secret. */
  view() {
    const config = this.config();
    if (!config) return { configured: false as const };
    const opened = this.secret(config);
    return { configured: true as const, url: config.url, events: config.events, signing: ("secret" in opened ? "sealed" : opened.state) as SecretState, updated_at: config.updated_at };
  }

  /** PUT: the URL and events. The first makes the secret and answers it, once; a later one keeps it. */
  save(body: Record<string, unknown>): { created: boolean; view: ReturnType<Webhooks["view"]>; secret?: string } {
    const issues: InputIssue[] = Object.keys(body).filter((key) => key !== "url" && key !== "events").map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
    const url = typeof body.url === "string" && body.url.length <= MAX_URL ? URL.parse(body.url) : null;
    if (body.url === undefined) issues.push({ field: "url", reason: "missing", message: "url is the http or https address to POST each event to" });
    else if (!url || !["http:", "https:"].includes(url.protocol)) issues.push({ field: "url", reason: "invalid", message: `url is an http or https address of at most ${MAX_URL} characters` });
    else if (url.username || url.password) issues.push({ field: "url", reason: "invalid", message: "url holds no user or password: the receiver checks the signature" });
    const events = body.events === undefined ? [...WEBHOOK_EVENTS] : body.events;
    if (!Array.isArray(events) || !events.length || !events.every((e) => (WEBHOOK_EVENTS as readonly unknown[]).includes(e)) || new Set(events).size !== events.length) {
      issues.push({ field: "events", reason: "invalid", message: `events is one or more of ${WEBHOOK_EVENTS.join(", ")}, each once` });
    }
    if (issues.length) throw invalid(issues);
    const was = this.config();
    let secret: string | undefined;
    if (!was) {
      if (!this.key) throw this.noKey();
      secret = `whsec_${randomBytes(32).toString("base64url")}`;
    }
    this.write({ url: url!.href, events: events as WebhookEvent[], secret: was?.secret ?? this.sealed(secret!), updated_at: new Date().toISOString() });
    return { created: !was, view: this.view(), ...(secret ? { secret } : {}) };
  }

  /** POST .../rotate: a new secret, answered once; the old one signs nothing more. */
  rotate(): { secret: string } {
    const config = this.need();
    if (!this.key) throw this.noKey();
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    this.write({ ...config, secret: this.sealed(secret), updated_at: new Date().toISOString() });
    return { secret };
  }

  /** DELETE: the webhook gone, and its pending deliveries with it; the log of those done stays. */
  remove(): void {
    if (!this.config()) return;
    rmSync(this.file, { force: true });
    const now = new Date().toISOString();
    for (const delivery of this.deliveries.filter((d) => d.status === "pending")) Object.assign(delivery, { status: "failed", error: "the webhook was removed", next_at: null, last_attempt_at: delivery.last_attempt_at ?? now });
    this.writeOutbox();
  }

  /** GET .../deliveries: the pending and the last done, newest first, without their bodies. */
  deliveriesView(): { deliveries: DeliveryView[] } {
    return { deliveries: [...this.deliveries].reverse().map(viewOf) };
  }

  /** A run's notice: queued for delivery when a webhook is set and takes `event`. `marker` makes its event id: the same
   *  notice of the same moment (seen again after a restart) has the same id, for a receiver to know it again. */
  emit(event: WebhookEvent, run: RunNotice, marker: string): void {
    const config = this.config();
    if (this.closed || !config?.events.includes(event)) return;
    const eventId = `evt_${createHash("sha256").update(`${run.run_id}\n${event}\n${marker}`).digest("hex").slice(0, 32)}`;
    this.enqueue(event, eventId, run.run_id, { id: eventId, event, at: new Date().toISOString(), run });
  }

  /** POST .../test: a `ping` delivered once now, never tried again; its delivery as it ended. */
  async test(): Promise<DeliveryView> {
    this.need();
    const id = `evt_${randomBytes(16).toString("hex")}`;
    const delivery = this.enqueue("ping", id, null, { id, event: "ping", at: new Date().toISOString(), run: null }, false);
    await this.attempt(delivery, false);
    return viewOf(delivery);
  }

  /** Stops: no try starts, those in flight are cut and waited for, and nothing more is written. A delivery cut here is
   *  still pending on disk, for the next server (its receiver may then get it twice, with the same delivery id). */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.stop.abort();
    await Promise.allSettled([...this.trying]);
  }

  private enqueue(event: Delivery["event"], eventId: string, runId: string | null, payload: Record<string, unknown>, now = true): Delivery {
    const delivery: Delivery = {
      id: `dlv_${randomBytes(16).toString("hex")}`, event, event_id: eventId, run_id: runId, body: JSON.stringify(payload), created_at: new Date().toISOString(),
      status: "pending", attempts: 0, status_code: null, error: null, last_attempt_at: null, next_at: Date.now(),
    };
    this.deliveries.push(delivery);
    this.writeOutbox();
    if (now) this.schedule(delivery, 0);
    return delivery;
  }

  private schedule(delivery: Delivery, delayMs: number): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.attempt(delivery, true);
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  private attempt(delivery: Delivery, retry: boolean): Promise<void> {
    const trying = this.tryOnce(delivery, retry).finally(() => this.trying.delete(trying));
    this.trying.add(trying);
    return trying;
  }

  /** One try: POSTed, signed, to the URL set now; no redirect followed, at most 10 s. Not 2xx: tried again after the
   *  next wait (`retry`), else failed, and the log says so. */
  private async tryOnce(delivery: Delivery, retry: boolean): Promise<void> {
    if (this.closed || delivery.status !== "pending") return;
    const config = this.config();
    const now = Date.now();
    delivery.attempts += 1;
    delivery.last_attempt_at = iso(now);
    let failure: string | undefined;
    if (!config) failure = "the webhook was removed";
    else {
      const opened = this.secret(config);
      if (!("secret" in opened)) failure = `the secret does not open here (${opened.state}): rotate it`;
      else {
        const timestamp = String(Math.floor(now / 1000));
        try {
          const res = await fetch(config.url, {
            method: "POST", redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.stop.signal]),
            headers: { "content-type": "application/json", "user-agent": "agentrun-serve-webhook/1", [WEBHOOK_HEADERS.event]: delivery.event, [WEBHOOK_HEADERS.delivery]: delivery.id, [WEBHOOK_HEADERS.timestamp]: timestamp, [WEBHOOK_HEADERS.signature]: signatureOf(opened.secret, timestamp, delivery.body) },
            body: delivery.body,
          });
          await res.body?.cancel().catch(() => undefined);
          delivery.status_code = res.status;
          if (res.status < 200 || res.status > 299) failure = res.status >= 300 && res.status < 400 ? `answered ${res.status}: a redirect is not followed` : `answered ${res.status}`;
        } catch (error) {
          delivery.status_code = null;
          failure = (error as Error).name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : `not reached: ${(error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message}`;
        }
      }
    }
    if (this.closed) return;
    delivery.error = failure ?? null;
    const wait = retry && failure && config ? this.retryMs[delivery.attempts - 1] : undefined;
    if (!failure) Object.assign(delivery, { status: "delivered", next_at: null });
    else if (wait !== undefined) {
      delivery.next_at = Date.now() + wait;
      this.schedule(delivery, wait);
    } else {
      Object.assign(delivery, { status: "failed", next_at: null });
      this.say({ condition: "delivery_failed", event: delivery.event, delivery: delivery.id, attempts: delivery.attempts, ...(delivery.status_code !== null ? { status_code: delivery.status_code } : {}), error: failure });
    }
    this.writeOutbox();
  }

  private need(): Config {
    const config = this.config();
    if (!config) throw new ApiError("not_found", "no webhook is set: PUT /v2/settings/webhook sets one");
    return config;
  }

  private noKey(): ApiError {
    return new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no webhook secret: it never keeps one in the clear.`);
  }

  private write(config: Config): void {
    writeDurableSync(this.file, `${JSON.stringify({ v: 1, ...config }, null, 2)}\n`);
  }
}

function viewOf({ body: _, next_at, ...rest }: Delivery): DeliveryView {
  return { ...rest, next_attempt_at: next_at === null ? null : iso(next_at) };
}
