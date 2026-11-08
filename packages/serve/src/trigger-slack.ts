// Slack: a trigger source pushed to the server by its Slack app. A mention of the app in one of a trigger's channels
// starts a run for its thread, and a person's reply in that thread steers the run (the kernel's conversations,
// triggers.ts receiveEvent). Served by the one push handler at /v2/hooks/slack: each request checked by Slack's v0
// signature under the app's signing secret (its settings', the server's), Slack's url_verification answered after that
// check, and each message read here, purely, into the kernel's event. The app's settings (PUT /v2/settings/slack) and
// the lines posted in a thread are slack.ts's.
import { createHmac, timingSafeEqual } from "node:crypto";
import { closedSchema, type Headers, type PushEvent, type TriggerAdapter, unknownSourceFields } from "./trigger-adapter.js";
import { ApiError, invalid } from "./errors.js";
import { isObject, type Json } from "./validate.js";

/** Slack's Web API. */
export const SLACK_API = "https://slack.com/api";

/** How far a request's X-Slack-Request-Timestamp may be from this server's clock, either way. */
export const SLACK_TOLERANCE_S = 300;
/** The most channels a Slack trigger lists. */
export const SLACK_CHANNELS_MAX = 50;
/** A Slack channel's id: a public channel's (C...) or a private one's (G...). */
const SLACK_CHANNEL = /^[CG][A-Z0-9]{2,20}$/;
/** The largest event body taken, as a webhook's. */
const SLACK_MAX_BODY = 256 * 1024;

const SLACK_SIGNATURE = /^v0=[0-9a-f]{64}$/;

function slackPrecheck(headers: Headers, nowMs: number): string | undefined {
  const timestamp = headers["x-slack-request-timestamp"];
  const signature = headers["x-slack-signature"];
  if (typeof timestamp !== "string" || typeof signature !== "string") return "missing_headers";
  if (!/^\d{1,12}$/.test(timestamp) || !SLACK_SIGNATURE.test(signature)) return "malformed_headers";
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SLACK_TOLERANCE_S) return "stale_timestamp";
  return undefined;
}

/** Slack's request signature ("Verifying requests from Slack"), in the shape of a signature scheme (a webhook trigger's
 *  table of them): `X-Slack-Signature: v0=<hex HMAC-SHA256 of "v0:{X-Slack-Request-Timestamp}:{body}">` under the app's
 *  signing secret, its timestamp within SLACK_TOLERANCE_S of this server's clock. Its firing key is the signed body's
 *  `event_id`, which Slack's retries repeat. */
export const SLACK_SCHEME = {
  signatureHeader: "x-slack-signature",
  describe: `\`slack\` takes a Slack app's request: \`X-Slack-Signature: v0=<hex HMAC-SHA256 of "v0:{X-Slack-Request-Timestamp}:{body}">\` under the app's signing secret, \`X-Slack-Request-Timestamp\` (Unix seconds, within ${SLACK_TOLERANCE_S} s of this server's clock either way).`,
  precheck: slackPrecheck,
  verify(key: string, headers: Headers, body: Buffer, nowMs: number): string | undefined {
    const early = slackPrecheck(headers, nowMs);
    if (early) return early;
    const expected = Buffer.from(`v0=${createHmac("sha256", key).update(`v0:${headers["x-slack-request-timestamp"] as string}:`).update(body).digest("hex")}`);
    return timingSafeEqual(expected, Buffer.from(headers["x-slack-signature"] as string)) ? undefined : "bad_signature";
  },
  firingKeyOf: (_headers: Headers, body: Buffer): string => {
    const doc = jsonOf(body);
    return isObject(doc) && typeof doc.event_id === "string" ? doc.event_id : "";
  },
  eventOf: (_headers: Headers, json: unknown): string | undefined => (isObject(json) && isObject(json.event) && typeof json.event.type === "string" ? json.event.type : undefined),
};

const jsonOf = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
};

/** A Slack message a trigger may act on: a mention of the app, or a reply in a thread. `thread_ts` is its thread's (its
 *  own `ts` at the top level), `text` its text with the app's mention taken out. */
export type SlackMessage = { team: string; channel: string; ts: string; thread_ts: string; user: string; text: string; event_id: string; mention: boolean };

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

/** A Slack message as the kernel takes it: keyed by its team, channel and ts (so Slack's retries and the same message
 *  told as both app_mention and message are one firing), in its channel's scope and its thread's conversation, from a
 *  member of the workspace, opening a thread only when it mentions the app. */
export const slackEvent = (message: SlackMessage): PushEvent => ({
  key: `${message.team}:${message.channel}:${message.ts}`,
  text: message.text,
  scope: message.channel,
  conversation: `${message.team}:${message.channel}:${message.thread_ts}`,
  opens: message.mention,
  actor: "member",
  attrs: { user: message.user, channel: message.channel },
});

/** A conversation's Slack thread: `team:channel:thread_ts`, as slackEvent names it. */
export const slackThreadOf = (conversation: string): { channel: string; thread_ts: string } => {
  const [, channel = "", thread_ts = ""] = conversation.split(":");
  return { channel, thread_ts };
};

export const slack: TriggerAdapter = {
  id: "slack",
  label: "Slack trigger",
  title: "Slack",
  delivery: "push",
  owner: false,
  describe: '{kind: "slack", channels, post_answer?}',
  fires: "a mention of the server's Slack app (`slack`, PUT /settings/slack)",
  firedBy: "`slack`: a Slack message (a mention, or a reply in a thread the trigger started), its key from the trigger and the message's team, channel and ts, so Slack's retries and the same message told twice are one firing.",
  schemas: [
    closedSchema(
      { kind: { const: "slack" }, channels: { type: "array", minItems: 1, maxItems: SLACK_CHANNELS_MAX, uniqueItems: true, items: { type: "string", pattern: "^[CG][A-Z0-9]{2,20}$" }, description: "The Slack channels (ids, C... or G...) where a mention of the server's Slack app starts a run, one per thread; a reply in the thread is a message to that run. A channel is one trigger's (scope_taken)." } },
      { post_answer: { type: "boolean", default: false, description: "Whether a completed run's line in its thread carries its final answer (escaped, cut to 3,000 characters); by default its status and link only." } },
    ),
  ],
  // Its two secrets, and who the app is (public: no secret), all the server's: the app's id given at a save, the rest
  // filled by its check (auth.test), when it was saved, and why posting is off, when Slack refused its bot token.
  settings: { scope: "server", fields: { signing_secret: {}, bot_token: {}, app_id: { public: true, given: true }, team_id: { public: true }, bot_user_id: { public: true }, bot_id: { public: true }, updated_at: { public: true }, disabled_at: { public: true }, disabled_reason: { public: true } } },
  // A member of the workspace opens a thread by a mention, and steers its run by a reply there, which may answer its
  // question (never an approval or a cap: server.ts message). A bot does neither: slackMessageOf drops its messages, and
  // the kernel holds every event to this.
  trust: { start: ["member"], steer: ["member"], answers: "question" },
  // The bot token checked with Slack's auth.test, which names the workspace and the app's bot user, before anything is
  // kept; the app's id, when given, is an app's.
  async check(values, api = SLACK_API) {
    if (values.app_id !== undefined && !/^A[A-Z0-9]{2,30}$/.test(values.app_id)) throw invalid([{ field: "app_id", reason: "wrong_type", message: "app_id is the Slack app's id (A...)" }]);
    let who: Json | null = null;
    try {
      const res = await fetch(`${api}/auth.test`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${values.bot_token}`, "content-type": "application/json; charset=utf-8" }, body: "{}" });
      who = (await res.json().catch(() => null)) as Json | null;
    } catch (error) {
      throw new ApiError("upstream_failed", `Slack's auth.test was not reached: ${(error as Error).message}`);
    }
    if (!who || who.ok !== true) throw invalid([{ field: "bot_token", reason: "invalid", message: `Slack refused the bot token: ${typeof who?.error === "string" ? who.error : "not ok"}` }]);
    if (typeof who.team_id !== "string" || typeof who.user_id !== "string") throw new ApiError("upstream_failed", "Slack's auth.test named no workspace or bot user.");
    return { team_id: who.team_id, bot_user_id: who.user_id, ...(typeof who.bot_id === "string" && who.bot_id ? { bot_id: who.bot_id } : {}) };
  },
  push: {
    maxBodyBytes: SLACK_MAX_BODY,
    key: "signing_secret",
    headers: SLACK_SCHEME.precheck,
    verify: SLACK_SCHEME.verify,
    // Slack's check that the URL is the app's, answered only after the request's own check.
    handshake(_headers, body) {
      const doc = jsonOf(body);
      return isObject(doc) && doc.type === "url_verification" && typeof doc.challenge === "string" ? { status: 200, body: { challenge: doc.challenge } } : undefined;
    },
    parse(_headers, body, _source, own) {
      const doc = jsonOf(body);
      const team_id = own?.("team_id");
      const bot_user_id = own?.("bot_user_id");
      if (!isObject(doc) || doc.type !== "event_callback" || !team_id || !bot_user_id) return [];
      const app_id = own?.("app_id");
      const message = slackMessageOf(doc, { team_id, bot_user_id, ...(app_id ? { app_id } : {}) });
      return "ignored" in message ? [] : [slackEvent(message)];
    },
  },
  parse(value, _now, bad, issues) {
    issues.push(...unknownSourceFields(value, ["kind", "channels", "post_answer"]));
    const channels = value.channels;
    if (!Array.isArray(channels) || channels.length < 1 || channels.length > SLACK_CHANNELS_MAX || !channels.every((c) => typeof c === "string" && SLACK_CHANNEL.test(c)) || new Set(channels).size !== channels.length) {
      return bad("channels", channels === undefined ? "missing" : "invalid", `channels lists 1 to ${SLACK_CHANNELS_MAX} distinct Slack channel ids (C... or G...): a mention of the app in one of them starts a run`), undefined;
    }
    if (value.post_answer !== undefined && typeof value.post_answer !== "boolean") return bad("post_answer", "wrong_type", "post_answer is true or false: whether a completed run's line in its thread carries its final answer"), undefined;
    return { kind: "slack", channels: [...(channels as string[])], post_answer: value.post_answer === true };
  },
  // A trigger listens on each of its channels; a channel is one trigger's.
  scopeOf: (source) => source.channels as string[],
  wellFormed: (source) => Array.isArray(source.channels) && source.channels.every((c) => typeof c === "string") && (source.post_answer === undefined || typeof source.post_answer === "boolean"),
};
