// A fake of Slack's Web API on loopback, for the Slack trigger's tests: auth.test names the example workspace and bot
// user for the one bot token it knows; chat.postMessage keeps each post and answers it taken, unless the test queued
// another answer for the next ones (`answers`).
import { createServer } from "node:http";

export const SLACK_TEAM = "T0EXAMPLE1";
export const SLACK_BOT_USER = "U0BOTUSER1";
export const SLACK_BOT_ID = "B0BOTID001";
export const SLACK_BOT_TOKEN = "not-a-secret-bot-token";

export async function fakeSlack(t) {
  const posts = [];
  /** Answers for the next chat.postMessage calls, in order: `{status?, body?, headers?}`. */
  const answers = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const known = req.headers.authorization === `Bearer ${SLACK_BOT_TOKEN}`;
      const reply = (status, json, headers = {}) => void res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(json));
      if (req.url === "/api/auth.test") return reply(200, known ? { ok: true, team_id: SLACK_TEAM, user_id: SLACK_BOT_USER, bot_id: SLACK_BOT_ID } : { ok: false, error: "invalid_auth" });
      if (req.url !== "/api/chat.postMessage") return reply(404, { ok: false, error: "unknown_method" });
      posts.push({ authorized: known, body });
      const next = answers.shift();
      if (next) return reply(next.status ?? 200, next.body ?? { ok: true }, next.headers);
      return reply(200, known ? { ok: true, channel: body.channel, ts: `${(Date.now() / 1000).toFixed(6)}` } : { ok: false, error: "invalid_auth" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())));
  return { url: `http://127.0.0.1:${server.address().port}/api`, posts, answers };
}
