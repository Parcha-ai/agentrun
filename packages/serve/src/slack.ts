// Slack, set through /v2/settings/slack: one incoming-webhook URL (https://hooks.slack.com/services/...) this server posts
// a readable message to when a run ends (`run.ended`), when a run comes to need its person (`run.needs_input`), and when a
// trigger's firing could not start its run (`trigger.failed`), each event on or off. It is the outbound webhook's outbox
// (webhooks.ts) under a channel of its own: the same queue, retries with backoff, dedupe by message id, deliveries log,
// test send, redelivery and private-target rule; only what it sends and how an answer is read differ.
//
// The URL is the credential (anyone holding it posts to the channel), so it is a secret: written only from the owner's
// signed-in session (secret-writes.ts), sealed in trigger_settings (adapter SLACK_CHANNEL, field `url`; a replaced or
// removed one kept retired, so a run that echoes it is still cut), and never answered, logged or put in a delivery's
// row: a read shows its origin and last four characters (shownUrl). The setting (SLACK_SETTING) holds that shortened
// form, the events, when it was set and why it is off.
//
// What a message says follows the webhook's rule: never a tool's arguments, a run's output or its input. It names the
// agent (its `agent_name`, which is its id when it has none), the status in a plain word, the run's title and a link to the
// run in the console; a wait says what the run waits on (`pending.kind`), a trigger's failure its name and error. Every
// string a message is made of is cut of the server's secrets first (SlackOptions.serverSecrets): an agent's or a trigger's name is
// whatever a person typed, and a run's title or a trigger's error may quote a key. Slack answers 200 "ok"; a 404 or
// 410 (no_service, channel_not_found, channel_is_archived...) turns Slack off with Slack's word, as a webhook's 410 does.
import { randomBytes } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import { ApiError, invalid } from "./errors.js";
import { redacted } from "./key-refusal.js";
import { SERVER_SCOPE } from "./sealed-settings-store.js";
import { registerNotSecretWrite, registerSecretPage, registerSecretWrite, secretMeta, secretName, type SecretMeta } from "./secret-writes.js";
import type { TriggerFailed } from "./triggers.js";
import { isObject, unknownFields } from "./validate.js";
import { type Emitted, type Gone, type Outbound, type OutboundConfig, RUN_EVENTS, type RunNotice, shownUrl, WEBHOOK_EVENTS, Webhooks, type WebhooksOptions, type WebhooksStore } from "./webhooks.js";

// Saving a URL, and removing Slack (its URL goes with it), are secret writes: the owner's signed-in session alone, never
// the API token. A save of the events alone writes no secret, and neither does a test or a redelivery.
registerSecretWrite("saveSlack", (body) => isObject(body) && body.url !== undefined);
registerSecretWrite("deleteSlack", () => true);
// Where the owner finishes each in the console: Settings → Slack. Slack's URL is never in a link: it is the credential.
registerSecretPage(["saveSlack", "deleteSlack"], "/#/settings/slack");
registerNotSecretWrite("testSlack", "A test send posts to the saved URL and writes none.");
registerNotSecretWrite("redeliverSlack", "A redelivery posts a logged message to the saved URL again and writes none.");

import { SLACK_CHANNEL, slackUrlForms } from "./slack-url.js";
export { SLACK_CHANNEL, slackUrlForms };
/** The store setting that holds Slack's shortened URL, its events, when it was set, and why it is off. */
export const SLACK_SETTING = "slack-out";
/** The one host an incoming-webhook URL may name. */
export const SLACK_HOST = "hooks.slack.com";
/** The events Slack can be sent: the webhook's. */
export const SLACK_EVENTS = WEBHOOK_EVENTS;
export type SlackEvent = (typeof SLACK_EVENTS)[number];
/** Every message type Slack is sent: its events, and the test send's. */
export const SLACK_MESSAGE_TYPES = [...SLACK_EVENTS, "slack.test"] as const;
/** Which events are on: all of them unless the owner turns one off. A run that waits on a person is the one moment a
 *  person must act, so run.needs_input is on too. */
export const DEFAULT_SLACK_EVENTS: Readonly<Record<SlackEvent, boolean>> = { "run.ended": true, "run.needs_input": true, "trigger.failed": true };
/** Where its URL is kept in trigger_settings: the server's scope, one given field. */
export const SLACK_URL_SPEC = { scope: "server" as const, fields: { url: {} } };
const URL_FIELD = "url";
const MAX_URL = 2048;
/** An incoming webhook's path: /services/ and its workspace, its app and its token. */
const SERVICES_PATH = /^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;
const URL_WORDS = `url is a Slack incoming-webhook URL: https://${SLACK_HOST}/services/... as Slack shows it, with no port, query or user`;
/** The most of a title or an error a message carries: a line Slack shows whole. */
const TITLE_MAX = 300;
const ERROR_MAX = 500;

const SLACK_OUTBOUND: Outbound = {
  channel: SLACK_CHANNEL, setting: SLACK_SETTING, spec: SLACK_URL_SPEC, field: URL_FIELD, testType: "slack.test",
  words: {
    removed: "Slack was removed", off: "Slack is off", unset: "Slack is not set: PUT /v2/settings/slack sets it",
    offWith: (reason) => `Slack is off (${reason}): save its URL again with PUT /v2/settings/slack`,
    unreadable: "the URL does not open here (unreadable): save it again",
  },
  offCode: "slack_off",
};

type Events = Record<SlackEvent, boolean>;
/** Slack as the store keeps it: the webhook's setting (its `url` the shortened form, never the URL), and its events. */
type SlackConfig = OutboundConfig & { events?: Partial<Events> };

/** Slack's URL's metadata, named slack:outbound: set or not, pasted in the console, and when. */
export const slackSecretMeta = (set: boolean, changedAt: string | null): SecretMeta => secretMeta(secretName("slack", "outbound"), { set, source: "console", changedAt });

/** What Slack takes beside the webhook's options: `serverSecrets`, every secret the server holds (server.ts serverSecrets),
 *  read at each message, so a secret saved since is cut too (key-refusal.ts redacted, the rule a run's view takes);
 *  `sendTo`, a test's seam, the origin each try posts to in place of https://hooks.slack.com, the URL's path kept (it may
 *  be on this machine). */
export type SlackOptions = WebhooksOptions & { serverSecrets?: () => readonly string[]; sendTo?: string };

/** Slack's view (GET /v2/settings/slack): never the URL. */
export type SlackView =
  | { configured: false; secret: SecretMeta; events: Events }
  | { configured: true; url: string; url_state: "sealed" | "unreadable"; secret: SecretMeta; events: Events; disabled: { at: string; reason: string } | null; updated_at: string };

export class SlackPosts extends Webhooks {
  private readonly serverSecrets: () => readonly string[];
  private readonly sendTo?: URL;

  constructor(store: WebhooksStore, key: Buffer, say: (fields: Record<string, string | number>) => void, options: SlackOptions = {}) {
    const { serverSecrets, sendTo, ...rest } = options;
    // A test's seam sends to this machine: its own target, never a name Slack's is resolved to.
    super(store, key, say, sendTo ? { ...rest, privateTargets: true } : rest, SLACK_OUTBOUND);
    this.serverSecrets = serverSecrets ?? (() => []);
    this.sendTo = sendTo ? new URL(sendTo) : undefined;
  }

  /** GET: the shortened URL, whether it opens here, which events are on, and why Slack is off, if it is; never the URL. */
  slackView(): SlackView {
    const config = this.config as SlackConfig | undefined;
    if (!config) return { configured: false, secret: slackSecretMeta(false, null), events: { ...DEFAULT_SLACK_EVENTS } };
    return {
      configured: true, url: config.url, url_state: this.urlNow() !== undefined ? "sealed" : "unreadable",
      secret: slackSecretMeta(true, config.secret_at), events: this.events(config), disabled: config.disabled ?? null, updated_at: config.updated_at,
    };
  }

  /** The webhook's view is not Slack's: slackView. */
  override view(): never {
    throw new Error("Slack's view is slackView()");
  }

  /** The webhook's PUT is not Slack's: saveSlack. */
  override async save(): Promise<never> {
    throw new Error("Slack is saved with saveSlack()");
  }

  /** The URLs Slack holds and held, each in the forms a run might echo: the server's list of its own secrets. */
  urlForms(): string[] {
    return this.signingSecrets().flatMap(slackUrlForms);
  }

  /** PUT: `url` (a secret write: the owner's session alone) sets Slack, or changes its URL, and turns it on again; `events`
   *  turns events on or off (a URL's first save takes the defaults for those it leaves out). The first answers created. A
   *  URL is sealed under a scope of its own before the setting that names it is written, and the one it replaces goes,
   *  retired (still cut from what runs say). */
  async saveSlack(body: Record<string, unknown>): Promise<{ created: boolean; view: SlackView }> {
    const issues = unknownFields(body, ["url", "events"]);
    let href: string | undefined;
    if (body.url !== undefined) {
      const url = typeof body.url === "string" && body.url.length <= MAX_URL ? URL.parse(body.url.trim()) : null;
      if (!url || url.protocol !== "https:" || url.hostname !== SLACK_HOST || url.port !== "" || url.username || url.password || url.search || url.hash || !SERVICES_PATH.test(url.pathname)) {
        issues.push({ field: "url", reason: "invalid", message: URL_WORDS });
      } else href = url.href;
    } else if (!this.config) issues.push({ field: "url", reason: "missing", message: `${URL_WORDS}; the first save names it` });
    let events: Partial<Events> | undefined;
    if (body.events !== undefined) {
      if (!isObject(body.events)) issues.push({ field: "events", reason: "invalid", message: `events is an object of ${SLACK_EVENTS.join(", ")}, each true or false` });
      else {
        events = {};
        for (const [name, on] of Object.entries(body.events)) {
          if (!(SLACK_EVENTS as readonly string[]).includes(name)) issues.push({ field: `events.${name}`, reason: "unknown_field", message: `an event is one of ${SLACK_EVENTS.join(", ")}` });
          else if (typeof on !== "boolean") issues.push({ field: `events.${name}`, reason: "invalid", message: `events.${name} is true or false` });
          else events[name as SlackEvent] = on;
        }
      }
    }
    if (issues.length) throw invalid(issues);
    return this.change(() => this.saveSlackNow(href, events ?? {}));
  }

  private async saveSlackNow(href: string | undefined, events: Partial<Events>): Promise<{ created: boolean; view: SlackView }> {
    const was = this.config as SlackConfig | undefined;
    const now = new Date().toISOString();
    // `updated_at` is the run-end cutoff (webhooks.ts due): an end from before it is never queued, by a notice or a start's
    // catch-up. It moves when a URL is saved, and when run.ended turns on again (an end while it was off is not posted
    // later). Any other change of events keeps it: an end the server has not read yet when another event is switched is
    // still posted.
    if (href === undefined) {
      if (!was) throw new ApiError("not_found", SLACK_OUTBOUND.words.unset);
      const next = { ...this.events(was), ...events };
      const endsOn = !this.events(was)["run.ended"] && next["run.ended"];
      await this.write({ ...was, events: next, updated_at: endsOn ? now : was.updated_at } as SlackConfig);
      return { created: false, view: this.slackView() };
    }
    const scope = `${SERVER_SCOPE}:${randomBytes(8).toString("hex")}`;
    await this.secrets.set(scope, URL_FIELD, href);
    try {
      const config: SlackConfig = { url: shownUrl(href), secret_at: now, secret_scope: scope, updated_at: now, events: { ...(was ? this.events(was) : DEFAULT_SLACK_EVENTS), ...events } };
      await this.write(config);
    } catch (error) {
      // The store may hold the setting that names the new URL (a put that landed, its flush failed), as the webhook's
      // rotate finds (webhooks.ts). What was there goes back first (the earlier setting, or none), and only once that is
      // durable does the new URL go: the store never names a URL that is gone. If it can't go back, the new URL stays,
      // and the next start removes whichever URL the setting does not name (load).
      const restored = await (was ? this.write(was) : this.unwrite()).then(() => true, () => false);
      if (restored) await this.secrets.remove(scope).catch((removal: Error) => this.say({ condition: "url_unremoved", error: removal.message }));
      throw error;
    }
    if (was && was.secret_scope !== scope) await this.secrets.remove(was.secret_scope).catch((removal: Error) => this.say({ condition: "url_unremoved", error: removal.message }));
    return { created: !was, view: this.slackView() };
  }

  /** A run's notice, queued when its event is on. */
  override async emit(type: (typeof RUN_EVENTS)[number], run: RunNotice, marker: string): Promise<Emitted> {
    if (!this.wants(type)) return "off";
    return super.emit(type, run, marker);
  }

  /** A trigger's failed firing, queued when trigger.failed is on. */
  override async emitTrigger(failed: TriggerFailed, firingKey: string): Promise<Emitted> {
    if (!this.wants("trigger.failed")) return "off";
    return super.emitTrigger(failed, firingKey);
  }

  /** The message, made of the notice's strings each cut of the server's secrets before it is escaped and shortened (a cut
   *  after would miss a value the escaping changed, or the shortening split), and saved so: its row never holds one. */
  protected override body(type: string, data: unknown): string {
    const held = this.serverSecrets();
    const fields = cutStrings(isObject(data) ? data : {}, (text) => redacted(text, held)) as Record<string, unknown>;
    const agent = typeof fields.agent_name === "string" && fields.agent_name ? fields.agent_name : typeof fields.agent_id === "string" ? fields.agent_id : undefined;
    return JSON.stringify(slackMessage(type, fields, { agent, base: this.base }));
  }

  /** Each try posts to the sealed URL (a test's `sendTo` in its origin's place), unsigned: Slack checks nothing but the URL. */
  protected override request(_config: OutboundConfig, credential: string): { url: URL; headers: Record<string, string> } {
    const url = new URL(credential);
    return { url: this.sendTo ? new URL(`${url.pathname}`, this.sendTo) : url, headers: { "content-type": "application/json", "user-agent": "agentrun-serve-slack/1" } };
  }

  /** Slack's answer: 2xx lands ("ok"); a 404 or 410 means the URL posts nowhere any more (no_service, channel_not_found,
   *  channel_is_archived), which turns Slack off with Slack's word; anything else is tried again. Only a word Slack answers
   *  (lowercase letters and underscores) is kept. */
  protected override async judged(res: Awaited<ReturnType<typeof undiciFetch>>): Promise<{ failure?: string; gone?: Gone }> {
    const text = (await res.text().catch(() => "")).trim().slice(0, 100);
    if (res.status >= 200 && res.status <= 299) return {};
    const word = /^[a-z_]{1,64}$/.test(text) ? ` ${text}` : "";
    if (res.status >= 300 && res.status < 400) return { failure: `answered ${res.status}: a redirect is not followed` };
    const failure = `answered ${res.status}${word}`;
    if (res.status !== 404 && res.status !== 410) return { failure };
    return { failure, gone: { reason: `Slack answered ${res.status}${word}: the URL posts nowhere now`, drop: `Slack is off: Slack answered ${res.status}${word}` } };
  }

  private events(config: SlackConfig): Events {
    return { ...DEFAULT_SLACK_EVENTS, ...(config.events ?? {}) };
  }

  private wants(type: SlackEvent): boolean {
    const config = this.config as SlackConfig | undefined;
    return !config || this.events(config)[type];
  }

  private urlNow(): string | undefined {
    const config = this.config;
    return config ? this.secrets.get(config.secret_scope, URL_FIELD) : undefined;
  }

}

/** `value` with each string in it, at any depth, made by `cut`. */
function cutStrings(value: unknown, cut: (text: string) => string): unknown {
  if (typeof value === "string") return cut(value);
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, cut));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutStrings(item, cut)]));
  return value;
}

// ---- the messages --------------------------------------------------------------------------------------------------

/** Slack's mrkdwn escapes: a title or an error never makes a link, a mention (<!channel>) or a broken entity. */
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** A link's address, kept only when it is http(s): Slack takes it whole between < and |. */
const link = (url: string, words: string) => (/^https?:\/\/[^\s<>|]+$/.test(url) ? `<${url}|${esc(words)}>` : esc(words));

/** A run's status, in a plain word. */
const STATUS_WORDS: Record<string, string> = { completed: "completed", failed: "failed", cancelled: "was cancelled", input_required: "needs you", working: "is working", queued: "is queued", paused: "is paused" };
/** What a run waits on, by its notice's `pending.kind`. */
const WAIT_WORDS: Record<string, string> = {
  question: "It asks you a question.",
  approval: "It waits for your approval of a tool call.",
  stopped: "A person stopped its turn: it waits for a message.",
  budget: "It is paused at its spend cap: raise the cap to go on.",
  browser: "It asks for you in its browser.",
  computer: "It asks for you on its computer.",
};

type SlackMessage = { text: string; blocks: Array<Record<string, unknown>> };

/** The Slack message for one event: `text` (what a notification shows, mrkdwn too, so escaped) and its blocks. `agent`: the agent's name, else
 *  its id; `base`: the console's address, for a trigger's link. Never a tool's arguments, an output or an input. */
export function slackMessage(type: string, data: Record<string, unknown>, { agent, base }: { agent?: string; base: string }): SlackMessage {
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
  const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
  const who = agent ? `*${esc(cut(agent, 100))}*` : "A run";
  if (type === "run.ended" || type === "run.needs_input") {
    const status = str(data.status);
    const said = STATUS_WORDS[status] ?? (status || "changed");
    const title = cut(str(data.title).trim(), TITLE_MAX);
    const kind = isObject(data.pending) ? str(data.pending.kind) : "";
    const wait = type === "run.needs_input" ? (WAIT_WORDS[kind] ?? "It waits for a message from you.") : undefined;
    const runId = str(data.run_id);
    const lines = [`${who} · run ${said}`, link(str(data.url), title || "Open the run"), ...(wait ? [wait] : [])];
    return {
      text: esc(`${agent ? `${cut(agent, 100)}: ` : ""}run ${said}${title ? `: ${title}` : ""}`),
      blocks: [section(lines.join("\n")), context(`AgentRun · ${type} · run \`${esc(runId)}\``)],
    };
  }
  if (type === "trigger.failed") {
    const name = cut(str(data.name), 100) || str(data.trigger_id);
    const error = isObject(data.error) ? data.error : {};
    const code = str(error.code);
    const message = cut(str(error.message).trim(), ERROR_MAX);
    const triggerUrl = `${base}/#/triggers/${encodeURIComponent(str(data.trigger_id))}`;
    const lines = [
      `Trigger ${link(triggerUrl, name)} could not start its run${agent ? ` of ${who}` : ""}.`,
      `\`${esc(code || "error")}\`${message ? `: ${esc(message)}` : ""}`,
      // The console's way, the CLI's and the API's: a server with no console (the API-only profile) takes the last two.
      ...(data.auto_paused === true ? [`It failed too many times in a row, so it is off now: turn it on again in the console, with \`agentrun triggers update ${esc(str(data.trigger_id))} --enabled\`, or with \`PATCH /v2/triggers/${esc(str(data.trigger_id))}\` and \`{"enabled": true}\`.`] : []),
    ];
    return {
      text: esc(`Trigger ${name} could not start its run${code ? `: ${code}` : ""}`),
      blocks: [section(lines.join("\n")), context(`AgentRun · trigger.failed · firing \`${esc(str(data.firing_key))}\``)],
    };
  }
  // The test send.
  return {
    text: "AgentRun can post here.",
    blocks: [section(`AgentRun can post here: run notices from ${link(base, "this server")} will come to this channel.`), context("AgentRun · slack.test")],
  };
}
