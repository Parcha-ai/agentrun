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
import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { unseal } from "@parcha/pi-durable-agent";
import { ApiError, invalid } from "./errors.js";
import { SERVER_SCOPE, sealedSettingsOverStore, type SealedSettingsOverStore } from "./sealed-settings-store.js";
import { signatureOf } from "./standard-webhooks.js";
import type { ChannelAttemptRow, ChannelPostRow, Store } from "./store/index.js";
import { webhookSecretMeta } from "./trigger-secrets-shown.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import type { TriggerFailed } from "./triggers.js";
import { isObject, unknownFields } from "./validate.js";

/** A run's two notices, which the server's run-change follower tells. */
export const RUN_EVENTS = ["run.needs_input", "run.ended"] as const;
/** Every message type a webhook is sent: a run's notices, and a trigger's failed firing (triggers.ts). */
export const WEBHOOK_EVENTS = [...RUN_EVENTS, "trigger.failed"] as const;
/** The message types: a run's two notices, and the test send's. */
export const MESSAGE_TYPES = [...WEBHOOK_EVENTS, "webhook.test"] as const;
type MessageType = (typeof MESSAGE_TYPES)[number];
/** The files an earlier version kept the webhook in, beside its store: read only by an import (webhookSecretIn). */
export const WEBHOOK_FILE = "webhook.json";
export const OUTBOX_FILE = "webhook-outbox.json";
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
 *  address a name resolves to (the system resolver by default). */
export type WebhooksOptions = { retryMs?: readonly number[]; privateTargets?: boolean; lookup?: (host: string) => Promise<string[]> };

/** A told row's marker, by what it marks: an end (its time) or a wait (its last row). */
const ENDED = "ended:";
const WAIT = "wait:";

/** What `emit` did with a notice: `queued`, in the store (or already there, or counted as sent); `unsaved`, the store
 *  refused the write, so the caller tells it again; `off`, no webhook set, or one a 410 turned off, so nothing is to be
 *  sent; `closed`, the server is stopping. */
export type Emitted = "queued" | "unsaved" | "off" | "closed";
/** What a notice says of its run: never its tools' arguments, its output or its input, which a receiver reads through the API. */
export type RunNotice = { run_id: string; agent_id: string; status: string; title: string; pending?: { kind: "question" | "approval" | "stopped" | "budget" | "browser" } };
/** The webhook as the store keeps it, but its secret: `secret_at`, when the secret was made (a URL change keeps it). */
type Config = { url: string; secret_at: string; updated_at: string; disabled?: { at: string; reason: string } };
/** What the ledger holds of one run: its end (its time), and the wait it stands at (its mark). */
type Noticed = { ended?: string; wait?: string };
export type Attempt = { webhook_id: string; type: MessageType; at: string; status_code: number | null; latency_ms: number; error: string | null; retry_at: string | null; redelivery: boolean };
/** Whether the secret signs here: sealed, or not, for no seal key or one it does not open under. */
type Signing = "sealed" | "seal_key_missing" | "unreadable";

const iso = (ms: number) => new Date(ms).toISOString();
export { signatureOf } from "./standard-webhooks.js";

/** The webhook an earlier version kept in `data`'s WEBHOOK_FILE: its signing secret, opened with the seal key of `env`, or
 *  why it does not open; undefined when it keeps none. Read for an import, which cuts it out of what it keeps. */
export function webhookSecretIn(data: string, env: NodeJS.ProcessEnv): { secret: string } | { signing: Exclude<Signing, "sealed"> } | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(data, WEBHOOK_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(doc) || doc.v !== 1 || typeof doc.secret !== "string") return undefined;
  const key = sealKeyOf(env[SEAL_KEY_ENV]);
  if (!key) return { signing: "seal_key_missing" };
  try {
    return { secret: unseal(key, Buffer.from(doc.secret, "base64"), "webhook/1|secret").toString("utf8") };
  } catch {
    return { signing: "unreadable" };
  }
}

/** The marker of the wait a run stands at: one per ask, however often or whenever the run is read, so every read of the
 *  same ask makes the same webhook-id. A question's is its waiting row (run-view.ts withAsks: the asked call's result,
 *  `:waiting`); an approval's, the call it holds; a budget pause's, its time; a hand-over's, when it was asked; a stop,
 *  which waits on no ask, the last row that shows (not usage, a phase or learning's). Never the last row for an ask: a
 *  run read again between the person's answer and its runner taking it (its row still marked waiting) shows the answer
 *  last, and a marker from that row would tell the same ask twice, under two ids. Undefined when there is none. */
export function waitMarkerOf(
  rows: readonly { id: string; kind: string; agent_label?: string | null }[],
  pending: { kind?: unknown; id?: unknown; at?: unknown; asked_at?: unknown } | null | undefined,
  waiting: boolean,
  learningLabel: string,
): string | undefined {
  const last = () => rows.findLast((r) => r.kind !== "usage" && r.kind !== "phase" && r.agent_label !== learningLabel)?.id;
  if (!waiting) return last();
  const kind = pending?.kind;
  if (kind === "approval" && typeof pending?.id === "string") return `approval:${pending.id}`;
  if (kind === "budget" && typeof pending?.at === "string") return `budget:${pending.at}`;
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

  private readonly retryMs: readonly number[];
  private readonly privateTargets: boolean;
  private readonly lookup: (host: string) => Promise<string[]>;

  /** `key` is the server's seal key; `say` takes a log line's fields. */
  constructor(
    private readonly store: WebhooksStore,
    key: Buffer,
    private readonly say: (fields: Record<string, string | number>) => void,
    options: WebhooksOptions = {},
  ) {
    this.secrets = sealedSettingsOverStore(store, WEBHOOK_CHANNEL, WEBHOOK_SECRET_SPEC, key, say);
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.privateTargets = options.privateTargets ?? false;
    this.lookup = options.lookup ?? (async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address));
  }

  /** Reads the webhook, its secret and its ledger once, and goes on with the messages an earlier server left queued, each
   *  at its next try's time; a test send is tried once, so one left queued failed. Awaited once at start. */
  async load(): Promise<void> {
    await this.secrets.load();
    const kept = await this.store.settings.get(WEBHOOK_SETTING);
    this.config = isObject(kept) && typeof kept.url === "string" && typeof kept.updated_at === "string" ? (kept as unknown as Config) : undefined;
    for (const row of await this.store.channels.told(WEBHOOK_CHANNEL)) {
      const noticed = this.notices.get(row.runId) ?? {};
      if (row.marker.startsWith(ENDED)) noticed.ended = row.marker.slice(ENDED.length);
      else if (row.marker.startsWith(WAIT)) noticed.wait = row.marker.slice(WAIT.length);
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
    const was = this.config;
    const now = new Date().toISOString();
    const rotates = !was || was.url !== url!.href;
    // The secret is written (sealed) before the setting that names it: a stop between the two leaves no webhook without one.
    // The one it replaces is kept retired, so a run that echoes it is still cut.
    const secret = rotates ? await this.secrets.mint(SERVER_SCOPE, SECRET_FIELD) : undefined;
    await this.write({ url: url!.href, secret_at: rotates ? now : was!.secret_at, updated_at: now });
    return { created: !was, view: this.view(), ...(secret ? { secret } : {}) };
  }

  /** DELETE: the webhook gone, its secret kept retired (cut from runs still), and its queued messages with it; the log of
   *  attempts stays. */
  async remove(): Promise<void> {
    if (!this.config) return;
    await this.store.settings.remove(WEBHOOK_SETTING);
    this.config = undefined;
    await this.secrets.remove(SERVER_SCOPE);
    await this.drop("the webhook was removed");
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
    if ((ends ? seen?.ended : seen?.wait) === marker) return "queued";
    const config = this.config;
    if (!config || config.disabled) {
      // A wait seen while nothing is to be sent is noted here, never written: told again, it reads nothing.
      if (!ends) this.notices.set(run.run_id, { wait: marker });
      return "off";
    }
    if (ends && !this.due(marker, config)) return "queued";
    const id = `msg_${createHash("sha256").update(`${run.run_id}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;
    const data = { run_id: run.run_id, agent_id: run.agent_id, status: run.status, title: run.title, url: `${this.base}/#/runs/${encodeURIComponent(run.run_id)}`, ...(run.pending ? { pending: run.pending } : {}) };
    // A new wait replaces every marker of the run (one after an end is a continued run's, past that end); an end replaces
    // the run's last end and keeps its wait.
    const told = ends ? { runId: run.run_id, marker: `${ENDED}${marker}`, replacing: ENDED } : { runId: run.run_id, marker: `${WAIT}${marker}`, replacing: "" };
    let added: boolean;
    try {
      added = await this.store.channels.post({ id, channel: WEBHOOK_CHANNEL, runId: run.run_id, moment: type, body: this.body(type, data), nextAt: Date.now() }, told);
    } catch (error) {
      this.say({ condition: "outbox_unwritable", webhook_id: id, error: (error as Error).message });
      return "unsaved";
    }
    this.notices.set(run.run_id, ends ? { ...seen, ended: marker } : { wait: marker });
    await this.prune(config);
    if (added) this.schedule(id, 0);
    return "queued";
  }

  /** A trigger's failed firing (triggers.ts), queued once: its webhook-id is made from the firing's key, so the same
   *  failure told again, by a later server too, is the same message. Its trigger keeps whether it was queued. */
  async emitTrigger(failed: TriggerFailed, firingKey: string): Promise<Emitted> {
    if (this.closed) return "closed";
    if (!this.config || this.config.disabled) return "off";
    const id = `msg_${createHash("sha256").update(`trigger.failed\n${firingKey}`).digest("hex").slice(0, 32)}`;
    try {
      if (await this.store.channels.post({ id, channel: WEBHOOK_CHANNEL, moment: "trigger.failed", body: this.body("trigger.failed", failed), nextAt: Date.now() })) this.schedule(id, 0);
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
   *  were read has moved past that end, which is not queued again. */
  async catchUp(rows: Iterable<{ id: string; state?: string; endedAt?: string }>, current: (id: string) => Promise<{ state?: string; endedAt?: string; notice: RunNotice } | null>): Promise<void> {
    const config = this.config;
    if (this.closed || !config || config.disabled) return;
    const store = new Map([...rows].map((row) => [row.id, row]));
    const forget: { runId: string; marker: string }[] = [];
    for (const [id, noticed] of this.notices) {
      const row = store.get(id);
      if (this.told.has(id) || (row && (row.state === "running" || noticed.wait === undefined))) continue;
      if (noticed.wait !== undefined) forget.push({ runId: id, marker: `${WAIT}${noticed.wait}` });
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
      await this.emit("run.ended", now.notice, endedAt);
    }
  }

  /** POST .../test: a `webhook.test` message tried once now, never again; its attempt. */
  async test(): Promise<Attempt> {
    this.need();
    const id = `msg_${randomBytes(16).toString("hex")}`;
    await this.store.channels.post({ id, channel: WEBHOOK_CHANNEL, moment: "webhook.test", body: this.body("webhook.test", {}), nextAt: Date.now() });
    return this.attempt(id, { retry: false, redelivery: false });
  }

  /** POST .../deliveries/{webhook_id}/redeliver: the message sent again once now, under its own webhook-id and body. */
  async redeliver(id: string): Promise<Attempt> {
    this.need();
    const post = await this.store.channels.get(id);
    if (!post || post.channel !== WEBHOOK_CHANNEL) throw new ApiError("not_found", `no message ${id} among the last ${ATTEMPTS_KEPT} attempts`);
    return this.attempt(id, { retry: false, redelivery: true });
  }

  /** Stops: no try starts, those in flight are cut and waited for, and nothing more is written. A message cut here is
   *  still queued in the store, for the next server (its receiver may get it twice, under the same webhook-id). */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.stop.abort();
    await Promise.allSettled([...this.trying]);
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
  private async dialled(url: URL): Promise<{ dispatcher?: Agent } | { refused: string }> {
    if (this.privateTargets) return {};
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (LOCAL_NAME.test(host)) return { refused: `refused: ${host} is not a public host` };
    const { isPrivateAddress, pinnedLookup } = await import("@parcha/pi-browser");
    let addresses: string[];
    try {
      addresses = net.isIP(host) ? [host] : await this.lookup(host);
    } catch (error) {
      return { refused: `not reached: ${(error as { code?: string }).code ?? "its name does not resolve"}` };
    }
    if (!addresses.length || addresses.some(isPrivateAddress)) return { refused: `refused: ${host} is not a public host` };
    return { dispatcher: new Agent({ connect: { lookup: pinnedLookup(addresses[0]!) } }) };
  }

  private signing(): Signing {
    return this.secrets.get(SERVER_SCOPE, SECRET_FIELD) !== undefined ? "sealed" : "unreadable";
  }

  private body(type: MessageType, data: unknown): string {
    return JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  }

  /** The setting written, then held here: a write the store refuses throws, and what was held stays held. */
  private async write(config: Config): Promise<void> {
    await this.store.settings.put(WEBHOOK_SETTING, config);
    this.config = config;
  }

  /** Whether an end's run.ended is still to be queued: at or after the webhook was set and the day began (a marker that
   *  names no time is not judged by one). The catch-up and the ledger's pruning read the same line, so the ledger never
   *  forgets an end a start would look for. */
  private due(endedAt: string, config: Config): boolean {
    const at = Date.parse(endedAt);
    return !Number.isFinite(at) || at >= Math.max(Date.parse(config.updated_at), Date.now() - END_NOTICE_WINDOW_MS);
  }

  /** The ledger's ends no longer due go (a start would not look for them). A wait with no end after it stays while the run
   *  stands at it, however long: never pruned by age, so the same question is never asked again. */
  private async prune(config: Config): Promise<void> {
    const stale = [...this.notices].filter(([, noticed]) => noticed.ended !== undefined && !this.due(noticed.ended, config));
    if (!stale.length) return;
    try {
      await this.store.channels.forget(WEBHOOK_CHANNEL, stale.map(([runId, noticed]) => ({ runId, marker: `${ENDED}${noticed.ended}` })));
    } catch {
      return;
    }
    for (const [runId, noticed] of stale) {
      if (noticed.wait === undefined) this.notices.delete(runId);
      else this.notices.set(runId, { wait: noticed.wait });
    }
  }

  private schedule(id: string, delayMs: number): void {
    if (this.closed) return;
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      // No try rejects unhandled, which would stop the server: one that throws is said, and its message stays as it was.
      this.attempt(id, { retry: true, redelivery: false }).catch((error: unknown) => {
        try {
          this.say({ condition: "attempt_failed", webhook_id: id, error: error instanceof Error ? error.message : String(error) });
        } catch {}
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
    if (!how.redelivery && !(await this.store.channels.claim(id, now, CLAIM_MS))) return attempt;
    const config = this.config;
    const secret = this.secrets.get(SERVER_SCOPE, SECRET_FIELD);
    let failure: string | undefined;
    if (!config) failure = "the webhook was removed";
    else if (config.disabled) failure = "the webhook is off";
    else if (secret === undefined) failure = "the secret does not open here (unreadable): set the webhook again";
    else {
      const timestamp = String(Math.floor(now / 1000));
      const started = performance.now();
      const target = new URL(config.url);
      const dial = await this.dialled(target);
      if ("refused" in dial) failure = dial.refused;
      else {
        try {
          const res = await undiciFetch(target, {
            method: "POST", redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.stop.signal]),
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
    attempt.error = failure ?? null;
    // The message as it stands now: a redelivery may have sent it while this try waited.
    const standingPost = (await this.store.channels.get(id).catch(() => post)) ?? post;
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
    try {
      await this.store.channels.settle(id, to ?? { state: standingPost.state, reason: standingPost.reason }, row, { kept: ATTEMPTS_KEPT, sending: [...this.sending.keys()] });
    } catch (error) {
      // Not written: the message stays as the store held it, and a queued one is tried again after the next wait (its
      // receiver may get it twice, under the same webhook-id).
      this.say({ condition: "attempt_unsaved", webhook_id: id, error: (error as Error).message });
      // Its claim runs out first, so the next try can take it.
      if (standingPost.state === "sending" && !how.redelivery) this.schedule(id, Math.max(delay ?? 0, CLAIM_MS));
      return attempt;
    }
    if (delay !== undefined) this.schedule(id, delay);
    if (to?.state === "dropped") this.say({ condition: "delivery_failed", type: attempt.type, webhook_id: id, attempts, ...(attempt.status_code !== null ? { status_code: attempt.status_code } : {}), error: failure! });
    if (gone) {
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
    return attempt;
  }

  /** Every queued message dropped, with `why` in the log. */
  private async drop(why: string): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const count = await this.store.channels.dropAll(WEBHOOK_CHANNEL, why).catch(() => 0);
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
