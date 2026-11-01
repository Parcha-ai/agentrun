// The webhook a person sets through /v2/settings/webhook: one URL this server POSTs to when a run comes to need its
// person (`run.needs_input`, its status input_required) and when it ends (`run.ended`: completed, failed or cancelled,
// once carried back). Each message is signed by the Standard Webhooks spec (standardwebhooks.com), so a receiver checks
// it with any of that spec's libraries: `webhook-id` (the same on every try: the receiver's idempotency key),
// `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">`
// under the secret `whsec_<base64 of 32 bytes>`, which this server makes at the first PUT, shows once, and keeps in
// DIR/webhook.json only sealed under the tool keys' seal key (tool-keys.ts). A message not answered 2xx is tried again
// on the spec's schedule, cut at about a day; a 410 turns the webhook off. Messages and the last attempts live in
// DIR/webhook-outbox.json, so a restart goes on with those pending. Never in store.sqlite, which runs open.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { isObject } from "./validate.js";

export const WEBHOOK_EVENTS = ["run.needs_input", "run.ended"] as const;
/** The message types: a run's two notices, and the test send's. */
export const MESSAGE_TYPES = [...WEBHOOK_EVENTS, "webhook.test"] as const;
type MessageType = (typeof MESSAGE_TYPES)[number];
export const WEBHOOK_FILE = "webhook.json";
export const OUTBOX_FILE = "webhook-outbox.json";
/** The waits before each try again, after the first at once: the Standard Webhooks schedule, cut at about a day. */
export const RETRY_MS: readonly number[] = [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000];
const TIMEOUT_MS = 15_000;
/** How many attempts the log keeps, and with them the messages they tried, for a redelivery. */
export const ATTEMPTS_KEPT = 50;
const FORMAT = "webhook/1";
const MAX_URL = 2048;

/** What a notice says of its run: never its tools' arguments, its output or its input, which a receiver reads through the API. */
export type RunNotice = { run_id: string; agent_id: string; status: string; title: string; pending?: { kind: "question" | "stopped" } };
type Config = { url: string; secret: string; updated_at: string; disabled?: { at: string; reason: string } };
type Message = { id: string; type: MessageType; body: string; created_at: string; status: "pending" | "delivered" | "failed"; attempts: number; next_at: number | null };
export type Attempt = { webhook_id: string; type: MessageType; at: string; status_code: number | null; latency_ms: number; error: string | null; retry_at: string | null; redelivery: boolean };
/** Whether the secret signs here: sealed, or not, for no seal key now or one it does not open under. */
type Signing = "sealed" | "seal_key_missing" | "unreadable";

const aad = `${FORMAT}|secret`;
const iso = (ms: number) => new Date(ms).toISOString();
/** The signature header of `body`, sent as message `id` at `timestamp` (Unix seconds), under `secret` (`whsec_...`). */
export const signatureOf = (secret: string, id: string, timestamp: string, body: string) =>
  `v1,${createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;

export class Webhooks {
  private readonly file: string;
  private readonly outbox: string;
  private readonly key: Buffer | undefined;
  private messages: Message[];
  private attempts: Attempt[];
  private base = "";
  private readonly timers = new Set<NodeJS.Timeout>();
  /** The tries in flight, which close() stops and waits for: nothing is written once it is closed. */
  private readonly trying = new Set<Promise<Attempt>>();
  private readonly stop = new AbortController();
  private closed = false;

  /** `env` is the server's own (withSecrets); `say` takes a log line's fields; `retryMs` the waits between tries. */
  constructor(data: string, env: NodeJS.ProcessEnv, private readonly say: (fields: Record<string, string | number>) => void, private readonly retryMs: readonly number[] = RETRY_MS) {
    this.file = join(data, WEBHOOK_FILE);
    this.outbox = join(data, OUTBOX_FILE);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    ({ messages: this.messages, attempts: this.attempts } = this.readOutbox());
    // A restart goes on with the messages an earlier server left pending, each at its next try's time; a test send is
    // tried once, so one left in flight failed.
    const tests = this.messages.filter((m) => m.status === "pending" && m.type === "webhook.test");
    for (const test of tests) Object.assign(test, { status: "failed", next_at: null });
    if (tests.length) this.writeOutbox();
    for (const message of this.messages) if (message.status === "pending") this.schedule(message, Math.max(0, (message.next_at ?? 0) - Date.now()));
  }

  /** Where the page is, for each notice's link to its run. */
  attach(base: string): void {
    this.base = base.replace(/\/+$/, "");
  }

  /** GET: the URL, whether the secret signs here, and why the webhook is off, if it is; never the secret. */
  view() {
    const config = this.config();
    if (!config) return { configured: false as const };
    const opened = this.secret(config);
    return { configured: true as const, url: config.url, signing: ("secret" in opened ? "sealed" : opened.signing) as Signing, disabled: config.disabled ?? null, updated_at: config.updated_at };
  }

  /** PUT: the URL, and the webhook on again. The first makes the secret and answers it, once; a later one keeps it. */
  save(body: Record<string, unknown>): { created: boolean; view: ReturnType<Webhooks["view"]>; secret?: string } {
    const issues: InputIssue[] = Object.keys(body).filter((key) => key !== "url").map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
    const url = typeof body.url === "string" && body.url.length <= MAX_URL ? URL.parse(body.url) : null;
    if (body.url === undefined) issues.push({ field: "url", reason: "missing", message: "url is the http or https address to POST each message to" });
    else if (!url || !["http:", "https:"].includes(url.protocol)) issues.push({ field: "url", reason: "invalid", message: `url is an http or https address of at most ${MAX_URL} characters` });
    else if (url.username || url.password) issues.push({ field: "url", reason: "invalid", message: "url holds no user or password: the receiver checks the signature" });
    if (issues.length) throw invalid(issues);
    const was = this.config();
    if (!was && !this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no webhook secret: it never keeps one in the clear.`);
    const secret = was ? undefined : `whsec_${randomBytes(32).toString("base64")}`;
    this.write({ url: url!.href, secret: was?.secret ?? seal(this.key!, Buffer.from(secret!, "utf8"), aad).toString("base64"), updated_at: new Date().toISOString() });
    return { created: !was, view: this.view(), ...(secret ? { secret } : {}) };
  }

  /** DELETE: the webhook gone, and its pending messages with it; the log of attempts stays. */
  remove(): void {
    if (!this.config()) return;
    rmSync(this.file, { force: true });
    this.drop("the webhook was removed");
  }

  /** GET .../deliveries: the last attempts, newest first. */
  attemptsView(): { attempts: Attempt[] } {
    return { attempts: [...this.attempts].reverse() };
  }

  /** A run's notice, queued when a webhook is set and on. `marker` makes its webhook-id: the same notice of the same
   *  moment, seen again after a restart, has the same id, which is a receiver's idempotency key. */
  emit(type: (typeof WEBHOOK_EVENTS)[number], run: RunNotice, marker: string): void {
    const config = this.config();
    if (this.closed || !config || config.disabled) return;
    const id = `msg_${createHash("sha256").update(`${run.run_id}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;
    if (this.messages.some((m) => m.id === id)) return;
    const data = { run_id: run.run_id, agent_id: run.agent_id, status: run.status, title: run.title, url: `${this.base}/#/runs/${encodeURIComponent(run.run_id)}`, ...(run.pending ? { pending: run.pending } : {}) };
    this.schedule(this.enqueue(id, type, data), 0);
  }

  /** POST .../test: a `webhook.test` message tried once now, never again; its attempt. */
  test(): Promise<Attempt> {
    this.need();
    return this.attempt(this.enqueue(`msg_${randomBytes(16).toString("hex")}`, "webhook.test", {}), { retry: false, redelivery: false });
  }

  /** POST .../deliveries/{webhook_id}/redeliver: the message sent again once now, under its own webhook-id and body. */
  redeliver(id: string): Promise<Attempt> {
    this.need();
    const message = this.messages.find((m) => m.id === id);
    if (!message) throw new ApiError("not_found", `no message ${id} among the last ${ATTEMPTS_KEPT} attempts`);
    return this.attempt(message, { retry: false, redelivery: true });
  }

  /** Stops: no try starts, those in flight are cut and waited for, and nothing more is written. A message cut here is
   *  still pending on disk, for the next server (its receiver may get it twice, under the same webhook-id). */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.stop.abort();
    await Promise.allSettled([...this.trying]);
  }

  private config(): Config | undefined {
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return isObject(doc) && doc.v === 1 && typeof doc.url === "string" && typeof doc.secret === "string" ? (doc as unknown as Config) : undefined;
    } catch {
      return undefined;
    }
  }

  private write(config: Config): void {
    writeDurableSync(this.file, `${JSON.stringify({ v: 1, ...config }, null, 2)}\n`);
  }

  private readOutbox(): { messages: Message[]; attempts: Attempt[] } {
    try {
      const doc = JSON.parse(readFileSync(this.outbox, "utf8")) as unknown;
      if (!isObject(doc) || doc.v !== 2 || !Array.isArray(doc.messages) || !Array.isArray(doc.attempts)) return { messages: [], attempts: [] };
      return { messages: doc.messages.filter((m) => isObject(m) && typeof m.id === "string" && typeof m.body === "string") as Message[], attempts: doc.attempts.filter(isObject) as Attempt[] };
    } catch {
      return { messages: [], attempts: [] };
    }
  }

  private writeOutbox(): void {
    // Closed, the data directory may be another server's already.
    if (this.closed) return;
    // The last attempts, and the messages pending or tried by one of those (a redelivery sends one again).
    this.attempts = this.attempts.slice(-ATTEMPTS_KEPT);
    const tried = new Set(this.attempts.map((a) => a.webhook_id));
    this.messages = this.messages.filter((m) => m.status === "pending" || tried.has(m.id));
    try {
      writeDurableSync(this.outbox, `${JSON.stringify({ v: 2, messages: this.messages, attempts: this.attempts })}\n`);
    } catch (error) {
      this.say({ condition: "outbox_unwritable", file: this.outbox, error: (error as NodeJS.ErrnoException).code ?? "unknown" });
    }
  }

  /** The secret, opened, or why it is not. */
  private secret(config: Config): { secret: string } | { signing: Exclude<Signing, "sealed"> } {
    if (!this.key) return { signing: "seal_key_missing" };
    try {
      return { secret: unseal(this.key, Buffer.from(config.secret, "base64"), aad).toString("utf8") };
    } catch {
      return { signing: "unreadable" };
    }
  }

  private enqueue(id: string, type: MessageType, data: Record<string, unknown>): Message {
    const created = new Date().toISOString();
    const message: Message = { id, type, body: JSON.stringify({ type, timestamp: created, data }), created_at: created, status: "pending", attempts: 0, next_at: Date.now() };
    this.messages.push(message);
    this.writeOutbox();
    return message;
  }

  private schedule(message: Message, delayMs: number): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.attempt(message, { retry: true, redelivery: false });
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  private attempt(message: Message, how: { retry: boolean; redelivery: boolean }): Promise<Attempt> {
    const trying = this.tryOnce(message, how).finally(() => this.trying.delete(trying));
    this.trying.add(trying);
    return trying;
  }

  /** One try: POSTed, signed, to the URL set now; no redirect followed, at most 15 s. Not 2xx: tried again after the
   *  next wait (`retry`), else failed, and the log says so. A 410 turns the webhook off. A redelivery is a try of its
   *  own: it settles a message still pending when it lands, and never fails one. */
  private async tryOnce(message: Message, how: { retry: boolean; redelivery: boolean }): Promise<Attempt> {
    const now = Date.now();
    const attempt: Attempt = { webhook_id: message.id, type: message.type, at: iso(now), status_code: null, latency_ms: 0, error: null, retry_at: null, redelivery: how.redelivery };
    if (this.closed || (message.status !== "pending" && !how.redelivery)) return attempt;
    const config = this.config();
    let failure: string | undefined;
    if (!config) failure = "the webhook was removed";
    else if (config.disabled && how.retry) failure = "the webhook is off";
    else {
      const opened = this.secret(config);
      if (!("secret" in opened)) failure = `the secret does not open here (${opened.signing}): set the webhook again`;
      else {
        const timestamp = String(Math.floor(now / 1000));
        const started = performance.now();
        try {
          const res = await fetch(config.url, {
            method: "POST", redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.stop.signal]),
            headers: { "content-type": "application/json", "user-agent": "agentrun-serve-webhook/1", "webhook-id": message.id, "webhook-timestamp": timestamp, "webhook-signature": signatureOf(opened.secret, message.id, timestamp, message.body) },
            body: message.body,
          });
          await res.body?.cancel().catch(() => undefined);
          attempt.status_code = res.status;
          if (res.status < 200 || res.status > 299) failure = res.status >= 300 && res.status < 400 ? `answered ${res.status}: a redirect is not followed` : `answered ${res.status}`;
        } catch (error) {
          failure = (error as Error).name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : `not reached: ${(error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message}`;
        }
        attempt.latency_ms = Math.round(performance.now() - started);
      }
    }
    if (this.closed) return attempt;
    attempt.error = failure ?? null;
    this.attempts.push(attempt);
    // The schedule counts the message's own tries: a redelivery is a try of its own, and leaves it as it was.
    if (!how.redelivery) message.attempts += 1;
    // A 410 turns off the webhook as this try found it: one set again or removed while the try waited is not its to turn
    // off, and the 410 is then a failure like any other.
    const standing = this.config();
    const gone = attempt.status_code === 410 && config !== undefined && standing !== undefined && standing.url === config.url && standing.updated_at === config.updated_at && !standing.disabled;
    const wait = how.retry && failure && config && !gone ? this.retryMs[message.attempts - 1] : undefined;
    if (!failure) Object.assign(message, { status: "delivered", next_at: null });
    else if (!how.redelivery && wait !== undefined) {
      // Jitter, so messages that failed together do not all come back together.
      const delay = Math.round(wait * (0.8 + 0.4 * Math.random()));
      message.next_at = Date.now() + delay;
      attempt.retry_at = iso(message.next_at);
      this.schedule(message, delay);
    } else if (!how.redelivery) {
      Object.assign(message, { status: "failed", next_at: null });
      this.say({ condition: "delivery_failed", type: message.type, webhook_id: message.id, attempts: message.attempts, ...(attempt.status_code !== null ? { status_code: attempt.status_code } : {}), error: failure! });
    }
    if (gone) {
      // Gone: the receiver says this endpoint is no more. Off, its pending messages dropped, until a PUT sets it again.
      const disabled = { at: attempt.at, reason: "the receiver answered 410 Gone" };
      this.write({ ...standing!, disabled });
      this.say({ condition: "webhook_disabled", url: standing!.url, reason: disabled.reason });
      this.drop("the webhook is off: its receiver answered 410");
      return attempt;
    }
    this.writeOutbox();
    return attempt;
  }

  /** Every pending message failed, with `why` in the log. */
  private drop(why: string): void {
    const pending = this.messages.filter((m) => m.status === "pending");
    for (const message of pending) Object.assign(message, { status: "failed", next_at: null });
    if (pending.length) this.say({ condition: "messages_dropped", count: pending.length, reason: why });
    this.writeOutbox();
  }

  private need(): Config {
    const config = this.config();
    if (!config) throw new ApiError("not_found", "no webhook is set: PUT /v2/settings/webhook sets one");
    return config;
  }
}
