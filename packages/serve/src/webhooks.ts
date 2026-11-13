// The webhook a person sets through /v2/settings/webhook: one URL this server POSTs to when a run comes to need its
// person (`run.needs_input`, its status input_required) and when it ends (`run.ended`: completed, failed or cancelled,
// once carried back). Each message is signed by the Standard Webhooks spec (standardwebhooks.com), so a receiver checks
// it with any of that spec's libraries: `webhook-id` (the same on every try: the receiver's idempotency key),
// `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">`
// under the secret `whsec_<base64 of 32 bytes>`, which this server makes at the first PUT and shows once. A message not
// answered 2xx is tried again on the spec's schedule, cut at about a day; a 410 turns the webhook off.
//
// Everything it keeps is in the one store, so nothing reads a file: its URL and state in settings (WEBHOOK_SETTING), its
// secret sealed in trigger_settings (adapter WEBHOOK_CHANNEL, the server's scope, a replaced one kept retired so a run that
// echoes it is still cut), its messages in channel_posts, each try in channel_attempts, and what each run was told in
// channel_told (channel WEBHOOK_CHANNEL). A run's moment is queued with its told row in one transaction, once, by whichever
// server sees it; a start queues each end the store holds that the ledger does not (catchUp). A write the store refuses
// is told to the caller (`unsaved`), which tells it again.
import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { ApiError, invalid } from "./errors.js";
import { SERVER_SCOPE, sealedSettingsOverStore, type SealedSettingsOverStore } from "./sealed-settings-store.js";
import { signatureOf } from "./standard-webhooks.js";
import type { ChannelAttemptRow, ChannelPostRow, Store } from "./store/index.js";
import { webhookSecretMeta } from "./trigger-secrets-shown.js";
import type { TriggerFailed } from "./triggers.js";
import { isObject, unknownFields } from "./validate.js";

/** A run's two notices, which the server's run-change follower tells. */
export const RUN_EVENTS = ["run.needs_input", "run.ended"] as const;
/** Every message type a webhook is sent: a run's notices, and a trigger's failed firing (triggers.ts). */
export const WEBHOOK_EVENTS = [...RUN_EVENTS, "trigger.failed"] as const;
/** The message types: a run's two notices, and the test send's. */
export const MESSAGE_TYPES = [...WEBHOOK_EVENTS, "webhook.test"] as const;
type MessageType = (typeof MESSAGE_TYPES)[number];
/** The file an earlier version kept the webhook in, beside its store: never read, only said at a start when it is left. */
export const WEBHOOK_FILE = "webhook.json";
/** The webhook's channel in the store (channel_posts, channel_attempts, channel_told) and its secret's adapter in
 *  trigger_settings. */
export const WEBHOOK_CHANNEL = "webhook-out";
/** The store setting that holds the webhook's URL, when its secret was made, and why it is off. */
export const WEBHOOK_SETTING = "webhook-out";
/** The waits before each try again, after the first at once: the Standard Webhooks schedule, cut at about a day. */
export const RETRY_MS: readonly number[] = [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000];
const TIMEOUT_MS = 15_000;
/** How far back an end's run.ended is still queued: past the retries (RETRY_MS, about a day), a notice would not be sent
 *  any more. */
const END_NOTICE_WINDOW_MS = 24 * 3_600_000;
/** How many attempts the log keeps, and with them the messages they tried, for a redelivery. */
export const ATTEMPTS_KEPT = 50;
const MAX_URL = 2048;
/** The secret's one field in trigger_settings: minted here, never given. */
const SECRET_FIELD = "secret";
/** Where its secret is kept in trigger_settings (adapter WEBHOOK_CHANNEL): the server's one scope, one minted field. */
export const WEBHOOK_SECRET_SPEC = { scope: "server" as const, fields: { [SECRET_FIELD]: { mint: true as const } } };
/** How long a try's claim on its message holds (Store.channels.claim): past the try's own TIMEOUT_MS. */
const CLAIM_MS = 60_000;
/** Names that are this machine or its own network, whatever they resolve to. */
const LOCAL_NAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i;
/** The words a URL on a private network or this machine is refused in. */
const PRIVATE_WORDS = "url is on a private network or this machine, which this server does not send to";

/** The webhook's URL as the server shows it (GET, its log): its origin and the last four characters of its path, never
 *  the whole URL, which can be a credential itself (a chat service's incoming-hook URL). */
export function shownUrl(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return "";
  const rest = `${parsed.pathname}${parsed.search}`.replace(/^\/$/, "");
  return rest.length > 4 ? `${parsed.origin}/…${rest.slice(-4)}` : `${parsed.origin}${rest}`;
}

/** What the webhook takes beside its store: `retryMs`, the waits between tries; `privateTargets`, whether it may send to a
 *  private network or this machine (the operator's AGENTRUN_WEBHOOK_PRIVATE_TARGETS, never the API's); `lookup`, every
 *  address a name resolves to (the system resolver by default); `storeRetryMs`, the wait before a try the store failed is
 *  tried again (STORE_RETRY_MS by default). */
export type WebhooksOptions = { retryMs?: readonly number[]; privateTargets?: boolean; lookup?: (host: string) => Promise<string[]>; storeRetryMs?: number };
/** How soon a try the store failed (its read or its claim threw) is tried again. */
const STORE_RETRY_MS = 5_000;
/** How many times a try's read of its message, before it settles, is tried (a wait of STORE_RETRY_MS between). */
const STANDING_READS = 3;
/** The least wait before a queued message whose claim was refused is tried again. */
const RE_ARM_MS = 20;

/** A told row's marker, by what it marks: an end (its time) or a wait (its ask's mark, waitMarkerOf). */
const ENDED = "ended:";
const WAIT = "wait:";
/** How many of a run's waits the ledger keeps: a run asks again with a new mark, so only an old ask read again (a stale
 *  read of the run) needs its mark, and that is one of its last few. */
const WAITS_KEPT = 20;

/** What `emit` did with a notice: `queued`, in the store (or already there, or counted as sent); `unsaved`, the store
 *  refused the write, so the caller tells it again; `off`, no webhook set, or one a 410 turned off, so nothing is to be
 *  sent; `closed`, the server is stopping. */
export type Emitted = "queued" | "unsaved" | "off" | "closed";
/** What a notice says of its run: never its tools' arguments, its output or its input, which a receiver reads through the API. */
export type RunNotice = { run_id: string; agent_id: string; status: string; title: string; pending?: { kind: "question" | "approval" | "stopped" | "budget" | "browser" } };
/** The webhook as the store keeps it, but its secret: `secret_at`, when the secret was made (the same URL keeps it);
 *  `secret_scope`, the scope its secret is sealed under in trigger_settings, one of its own for each secret made, so the
 *  setting names the one secret that signs for its URL, and the two go live in the setting's one write. */
type Config = { url: string; secret_at: string; secret_scope: string; updated_at: string; disabled?: { at: string; reason: string } };
/** What the ledger holds of one run: its end (its time), and the waits it was told of (each its ask's mark, waitMarkerOf;
 *  the one it stands at last), kept until the run moves past them: they go with the end that came after them, once that
 *  end is no longer due. */
type Noticed = { ended?: string; waits?: string[] };
export type Attempt = { webhook_id: string; type: MessageType; at: string; status_code: number | null; latency_ms: number; error: string | null; retry_at: string | null; redelivery: boolean };
/** Whether the secret signs here: sealed, or not, for a seal key it does not open under (or damaged). */
type Signing = "sealed" | "unreadable";

const iso = (ms: number) => new Date(ms).toISOString();

/** `work`'s result, or `signal`'s reason the moment it aborts: a lookup that never answers is given up on, not waited out. */
const abortable = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
export { signatureOf } from "./standard-webhooks.js";

/** The mark of the wait a run stands at, its webhook-id's marker: one per ask, however often or whenever the run is read,
 *  so every read of the same ask makes the same webhook-id. A question's is its waiting row (run-view.ts withAsks: the
 *  asked call's result, `:waiting`); an approval's, the call it holds; a budget pause's, its time and its cap; a hand-over's, when it
 *  was asked; a stop, which waits on no ask, the last row that shows (not usage, a phase or learning's). Never the last
 *  row for an ask: a run read between the person's answer and its runner's take of it shows the answer last, and a
 *  marker from that row would tell the same ask twice, under two ids. Undefined when there is none. */
export function waitMarkerOf(
  rows: readonly { id: string; kind: string; agent_label?: string | null }[],
  pending: { kind?: unknown; id?: unknown; at?: unknown; asked_at?: unknown; cap_usd?: unknown } | null | undefined,
  waiting: boolean,
  learningLabel: string,
): string | undefined {
  const last = () => rows.findLast((r) => r.kind !== "usage" && r.kind !== "phase" && r.agent_label !== learningLabel)?.id;
  if (!waiting) return last();
  const kind = pending?.kind;
  if (kind === "approval" && typeof pending?.id === "string") return `approval:${pending.id}`;
  // A pause at the cap, by when it came and the cap it waits at: waits at one cap are one pause, told once, and a raise that
  // still does not cover the step pauses the run anew at the higher cap, told again (the runner writes no row for the
  // refused step, so its time alone would not move).
  if (kind === "budget" && typeof pending?.at === "string") return `budget:${pending.at}${typeof pending.cap_usd === "number" ? `:${pending.cap_usd}` : ""}`;
  if ((kind === "browser" || kind === "computer") && typeof pending?.asked_at === "string") return `${kind}:${pending.asked_at}`;
  return rows.findLast((r) => r.kind === "waiting")?.id ?? last();
}

/** The store slice the webhook reads and writes. */
export type WebhooksStore = Pick<Store, "settings" | "triggerSettings" | "channels" | "flush">;

const attemptView = (row: ChannelAttemptRow): Attempt => ({
  webhook_id: row.postId, type: row.moment as MessageType, at: iso(row.at), status_code: row.statusCode, latency_ms: row.latencyMs, error: row.error,
  retry_at: row.retryAt === null ? null : iso(row.retryAt), redelivery: row.redelivery,
});

export class Webhooks {
  private readonly secrets: SealedSettingsOverStore;
  private config?: Config;
  /** The ledger, by run, as channel_told holds it (this server is its one writer), and the waits seen while nothing is
   *  sent, held here only. */
  private readonly notices = new Map<string, Noticed>();
  /** The runs told of since this server started: their ledger entries are this server's news, which a start's catch-up
   *  never drops. */
  private readonly told = new Set<string>();
  private base = "";
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** The tries in flight, which close() stops and waits for: nothing is written once it is closed. */
  private readonly trying = new Set<Promise<Attempt>>();
  /** The messages with a try in flight, and how many: a settle keeps each in the store until it lands, so one whose
   *  earlier attempts left the log meanwhile can still be redelivered. */
  private readonly sending = new Map<string, number>();
  private readonly stop = new AbortController();
  private closed = false;
  /** What reads the webhook and then writes it (a PUT, a DELETE, a try's outcome and its 410), one after another: each
   *  reads it as the last one left it, so a 410 never turns off a webhook a PUT set again meanwhile, and two first PUTs
   *  never each show a secret the other replaced. */
  private changing: Promise<unknown> = Promise.resolve();
  /** A DELETE under way: no notice is queued meanwhile, so none slips past its drop of the queued messages. */
  private removing = false;
  /** The tries' writes the store refused, each waiting to be written again (resettle), by its timer: the close writes each
   *  at once instead. */
  private readonly rewriting = new Map<NodeJS.Timeout, () => Promise<void>>();
  /** Those writes under way, which the close waits for, so each lands before the store closes. */
  private readonly rewrites = new Set<Promise<void>>();
  /** The message writes in flight (posted), each settled or not: a DELETE waits for them before its drop. */
  private readonly posting = new Set<Promise<void>>();

  private readonly retryMs: readonly number[];
  private readonly privateTargets: boolean;
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly storeRetryMs: number;

  /** `key` is the server's seal key; `say` takes a log line's fields. */
  constructor(
    private readonly store: WebhooksStore,
    key: Buffer,
    private readonly say: (fields: Record<string, string | number>) => void,
    options: WebhooksOptions = {},
  ) {
    this.secrets = sealedSettingsOverStore(store, WEBHOOK_CHANNEL, WEBHOOK_SECRET_SPEC, key, say);
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.storeRetryMs = options.storeRetryMs ?? STORE_RETRY_MS;
    this.privateTargets = options.privateTargets ?? false;
    this.lookup = options.lookup ?? (async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address));
  }

  /** Reads the webhook, its secret and its ledger once, and goes on with the messages an earlier server left queued, each
   *  at its next try's time; a test send is tried once, so one left queued failed. Awaited once at start. */
  async load(): Promise<void> {
    await this.secrets.load();
    const kept = await this.store.settings.get(WEBHOOK_SETTING);
    this.config = isObject(kept) && typeof kept.url === "string" && typeof kept.secret_scope === "string" && typeof kept.updated_at === "string" ? (kept as unknown as Config) : undefined;
    // A secret no setting names (one made by a PUT whose setting never landed, or the one a later PUT replaced and could not
    // remove) signs nothing: it goes, retired, still cut from what runs say.
    for (const scope of this.secrets.scopes()) {
      if (scope !== this.config?.secret_scope) await this.secrets.remove(scope).catch((error: Error) => this.say({ condition: "secret_unremoved", error: error.message }));
    }
    for (const row of await this.store.channels.told(WEBHOOK_CHANNEL)) {
      const noticed = this.notices.get(row.runId) ?? {};
      if (row.marker.startsWith(ENDED)) noticed.ended = row.marker.slice(ENDED.length);
      else if (row.marker.startsWith(WAIT)) noticed.waits = [...(noticed.waits ?? []), row.marker.slice(WAIT.length)];
      this.notices.set(row.runId, noticed);
    }
    // The store's one server (its lock): a claim an earlier server held is that server's try, cut by its stop.
    await this.store.channels.release(WEBHOOK_CHANNEL);
    for (const post of await this.store.channels.queued(WEBHOOK_CHANNEL)) {
      if (post.moment === "webhook.test") await this.store.channels.settle(post.id, { state: "dropped", reason: "a test send is tried once" });
      else this.schedule(post.id, Math.max(0, post.nextAt - Date.now()));
    }
  }

  /** Where the page is, for each notice's link to its run. */
  attach(base: string): void {
    this.base = base.replace(/\/+$/, "");
  }

  /** The secret, and each one this webhook held before (removed by a DELETE, or replaced: kept retired in the store), for
   *  the server's list of its own secrets (server-secrets.ts): a run that echoes an old one is cut all the same. */
  signingSecrets(): string[] {
    return this.secrets.values();
  }

  /** GET: the URL, whether the secret signs here, and why the webhook is off, if it is; its secret's metadata, never the
   *  secret. */
  view() {
    const config = this.config;
    if (!config) return { configured: false as const, secret: webhookSecretMeta(false, null) };
    return { configured: true as const, url: shownUrl(config.url), signing: this.signing(), secret: webhookSecretMeta(true, config.secret_at), disabled: config.disabled ?? null, updated_at: config.updated_at };
  }

  /** PUT: the URL, and the webhook on again. The first makes the secret and answers it, once, and so does one that changes
   *  the URL: a new receiver gets a new secret, so no one who may set the URL can have messages signed for another
   *  receiver. One that keeps the URL keeps the secret. A URL on a private network or this machine is refused (unless the
   *  operator allows it), by name or by any address its name resolves to; each try checks again (tryOnce). */
  async save(body: Record<string, unknown>): Promise<{ created: boolean; view: ReturnType<Webhooks["view"]>; secret?: string }> {
    const issues = unknownFields(body, ["url"]);
    const url = typeof body.url === "string" && body.url.length <= MAX_URL ? URL.parse(body.url) : null;
    if (body.url === undefined) issues.push({ field: "url", reason: "missing", message: "url is the http or https address to POST each message to" });
    else if (!url || !["http:", "https:"].includes(url.protocol)) issues.push({ field: "url", reason: "invalid", message: `url is an http or https address of at most ${MAX_URL} characters` });
    else if (url.username || url.password) issues.push({ field: "url", reason: "invalid", message: "url holds no user or password: the receiver checks the signature" });
    else if ((await this.privateAt(url)) !== undefined) issues.push({ field: "url", reason: "invalid", message: PRIVATE_WORDS });
    if (issues.length) throw invalid(issues);
    return this.change(() => this.saveNow(url!.href));
  }

  /** The PUT's change, once every change before it has landed: the webhook as the last one left it, then the new one. */
  private async saveNow(href: string): Promise<{ created: boolean; view: ReturnType<Webhooks["view"]>; secret?: string }> {
    const was = this.config;
    const now = new Date().toISOString();
    // A new URL gets a new secret, and so does one whose secret does not open here (sealed under another key).
    const rotates = !was || was.url !== href || this.signingSecret() === undefined;
    // A new secret is sealed under a scope of its own before the setting that names it is written: until that write lands,
    // the webhook is the one it was, its URL with its secret, and a try signs with that.
    const scope = rotates ? `${SERVER_SCOPE}:${randomBytes(8).toString("hex")}` : was!.secret_scope;
    const secret = rotates ? await this.secrets.mint(scope, SECRET_FIELD) : undefined;
    try {
      await this.write({ url: href, secret_at: rotates ? now : was!.secret_at, secret_scope: scope, updated_at: now });
    } catch (error) {
      // A secret made here and never shown signs nothing: removed (retired, still cut), so the next PUT that needs one makes
      // one and shows it, and no one keeps a secret no one was given.
      if (secret) await this.secrets.remove(scope).catch((removal: Error) => this.say({ condition: "secret_unremoved", error: removal.message }));
      throw error;
    }
    // The secret it replaces goes, retired: a run that echoes it is still cut. One not removed now is removed at the next
    // start (load).
    if (rotates && was && was.secret_scope !== scope) await this.secrets.remove(was.secret_scope).catch((removal: Error) => this.say({ condition: "secret_unremoved", error: removal.message }));
    return { created: !was, view: this.view(), ...(secret ? { secret } : {}) };
  }

  /** DELETE: the webhook gone, its queued messages with it, and its secret (retired: still cut from what a run says); the
   *  log of attempts stays. In that order: shut to new notices, its queued messages dropped, the setting removed, then
   *  every secret of the webhook, on every DELETE (none once gone), so a removal of a secret that failed is finished by
   *  the next DELETE, and whatever fails, nothing of the removed webhook is left to send, to it or to a later one. */
  remove(): Promise<void> {
    return this.change(async () => {
      if (this.config) {
        this.removing = true;
        try {
          // Every message whose write passed the check before the DELETE began lands first (on Postgres another pooled
          // connection may commit it later): then the drop takes it too, and none outlives the DELETE.
          await Promise.all([...this.posting]);
          await this.drop("the webhook was removed", true);
          await this.store.settings.remove(WEBHOOK_SETTING);
          await this.store.flush();
          this.config = undefined;
        } finally {
          this.removing = false;
        }
      }
      for (const scope of this.secrets.scopes()) await this.secrets.remove(scope);
    });
  }

  /** `work`, once every change of the webhook asked for before it has settled, failed or not. */
  private change<T>(work: () => Promise<T>): Promise<T> {
    const done = this.changing.then(work, work);
    this.changing = done.then(() => undefined, () => undefined);
    return done;
  }

  /** GET .../deliveries: the last attempts, newest first. */
  async attemptsView(): Promise<{ attempts: Attempt[] }> {
    return { attempts: (await this.store.channels.attempts(WEBHOOK_CHANNEL, ATTEMPTS_KEPT)).map(attemptView) };
  }

  /** A run's moment, told by the server each time it sees it (a wait reached, an end the store has): queued once, when a
   *  webhook is set and on, with its ledger row in the same transaction. `marker` makes its webhook-id: the same moment,
   *  seen again after a restart, has the same id, which is a receiver's idempotency key. An end before the webhook was
   *  set, or past the day, counts as sent. */
  async emit(type: (typeof RUN_EVENTS)[number], run: RunNotice, marker: string): Promise<Emitted> {
    if (this.closed) return "closed";
    this.told.add(run.run_id);
    const ends = type === "run.ended";
    const seen = this.notices.get(run.run_id);
    // One message per (run, wait): a wait the run was told of already, last or earlier, is never queued again.
    if (ends ? seen?.ended === marker : seen?.waits?.includes(marker)) return "queued";
    // The waits told, this one newest; the oldest go past WAITS_KEPT.
    const waits = [...(seen?.waits ?? []), marker];
    const kept = waits.slice(-WAITS_KEPT);
    const config = this.config;
    // Off, or being removed (a DELETE under way): nothing is to be sent, so nothing is queued past its drop.
    if (!config || config.disabled || this.removing) {
      // A wait seen while nothing is to be sent is noted here, never written: told again, it reads nothing.
      if (!ends) this.notices.set(run.run_id, { waits: kept });
      return "off";
    }
    if (ends && !this.due(marker, config)) return "queued";
    const id = `msg_${createHash("sha256").update(`${run.run_id}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;
    const data = { run_id: run.run_id, agent_id: run.agent_id, status: run.status, title: run.title, url: `${this.base}/#/runs/${encodeURIComponent(run.run_id)}`, ...(run.pending ? { pending: run.pending } : {}) };
    // A new wait goes beside the run's earlier waits and replaces its end (one after an end is a continued run's, past that
    // end); an end replaces the run's last end and keeps its waits.
    const told = ends ? { runId: run.run_id, marker: `${ENDED}${marker}`, replacing: ENDED } : { runId: run.run_id, marker: `${WAIT}${marker}`, replacing: ENDED };
    let added: boolean;
    try {
      added = await this.posted({ id, channel: WEBHOOK_CHANNEL, runId: run.run_id, moment: type, body: this.body(type, data), nextAt: Date.now() }, told);
    } catch (error) {
      this.say({ condition: "outbox_unwritable", webhook_id: id, error: (error as Error).message });
      return "unsaved";
    }
    this.notices.set(run.run_id, ends ? { ...seen, ended: marker } : { waits: kept });
    // The waits past WAITS_KEPT leave the store's ledger too; one not forgotten now is forgotten with the next.
    if (!ends && waits.length > kept.length) await this.store.channels.forget(WEBHOOK_CHANNEL, waits.slice(0, waits.length - kept.length).map((gone) => ({ runId: run.run_id, marker: `${WAIT}${gone}` }))).catch(() => undefined);
    await this.prune(config);
    // A message already there (an earlier telling whose durable commit failed after its write) is armed too, unless it is.
    if (added || !this.timers.has(id)) this.schedule(id, 0);
    return "queued";
  }

  /** A trigger's failed firing (triggers.ts), queued once: its webhook-id is made from the firing's key, so the same
   *  failure told again, by a later server too, is the same message. Its trigger keeps whether it was queued. */
  async emitTrigger(failed: TriggerFailed, firingKey: string): Promise<Emitted> {
    if (this.closed) return "closed";
    if (!this.config || this.config.disabled || this.removing) return "off";
    const id = `msg_${createHash("sha256").update(`trigger.failed\n${firingKey}`).digest("hex").slice(0, 32)}`;
    try {
      if ((await this.posted({ id, channel: WEBHOOK_CHANNEL, moment: "trigger.failed", body: this.body("trigger.failed", failed), nextAt: Date.now() })) || !this.timers.has(id)) this.schedule(id, 0);
    } catch (error) {
      this.say({ condition: "outbox_unwritable", webhook_id: id, error: (error as Error).message });
      return "unsaved";
    }
    return "queued";
  }

  /** A start's catch-up, once its runs are read (`rows`, the store's: a row with no state is an ended one). First the
   *  ledger as the store now stands: a run the store no longer has goes, and a wait of a run it holds as ended goes (an
   *  end the webhook was off for never moved it past). Then each end the store holds that the ledger does not, and that is
   *  still due, is queued under the store's end time, so under the same webhook-id. `current` reads the run as the store
   *  holds it right before its end is queued, with its notice (null: no such run now): a run continued since the rows
   *  were read has moved past that end, which is not queued again. Answers the runs whose end the store refused to queue
   *  (`unsaved`): the caller tells each again until it is saved (server.ts endsLeft), since no feed change will. */
  async catchUp(rows: Iterable<{ id: string; state?: string; endedAt?: string }>, current: (id: string) => Promise<{ state?: string; endedAt?: string; notice: RunNotice } | null>): Promise<string[]> {
    const config = this.config;
    const unsaved: string[] = [];
    if (this.closed || !config || config.disabled) return unsaved;
    const store = new Map([...rows].map((row) => [row.id, row]));
    const forget: { runId: string; marker: string }[] = [];
    for (const [id, noticed] of this.notices) {
      const row = store.get(id);
      if (this.told.has(id) || (row && (row.state === "running" || !noticed.waits?.length))) continue;
      for (const wait of noticed.waits ?? []) forget.push({ runId: id, marker: `${WAIT}${wait}` });
      if (!row && noticed.ended !== undefined) forget.push({ runId: id, marker: `${ENDED}${noticed.ended}` });
    }
    if (forget.length) {
      await this.store.channels.forget(WEBHOOK_CHANNEL, forget);
      for (const { runId } of forget) {
        const noticed = this.notices.get(runId);
        if (store.has(runId) && noticed?.ended !== undefined) this.notices.set(runId, { ended: noticed.ended });
        else this.notices.delete(runId);
      }
    }
    for (const { id, state, endedAt } of store.values()) {
      if (state === "running" || !endedAt || this.notices.get(id)?.ended === endedAt || !this.due(endedAt, config)) continue;
      const now = await current(id).catch((error: Error) => (this.say({ condition: "notice_unread", run: id, error: error.message }), undefined));
      if (now === undefined) continue;
      if (!now || now.state === "running" || now.endedAt !== endedAt) {
        this.say({ condition: "end_moved_on", run: id, ended: endedAt });
        continue;
      }
      if ((await this.emit("run.ended", now.notice, endedAt)) === "unsaved") unsaved.push(id);
    }
    return unsaved;
  }

  /** POST .../test: a `webhook.test` message tried once now, never again; its attempt. */
  async test(): Promise<Attempt> {
    this.need();
    const id = `msg_${randomBytes(16).toString("hex")}`;
    await this.posted({ id, channel: WEBHOOK_CHANNEL, moment: "webhook.test", body: this.body("webhook.test", {}), nextAt: Date.now() });
    return this.attempt(id, { retry: false, redelivery: false });
  }

  /** A message (and its ledger row, `told`) queued in one transaction, then made durable (the store's flush, as every write
   *  the server confirms is) before it is answered or tried: a crash of the machine never loses a message answered
   *  `queued`, nor the row that keeps it from being told twice. Tracked while in flight, so a DELETE waits for it. */
  private posted(post: Parameters<WebhooksStore["channels"]["post"]>[0], told?: Parameters<WebhooksStore["channels"]["post"]>[1]): Promise<boolean> {
    const writing = (async () => {
      const added = await this.store.channels.post(post, told);
      await this.store.flush();
      return added;
    })();
    const held = writing.then(() => undefined, () => undefined);
    this.posting.add(held);
    void held.then(() => this.posting.delete(held));
    return writing;
  }

  /** POST .../deliveries/{webhook_id}/redeliver: the message sent again once now, under its own webhook-id and body. */
  async redeliver(id: string): Promise<Attempt> {
    this.need();
    const post = await this.store.channels.get(id);
    if (!post || post.channel !== WEBHOOK_CHANNEL) throw new ApiError("not_found", `no message ${id} among the last ${ATTEMPTS_KEPT} attempts`);
    return this.attempt(id, { retry: false, redelivery: true });
  }

  /** Stops: no try starts, those in flight are cut and waited for, and nothing more is written but the tries' writes the
   *  store refused before (resettle), each written now and waited for, so a try's known outcome (a delivered message, a
   *  410's turn-off) lands before the store closes. A message cut here is still queued in the store, for the next server
   *  (its receiver may get it twice, under the same webhook-id). */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const waiting = [...this.rewriting];
    this.rewriting.clear();
    for (const [timer, rewrite] of waiting) (clearTimeout(timer), void rewrite());
    this.stop.abort();
    await Promise.allSettled([...this.trying]);
    await Promise.allSettled([...this.rewrites]);
  }

  /** Why `url` may not be sent to (a private address, by name or by what the name resolves to now), or undefined. A name
   *  that does not resolve passes here: the try resolves it again, and refuses then. */
  private async privateAt(url: URL): Promise<string | undefined> {
    if (this.privateTargets) return undefined;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (LOCAL_NAME.test(host)) return host;
    const { isPrivateAddress } = await import("@parcha/pi-browser");
    if (net.isIP(host)) return isPrivateAddress(host) ? host : undefined;
    const addresses = await this.lookup(host).catch(() => [] as string[]);
    return addresses.find(isPrivateAddress);
  }

  /** The address a try dials for `url`, checked: every address its name resolves to now is public (unless the operator
   *  allows private ones), and the connection goes to the one checked, so a name that resolves again between the check
   *  and the connect cannot reach another. A refusal in words. */
  private async dialled(url: URL, signal: AbortSignal): Promise<{ dispatcher?: Agent } | { refused: string }> {
    if (this.privateTargets) return {};
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (LOCAL_NAME.test(host)) return { refused: `refused: ${host} is not a public host` };
    const { isPrivateAddress, pinnedLookup } = await import("@parcha/pi-browser");
    let addresses: string[];
    try {
      addresses = net.isIP(host) ? [host] : await abortable(this.lookup(host), signal);
    } catch (error) {
      // The try's own bound, cut or the server stopping: the lookup is given up on, never waited out.
      if (signal.aborted) return { refused: (signal.reason as Error | undefined)?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : "not reached: the server is stopping" };
      return { refused: `not reached: ${(error as { code?: string }).code ?? "its name does not resolve"}` };
    }
    if (!addresses.length || addresses.some(isPrivateAddress)) return { refused: `refused: ${host} is not a public host` };
    return { dispatcher: new Agent({ connect: { lookup: pinnedLookup(addresses[0]!) } }) };
  }

  private signing(): Signing {
    return this.signingSecret() !== undefined ? "sealed" : "unreadable";
  }

  /** The secret the webhook's setting names, opened here; undefined when none is set, or it does not open here. */
  private signingSecret(config: Config | undefined = this.config): string | undefined {
    return config ? this.secrets.get(config.secret_scope, SECRET_FIELD) : undefined;
  }

  private body(type: MessageType, data: unknown): string {
    return JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  }

  /** The setting written, then held here: a write the store refuses throws, and what was held stays held. */
  private async write(config: Config): Promise<void> {
    await this.store.settings.put(WEBHOOK_SETTING, config);
    // Durable before the PUT (or the 410 that turns it off) answers, as the store's other confirmed writes are.
    await this.store.flush();
    this.config = config;
  }

  /** Whether an end's run.ended is still to be queued: at or after the webhook was set and the day began (a marker that
   *  names no time is not judged by one). The catch-up and the ledger's pruning read the same line, so the ledger never
   *  forgets an end a start would look for. */
  private due(endedAt: string, config: Config): boolean {
    const at = Date.parse(endedAt);
    return !Number.isFinite(at) || at >= Math.max(Date.parse(config.updated_at), Date.now() - END_NOTICE_WINDOW_MS);
  }

  /** The ledger's ends no longer due go (a start would not look for them). Waits with no end after them stay while the run
   *  stands at them, however long: never pruned by age, so the same question is never asked again. */
  private async prune(config: Config): Promise<void> {
    const stale = [...this.notices].filter(([, noticed]) => noticed.ended !== undefined && !this.due(noticed.ended, config));
    if (!stale.length) return;
    try {
      await this.store.channels.forget(WEBHOOK_CHANNEL, stale.map(([runId, noticed]) => ({ runId, marker: `${ENDED}${noticed.ended}` })));
    } catch {
      return;
    }
    for (const [runId, noticed] of stale) {
      if (!noticed.waits?.length) this.notices.delete(runId);
      else this.notices.set(runId, { waits: noticed.waits });
    }
  }

  private schedule(id: string, delayMs: number): void {
    if (this.closed) return;
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      // No try rejects unhandled, which would stop the server: one that throws (a store that failed its read or its claim)
      // is said, its message stays as it was, and it is tried again after STORE_RETRY_MS, as long as the message is queued:
      // its timer was its only one. A try of a message no longer queued (sent, dropped) claims nothing, and ends there.
      this.attempt(id, { retry: true, redelivery: false }).catch((error: unknown) => {
        try {
          this.say({ condition: "attempt_failed", webhook_id: id, error: error instanceof Error ? error.message : String(error) });
        } catch {}
        this.schedule(id, this.storeRetryMs);
      });
    }, delayMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  private attempt(id: string, how: { retry: boolean; redelivery: boolean }): Promise<Attempt> {
    this.sending.set(id, (this.sending.get(id) ?? 0) + 1);
    const trying = this.tryOnce(id, how).finally(() => {
      this.trying.delete(trying);
      const left = this.sending.get(id)! - 1;
      if (left) this.sending.set(id, left);
      else this.sending.delete(id);
    });
    this.trying.add(trying);
    return trying;
  }

  /** One try: POSTed, signed, to the URL set now; no redirect followed, at most 15 s. Not 2xx: tried again after the
   *  next wait (`retry`), else dropped, and the log says so. A 410 turns the webhook off. A redelivery is a try of its
   *  own: it marks a message sent when it lands, and never drops one. */
  private async tryOnce(id: string, how: { retry: boolean; redelivery: boolean }): Promise<Attempt> {
    const now = Date.now();
    const post = await this.store.channels.get(id);
    const attempt: Attempt = { webhook_id: id, type: (post?.moment ?? "webhook.test") as MessageType, at: iso(now), status_code: null, latency_ms: 0, error: null, retry_at: null, redelivery: how.redelivery };
    if (this.closed || !post) return attempt;
    // A message's own try claims it first (compare-and-set): a try already out, or one that settled it, holds it.
    if (!how.redelivery && !(await this.store.channels.claim(id, now, CLAIM_MS))) {
      // Not taken. One still queued was not due yet (its timer fired a little before its time) or lost a race with a
      // try that has settled it again since: armed again for its time, never left without a timer. One sent, dropped
      // or held by another try is not this try's.
      const standing = await this.store.channels.get(id);
      if (standing?.state === "queued") this.schedule(id, Math.max(standing.nextAt - Date.now(), RE_ARM_MS));
      return attempt;
    }
    const config = this.config;
    // Signed with the secret this setting names: the URL and its secret, as the store holds them together.
    const secret = this.signingSecret(config);
    let failure: string | undefined;
    if (!config) failure = "the webhook was removed";
    else if (config.disabled) failure = "the webhook is off";
    else if (secret === undefined) failure = "the secret does not open here (unreadable): set the webhook again";
    else {
      const timestamp = String(Math.floor(now / 1000));
      const started = performance.now();
      const target = new URL(config.url);
      // One bound for the whole try, its name's lookup included, and the server's stop cuts it all (close()).
      const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.stop.signal]);
      const dial = await this.dialled(target, signal);
      if ("refused" in dial) failure = dial.refused;
      else {
        try {
          const res = await undiciFetch(target, {
            method: "POST", redirect: "manual", signal,
            headers: { "content-type": "application/json", "user-agent": "agentrun-serve-webhook/1", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signatureOf(secret, id, timestamp, post.body) },
            body: post.body,
            ...(dial.dispatcher ? { dispatcher: dial.dispatcher } : {}),
          });
          await res.body?.cancel().catch(() => undefined);
          attempt.status_code = res.status;
          if (res.status < 200 || res.status > 299) failure = res.status >= 300 && res.status < 400 ? `answered ${res.status}: a redirect is not followed` : `answered ${res.status}`;
        } catch (error) {
          failure = (error as Error).name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : `not reached: ${(error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message}`;
        } finally {
          await dial.dispatcher?.close().catch(() => undefined);
        }
      }
      attempt.latency_ms = Math.round(performance.now() - started);
    }
    if (this.closed) return attempt;
    // What the try found is settled against the webhook as it stands once every change asked for before it (a PUT, a
    // DELETE, another try's 410) has landed: a 410 never turns off a webhook a PUT is setting again meanwhile.
    return this.change(() => this.settleTry(id, how, now, post, config, failure, attempt));
  }

  /** A try's outcome written: the message's new state and the try, in one transaction; its next try armed; a 410 that
   *  still names the webhook as it stands turns it off. */
  private async settleTry(id: string, how: { retry: boolean; redelivery: boolean }, now: number, post: ChannelPostRow, config: Config | undefined, failure: string | undefined, attempt: Attempt): Promise<Attempt> {
    if (this.closed) return attempt;
    attempt.error = failure ?? null;
    // The message as it stands now: a redelivery may have sent it while this try waited. Its read is tried a few times. If
    // the store still refuses it, the outcome is never settled from `post`, which was read before the claim and says queued:
    // that skips the branch that sets the next try, and nothing would send the message again until a restart. It is written
    // by resettle instead, which reads the message itself and writes only while it is still this try's (sending).
    let read: ChannelPostRow | undefined;
    let unread: Error | undefined;
    for (let i = 0; i < STANDING_READS; i++) {
      try {
        read = await this.store.channels.get(id);
        unread = undefined;
        break;
      } catch (error) {
        unread = error as Error;
        if (i < STANDING_READS - 1) await new Promise((resolve) => setTimeout(resolve, this.storeRetryMs));
      }
    }
    // Unread: what the claim made it. Used only to work out this try's outcome; the write waits for resettle's own read.
    const standingPost = unread ? { ...post, state: "sending" as const } : (read ?? post);
    // The schedule counts the message's own tries: a redelivery is a try of its own, and leaves it as it was.
    const attempts = standingPost.attempts + (how.redelivery ? 0 : 1);
    // A 410 turns off the webhook as this try found it: one set again or removed while the try waited is not its to turn
    // off, and the 410 is then a failure like any other.
    const standing = this.config;
    const gone = attempt.status_code === 410 && config !== undefined && standing !== undefined && standing.url === config.url && standing.updated_at === config.updated_at && !standing.disabled;
    const wait = how.retry && failure && config && !gone ? this.retryMs[attempts - 1] : undefined;
    let to: { state: ChannelPostRow["state"]; attempts?: number; nextAt?: number; reason?: string | null } | undefined;
    let delay: number | undefined;
    if (!failure) to = { state: "sent", attempts, reason: null };
    // A redelivery that failed leaves the message as it is, and so does a try that ends after one sent it.
    else if (!how.redelivery && standingPost.state === "sending") {
      if (wait !== undefined) {
        // Jitter, so messages that failed together do not all come back together.
        delay = Math.round(wait * (0.8 + 0.4 * Math.random()));
        attempt.retry_at = iso(Date.now() + delay);
        to = { state: "queued", attempts, nextAt: Date.now() + delay, reason: failure };
      } else to = { state: "dropped", attempts, reason: failure };
    }
    const row: ChannelAttemptRow = {
      postId: id, moment: attempt.type, at: now, statusCode: attempt.status_code, latencyMs: attempt.latency_ms, error: attempt.error,
      retryAt: attempt.retry_at === null ? null : Date.parse(attempt.retry_at), redelivery: how.redelivery,
    };
    const write = () => this.store.channels.settle(id, to ?? { state: standingPost.state, reason: standingPost.reason }, row, { kept: ATTEMPTS_KEPT, sending: [...this.sending.keys()] });
    try {
      if (unread) throw unread;
      await write();
    } catch (error) {
      this.say({ condition: "attempt_unsaved", webhook_id: id, error: (error as Error).message });
      // Not written. This try's own outcome is known, so only its write is tried again, soon and until it lands, never
      // the send: a message its receiver has is not sent again when its claim runs out, and a failed one keeps its
      // schedule. A redelivery's outcome (the message's own state left as it was) is let go.
      if (to !== undefined) this.resettle(id, how.redelivery, write, () => this.afterSettle(id, to, delay, attempt, attempts, failure, gone, standing));
      return attempt;
    }
    await this.afterSettle(id, to, delay, attempt, attempts, failure, gone, standing);
    return attempt;
  }

  /** What follows a try's write: its next try armed, its failure said, and a 410's turn-off of the webhook as it stands.
   *  The 410 is checked again against the webhook as it stands now: one whose write landed late (resettle), after a PUT set
   *  another URL or a DELETE removed it, was the old URL's, and turns nothing off. */
  private async afterSettle(id: string, to: { state: ChannelPostRow["state"]; nextAt?: number } | undefined, delay: number | undefined, attempt: Attempt, attempts: number, failure: string | undefined, gone: boolean, standing: Config | undefined): Promise<void> {
    if (delay !== undefined) this.schedule(id, Math.max(0, (to?.nextAt ?? Date.now()) - Date.now()));
    if (to?.state === "dropped") this.say({ condition: "delivery_failed", type: attempt.type, webhook_id: id, attempts, ...(attempt.status_code !== null ? { status_code: attempt.status_code } : {}), error: failure! });
    const current = this.config;
    const stillGone = gone && standing !== undefined && current !== undefined && !current.disabled && current.url === standing.url && current.secret_scope === standing.secret_scope && current.updated_at === standing.updated_at;
    if (stillGone) {
      // Gone: the receiver says this endpoint is no more. Off, its queued messages dropped, until a PUT sets it again.
      const off = { ...standing!, disabled: { at: attempt.at, reason: "the receiver answered 410 Gone" } };
      try {
        await this.write(off);
      } catch (error) {
        // Off here all the same, and the next PUT writes the webhook whole.
        this.config = off;
        this.say({ condition: "webhook_unwritable", error: (error as Error).message });
      }
      this.say({ condition: "webhook_disabled", url: shownUrl(standing!.url), reason: off.disabled.reason });
      await this.drop("the webhook is off: its receiver answered 410");
    }
  }

  /** A try's write the store refused (`write`), written again after the store's wait until it lands, then what follows it
   *  (`after`), among the webhook's changes. Its own timer, beside the message's: the message keeps its schedule meanwhile.
   *  A message's own try writes only while the message is still its (sending, its claim): one a DELETE dropped, or another
   *  try settled, is not its to write. A redelivery, which claims nothing, writes its landing whatever the message's state
   *  (a queued one reads sent, and its next try then finds nothing to send). One under way when the server closes is waited
   *  for, and one waiting is written at the close (close); one refused again then is left as the store holds it, for the
   *  next server. */
  private resettle(id: string, redelivery: boolean, write: () => Promise<void>, after: () => Promise<void>): void {
    if (this.closed) return;
    const rewrite = (): Promise<void> => {
      const task = this.change(async () => {
        try {
          if (!redelivery && (await this.store.channels.get(id))?.state !== "sending") return;
          await write();
        } catch {
          return this.resettle(id, redelivery, write, after);
        }
        await after();
      }).catch((error: Error) => this.say({ condition: "attempt_unsaved", webhook_id: id, error: error.message }));
      this.rewrites.add(task);
      void task.finally(() => this.rewrites.delete(task));
      return task;
    };
    const timer = setTimeout(() => {
      this.rewriting.delete(timer);
      void rewrite();
    }, this.storeRetryMs);
    timer.unref();
    this.rewriting.set(timer, rewrite);
  }

  /** Every queued message dropped, with `why` in the log. `strict`: a drop the store refuses throws (a DELETE then fails
   *  before anything else of it is done); else it is let be, and a queued message's try finds the webhook off. */
  private async drop(why: string, strict = false): Promise<void> {
    let count = 0;
    try {
      count = await this.store.channels.dropAll(WEBHOOK_CHANNEL, why);
    } catch (error) {
      // Refused: a DELETE fails with the webhook still set, its messages still queued and their timers kept, so each is
      // tried on its schedule as before.
      if (strict) throw error;
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (count) this.say({ condition: "messages_dropped", count, reason: why });
  }

  /** The webhook, set and on: a test or a redelivery sends nothing to one a 410 turned off, as no try does. */
  private need(): Config {
    const config = this.config;
    if (!config) throw new ApiError("not_found", "no webhook is set: PUT /v2/settings/webhook sets one");
    if (config.disabled) throw new ApiError("webhook_off", `the webhook is off (${config.disabled.reason}): set it again with PUT /v2/settings/webhook`);
    return config;
  }
}
