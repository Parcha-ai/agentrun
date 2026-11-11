// The webhook a person sets through /v2/settings/webhook: one URL this server POSTs to when a run comes to need its
// person (`run.needs_input`, its status input_required) and when it ends (`run.ended`: completed, failed or cancelled,
// once carried back). Each message is signed by the Standard Webhooks spec (standardwebhooks.com), so a receiver checks
// it with any of that spec's libraries: `webhook-id` (the same on every try: the receiver's idempotency key),
// `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">`
// under the secret `whsec_<base64 of 32 bytes>`, which this server makes at the first PUT and shows once. Everything is in
// the one store, on SQLite and Postgres alike: the webhook in the setting WEBHOOK_SETTING, its secret sealed under the
// server's seal key among the server's sealed settings (sealed-settings-store.ts, adapter OUTBOUND_WEBHOOK), and the
// outbox in the setting OUTBOX_SETTING. A message not answered 2xx is tried again on the spec's schedule, cut at about a
// day; a 410 turns the webhook off. The outbox holds the messages and the last attempts, so a restart goes on with those
// pending, and with them, in the same write, the ledger: the end and the wait each run's notices were queued for. A run's
// moment is queued once, by whichever server sees it, and a start queues each end the store holds that the ledger does not
// (catchUp): a kill between the run's end and the outbox write loses no run.ended, and sends none twice.
import { createHash, randomBytes } from "node:crypto";
import { ApiError, invalid } from "./errors.js";
import { SERVER_SCOPE, type SealedSettingsOverStore, type SettingsSpec } from "./sealed-settings-store.js";
import { signatureOf } from "./standard-webhooks.js";
import type { Settings } from "./store/index.js";
import { webhookSecretMeta } from "./trigger-secrets-shown.js";
import type { TriggerFailed } from "./triggers.js";
import { isObject, unknownFields } from "./validate.js";

/** A run's two notices, which runs.ts tells. */
export const RUN_EVENTS = ["run.needs_input", "run.ended"] as const;
/** Every message type a webhook is sent: a run's notices, and a trigger's failed firing (triggers.ts). */
export const WEBHOOK_EVENTS = [...RUN_EVENTS, "trigger.failed"] as const;
/** The message types: a run's two notices, and the test send's. */
export const MESSAGE_TYPES = [...WEBHOOK_EVENTS, "webhook.test"] as const;
type MessageType = (typeof MESSAGE_TYPES)[number];
/** The store setting the webhook is kept in: its URL, when its secret was made, and why it is off, if it is. */
export const WEBHOOK_SETTING = "webhook";
/** The store setting the outbox is kept in: the messages, the last attempts and the ledger, written whole. */
export const OUTBOX_SETTING = "webhook_outbox";
/** The webhook's signing secret among the server's sealed settings (sealed-settings-store.ts): minted at the first PUT,
 *  kept sealed in the store, retired (still cut from what runs say) when it goes. Not a trigger source: its own adapter id. */
export const OUTBOUND_WEBHOOK: { readonly id: string; readonly settings: SettingsSpec } = { id: "outbound_webhook", settings: { scope: "server", fields: { secret: { mint: true } } } };
const SECRET_FIELD = "secret";
/** The waits before each try again, after the first at once: the Standard Webhooks schedule, cut at about a day. */
export const RETRY_MS: readonly number[] = [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000];
const TIMEOUT_MS = 15_000;
/** How soon an outbox write that failed is tried again. */
const OUTBOX_RETRY_MS = 5_000;
/** How far back an end's run.ended is still queued: past the outbox's own retries (RETRY_MS, about a day), a notice
 *  would not be sent any more. */
const END_NOTICE_WINDOW_MS = 24 * 3_600_000;
/** The outbox's version: one of another is not read. */
const OUTBOX_VERSION = 1;
/** How many attempts the log keeps, and with them the messages they tried, for a redelivery. */
export const ATTEMPTS_KEPT = 50;
const MAX_URL = 2048;

/** What a notice says of its run: never its tools' arguments, its output or its input, which a receiver reads through the API. */
/** What `emit` did with a notice: `queued`, in the outbox in the store (or already there, or counted as sent); `unsaved`,
 *  held here only, its outbox write failed; `off`, no webhook set, or one a 410 turned off, so nothing is to be sent;
 *  `closed`, the server is stopping. */
export type Emitted = "queued" | "unsaved" | "off" | "closed";
export type RunNotice = { run_id: string; agent_id: string; status: string; title: string; pending?: { kind: "question" | "approval" | "stopped" | "budget" | "browser" } };
/** `secret_at`: when the secret was made, its own time (a URL change keeps it). */
type Config = { url: string; secret_at: string; updated_at: string; disabled?: { at: string; reason: string } };
type Message = { id: string; type: MessageType; body: string; created_at: string; status: "pending" | "delivered" | "failed"; attempts: number; next_at: number | null };
/** What the outbox queued of one run: its end (its time), and the wait it stands at (its mark), kept until the run moves
 *  past it: a new wait replaces it, and it goes with the end that came after it, once that end is no longer due. */
type Noticed = { ended?: string; wait?: string };
export type Attempt = { webhook_id: string; type: MessageType; at: string; status_code: number | null; latency_ms: number; error: string | null; retry_at: string | null; redelivery: boolean };
/** Whether the secret signs here: sealed, or not, for a seal key it does not open under (or damaged). */
type Signing = "sealed" | "unreadable";
/** The store slice the webhook reads and writes: its two settings, and the durable commit after each write. */
export type WebhookStore = { readonly settings: Pick<Settings, "get" | "put" | "remove">; flush(): Promise<void> };
/** The webhook's secret, among the server's sealed settings (OUTBOUND_WEBHOOK), loaded before the webhook is. */
export type WebhookSecret = Pick<SealedSettingsOverStore, "get" | "mint" | "remove">;

const iso = (ms: number) => new Date(ms).toISOString();
export { signatureOf } from "./standard-webhooks.js";

/** The webhook as the store keeps it, if it holds one. */
function configOf(value: unknown): Config | undefined {
  return isObject(value) && value.v === 1 && typeof value.url === "string" && typeof value.secret_at === "string" && typeof value.updated_at === "string" ? (value as unknown as Config) : undefined;
}

export class Webhooks {
  private messages: Message[] = [];
  private attempts: Attempt[] = [];
  /** The ledger, by run: written with the messages, in the same write. */
  private notices: Record<string, Noticed> = {};
  /** The webhook as the store holds it: read at load, then kept with every write (this server is the store's one writer).
   *  A write that failed (a 410 that turned it off, on a store that refused the write) leaves it held here as it now is, and
   *  the next PUT writes it whole. */
  private current?: Config;
  /** The runs told of since this server started: their ledger entries are this server's news, which a start's catch-up
   *  never drops. */
  private readonly told = new Set<string>();
  private base = "";
  private readonly timers = new Set<NodeJS.Timeout>();
  /** The tries in flight, which close() stops and waits for: nothing is written once it is closed. */
  private readonly trying = new Set<Promise<Attempt>>();
  private readonly stop = new AbortController();
  private closed = false;
  /** The outbox as held here is not in the store: its last write failed. Written again soon, and at the close. */
  private unsaved = false;
  private saving?: NodeJS.Timeout;
  /** The outbox's writes, one after another: each writes the outbox as it stands when its turn comes. */
  private writing: Promise<boolean> = Promise.resolve(true);
  /** What reads the webhook and then writes it (a PUT, a DELETE, a try's 410 that turns it off), one after another: each
   *  reads it as the last one left it, so a 410 never turns off a webhook a PUT set again meanwhile. */
  private changing: Promise<unknown> = Promise.resolve();
  /** The messages with a try in flight, by id, and how many: kept in the outbox until each lands, so one whose earlier
   *  attempts left the log meanwhile can still be redelivered. */
  private readonly sending = new Map<string, number>();

  /** `store` keeps the webhook and its outbox, `secret` its signing secret (the server's sealed settings for
   *  OUTBOUND_WEBHOOK, loaded); `say` takes a log line's fields; `retryMs` the waits between tries. load() before use. */
  constructor(private readonly store: WebhookStore, private readonly secret: WebhookSecret, private readonly say: (fields: Record<string, string | number>) => void, private readonly retryMs: readonly number[] = RETRY_MS) {}

  /** Reads the webhook and the outbox as the last server left them, and goes on with the messages it left pending, each at
   *  its next try's time; a test send is tried once, so one left in flight failed. Awaited once, before anything else. */
  async load(): Promise<void> {
    this.current = configOf(await this.store.settings.get(WEBHOOK_SETTING));
    ({ messages: this.messages, attempts: this.attempts, notices: this.notices } = this.outboxOf(await this.store.settings.get(OUTBOX_SETTING)));
    const tests = this.messages.filter((m) => m.status === "pending" && m.type === "webhook.test");
    for (const test of tests) Object.assign(test, { status: "failed", next_at: null });
    if (tests.length) await this.writeOutbox();
    for (const message of this.messages) if (message.status === "pending") this.schedule(message, Math.max(0, (message.next_at ?? 0) - Date.now()));
  }

  /** Where the page is, for each notice's link to its run. */
  attach(base: string): void {
    this.base = base.replace(/\/+$/, "");
  }

  /** GET: the URL, whether the secret signs here, and why the webhook is off, if it is; its secret's metadata (secret-writes.ts
   *  SecretMeta), never the secret. */
  view() {
    const config = this.config();
    if (!config) return { configured: false as const, secret: webhookSecretMeta(false, null) };
    const signing: Signing = this.signingSecret() !== undefined ? "sealed" : "unreadable";
    return { configured: true as const, url: config.url, signing, secret: webhookSecretMeta(true, config.secret_at), disabled: config.disabled ?? null, updated_at: config.updated_at };
  }

  /** PUT: the URL, and the webhook on again. The first makes the secret and answers it, once; a later one keeps it, or
   *  makes a new one (answered once) when the one kept does not open under this server's seal key. */
  async save(body: Record<string, unknown>): Promise<{ created: boolean; view: ReturnType<Webhooks["view"]>; secret?: string }> {
    const issues = unknownFields(body, ["url"]);
    const url = typeof body.url === "string" && body.url.length <= MAX_URL ? URL.parse(body.url) : null;
    if (body.url === undefined) issues.push({ field: "url", reason: "missing", message: "url is the http or https address to POST each message to" });
    else if (!url || !["http:", "https:"].includes(url.protocol)) issues.push({ field: "url", reason: "invalid", message: `url is an http or https address of at most ${MAX_URL} characters` });
    else if (url.username || url.password) issues.push({ field: "url", reason: "invalid", message: "url holds no user or password: the receiver checks the signature" });
    if (issues.length) throw invalid(issues);
    return this.change(async () => {
      const was = this.config();
      const now = new Date().toISOString();
      const kept = was !== undefined && this.signingSecret() !== undefined;
      const secret = kept ? undefined : await this.secret.mint(SERVER_SCOPE, SECRET_FIELD);
      try {
        await this.write({ url: url!.href, secret_at: kept ? was!.secret_at : now, updated_at: now });
      } catch (error) {
        // A secret made here and never shown signs nothing: removed (retired, still cut), so the next PUT makes and shows
        // one, never keeping one nobody was given.
        if (secret) await this.secret.remove(SERVER_SCOPE).catch((removal: Error) => this.say({ condition: "secret_unremoved", error: removal.message }));
        throw error;
      }
      return { created: !was, view: this.view(), ...(secret ? { secret } : {}) };
    });
  }

  /** DELETE: the webhook gone, its secret with it (retired: still cut from what a run says), and its pending messages; the
   *  log of attempts stays. */
  remove(): Promise<void> {
    return this.change(async () => {
      if (!this.config()) return;
      await this.store.settings.remove(WEBHOOK_SETTING);
      await this.store.flush();
      this.current = undefined;
      await this.secret.remove(SERVER_SCOPE);
      await this.drop("the webhook was removed");
    });
  }

  /** GET .../deliveries: the last attempts, newest first. */
  attemptsView(): { attempts: Attempt[] } {
    return { attempts: [...this.attempts].reverse() };
  }

  /** A run's moment, told by the server each time it sees it (a wait reached, an end the store has): queued once, when a
   *  webhook is set and on, and kept in the ledger in the same write. `marker` makes its webhook-id: the same moment, seen
   *  again after a restart, has the same id, which is a receiver's idempotency key. An end before the webhook was set, or
   *  past the outbox's day, counts as sent. */
  async emit(type: (typeof RUN_EVENTS)[number], run: RunNotice, marker: string): Promise<Emitted> {
    if (this.closed) return "closed";
    this.told.add(run.run_id);
    const ends = type === "run.ended";
    const seen = this.notices[run.run_id];
    if ((ends ? seen?.ended : seen?.wait) === marker) return this.landed();
    const config = this.config();
    if (!config || config.disabled) {
      // A wait seen while nothing is to be sent is noted here, never written for it: told again, it writes nothing.
      if (!ends) this.notices[run.run_id] = { wait: marker };
      return "off";
    }
    if (ends && !this.due(marker, config)) return "queued";
    const id = `msg_${createHash("sha256").update(`${run.run_id}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;
    // A new wait replaces the last; one after an end is a continued run's, past that end, which the store no longer holds.
    this.notices[run.run_id] = ends ? { ...seen, ended: marker } : { wait: marker };
    this.prune(config);
    const data = { run_id: run.run_id, agent_id: run.agent_id, status: run.status, title: run.title, url: `${this.base}/#/runs/${encodeURIComponent(run.run_id)}`, ...(run.pending ? { pending: run.pending } : {}) };
    const { message, saved } = this.enqueue(id, type, data);
    this.schedule(message, 0);
    return (await saved) ? "queued" : "unsaved";
  }

  /** A trigger's failed firing (triggers.ts), queued once: its webhook-id is made from the firing's key, so the same
   *  failure told again, by a later server too, is the same message. Its trigger keeps whether it was queued. */
  async emitTrigger(failed: TriggerFailed, firingKey: string): Promise<Emitted> {
    if (this.closed) return "closed";
    const config = this.config();
    if (!config || config.disabled) return "off";
    const id = `msg_${createHash("sha256").update(`trigger.failed\n${firingKey}`).digest("hex").slice(0, 32)}`;
    if (this.messages.some((m) => m.id === id)) return this.landed();
    const { message, saved } = this.enqueue(id, "trigger.failed", failed);
    this.schedule(message, 0);
    return (await saved) ? "queued" : "unsaved";
  }

  /** A start's catch-up, once its runs are read (`rows`, the store's: a row with no state is an ended one). First, before
   *  anything is awaited, the ledger as the store now stands: a run the store no longer has goes, and a wait of a run it
   *  holds as ended goes (an end the webhook was off for never moved it past). Then each end the store holds that the
   *  ledger does not, and that is still due, is queued under the store's end time, so under the same webhook-id: its
   *  server was killed between the run's end and the outbox write, or that write never landed. `current` reads the run as
   *  the store holds it right before its end is queued, with its notice (null: no such run now). The server takes
   *  requests meanwhile, so a run continued since the rows were read has moved past that end, which was queued before it
   *  could be continued: its end is not queued again. */
  async catchUp(rows: Iterable<{ id: string; state?: string; endedAt?: string }>, current: (id: string) => Promise<{ state?: string; endedAt?: string; notice: RunNotice } | null>): Promise<void> {
    const config = this.config();
    if (this.closed || !config || config.disabled) return;
    const store = new Map([...rows].map((row) => [row.id, row]));
    let dropped = false;
    for (const [id, noticed] of Object.entries(this.notices)) {
      const row = store.get(id);
      if (this.told.has(id) || (row && (row.state === "running" || noticed.wait === undefined))) continue;
      if (row && noticed.ended) this.notices[id] = { ended: noticed.ended };
      else delete this.notices[id];
      dropped = true;
    }
    if (dropped) await this.writeOutbox();
    for (const { id, state, endedAt } of store.values()) {
      if (state === "running" || !endedAt || this.notices[id]?.ended === endedAt || !this.due(endedAt, config)) continue;
      const now = await current(id).catch((error: Error) => (this.say({ condition: "notice_unread", run: id, error: error.message }), undefined));
      if (now === undefined) continue;
      if (!now || now.state === "running" || now.endedAt !== endedAt) {
        this.say({ condition: "end_moved_on", run: id, ended: endedAt });
        continue;
      }
      await this.emit("run.ended", now.notice, endedAt);
    }
  }

  /** POST .../test: a `webhook.test` message tried once now, never again; its attempt. */
  test(): Promise<Attempt> {
    this.need();
    return this.attempt(this.enqueue(`msg_${randomBytes(16).toString("hex")}`, "webhook.test", {}).message, { retry: false, redelivery: false });
  }

  /** POST .../deliveries/{webhook_id}/redeliver: the message sent again once now, under its own webhook-id and body. */
  redeliver(id: string): Promise<Attempt> {
    this.need();
    const message = this.messages.find((m) => m.id === id);
    if (!message) throw new ApiError("not_found", `no message ${id} among the last ${ATTEMPTS_KEPT} attempts`);
    return this.attempt(message, { retry: false, redelivery: true });
  }

  /** Stops: no try starts, those in flight are cut and waited for, and nothing more is written but what a failed write left
   *  only here. A message cut here is still pending in the store, for the next server (its receiver may get it twice,
   *  under the same webhook-id). Before the store closes. */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.saving);
    this.stop.abort();
    await Promise.allSettled([...this.trying]);
    await this.writing;
    // A notice a failed write left only here is written now, while the store is still this server's.
    if (this.unsaved) await this.persist();
  }

  private config(): Config | undefined {
    return this.current;
  }

  /** Whether what is held here is in the store: once every outbox write asked for so far has settled (each writes it
   *  whole), `queued` when the last one landed, else `unsaved`. A moment told again while its first write is still in
   *  flight waits for it, never answering `queued` before it lands. */
  private async landed(): Promise<"queued" | "unsaved"> {
    await this.writing;
    return this.unsaved ? "unsaved" : "queued";
  }

  /** `work`, once every change of the webhook asked for before it has settled, failed or not. */
  private change<T>(work: () => Promise<T>): Promise<T> {
    const done = this.changing.then(work, work);
    this.changing = done.then(() => undefined, () => undefined);
    return done;
  }

  /** The signing secret, opened here; undefined when there is none, or it does not open under this server's seal key. */
  private signingSecret(): string | undefined {
    return this.secret.get(SERVER_SCOPE, SECRET_FIELD);
  }

  /** Throws when the write fails: the webhook as held here stays as it was. */
  private async write(config: Config): Promise<void> {
    await this.store.settings.put(WEBHOOK_SETTING, { v: 1, ...config });
    await this.store.flush();
    this.current = config;
  }

  /** The outbox as the last server left it. One of another version is not read, and the log says which it was. */
  private outboxOf(doc: unknown): { messages: Message[]; attempts: Attempt[]; notices: Record<string, Noticed> } {
    if (isObject(doc) && doc.v !== OUTBOX_VERSION) this.say({ condition: "outbox_not_read", setting: OUTBOX_SETTING, version: String(doc.v), reason: `not this server's version (${OUTBOX_VERSION})` });
    if (!isObject(doc) || doc.v !== OUTBOX_VERSION || !Array.isArray(doc.messages) || !Array.isArray(doc.attempts)) return { messages: [], attempts: [], notices: {} };
    const notices = isObject(doc.notices) ? (Object.fromEntries(Object.entries(doc.notices).filter(([, n]) => isObject(n))) as Record<string, Noticed>) : {};
    return { messages: doc.messages.filter((m) => isObject(m) && typeof m.id === "string" && typeof m.body === "string") as Message[], attempts: doc.attempts.filter(isObject) as unknown as Attempt[], notices };
  }

  /** Whether an end's run.ended is still to be queued: at or after the webhook was set and the outbox's day began (a
   *  marker that names no time is not judged by one). The catch-up and the ledger's pruning read the same line, so the
   *  ledger never forgets an end a start would look for. */
  private due(endedAt: string, config: Config): boolean {
    const at = Date.parse(endedAt);
    return !Number.isFinite(at) || at >= Math.max(Date.parse(config.updated_at), Date.now() - END_NOTICE_WINDOW_MS);
  }

  /** The ledger without what no start looks for: a run whose end is no longer due goes, with the wait it ended past. A
   *  wait with no end after it stays while the run stands at it, however long: never pruned by age, so the same question
   *  is never asked again. */
  private prune(config: Config): void {
    for (const [id, noticed] of Object.entries(this.notices)) if (noticed.ended && !this.due(noticed.ended, config)) delete this.notices[id];
  }

  /** The outbox written, after every write asked for before it; whether it landed. One that failed is kept here and
   *  written again until a write lands (or the close writes it). Closed, nothing is written: the store may be the next
   *  server's already. */
  private writeOutbox(): Promise<boolean> {
    if (this.closed) return Promise.resolve(!this.unsaved);
    this.writing = this.writing.then(() => this.persist());
    return this.writing.then((landed) => {
      if (!landed && !this.saving && !this.closed) {
        const timer = setTimeout(() => { this.saving = undefined; void this.writeOutbox(); }, OUTBOX_RETRY_MS);
        timer.unref();
        this.saving = timer;
      }
      return landed;
    });
  }

  /** The outbox written whole, in one durable commit: the last attempts, and the messages pending or tried by one of
   *  those (a redelivery sends one again). False when the write failed, which the log says once until one lands. */
  private async persist(): Promise<boolean> {
    this.attempts = this.attempts.slice(-ATTEMPTS_KEPT);
    const tried = new Set(this.attempts.map((a) => a.webhook_id));
    this.messages = this.messages.filter((m) => m.status === "pending" || tried.has(m.id) || this.sending.has(m.id));
    try {
      await this.store.settings.put(OUTBOX_SETTING, { v: OUTBOX_VERSION, messages: this.messages, attempts: this.attempts, notices: this.notices });
      await this.store.flush();
      this.unsaved = false;
      return true;
    } catch (error) {
      if (!this.unsaved) this.say({ condition: "outbox_unwritable", setting: OUTBOX_SETTING, error: (error as Error).message });
      this.unsaved = true;
      return false;
    }
  }

  /** A new pending message, and its outbox write (whether it landed). */
  private enqueue(id: string, type: MessageType, data: unknown): { message: Message; saved: Promise<boolean> } {
    const created = new Date().toISOString();
    const message: Message = { id, type, body: JSON.stringify({ type, timestamp: created, data }), created_at: created, status: "pending", attempts: 0, next_at: Date.now() };
    this.messages.push(message);
    return { message, saved: this.writeOutbox() };
  }

  private schedule(message: Message, delayMs: number): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      // No try rejects unhandled, which would stop the server: one that throws is said, and its message stays as it was.
      this.attempt(message, { retry: true, redelivery: false }).catch((error: unknown) => {
        try {
          this.say({ condition: "attempt_failed", webhook_id: message.id, error: error instanceof Error ? error.message : String(error) });
        } catch {}
      });
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  private attempt(message: Message, how: { retry: boolean; redelivery: boolean }): Promise<Attempt> {
    this.sending.set(message.id, (this.sending.get(message.id) ?? 0) + 1);
    const trying = this.tryOnce(message, how).finally(() => {
      this.trying.delete(trying);
      const left = this.sending.get(message.id)! - 1;
      if (left) this.sending.set(message.id, left);
      else this.sending.delete(message.id);
    });
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
    else if (config.disabled) failure = "the webhook is off";
    else {
      const secret = this.signingSecret();
      if (secret === undefined) failure = "the secret does not open here (unreadable): set the webhook again";
      else {
        const timestamp = String(Math.floor(now / 1000));
        const started = performance.now();
        try {
          const res = await fetch(config.url, {
            method: "POST", redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.stop.signal]),
            headers: { "content-type": "application/json", "user-agent": "agentrun-serve-webhook/1", "webhook-id": message.id, "webhook-timestamp": timestamp, "webhook-signature": signatureOf(secret, message.id, timestamp, message.body) },
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
    // What the try found is settled against the webhook as it stands once every change before it has landed.
    return this.change(async () => {
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
      // A redelivery that failed leaves the message as it is, and so does a try that ends after one delivered it.
      else if (!how.redelivery && message.status === "pending") {
        if (wait !== undefined) {
          // Jitter, so messages that failed together do not all come back together.
          const delay = Math.round(wait * (0.8 + 0.4 * Math.random()));
          message.next_at = Date.now() + delay;
          attempt.retry_at = iso(message.next_at);
          this.schedule(message, delay);
        } else {
          Object.assign(message, { status: "failed", next_at: null });
          this.say({ condition: "delivery_failed", type: message.type, webhook_id: message.id, attempts: message.attempts, ...(attempt.status_code !== null ? { status_code: attempt.status_code } : {}), error: failure });
        }
      }
      if (gone) {
        // Gone: the receiver says this endpoint is no more. Off, its pending messages dropped, until a PUT sets it again.
        const disabled = { at: attempt.at, reason: "the receiver answered 410 Gone" };
        const off = { ...standing!, disabled };
        try {
          await this.write(off);
        } catch (error) {
          // Off here all the same: held, and the next PUT writes the webhook whole.
          this.current = off;
          this.say({ condition: "webhook_unwritable", setting: WEBHOOK_SETTING, error: (error as Error).message });
        }
        this.say({ condition: "webhook_disabled", url: standing!.url, reason: disabled.reason });
        await this.drop("the webhook is off: its receiver answered 410");
        return attempt;
      }
      await this.writeOutbox();
      return attempt;
    });
  }

  /** Every pending message failed, with `why` in the log. */
  private async drop(why: string): Promise<void> {
    const pending = this.messages.filter((m) => m.status === "pending");
    for (const message of pending) Object.assign(message, { status: "failed", next_at: null });
    if (pending.length) this.say({ condition: "messages_dropped", count: pending.length, reason: why });
    await this.writeOutbox();
  }

  /** The webhook, set and on: a test or a redelivery sends nothing to one a 410 turned off, as no try does. */
  private need(): Config {
    const config = this.config();
    if (!config) throw new ApiError("not_found", "no webhook is set: PUT /v2/settings/webhook sets one");
    if (config.disabled) throw new ApiError("webhook_off", `the webhook is off (${config.disabled.reason}): set it again with PUT /v2/settings/webhook`);
    return config;
  }
}
