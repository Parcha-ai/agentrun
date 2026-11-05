// GitHub: a mention of this server's handle on an issue or pull request in a repo a trigger lists, by its owner, a member
// or a collaborator, or an issue assigned to the configured login, starts that trigger's run, keyed to the issue or pull
// request (triggers.ts conversations), and a later mention there is a message to that run. One set of settings a server:
// PUT /v2/settings/github keeps the webhook secret and the token that comments sealed in DIR/github.json under the seal
// key (tool-keys.ts), never in the clear and never shown again. Each request to POST /v2/hooks/github is checked by
// GitHub's X-Hub-Signature-256 on its raw body before anything else. One comment is posted on the issue or pull request
// when its run needs its person and when it ends; comments wait in DIR/github-outbox.json, with the ledger of what each
// run's issue was told, and are tried again on the webhook's schedule (webhooks.ts RETRY_MS) until GitHub takes them.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { RETRY_MS, type RunNotice } from "./webhooks.js";
import { isObject, type Json, unknownFields } from "./validate.js";

export const GITHUB_FILE = "github.json";
export const GITHUB_OUTBOX = "github-outbox.json";
export const GITHUB_API = "https://api.github.com";
/** The most of a run's answer a comment carries, when its trigger asks for the answer (its source's `post_answer`). */
export const ANSWER_POSTED_CHARS = 3_000;
const TIMEOUT_MS = 15_000;
/** How soon an outbox write that failed is tried again: until it is kept, the next server could post a taken comment
 *  again. */
const WRITE_RETRY_MS = 5_000;
/** A ledger entry is dropped this long after it was last written: its issue is gone from the trigger by then. */
const LEDGER_KEPT_MS = 30 * 86_400_000;
/** U+2060 WORD JOINER: shown as nothing, and it ends a mention or a reference GitHub would link. */
const JOINER = "\u2060";
/** The shortest webhook secret kept: GitHub sets none, and a short one is guessed. */
export const MIN_SECRET_CHARS = 16;
/** Who may start or talk to a run from GitHub: the repo's owner, a member of its organisation, or a collaborator. A
 *  MEMBER is any member of the organisation, one who can only read the repo too. */
export const ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const;
/** The events a GitHub trigger acts on (each with its actions): what the webhook subscribes to. */
export const GITHUB_EVENTS = ["issue_comment", "pull_request_review_comment", "issues"] as const;
const aad = (field: string) => `github/1|${field}`;
/** A GitHub login: 1 to 39 letters, digits and single hyphens, no hyphen at either end; an app's is followed by `[bot]`. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;

/** A comment to post: a run's moment, on its issue or pull request. */
type Post = { id: string; repo: string; number: number; body: string; attempts: number; next_at: number };
/** What a run's issue was told: the wait it stands at and its end, by their markers (runs.ts notify). */
type Told = { wait?: string; ended?: string; at: string };
type Settings = { handle: string; assignee_login?: string; webhook_secret: string; token: string; updated_at: string; disabled?: { at: string; reason: string } };

/** A GitHub event a trigger may act on: in `repo` (its id and full name), on issue or pull request `number`, written by
 *  `user`. `key`, the object it is (a comment's id, or the delivery of an assignment), its firing's key; `text`, what the
 *  run is given (the title, then the comment, the review comment's place, or the issue's body); `mention`, whether it is
 *  addressed to the handle (an assignment always is). */
export type GitHubEvent = { repo_id: number; repo: string; number: number; user: string; key: string; text: string; mention: boolean };

/** Whether `text` mentions `handle`: `@handle` (any case, `[bot]` after it or not) as a word, neither part of a longer
 *  login, an address or a team, as GitHub links a mention. */
export function mentions(text: string, handle: string): boolean {
  return mentionPattern(handle).test(text);
}
const mentionPattern = (handle: string, flags = "i") => new RegExp(`(?<![A-Za-z0-9_@.\\-/])@${handle.replace(/\[bot\]$/, "").replace(/[-]/g, "\\-")}(?:\\[bot\\])?(?![A-Za-z0-9_\\-/\\[]|\\.[A-Za-z0-9])`, flags);

/** Why a request to POST /v2/hooks/github is not signed by `secret`, or undefined when it is: X-Hub-Signature-256 is
 *  `sha256=` and the hex HMAC-SHA256 of the raw body under the webhook secret, and X-GitHub-Event and X-GitHub-Delivery
 *  are there, each once. GitHub signs no time: a delivery sent again is the same delivery, deduped by what it is. */
export function gitHubRefusal(secret: string, headers: Record<string, string | string[] | undefined>, body: Buffer): string | undefined {
  const refused = gitHubHeadersRefusal(headers);
  if (refused) return refused;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from((headers["x-hub-signature-256"] as string).slice("sha256=".length), "hex")) ? undefined : "bad_signature";
}

/** Why the headers can never pass, before a byte of the body is read; undefined when they may. A header sent twice
 *  arrives joined (`a, b`), which no form here takes. */
export function gitHubHeadersRefusal(headers: Record<string, string | string[] | undefined>): string | undefined {
  const signature = headers["x-hub-signature-256"];
  const event = headers["x-github-event"];
  const delivery = headers["x-github-delivery"];
  if (typeof signature !== "string" || typeof event !== "string" || typeof delivery !== "string") return "missing_headers";
  if (!/^sha256=[0-9a-f]{64}$/.test(signature) || !/^[a-z_]{1,64}$/.test(event) || !/^[A-Za-z0-9-]{1,64}$/.test(delivery)) return "malformed_headers";
  return undefined;
}

/** The event a delivery carries, if a trigger may act on it; else why it is ignored. Acted on: a comment made (on an
 *  issue, a pull request, or a pull request's diff) by an owner, a member or a collaborator who is the delivery's
 *  sender, and an issue assigned to `assignee`. Ignored: a bot (by its type, or a login ending in `[bot]`), the handle
 *  itself, an edit or a removal, anyone else, and anything else. `delivery`: X-GitHub-Delivery. */
export function gitHubEventOf(event: string, body: Json, delivery: string, own: { handle: string; assignee_login?: string }): GitHubEvent | { ignored: string } {
  const repo = body.repository;
  const sender = body.sender;
  if (!isObject(repo) || !Number.isSafeInteger(repo.id) || typeof repo.full_name !== "string" || !isObject(sender) || typeof sender.login !== "string") return { ignored: "no repository or sender" };
  const self = own.handle.replace(/\[bot\]$/, "").toLowerCase();
  const botLike = (who: Json) => who.type === "Bot" || (typeof who.login === "string" && (/\[bot\]$/i.test(who.login) || who.login.replace(/\[bot\]$/i, "").toLowerCase() === self));
  if (botLike(sender)) return { ignored: "a bot's event" };
  const where = { repo_id: repo.id as number, repo: repo.full_name };
  if (event === "issues") {
    const issue = body.issue;
    const assignee = body.assignee;
    if (body.action !== "assigned" || !isObject(issue) || !Number.isSafeInteger(issue.number) || !isObject(assignee) || typeof assignee.login !== "string") return { ignored: "not an assignment" };
    if (!own.assignee_login || assignee.login.toLowerCase() !== own.assignee_login.toLowerCase()) return { ignored: "assigned to someone else" };
    // Only someone with triage access or more can assign an issue: GitHub checked who did.
    return { ...where, number: issue.number as number, user: sender.login, key: `assigned:${delivery}`, text: subject(issue, typeof issue.body === "string" ? issue.body : ""), mention: true };
  }
  if (event !== "issue_comment" && event !== "pull_request_review_comment") return { ignored: `a ${event} event` };
  const comment = body.comment;
  const on = event === "issue_comment" ? body.issue : body.pull_request;
  if (body.action !== "created") return { ignored: `a comment ${String(body.action)}` };
  if (!isObject(comment) || !Number.isSafeInteger(comment.id) || typeof comment.body !== "string" || !isObject(comment.user) || !isObject(on) || !Number.isSafeInteger(on.number)) return { ignored: "not a comment" };
  if (botLike(comment.user)) return { ignored: "a bot's comment" };
  if (comment.user.id !== sender.id) return { ignored: "a comment its sender did not write" };
  if (!(ASSOCIATIONS as readonly unknown[]).includes(comment.author_association)) return { ignored: "not an owner, member or collaborator" };
  const mention = mentions(comment.body, own.handle);
  const said = comment.body.replace(mentionPattern(own.handle, "gi"), "").trim();
  const place = event === "pull_request_review_comment" && typeof comment.path === "string" ? `On ${comment.path}${Number.isSafeInteger(comment.line) ? `:${comment.line}` : Number.isSafeInteger(comment.original_line) ? ` (line ${comment.original_line} before)` : ""}:\n` : "";
  const kind = event === "issue_comment" ? "comment" : "review_comment";
  return { ...where, number: on.number as number, user: comment.user.login as string, key: `${kind}:${comment.id}`, text: subject(on, `${place}${said}`), mention };
}

/** A run's answer as a comment carries it: cut to ANSWER_POSTED_CHARS, then defused, so it mentions no one (no
 *  `@login`, no `@org/team`), references no issue (`#12`, `owner/repo#12`, `GH-12` each put an event on that issue), and
 *  cannot close the block it is shown in. GitHub's own HTML sanitising does the rest; an issue's URL is left as it is,
 *  a link. A comment closes no issue: only a pull request's body and a commit's message do. */
export function gitHubText(text: string): string {
  const cut = text.length > ANSWER_POSTED_CHARS ? `${text.slice(0, ANSWER_POSTED_CHARS)}…` : text;
  return cut.replace(/@(?=[A-Za-z0-9])/g, `@${JOINER}`).replace(/#(?=\d)/g, `#${JOINER}`).replace(/\b(GH)-(?=\d)/gi, `$1${JOINER}-`).replace(/<\/details/gi, "&lt;/details");
}

/** The one comment a run's moment posts on its issue or pull request: as Slack's line (slack.ts slackLine), in
 *  GitHub's markdown. Waiting, by `pending.kind`: a question is answered by a comment that mentions the handle; an
 *  approval only in the console; a pause at the cap by a raise; a stop by a mention that goes on. Ended: its status, and
 *  with `answer` (given when the trigger posts it, its source's post_answer) the run's final answer, defused, in a block
 *  of its own. The handle is shown in code, so the comment mentions no one. `base`: the console's public URL. */
export function gitHubLine(type: "run.needs_input" | "run.ended", run: RunNotice, { base, handle, answer }: { base: string | null; handle: string; answer?: string | null }): string {
  const link = base ? `[open the run](${base}/#/runs/${encodeURIComponent(run.run_id)})` : null;
  const at = `\`@${handle.replace(/\[bot\]$/, "")}\``;
  if (type === "run.needs_input") {
    const pending = run.pending as { kind?: unknown; tool?: unknown } | undefined;
    const kind = pending?.kind;
    if (kind === "budget") return link ? `Paused at its spend cap: ${link}.` : "Paused at its spend cap.";
    if (kind === "approval") {
      const of = typeof pending?.tool === "string" && pending.tool ? ` of \`${pending.tool.replace(/`/g, "'")}\`` : "";
      return `Waiting for your approval${of}: approve in the console${link ? `: ${link}` : ""}.`;
    }
    if (kind === "question" || kind === "stopped") {
      const head = kind === "question" ? `Waiting for your answer: reply here mentioning ${at}` : `Stopped: mention ${at} here to go on`;
      return link ? `${head}, or ${link}.` : `${head}.`;
    }
    return link ? `Waiting: ${link}.` : "Waiting: open the run in the console.";
  }
  const head = run.status === "completed" ? "Done" : run.status === "cancelled" ? "Cancelled" : "Failed";
  const said = run.status === "completed" && answer ? `\n\n<details><summary>Answer</summary>\n\n${gitHubText(answer)}\n\n</details>` : "";
  return `${head}${link ? `: ${link}` : ""}.${said}`;
}

/** An issue's or pull request's title, then `text`. */
const subject = (on: Json, text: string) => `#${on.number}: ${typeof on.title === "string" ? on.title : ""}${text ? `\n\n${text}` : ""}`;

/** The settings `file` keeps, if it holds them. */
function settingsIn(file: string): Settings | undefined {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isObject(doc) && doc.v === 1 && typeof doc.handle === "string" && typeof doc.webhook_secret === "string" && typeof doc.token === "string" ? (doc as unknown as Settings) : undefined;
  } catch {
    return undefined;
  }
}

/** Both secrets, opened under `key`; undefined with no key, or one they were not sealed under. */
function openedWith(key: Buffer | undefined, settings: Settings): { webhook_secret: string; token: string } | undefined {
  if (!key) return undefined;
  try {
    const open = (field: "webhook_secret" | "token") => unseal(key, Buffer.from(settings[field], "base64"), aad(field)).toString("utf8");
    return { webhook_secret: open("webhook_secret"), token: open("token") };
  } catch {
    return undefined;
  }
}

/** The GitHub secrets data directory `data` keeps, opened with the seal key of `env`: what an import cuts out of
 *  everything it writes. */
export function gitHubSecretsIn(data: string, env: NodeJS.ProcessEnv): string[] {
  const settings = settingsIn(join(data, GITHUB_FILE));
  const opened = settings && openedWith(sealKeyOf(env[SEAL_KEY_ENV]), settings);
  return opened ? [opened.webhook_secret, opened.token] : [];
}

export class GitHub {
  private readonly file: string;
  private readonly outbox: string;
  private readonly key: Buffer | undefined;
  private posts: Post[] = [];
  private told: Record<string, Told> = {};
  private base: string | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly stop = new AbortController();
  private closed = false;
  /** The outbox in memory differs from the one on disk: its last write failed, and is tried again (WRITE_RETRY_MS). */
  private unsaved = false;
  private rewrite: NodeJS.Timeout | undefined;

  /** `api`: GitHub's REST API (a test's fake); `retryMs`: the waits between tries of a comment. */
  constructor(data: string, env: NodeJS.ProcessEnv, private readonly say: (fields: Record<string, string | number>) => void, private readonly api = GITHUB_API, private readonly retryMs: readonly number[] = RETRY_MS) {
    this.file = join(data, GITHUB_FILE);
    this.outbox = join(data, GITHUB_OUTBOX);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    try {
      const doc = JSON.parse(readFileSync(this.outbox, "utf8")) as unknown;
      if (isObject(doc) && doc.v === 1 && Array.isArray(doc.posts) && isObject(doc.told)) ({ posts: this.posts, told: this.told } = doc as unknown as { posts: Post[]; told: Record<string, Told> });
    } catch {}
    for (const post of this.posts) this.schedule(post, Math.max(0, post.next_at - Date.now()));
  }

  close(): void {
    // What it holds, written once more as it stops: a comment GitHub took and a write that failed would be posted again.
    if (this.unsaved) this.write();
    this.closed = true;
    this.stop.abort();
    for (const timer of this.timers) clearTimeout(timer);
  }

  /** The page's address, for each comment's link to its run: only a public one (AGENTRUN_PUBLIC_URL). */
  attach(base: string | undefined): void {
    this.base = base ? base.replace(/\/+$/, "") : null;
  }

  /** GET: the handle and the login an assignment starts a run for, whether comments carry a link, and why posting is
   *  off, if it is; never a secret. */
  view() {
    const settings = this.settings();
    if (!settings) return { configured: false as const };
    return { configured: true as const, handle: settings.handle, assignee_login: settings.assignee_login ?? null, links: this.base !== null, at_rest: this.opened(settings) ? "sealed" : "unreadable", disabled: settings.disabled ?? null, updated_at: settings.updated_at };
  }

  /** PUT: `{webhook_secret, token, handle, assignee_login?}`. The token is any one that can comment on the repos' issues
   *  and pull requests (an App installation's, which lasts an hour and is put again before it ends, or another); it is
   *  not tried here, as no one call checks every kind: a token GitHub refuses turns posting off at its first comment. */
  save(body: Json): ReturnType<GitHub["view"]> {
    const issues = unknownFields(body, ["webhook_secret", "token", "handle", "assignee_login"]);
    const text = (field: string, min: number, max: number) => typeof body[field] === "string" && (body[field] as string).length >= min && (body[field] as string).length <= max;
    if (!text("webhook_secret", MIN_SECRET_CHARS, 256)) issues.push({ field: "webhook_secret", reason: body.webhook_secret === undefined ? "missing" : "invalid", message: `webhook_secret is the webhook's secret, ${MIN_SECRET_CHARS} to 256 characters` });
    if (!text("token", 1, 4096)) issues.push({ field: "token", reason: body.token === undefined ? "missing" : "wrong_type", message: "token is one that can comment on the repos' issues and pull requests" });
    if (!(typeof body.handle === "string" && LOGIN.test(body.handle))) issues.push({ field: "handle", reason: body.handle === undefined ? "missing" : "invalid", message: "handle is the GitHub login a mention names (an app's slug, or `name[bot]`)" });
    if (body.assignee_login !== undefined && !(typeof body.assignee_login === "string" && LOGIN.test(body.assignee_login))) issues.push({ field: "assignee_login", reason: "invalid", message: "assignee_login is the GitHub login an issue is assigned to, to start a run" });
    if (issues.length) throw invalid(issues);
    if (!this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no GitHub secrets: it never keeps one in the clear.`);
    const settings: Settings = {
      handle: body.handle as string, ...(typeof body.assignee_login === "string" ? { assignee_login: body.assignee_login } : {}),
      webhook_secret: this.sealed("webhook_secret", body.webhook_secret as string), token: this.sealed("token", body.token as string), updated_at: new Date().toISOString(),
    };
    writeDurableSync(this.file, `${JSON.stringify({ v: 1, ...settings }, null, 2)}\n`);
    return this.view();
  }

  /** DELETE: the settings gone: a request to /v2/hooks/github is refused, and nothing more is posted. */
  remove(): void {
    rmSync(this.file, { force: true });
  }

  /** The webhook secret and who this server answers to, to check a request by; undefined when GitHub is not set here
   *  (or its secret does not open). */
  checker(): { webhook_secret: string; handle: string; assignee_login?: string } | undefined {
    const settings = this.settings();
    const opened = settings && this.opened(settings);
    return settings && opened ? { webhook_secret: opened.webhook_secret, handle: settings.handle, ...(settings.assignee_login ? { assignee_login: settings.assignee_login } : {}) } : undefined;
  }

  /** Both secrets, opened, for the redaction of what is shown, and an import's cut. */
  values(): string[] {
    const settings = this.settings();
    const opened = settings && this.opened(settings);
    return opened ? [opened.webhook_secret, opened.token] : [];
  }

  // ---- posting --------------------------------------------------------------------------------------------------------

  /** A run's moment, told by runs.ts as webhooks.ts is (`marker` names it), for a run a GitHub trigger started on `on`:
   *  one comment queued for it, once per moment, in the same write as the ledger. `answer`: the run's final answer, given
   *  only when the trigger posts it (its source's post_answer). */
  emit(type: "run.needs_input" | "run.ended", run: RunNotice, marker: string, on: { repo: string; number: number }, answer?: string | null): void {
    const settings = this.settings();
    if (this.closed || !settings || settings.disabled) return;
    const told = this.told[run.run_id];
    const ends = type === "run.ended";
    if ((ends ? told?.ended : told?.wait) === marker) return;
    const id = `ghc_${createHash("sha256").update(`${run.run_id}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;
    this.told[run.run_id] = { ...told, ...(ends ? { ended: marker } : { wait: marker }), at: new Date().toISOString() };
    if (!this.posts.some((p) => p.id === id)) {
      const post: Post = { id, repo: on.repo, number: on.number, body: gitHubLine(type, run, { base: this.base, handle: settings.handle, answer }), attempts: 0, next_at: Date.now() };
      this.posts.push(post);
      this.schedule(post, 0);
    }
    this.write();
  }

  /** Whether `run`'s end at `marker` (its end time) was told its issue already: a start's catch-up queues one it lacks.
   *  A run a mention opened again ends again, at another time, so an earlier end is not this one. */
  toldEnd(runId: string, marker: string): boolean {
    return this.told[runId]?.ended === marker;
  }

  private schedule(post: Post, delayMs: number): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.attempt(post).catch((error: Error) => this.say({ condition: "github_post_failed", post: post.id, error: error.message }));
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  /** One try of the comment. Made (201): gone from the outbox. Rate limited (429, or a 403 that says so), a 5xx, or no
   *  answer: tried again after the next wait (at least what GitHub says to wait). The token refused (401): posting turned
   *  off until the settings are saved again. Anything else: failed, and said. A comment whose answer never came may have
   *  landed: tried again, it can show twice. */
  private async attempt(post: Post): Promise<void> {
    const settings = this.settings();
    const opened = settings && this.opened(settings);
    if (this.closed || !this.posts.includes(post)) return;
    if (!settings || !opened || settings.disabled) return this.drop(post, settings ? "posting is off" : "GitHub is not set here");
    const answer = await this.call(post, opened.token);
    if (this.closed) return;
    post.attempts += 1;
    if (answer.ok) return this.drop(post);
    if (answer.status === 401) {
      // Turned off only as the settings still stand: ones deleted or saved again during the wait are never written back.
      const now = this.settings();
      if (now && now.updated_at === settings.updated_at && now.token === settings.token) {
        this.writeSettings({ ...now, disabled: { at: new Date().toISOString(), reason: "GitHub refused the token (401): save the settings again with a token that can comment" } });
        this.say({ condition: "github_disabled", error: "401" });
      }
      return this.drop(post, answer.error);
    }
    const wait = this.retryMs[post.attempts - 1];
    if (answer.retry && wait !== undefined) {
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
    if (why) this.say({ condition: "github_post_failed", post: post.id, attempts: post.attempts, error: why });
    this.write();
  }

  /** POST /repos/{repo}/issues/{number}/comments, which takes an issue's and a pull request's alike. */
  private async call(post: Post, token: string): Promise<{ ok: true } | { ok: false; status?: number; error: string; retry?: boolean; retry_after_ms?: number }> {
    try {
      const res = await fetch(`${this.api}/repos/${post.repo.split("/").map(encodeURIComponent).join("/")}/issues/${post.number}/comments`, {
        method: "POST", redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.stop.signal]),
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "agentrun-serve", "content-type": "application/json" },
        body: JSON.stringify({ body: post.body }),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 201) return { ok: true };
      // GitHub's rate limits: a 429, or a 403 with no requests left; wait as it says (Retry-After, or until the reset).
      const after = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const limited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || after > 0));
      const wait = after > 0 ? after * 1000 : reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 0;
      if (limited) return { ok: false, status: res.status, error: "rate limited", retry: true, ...(wait > 0 ? { retry_after_ms: wait } : {}) };
      return { ok: false, status: res.status, error: `answered ${res.status}`, retry: res.status >= 500 };
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
      // Held here and tried again until kept (a stop writes it too): a comment's own try goes on meanwhile.
      this.unsaved = true;
      this.say({ condition: "github_outbox_unwritable", file: this.outbox, error: (error as NodeJS.ErrnoException).code ?? "unknown" });
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

  private writeSettings(settings: Settings): void {
    try {
      writeDurableSync(this.file, `${JSON.stringify({ v: 1, ...settings }, null, 2)}\n`);
    } catch (error) {
      this.say({ condition: "github_settings_unwritable", file: this.file, error: (error as NodeJS.ErrnoException).code ?? "unknown" });
    }
  }

  private settings(): Settings | undefined {
    return settingsIn(this.file);
  }

  private sealed(field: string, value: string): string {
    return seal(this.key!, Buffer.from(value, "utf8"), aad(field)).toString("base64");
  }

  private opened(settings: Settings): { webhook_secret: string; token: string } | undefined {
    return openedWith(this.key, settings);
  }
}

/** What an unset server checks a request against, so a refusal takes the time a real check does. */
export const NO_GITHUB_SECRET = randomBytes(32).toString("hex");
