// GitHub: a mention of this server's handle on an issue or pull request in a repo a trigger lists, by its owner, a member
// or a collaborator, or an issue assigned to the configured login, starts that trigger's run, keyed to the issue or pull
// request (triggers.ts conversations), and a later mention there is a message to that run. One set of settings a server:
// PUT /v2/settings/github keeps the webhook secret and the token that comments sealed in DIR/github.json under the seal
// key (tool-keys.ts), never in the clear and never shown again. Each request to POST /v2/hooks/github is checked by
// GitHub's X-Hub-Signature-256 on its raw body before anything else.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { isObject, type Json, unknownFields } from "./validate.js";

export const GITHUB_FILE = "github.json";
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
  private readonly key: Buffer | undefined;
  private base: string | null = null;

  constructor(data: string, env: NodeJS.ProcessEnv) {
    this.file = join(data, GITHUB_FILE);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
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
