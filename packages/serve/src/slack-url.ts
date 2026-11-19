// Slack's incoming-webhook URL as a secret: where it is sealed, and the forms of it a run might echo. Its own module, with
// no import, so the runner's read of the store's secrets (runner/store-secrets.ts) lists it as the server does
// (server-secrets-store.ts, slack.ts urlForms) without loading Slack's outbox.

/** Slack's channel in the store (channel_posts, channel_attempts, channel_told) and its URL's adapter in trigger_settings. */
export const SLACK_CHANNEL = "slack-out";

/** The forms of a Slack URL a run might echo, each cut from what the server shows: the URL whole and its token (the path's
 *  last part, the credential itself). */
export function slackUrlForms(url: string): string[] {
  const token = URL.parse(url)?.pathname.split("/").pop() ?? "";
  return token.length >= 16 ? [url, token] : [url];
}
