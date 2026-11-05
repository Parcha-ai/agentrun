// Slack: a mention of this server's Slack app in a channel a trigger lists starts that trigger's run, keyed to its thread
// (triggers.ts), a reply in the thread is a message to that run, and one line is posted in the thread when the run needs
// its person and when it ends. One Slack app a server: PUT /v2/settings/slack keeps its signing secret and bot token
// sealed in DIR/slack.json under the seal key (tool-keys.ts), never in the clear, and never shown again. Each request
// to POST /v2/hooks/slack is checked by Slack's v0 signature on its raw body before anything else. The lines posted wait
// in DIR/slack-outbox.json, with the ledger of what each run's thread was told, and are tried again on the webhook's
// schedule (webhooks.ts RETRY_MS) until chat.postMessage takes them.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { RETRY_MS, type RunNotice } from "./webhooks.js";
import { isObject, type Json, unknownFields } from "./validate.js";

export const SLACK_FILE = "slack.json";
export const SLACK_OUTBOX = "slack-outbox.json";
export const SLACK_API = "https://slack.com/api";
/** How far a request's X-Slack-Request-Timestamp may be from this server's clock, either way. */
export const SLACK_TOLERANCE_S = 300;
/** The most of a run's answer a thread is posted, when the settings ask for the answer (`post_answer`). */
export const ANSWER_POSTED_CHARS = 3_000;
const TIMEOUT_MS = 15_000;
/** A ledger entry is dropped this long after it was last written: its thread is gone from the trigger by then. */
const LEDGER_KEPT_MS = 30 * 86_400_000;
const AUTH_GONE = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);
const TRY_AGAIN = new Set(["ratelimited", "rate_limited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"]);
const aad = (field: string) => `slack/1|${field}`;

type Settings = { team_id: string; bot_user_id: string; bot_id: string; app_id?: string; post_answer: boolean; signing_secret: string; bot_token: string; updated_at: string; disabled?: { at: string; reason: string } };
/** A message to post: a run's moment, in its thread. */
type Post = { id: string; channel: string; thread_ts: string; text: string; attempts: number; next_at: number };
/** What a run's thread was told: the wait it stands at and its end, by their markers (runs.ts notify). */
type Told = { wait?: string; ended?: string; at: string };
/** A Slack message a trigger may act on: a mention, or a reply in a thread. `thread_ts` is its thread's (its own `ts` at
 *  the top level), `text` its text with the app's mention taken out. */
export type SlackMessage = { team: string; channel: string; ts: string; thread_ts: string; user: string; text: string; event_id: string; mention: boolean };

/** Why a request to POST /v2/hooks/slack is not signed by `secret`, or undefined when it is: X-Slack-Signature is
 *  `v0=` and the hex HMAC-SHA256 of "v0:{X-Slack-Request-Timestamp}:{raw body}" under the signing secret, and the
 *  timestamp is within SLACK_TOLERANCE_S of now. */
export function slackRefusal(secret: string, headers: Record<string, string | string[] | undefined>, body: Buffer, nowMs: number): string | undefined {
  const timestamp = headers["x-slack-request-timestamp"];
  const signature = headers["x-slack-signature"];
  if (typeof timestamp !== "string" || typeof signature !== "string") return "missing_headers";
  if (!/^\d{1,12}$/.test(timestamp) || !/^v0=[0-9a-f]{64}$/.test(signature)) return "malformed_headers";
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SLACK_TOLERANCE_S) return "stale_timestamp";
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`);
  return timingSafeEqual(expected, Buffer.from(signature)) ? undefined : "bad_signature";
}

/** The message an event_callback carries, if a trigger may act on it; else why it is ignored. Ignored: another workspace
 *  (the envelope's, or the person's, in a shared channel), another app, a message from a bot or this app's own, an
 *  edit or anything but a person's message, a direct message, and a message with no thread or mention to act on. */
export function slackMessageOf(envelope: Json, own: { team_id: string; bot_user_id: string; app_id?: string }): SlackMessage | { ignored: string } {
  if (envelope.team_id !== own.team_id) return { ignored: "another workspace" };
  if (own.app_id && envelope.api_app_id !== own.app_id) return { ignored: "another app" };
  const event = envelope.event;
  if (!isObject(event) || (event.type !== "app_mention" && event.type !== "message")) return { ignored: "not a message" };
  if (event.bot_id !== undefined || event.subtype === "bot_message" || typeof event.user !== "string" || event.user === own.bot_user_id || event.user === "USLACK") return { ignored: "a bot's message" };
  if (event.subtype !== undefined && event.subtype !== "file_share" && event.subtype !== "thread_broadcast") return { ignored: `a ${String(event.subtype)} message` };
  if ([event.team, event.user_team, event.source_team].some((team) => team !== undefined && team !== own.team_id)) return { ignored: "a person of another workspace" };
  if (event.channel_type === "im" || typeof event.channel !== "string" || typeof event.ts !== "string" || typeof event.text !== "string" || typeof envelope.event_id !== "string") return { ignored: "not a channel message" };
  const mentioned = new RegExp(`<@${own.bot_user_id}(\\|[^>]*)?>`, "g");
  const mention = event.type === "app_mention" || event.text.includes(`<@${own.bot_user_id}`);
  const thread_ts = typeof event.thread_ts === "string" ? event.thread_ts : event.ts;
  return { team: own.team_id, channel: event.channel, ts: event.ts, thread_ts, user: event.user, text: event.text.replace(mentioned, "").trim(), event_id: envelope.event_id, mention };
}

/** The settings `file` keeps, if it holds them. */
function settingsIn(file: string): Settings | undefined {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isObject(doc) && doc.v === 1 && typeof doc.team_id === "string" && typeof doc.signing_secret === "string" && typeof doc.bot_token === "string" ? (doc as unknown as Settings) : undefined;
  } catch {
    return undefined;
  }
}

/** Both secrets, opened under `key`; undefined with no key, or one they were not sealed under. */
function openedWith(key: Buffer | undefined, settings: Settings): { signing_secret: string; bot_token: string } | undefined {
  if (!key) return undefined;
  try {
    const open = (field: "signing_secret" | "bot_token") => unseal(key, Buffer.from(settings[field], "base64"), aad(field)).toString("utf8");
    return { signing_secret: open("signing_secret"), bot_token: open("bot_token") };
  } catch {
    return undefined;
  }
}

/** The Slack secrets data directory `data` keeps, opened with the seal key of `env`: what an import cuts out of
 *  everything it writes. */
export function slackSecretsIn(data: string, env: NodeJS.ProcessEnv): string[] {
  const settings = settingsIn(join(data, SLACK_FILE));
  const opened = settings && openedWith(sealKeyOf(env[SEAL_KEY_ENV]), settings);
  return opened ? [opened.signing_secret, opened.bot_token] : [];
}

export class Slack {
  private readonly file: string;
  private readonly outbox: string;
  private readonly key: Buffer | undefined;
  private posts: Post[] = [];
  private told: Record<string, Told> = {};
  private base: string | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly stop = new AbortController();
  private closed = false;

  /** `api`: Slack's Web API (a test's fake); `retryMs`: the waits between tries of a post. */
  constructor(data: string, env: NodeJS.ProcessEnv, private readonly say: (fields: Record<string, string | number>) => void, private readonly api = SLACK_API, private readonly retryMs: readonly number[] = RETRY_MS) {
    this.file = join(data, SLACK_FILE);
    this.outbox = join(data, SLACK_OUTBOX);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    try {
      const doc = JSON.parse(readFileSync(this.outbox, "utf8")) as unknown;
      if (isObject(doc) && doc.v === 1 && Array.isArray(doc.posts) && isObject(doc.told)) ({ posts: this.posts, told: this.told } = doc as unknown as { posts: Post[]; told: Record<string, Told> });
    } catch {}
    for (const post of this.posts) this.schedule(post, Math.max(0, post.next_at - Date.now()));
  }

  /** The page's address, for each line's link to its run: only a public one (AGENTRUN_PUBLIC_URL), which a person in
   *  Slack can open; none, and the lines carry no link. */
  attach(base: string | undefined): void {
    this.base = base ? base.replace(/\/+$/, "") : null;
  }

  close(): void {
    this.closed = true;
    this.stop.abort();
    for (const timer of this.timers) clearTimeout(timer);
  }

  // ---- settings -------------------------------------------------------------------------------------------------------

  /** GET: the workspace and app, whether the answer is posted, whether lines carry a link, and why posting is off, if it
   *  is; never a secret. */
  view() {
    const settings = this.settings();
    if (!settings) return { configured: false as const };
    return { configured: true as const, team_id: settings.team_id, bot_user_id: settings.bot_user_id, app_id: settings.app_id ?? null, post_answer: settings.post_answer, links: this.base !== null, at_rest: this.opened(settings) ? "sealed" : "unreadable", disabled: settings.disabled ?? null, updated_at: settings.updated_at };
  }

  /** PUT: `{signing_secret, bot_token, app_id?, post_answer?}`, the bot token checked with Slack's auth.test (which names
   *  the workspace and the app's bot user) before anything is kept. Both secrets are kept sealed; posting is on again. */
  async save(body: Json): Promise<ReturnType<Slack["view"]>> {
    const issues = unknownFields(body, ["signing_secret", "bot_token", "app_id", "post_answer"]);
    const text = (field: string, max: number) => typeof body[field] === "string" && (body[field] as string).length >= 1 && (body[field] as string).length <= max;
    if (!text("signing_secret", 256)) issues.push({ field: "signing_secret", reason: body.signing_secret === undefined ? "missing" : "wrong_type", message: "signing_secret is the Slack app's signing secret (Basic Information)" });
    if (!text("bot_token", 512)) issues.push({ field: "bot_token", reason: body.bot_token === undefined ? "missing" : "wrong_type", message: "bot_token is the app's bot token (xoxb-...), with chat:write" });
    if (body.app_id !== undefined && !(typeof body.app_id === "string" && /^A[A-Z0-9]{2,30}$/.test(body.app_id))) issues.push({ field: "app_id", reason: "wrong_type", message: "app_id is the Slack app's id (A...)" });
    if (body.post_answer !== undefined && typeof body.post_answer !== "boolean") issues.push({ field: "post_answer", reason: "wrong_type", message: "post_answer is true or false" });
    if (issues.length) throw invalid(issues);
    if (!this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no Slack secrets: it never keeps one in the clear.`);
    const who = await this.call("auth.test", body.bot_token as string, {});
    if (!who.ok) throw invalid([{ field: "bot_token", reason: "invalid", message: `Slack refused the bot token: ${who.error}` }]);
    if (typeof who.body.team_id !== "string" || typeof who.body.user_id !== "string") throw new ApiError("upstream_failed", "Slack's auth.test named no workspace or bot user.");
    const settings: Settings = {
      team_id: who.body.team_id, bot_user_id: who.body.user_id, bot_id: typeof who.body.bot_id === "string" ? who.body.bot_id : "", ...(typeof body.app_id === "string" ? { app_id: body.app_id } : {}),
      post_answer: body.post_answer === true, signing_secret: this.sealed("signing_secret", body.signing_secret as string), bot_token: this.sealed("bot_token", body.bot_token as string), updated_at: new Date().toISOString(),
    };
    writeDurableSync(this.file, `${JSON.stringify({ v: 1, ...settings }, null, 2)}\n`);
    return this.view();
  }

  /** DELETE: the settings gone: a request to /v2/hooks/slack is refused, and nothing more is posted. */
  remove(): void {
    rmSync(this.file, { force: true });
  }

  /** The signing secret and who this app is, to check a request by; undefined when Slack is not set here (or its secret
   *  does not open). */
  checker(): { signing_secret: string; team_id: string; bot_user_id: string; app_id?: string } | undefined {
    const settings = this.settings();
    const opened = settings && this.opened(settings);
    return settings && opened ? { signing_secret: opened.signing_secret, team_id: settings.team_id, bot_user_id: settings.bot_user_id, ...(settings.app_id ? { app_id: settings.app_id } : {}) } : undefined;
  }

  /** Both secrets, opened, for the redaction of what is shown, and an import's cut. */
  values(): string[] {
    const settings = this.settings();
    const opened = settings && this.opened(settings);
    return opened ? [opened.signing_secret, opened.bot_token] : [];
  }

  // ---- posting --------------------------------------------------------------------------------------------------------

  /** A run's moment, told by runs.ts as webhooks.ts is (`marker` names it), for a run a Slack trigger started in
   *  `thread`: one line queued for its thread, once per moment, in the same write as the ledger. `answer`: the run's
   *  final answer, posted when the settings ask for it. */
  emit(type: "run.needs_input" | "run.ended", run: RunNotice, marker: string, thread: { channel: string; thread_ts: string }, answer?: string | null): void {
    if (this.closed || !this.settings() || this.settings()!.disabled) return;
    const told = this.told[run.run_id];
    const ends = type === "run.ended";
    if ((ends ? told?.ended : told?.wait) === marker) return;
    const id = `slk_${createHash("sha256").update(`${run.run_id}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;
    this.told[run.run_id] = { ...told, ...(ends ? { ended: marker } : { wait: marker }), at: new Date().toISOString() };
    if (!this.posts.some((p) => p.id === id)) {
      const post: Post = { id, ...thread, text: this.line(type, run, answer), attempts: 0, next_at: Date.now() };
      this.posts.push(post);
      this.schedule(post, 0);
    }
    this.write();
  }

  /** Whether `run`'s end was told its thread already: a start's catch-up queues one it lacks. */
  toldEnd(runId: string): boolean {
    return this.told[runId]?.ended !== undefined;
  }

  private line(type: "run.needs_input" | "run.ended", run: RunNotice, answer?: string | null): string {
    const link = this.base ? `<${this.base}/#/runs/${encodeURIComponent(run.run_id)}|open the run>` : null;
    if (type === "run.needs_input") {
      const kind = run.pending?.kind;
      if (kind === "budget") return link ? `Paused at its spend cap: ${link}` : "Paused at its spend cap.";
      const head = kind === "question" ? "Waiting for your answer: reply in this thread" : "Stopped: reply in this thread to go on";
      return link ? `${head}, or ${link}` : `${head}.`;
    }
    const head = run.status === "completed" ? "Done" : run.status === "cancelled" ? "Cancelled" : "Failed";
    const said = run.status === "completed" && answer && this.settings()?.post_answer ? `\n\n${answer.length > ANSWER_POSTED_CHARS ? `${answer.slice(0, ANSWER_POSTED_CHARS)}…` : answer}` : "";
    return `${head}${link ? `: ${link}` : "."}${said}`;
  }

  private schedule(post: Post, delayMs: number): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.attempt(post).catch((error: Error) => this.say({ condition: "slack_post_failed", post: post.id, error: error.message }));
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  /** One try of chat.postMessage, in the thread (its parent's ts). Taken (`ok`): gone from the outbox. Rate limited, or
   *  a failure Slack says may pass, or no answer: tried again after the next wait (at least its Retry-After). The bot
   *  token refused: posting turned off until the settings are saved again. Anything else: failed, and said. A post whose
   *  answer never came may have landed: tried again, it can show twice. */
  private async attempt(post: Post): Promise<void> {
    const settings = this.settings();
    const opened = settings && this.opened(settings);
    if (this.closed || !this.posts.includes(post)) return;
    if (!settings || !opened || settings.disabled) return this.drop(post, settings ? "posting is off" : "Slack is not set here");
    const answer = await this.call("chat.postMessage", opened.bot_token, { channel: post.channel, thread_ts: post.thread_ts, text: post.text, unfurl_links: false, unfurl_media: false });
    if (this.closed) return;
    post.attempts += 1;
    if (answer.ok) return this.drop(post);
    if (AUTH_GONE.has(answer.error)) {
      this.writeSettings({ ...settings, disabled: { at: new Date().toISOString(), reason: `Slack refused the bot token (${answer.error}): save the settings again` } });
      this.say({ condition: "slack_disabled", error: answer.error });
      return this.drop(post, answer.error);
    }
    const wait = this.retryMs[post.attempts - 1];
    if ((answer.retry || TRY_AGAIN.has(answer.error)) && wait !== undefined) {
      const delay = Math.max(wait, answer.retry_after_ms ?? 0);
      post.next_at = Date.now() + delay;
      this.write();
      return this.schedule(post, delay);
    }
    this.drop(post, answer.error);
  }

  /** `post` out of the outbox: taken, or failed with `why`, said. */
  private drop(post: Post, why?: string): void {
    this.posts = this.posts.filter((p) => p !== post);
    if (why) this.say({ condition: "slack_post_failed", post: post.id, attempts: post.attempts, error: why });
    this.write();
  }

  /** A call of Slack's Web API with the bot token: `ok` with Slack's body, or its error (`retry`: one that may pass). */
  private async call(method: string, token: string, body: Record<string, unknown>): Promise<{ ok: true; body: Json } | { ok: false; error: string; retry?: boolean; retry_after_ms?: number }> {
    try {
      const res = await fetch(`${this.api}/${method}`, { method: "POST", redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.stop.signal]), headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
      const after = Number(res.headers.get("retry-after"));
      const json = (await res.json().catch(() => null)) as Json | null;
      if (res.status === 429) return { ok: false, error: "ratelimited", retry: true, ...(after > 0 ? { retry_after_ms: after * 1000 } : {}) };
      if (res.status >= 500 || !json) return { ok: false, error: `answered ${res.status}`, retry: true };
      if (json.ok !== true) return { ok: false, error: typeof json.error === "string" ? json.error : "not ok", ...(after > 0 ? { retry_after_ms: after * 1000 } : {}) };
      return { ok: true, body: json };
    } catch (error) {
      return { ok: false, error: (error as Error).name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : `not reached: ${(error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message}`, retry: true };
    }
  }

  private write(): void {
    if (this.closed) return;
    const old = Date.now() - LEDGER_KEPT_MS;
    for (const [id, told] of Object.entries(this.told)) if (Date.parse(told.at) < old) delete this.told[id];
    try {
      writeDurableSync(this.outbox, `${JSON.stringify({ v: 1, posts: this.posts, told: this.told })}\n`);
    } catch (error) {
      // Held here: the next write carries it, and a post's own try goes on.
      this.say({ condition: "slack_outbox_unwritable", file: this.outbox, error: (error as NodeJS.ErrnoException).code ?? "unknown" });
    }
  }

  private settings(): Settings | undefined {
    return settingsIn(this.file);
  }

  private writeSettings(settings: Settings): void {
    try {
      writeDurableSync(this.file, `${JSON.stringify({ v: 1, ...settings }, null, 2)}\n`);
    } catch (error) {
      this.say({ condition: "slack_settings_unwritable", file: this.file, error: (error as NodeJS.ErrnoException).code ?? "unknown" });
    }
  }

  private sealed(field: string, value: string): string {
    return seal(this.key!, Buffer.from(value, "utf8"), aad(field)).toString("base64");
  }

  private opened(settings: Settings): { signing_secret: string; bot_token: string } | undefined {
    return openedWith(this.key, settings);
  }
}

/** What an unset server checks a request against, so a refusal takes the time a real check does. */
export const NO_SLACK_SECRET = randomBytes(32).toString("hex");
