// The webhook a person sets through /v2/settings/webhook: one URL this server POSTs to when a run comes to need its
// person (`run.needs_input`, its status input_required) and when it ends (`run.ended`: completed, failed or cancelled,
// once carried back). Each message is signed by the Standard Webhooks spec (standardwebhooks.com), so a receiver checks
// it with any of that spec's libraries: `webhook-id` (the same on every try: the receiver's idempotency key),
// `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">`
// under the secret `whsec_<base64 of 32 bytes>`, which this server makes at the first PUT, shows once, and keeps in
// DIR/webhook.json only sealed under the tool keys' seal key (tool-keys.ts). A message not answered 2xx is tried again
// on the spec's schedule, cut at about a day; a 410 turns the webhook off. Messages and the last attempts live in
// DIR/webhook-outbox.json, so a restart goes on with those pending. Never in store.sqlite, which runs open.
// With them, in the same write, the ledger: the end and the wait each run's notices were queued for. A run's moment is
// queued once, by whichever server sees it, and a start queues each end the agent store holds that the ledger does not
// (catchUp): a kill between the store's end and the outbox write loses no run.ended, and sends none twice.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { mintSecret, signatureOf } from "./standard-webhooks.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import type { TriggerFailed } from "./triggers.js";
import { isObject, unknownFields } from "./validate.js";

/** A run's two notices, which runs.ts tells. */
export const RUN_EVENTS = ["run.needs_input", "run.ended"] as const;
/** Every message type a webhook is sent: a run's notices, and a trigger's failed firing (triggers.ts). */
export const WEBHOOK_EVENTS = [...RUN_EVENTS, "trigger.failed"] as const;
/** The message types: a run's two notices, and the test send's. */
export const MESSAGE_TYPES = [...WEBHOOK_EVENTS, "webhook.test"] as const;
type MessageType = (typeof MESSAGE_TYPES)[number];
export const WEBHOOK_FILE = "webhook.json";
export const OUTBOX_FILE = "webhook-outbox.json";
/** The waits before each try again, after the first at once: the Standard Webhooks schedule, cut at about a day. */
export const RETRY_MS: readonly number[] = [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000];
const TIMEOUT_MS = 15_000;
/** How soon an outbox write that failed is tried again. */
const OUTBOX_RETRY_MS = 5_000;
/** How far back an end's run.ended is still queued: past the outbox's own retries (RETRY_MS, about a day), a notice
 *  would not be sent any more. */
const END_NOTICE_WINDOW_MS = 24 * 3_600_000;
/** The outbox file's version: a file of another one is not read. */
const OUTBOX_VERSION = 3;
/** How many attempts the log keeps, and with them the messages they tried, for a redelivery. */
export const ATTEMPTS_KEPT = 50;
const FORMAT = "webhook/1";
const MAX_URL = 2048;

/** What a notice says of its run: never its tools' arguments, its output or its input, which a receiver reads through the API. */
/** What `emit` did with a notice: `queued`, in the outbox on disk (or already there, or counted as sent); `unsaved`,
 *  held here only, its outbox write failed; `off`, no webhook set, or one a 410 turned off, so nothing is to be sent;
 *  `closed`, the server is stopping. */
export type Emitted = "queued" | "unsaved" | "off" | "closed";
export type RunNotice = { run_id: string; agent_id: string; status: string; title: string; pending?: { kind: "question" | "approval" | "stopped" | "budget" } };
type Config = { url: string; secret: string; updated_at: string; disabled?: { at: string; reason: string } };
type Message = { id: string; type: MessageType; body: string; created_at: string; status: "pending" | "delivered" | "failed"; attempts: number; next_at: number | null };
/** What the outbox queued of one run: its end (its time), and the wait it stands at (its mark), kept until the run moves
 *  past it: a new wait replaces it, and it goes with the end that came after it, once that end is no longer due. */
type Noticed = { ended?: string; wait?: string };
export type Attempt = { webhook_id: string; type: MessageType; at: string; status_code: number | null; latency_ms: number; error: string | null; retry_at: string | null; redelivery: boolean };
/** Whether the secret signs here: sealed, or not, for no seal key now or one it does not open under. */
type Signing = "sealed" | "seal_key_missing" | "unreadable";

const aad = `${FORMAT}|secret`;
const iso = (ms: number) => new Date(ms).toISOString();
export { signatureOf } from "./standard-webhooks.js";

/** The webhook as `file` keeps it, if it holds one. */
function configIn(file: string): Config | undefined {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isObject(doc) && doc.v === 1 && typeof doc.url === "string" && typeof doc.secret === "string" ? (doc as unknown as Config) : undefined;
  } catch {
    return undefined;
  }
}

/** Its secret, opened under `key`, or why it is not. */
function opened(key: Buffer | undefined, config: Config): { secret: string } | { signing: Exclude<Signing, "sealed"> } {
  if (!key) return { signing: "seal_key_missing" };
  try {
    return { secret: unseal(key, Buffer.from(config.secret, "base64"), aad).toString("utf8") };
  } catch {
    return { signing: "unreadable" };
  }
}

/** The signing secret of the webhook data directory `data` keeps, opened with the seal key of `env`, or why it does not
 *  open (no seal key, or one it was not sealed under); undefined when it keeps none. Read for an import, which cuts it
 *  out of what it keeps. */
export function webhookSecretIn(data: string, env: NodeJS.ProcessEnv): ReturnType<typeof opened> | undefined {
  const config = configIn(join(data, WEBHOOK_FILE));
  return config && opened(sealKeyOf(env[SEAL_KEY_ENV]), config);
}

export class Webhooks {
  private readonly file: string;
  private readonly outbox: string;
  private readonly key: Buffer | undefined;
  private messages: Message[];
  private attempts: Attempt[];
  /** The ledger, by run: written with the messages, in the same write. */
  private notices: Record<string, Noticed>;
  /** The runs told of since this server started: their ledger entries are this server's news, which a start's catch-up
   *  never drops. */
  private readonly told = new Set<string>();
  private base = "";
  private readonly timers = new Set<NodeJS.Timeout>();
  /** The tries in flight, which close() stops and waits for: nothing is written once it is closed. */
  private readonly trying = new Set<Promise<Attempt>>();
  private readonly stop = new AbortController();
  private closed = false;
  /** The outbox as held here is not on disk: its last write failed. Written again soon, and at the close. */
  private unsaved = false;
  private saving?: NodeJS.Timeout;
  /** The webhook as held here when its write failed (a 410 that turned it off, on a full disk): read in place of the
   *  file until a write lands, as the next PUT's does. */
  private held?: Config;
  /** The messages with a try in flight, by id, and how many: kept in the outbox until each lands, so one whose earlier
   *  attempts left the log meanwhile can still be redelivered. */
  private readonly sending = new Map<string, number>();

  /** `env` is the server's own (withSecrets); `say` takes a log line's fields; `retryMs` the waits between tries. */
  constructor(data: string, env: NodeJS.ProcessEnv, private readonly say: (fields: Record<string, string | number>) => void, private readonly retryMs: readonly number[] = RETRY_MS) {
    this.file = join(data, WEBHOOK_FILE);
    this.outbox = join(data, OUTBOX_FILE);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    ({ messages: this.messages, attempts: this.attempts, notices: this.notices } = this.readOutbox());
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

  /** The secret, opened here, and each one this server held before it since it started (removed by a DELETE, or
   *  replaced), for the server's list of its own secrets (server-secrets.ts): a run that echoes an old one is cut all the
   *  same. None that is not there, or does not open. */
  signingSecrets(): string[] {
    const now = this.signingSecret();
    return [...(now ? [now] : []), ...this.retired];
  }
  /** The secrets this webhook signed with before, in memory alone, for this process's life. */
  private readonly retired = new Set<string>();

  /** The secret, opened here; undefined when there is none, or it does not open. */
  private signingSecret(): string | undefined {
    if (this.signing === undefined) {
      const config = this.config();
      const opened = config && this.secret(config);
      this.signing = { value: opened && "secret" in opened ? opened.secret : undefined };
    }
    return this.signing.value;
  }
  /** signingSecret's last reading: read again after any write of the webhook's file, which only this server makes. */
  private signing?: { value: string | undefined };

  /** GET: the URL, whether the secret signs here, and why the webhook is off, if it is; never the secret. */
  view() {
    const config = this.config();
    if (!config) return { configured: false as const };
    const opened = this.secret(config);
    return { configured: true as const, url: config.url, signing: ("secret" in opened ? "sealed" : opened.signing) as Signing, disabled: config.disabled ?? null, updated_at: config.updated_at };
  }

  /** PUT: the URL, and the webhook on again. The first makes the secret and answers it, once; a later one keeps it. */
  save(body: Record<string, unknown>): { created: boolean; view: ReturnType<Webhooks["view"]>; secret?: string } {
    const issues = unknownFields(body, ["url"]);
    const url = typeof body.url === "string" && body.url.length <= MAX_URL ? URL.parse(body.url) : null;
    if (body.url === undefined) issues.push({ field: "url", reason: "missing", message: "url is the http or https address to POST each message to" });
    else if (!url || !["http:", "https:"].includes(url.protocol)) issues.push({ field: "url", reason: "invalid", message: `url is an http or https address of at most ${MAX_URL} characters` });
    else if (url.username || url.password) issues.push({ field: "url", reason: "invalid", message: "url holds no user or password: the receiver checks the signature" });
    if (issues.length) throw invalid(issues);
    const was = this.config();
    if (!was && !this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no webhook secret: it never keeps one in the clear.`);
    const secret = was ? undefined : mintSecret();
    this.write({ url: url!.href, secret: was?.secret ?? seal(this.key!, Buffer.from(secret!, "utf8"), aad).toString("base64"), updated_at: new Date().toISOString() });
    return { created: !was, view: this.view(), ...(secret ? { secret } : {}) };
  }

  /** DELETE: the webhook gone, and its pending messages with it; the log of attempts stays. */
  remove(): void {
    if (!this.config()) return;
    const was = this.signingSecret();
    rmSync(this.file, { force: true });
    if (was) this.retired.add(was);
    this.signing = undefined;
    this.held = undefined;
    this.drop("the webhook was removed");
  }

  /** GET .../deliveries: the last attempts, newest first. */
  attemptsView(): { attempts: Attempt[] } {
    return { attempts: [...this.attempts].reverse() };
  }

  /** A run's moment, told by runs.ts each time it sees it (a wait reached, an end the agent store has): queued once, when
   *  a webhook is set and on, and kept in the ledger in the same write. `marker` makes its webhook-id: the same moment,
   *  seen again after a restart, has the same id, which is a receiver's idempotency key. An end before the webhook was
   *  set, or past the outbox's day, counts as sent. */
  emit(type: (typeof RUN_EVENTS)[number], run: RunNotice, marker: string): Emitted {
    if (this.closed) return "closed";
    this.told.add(run.run_id);
    const ends = type === "run.ended";
    const seen = this.notices[run.run_id];
    if ((ends ? seen?.ended : seen?.wait) === marker) return this.unsaved ? "unsaved" : "queued";
    const config = this.config();
    if (!config || config.disabled) {
      // A wait seen while nothing is to be sent is noted here, never written for it: told again, it reads no file.
      if (!ends) this.notices[run.run_id] = { wait: marker };
      return "off";
    }
    if (ends && !this.due(marker, config)) return "queued";
    const id = `msg_${createHash("sha256").update(`${run.run_id}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;
    // A new wait replaces the last; one after an end is a continued run's, past that end, which the store no longer holds.
    this.notices[run.run_id] = ends ? { ...seen, ended: marker } : { wait: marker };
    this.prune(config);
    const data = { run_id: run.run_id, agent_id: run.agent_id, status: run.status, title: run.title, url: `${this.base}/#/runs/${encodeURIComponent(run.run_id)}`, ...(run.pending ? { pending: run.pending } : {}) };
    this.schedule(this.enqueue(id, type, data), 0);
    return this.unsaved ? "unsaved" : "queued";
  }

  /** A trigger's failed firing (triggers.ts), queued once: its webhook-id is made from the firing's key, so the same
   *  failure told again, by a later server too, is the same message. Its trigger keeps whether it was queued. */
  emitTrigger(failed: TriggerFailed, firingKey: string): Emitted {
    if (this.closed) return "closed";
    const config = this.config();
    if (!config || config.disabled) return "off";
    const id = `msg_${createHash("sha256").update(`trigger.failed\n${firingKey}`).digest("hex").slice(0, 32)}`;
    if (!this.messages.some((m) => m.id === id)) this.schedule(this.enqueue(id, "trigger.failed", failed), 0);
    return this.unsaved ? "unsaved" : "queued";
  }

  /** A start's catch-up, once its runs are read (`rows`, the agent store's: a row with no state is an ended one). First,
   *  before anything is awaited, the ledger as the store now stands: a run the store no longer has goes, and a wait of a
   *  run it holds as ended goes (an end the webhook was off for never moved it past). Then each end the store holds that
   *  the ledger does not, and that is still due, is queued under the store's end time, so under the same webhook-id: its
   *  server was killed between the store's end and the outbox write, or that write never reached the disk. `current`
   *  reads the run as the store holds it right before its end is queued, with its notice (null: no such run now). The
   *  server takes requests meanwhile, so a run continued since the rows were read has moved past that end, which was
   *  queued before it could be continued: its end is not queued again. */
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
    if (dropped) this.writeOutbox();
    for (const { id, state, endedAt } of store.values()) {
      if (state === "running" || !endedAt || this.notices[id]?.ended === endedAt || !this.due(endedAt, config)) continue;
      const now = await current(id).catch((error: Error) => (this.say({ condition: "notice_unread", run: id, error: error.message }), undefined));
      if (now === undefined) continue;
      if (!now || now.state === "running" || now.endedAt !== endedAt) {
        this.say({ condition: "end_moved_on", run: id, ended: endedAt });
        continue;
      }
      this.emit("run.ended", now.notice, endedAt);
    }
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
    clearTimeout(this.saving);
    this.stop.abort();
    await Promise.allSettled([...this.trying]);
    // A notice a failed write left only here is written now, while the data directory is still this server's.
    if (this.unsaved) this.store();
  }

  private config(): Config | undefined {
    return this.held ?? configIn(this.file);
  }

  /** Throws when the write fails: what was held stays held. */
  private write(config: Config): void {
    const was = this.signingSecret();
    writeDurableSync(this.file, `${JSON.stringify({ v: 1, ...config }, null, 2)}\n`);
    this.held = undefined;
    this.signing = undefined;
    // A write that replaces the secret keeps the one it replaced (signingSecrets).
    if (was && was !== this.signingSecret()) this.retired.add(was);
  }

  /** The outbox as the last server left it. A file of another version is not read, and the log says which it was. */
  private readOutbox(): { messages: Message[]; attempts: Attempt[]; notices: Record<string, Noticed> } {
    try {
      const doc = JSON.parse(readFileSync(this.outbox, "utf8")) as unknown;
      if (isObject(doc) && doc.v !== OUTBOX_VERSION) this.say({ condition: "outbox_not_read", file: this.outbox, version: String(doc.v), reason: `not this server's version (${OUTBOX_VERSION})` });
      if (!isObject(doc) || doc.v !== OUTBOX_VERSION || !Array.isArray(doc.messages) || !Array.isArray(doc.attempts)) return { messages: [], attempts: [], notices: {} };
      const notices = isObject(doc.notices) ? (Object.fromEntries(Object.entries(doc.notices).filter(([, n]) => isObject(n))) as Record<string, Noticed>) : {};
      return { messages: doc.messages.filter((m) => isObject(m) && typeof m.id === "string" && typeof m.body === "string") as Message[], attempts: doc.attempts.filter(isObject) as Attempt[], notices };
    } catch {
      return { messages: [], attempts: [], notices: {} };
    }
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

  private writeOutbox(): void {
    // Closed, the data directory may be another server's already.
    if (this.closed) return;
    if (this.store() || this.saving) return;
    // Not saved: kept, and written again until a write lands (or the close writes it).
    const timer = setTimeout(() => { this.saving = undefined; this.writeOutbox(); }, OUTBOX_RETRY_MS);
    timer.unref();
    this.saving = timer;
  }

  /** The outbox written whole: the last attempts, and the messages pending or tried by one of those (a redelivery sends
   *  one again). False when the write failed, which the log says once until one lands. */
  private store(): boolean {
    this.attempts = this.attempts.slice(-ATTEMPTS_KEPT);
    const tried = new Set(this.attempts.map((a) => a.webhook_id));
    this.messages = this.messages.filter((m) => m.status === "pending" || tried.has(m.id) || this.sending.has(m.id));
    try {
      writeDurableSync(this.outbox, `${JSON.stringify({ v: OUTBOX_VERSION, messages: this.messages, attempts: this.attempts, notices: this.notices })}\n`);
      this.unsaved = false;
      return true;
    } catch (error) {
      if (!this.unsaved) this.say({ condition: "outbox_unwritable", file: this.outbox, error: (error as NodeJS.ErrnoException).code ?? "unknown" });
      this.unsaved = true;
      return false;
    }
  }

  /** The secret, opened, or why it is not. */
  private secret(config: Config): { secret: string } | { signing: Exclude<Signing, "sealed"> } {
    return opened(this.key, config);
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
        this.write(off);
      } catch (error) {
        // Off here all the same: held, and the next PUT writes the webhook whole.
        this.held = off;
        this.say({ condition: "webhook_unwritable", file: this.file, error: (error as NodeJS.ErrnoException).code ?? "unknown" });
      }
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

  /** The webhook, set and on: a test or a redelivery sends nothing to one a 410 turned off, as no try does. */
  private need(): Config {
    const config = this.config();
    if (!config) throw new ApiError("not_found", "no webhook is set: PUT /v2/settings/webhook sets one");
    if (config.disabled) throw new ApiError("webhook_off", `the webhook is off (${config.disabled.reason}): set it again with PUT /v2/settings/webhook`);
    return config;
  }
}
