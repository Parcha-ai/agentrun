// Slack's half that is not the trigger kernel's: the one line posted in a thread when its run needs its person and when
// it ends, through the server's Slack app (its settings: PUT /v2/settings/sources/slack, source-settings.ts, the bot
// token checked with Slack's auth.test and kept in the Slack source's sealed settings, never in the clear).
// The lines wait in DIR/slack-outbox.json, with the ledger of what each run's thread was told, and are tried again on
// the webhook's schedule (webhooks.ts RETRY_MS) until chat.postMessage takes them. Requests to /v2/hooks/slack, and
// what a message does, are the Slack adapter's and the kernel's (trigger-slack.ts, triggers.ts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeDurableSync } from "./files.js";
import { type SealedSettings, SERVER_SCOPE } from "./sealed-settings.js";
import { SLACK_API } from "./trigger-slack.js";
import { RETRY_MS, type RunNotice } from "./webhooks.js";
import { isObject, type Json } from "./validate.js";

export const SLACK_OUTBOX = "slack-outbox.json";
/** The most of a run's answer a thread is posted, when its trigger asks for the answer (its source's `post_answer`). */
export const ANSWER_POSTED_CHARS = 3_000;
const TIMEOUT_MS = 15_000;
/** How soon an outbox write that failed is tried again: until it is kept, the next server could post a taken line again. */
const WRITE_RETRY_MS = 5_000;
/** A ledger entry is dropped this long after it was last written: its thread is gone from the trigger by then. */
const LEDGER_KEPT_MS = 30 * 86_400_000;
const AUTH_GONE = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);
const TRY_AGAIN = new Set(["ratelimited", "rate_limited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"]);

/** The app as its settings keep it: who it is, when it was saved, why posting is off (if it is), and its two secrets. */
type Settings = { team_id: string; bot_user_id: string; bot_id: string; app_id?: string; signing_secret: string; bot_token: string; updated_at: string; disabled?: { at: string; reason: string } };
/** A message to post: a run's moment, in its thread. */
/** A line to post, for its run (`run_id`). A waiting line keeps the wait it was for too (`wait`, its marker): it goes
 *  only while the run still waits there. */
type Post = { id: string; channel: string; thread_ts: string; text: string; attempts: number; next_at: number; run_id: string; wait?: string };
/** What a run's thread was told: the wait it stands at and its end, by their markers (runs.ts notify). */
type Told = { wait?: string; ended?: string; at: string };
/** Text as Slack shows it, never as its markup: `&`, `<` and `>` escaped, so an agent's words can mention no one (no
 *  `<!channel>`, no `<@U...>`) and make no link. */
export const slackText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The one line a run's moment posts in its thread. Waiting, by `pending.kind`: a question is answered by a reply in the
 *  thread; an approval (a tool call waiting on its owner's OK, which names the tool) only in the console, as no reply
 *  approves; a pause at the cap by a raise; a stop by a reply that goes on; any other kind, at the run. Ended: its status,
 *  and with `answer` (given when the thread's trigger posts it, its source's post_answer) the run's final answer, escaped and cut to ANSWER_POSTED_CHARS. `base`:
 *  the console's public URL, for the run's link; none, no link. */
export function slackLine(type: "run.needs_input" | "run.ended", run: RunNotice, { base, answer }: { base: string | null; answer?: string | null }): string {
  const link = base ? `<${base}/#/runs/${encodeURIComponent(run.run_id)}|open the run>` : null;
  if (type === "run.needs_input") {
    // A kind this server may not have yet (an approval) read by name, as its notice will carry it.
    const pending = run.pending as { kind?: unknown; tool?: unknown } | undefined;
    const kind = pending?.kind;
    if (kind === "budget") return link ? `Paused at its spend cap: ${link}` : "Paused at its spend cap.";
    if (kind === "approval") {
      const of = typeof pending?.tool === "string" && pending.tool ? ` of ${slackText(pending.tool)}` : "";
      return `Waiting for your approval${of}: approve in the console${link ? ` ${link}` : "."}`;
    }
    if (kind === "question" || kind === "stopped") {
      const head = kind === "question" ? "Waiting for your answer: reply in this thread" : "Stopped: reply in this thread to go on";
      return link ? `${head}, or ${link}` : `${head}.`;
    }
    return link ? `Waiting: ${link}` : "Waiting: open the run in the console.";
  }
  const head = run.status === "completed" ? "Done" : run.status === "cancelled" ? "Cancelled" : "Failed";
  const shown = answer ? slackText(answer.length > ANSWER_POSTED_CHARS ? `${answer.slice(0, ANSWER_POSTED_CHARS)}…` : answer) : "";
  const said = run.status === "completed" && shown ? `\n\n${shown}` : "";
  return `${head}${link ? `: ${link}` : "."}${said}`;
}

export class Slack {
  private readonly outbox: string;
  private posts: Post[] = [];
  private told: Record<string, Told> = {};
  private base: string | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly stop = new AbortController();
  private closed = false;
  /** The outbox in memory differs from the one on disk: its last write failed, and is tried again (WRITE_RETRY_MS). */
  private unsaved = false;
  private rewrite: NodeJS.Timeout | undefined;
  /** The wait a run stands at now (runs.ts currentWait), set once the runs are; null, none. */
  private waits: ((runId: string) => Promise<string | null>) | undefined;

  /** `store`: the Slack source's sealed settings (sealed-settings.ts), the server's, where the app is kept; `api`:
   *  Slack's Web API (a test's fake); `retryMs`: the waits between tries of a post. */
  constructor(data: string, private readonly store: SealedSettings | undefined, private readonly say: (fields: Record<string, string | number>) => void, private readonly api = SLACK_API, private readonly retryMs: readonly number[] = RETRY_MS) {
    this.outbox = join(data, SLACK_OUTBOX);
    try {
      const doc = JSON.parse(readFileSync(this.outbox, "utf8")) as unknown;
      if (isObject(doc) && doc.v === 1 && Array.isArray(doc.posts) && isObject(doc.told)) ({ posts: this.posts, told: this.told } = doc as unknown as { posts: Post[]; told: Record<string, Told> });
    } catch {}
    // Every line names its run, and a waiting line its wait: one that does not is dropped, never posted.
    const unreadable = (post: Post) => (typeof post.run_id !== "string" ? "no run_id" : post.wait !== undefined && typeof post.wait !== "string" ? "bad wait" : undefined);
    const dropped = this.posts.filter((post) => unreadable(post) !== undefined);
    if (dropped.length) {
      for (const post of dropped) this.say({ condition: "slack_post_dropped", post: post.id, reason: unreadable(post)! });
      this.posts = this.posts.filter((post) => !dropped.includes(post));
      this.write();
    }
    for (const post of this.posts) this.schedule(post, Math.max(0, post.next_at - Date.now()));
  }

  /** The page's address, for each line's link to its run: only a public one (AGENTRUN_PUBLIC_URL), which a person in
   *  Slack can open; none, and the lines carry no link. */
  attach(base: string | undefined): void {
    this.base = base ? base.replace(/\/+$/, "") : null;
  }

  /** How a waiting line learns whether its run still waits there, given once the server's runs are. */
  watchWaits(waits: (runId: string) => Promise<string | null>): void {
    this.waits = waits;
  }

  close(): void {
    // What it holds, written once more as it stops: a line Slack took and a write that failed would be posted again.
    if (this.unsaved) this.write();
    this.closed = true;
    this.stop.abort();
    for (const timer of this.timers) clearTimeout(timer);
  }

  // ---- posting --------------------------------------------------------------------------------------------------------

  /** A run's moment, told by runs.ts as webhooks.ts is (`marker` names it), for a run a Slack trigger started in
   *  `thread`: one line queued for its thread, once per moment, in the same write as the ledger. `answer`: the run's
   *  final answer, given only when the thread's trigger posts it (its source's post_answer). */
  emit(type: "run.needs_input" | "run.ended", run: RunNotice, marker: string, thread: { channel: string; thread_ts: string }, answer?: string | null): void {
    if (this.closed || !this.settings() || this.settings()!.disabled) return;
    const told = this.told[run.run_id];
    const ends = type === "run.ended";
    if ((ends ? told?.ended : told?.wait) === marker) return;
    const id = `slk_${createHash("sha256").update(`${run.run_id}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;
    this.told[run.run_id] = { ...told, ...(ends ? { ended: marker } : { wait: marker }), at: new Date().toISOString() };
    // The run has left any other wait it was told of (an end, or another wait): those waiting lines still queued go.
    const stale = this.posts.filter((p) => p.run_id === run.run_id && p.wait !== undefined && (ends || p.wait !== marker));
    if (stale.length) (this.posts = this.posts.filter((p) => !stale.includes(p)), stale.forEach((p) => this.say({ condition: "slack_post_stale", post: p.id })));
    if (!this.posts.some((p) => p.id === id)) {
      const post: Post = { id, ...thread, text: this.line(type, run, answer), attempts: 0, next_at: Date.now(), run_id: run.run_id, ...(ends ? {} : { wait: marker }) };
      this.posts.push(post);
      this.schedule(post, 0);
    }
    this.write();
  }

  /** Whether `run`'s end at `marker` (its end time) was told its thread already: a start's catch-up queues one it lacks.
   *  A run a thread reply opened again ends again, at another time, so an earlier end is not this one. */
  toldEnd(runId: string, marker: string): boolean {
    return this.told[runId]?.ended === marker;
  }

  private line(type: "run.needs_input" | "run.ended", run: RunNotice, answer?: string | null): string {
    return slackLine(type, run, { base: this.base, answer });
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
    // A waiting line goes only while its run still waits there: an answer, in the thread or the console, takes it out
    // of the wait with no notice. Asked before every try; a run that cannot be read is taken to wait, so a real line is
    // never lost to a busy store. Before the server's runs are, it waits for them.
    if (post.wait !== undefined) {
      if (!this.waits) return this.schedule(post, 250);
      const now = await this.waits(post.run_id).catch(() => post.wait);
      if (this.closed || !this.posts.includes(post)) return;
      if (now !== post.wait) {
        this.say({ condition: "slack_post_stale", post: post.id });
        return this.drop(post);
      }
    }
    const answer = await this.call("chat.postMessage", opened.bot_token, { channel: post.channel, thread_ts: post.thread_ts, text: post.text, unfurl_links: false, unfurl_media: false });
    if (this.closed) return;
    post.attempts += 1;
    if (answer.ok) return this.drop(post);
    if (AUTH_GONE.has(answer.error)) {
      // Turned off only as the settings still stand: ones deleted or saved again during the wait are never written back.
      const now = this.settings();
      if (now && now.updated_at === settings.updated_at && now.bot_token === settings.bot_token) {
        this.writeSettings({ ...now, disabled: { at: new Date().toISOString(), reason: `Slack refused the bot token (${answer.error}): save the settings again` } });
        this.say({ condition: "slack_disabled", error: answer.error });
      }
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
      this.unsaved = false;
    } catch (error) {
      // Held here and tried again until kept (a stop writes it too): a post's own try goes on meanwhile.
      this.unsaved = true;
      this.say({ condition: "slack_outbox_unwritable", file: this.outbox, error: (error as NodeJS.ErrnoException).code ?? "unknown" });
      if (!this.rewrite && !this.closed) {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.rewrite = undefined;
          if (this.unsaved) this.write();
        }, WRITE_RETRY_MS);
        timer.unref();
        this.timers.add(timer);
        this.rewrite = timer;
      }
    }
  }

  /** The app as its settings keep it now; undefined when it is not set here (or does not open). */
  private settings(): Settings | undefined {
    const get = (field: string) => this.store?.get(SERVER_SCOPE, field);
    const [team_id, bot_user_id, updated_at, signing_secret, bot_token] = ["team_id", "bot_user_id", "updated_at", "signing_secret", "bot_token"].map(get);
    if (!team_id || !bot_user_id || !updated_at || !signing_secret || !bot_token) return undefined;
    const app_id = get("app_id");
    const [at, reason] = [get("disabled_at"), get("disabled_reason")];
    return { team_id, bot_user_id, bot_id: get("bot_id") ?? "", ...(app_id ? { app_id } : {}), signing_secret, bot_token, updated_at, ...(at && reason ? { disabled: { at, reason } } : {}) };
  }

  /** Posting turned off: why, kept with the settings until they are saved again. */
  private writeSettings(settings: Settings): void {
    try {
      if (settings.disabled) for (const [field, value] of [["disabled_at", settings.disabled.at], ["disabled_reason", settings.disabled.reason]] as const) this.store?.set(SERVER_SCOPE, field, value);
    } catch (error) {
      this.say({ condition: "slack_settings_unwritable", error: (error as Error).message });
    }
  }

  private opened(settings: Settings): { signing_secret: string; bot_token: string } {
    return { signing_secret: settings.signing_secret, bot_token: settings.bot_token };
  }
}
