// The feed tests' own: the fake feed (src/feed/feed-faux.ts) on loopback, a feed trigger's body, its grid's times, and a
// fired run's payload read back from its input.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startFeedFaux } from "../dist/feed/feed-faux.js";
import { launchText } from "./email-support.mjs";

export const T0 = "2026-06-01T00:00:30Z";
/** The every_s 900 grid's tick `n` after T0 (00:15, 00:30, ...), as a feed trigger's default check runs. */
export const tick = (n) => new Date(Date.parse("2026-06-01T00:15:00Z") + (n - 1) * 900_000).toISOString().replace(".000Z", "Z");

/** A fake feed for the test, closed after it. */
export async function feed(t, options) {
  const faux = await startFeedFaux(options);
  t.after(() => faux.close());
  return faux;
}

/** `n` dated posts, newest first, named `prefix N` (N from n down to 1), each a day after the one before. */
export const posts = (n, prefix = "Old", from = Date.UTC(2026, 4, 1)) =>
  Array.from({ length: n }, (_, i) => n - i).map((k) => ({ id: `${prefix.toLowerCase()}-${k}`, link: `https://blog.example/${prefix.toLowerCase()}-${k}`, title: `${prefix} ${k}`, published: new Date(from + k * 86_400_000).toISOString() }));

/** A GitHub pull request as GitHub's pulls API lists it, the fields a feed reads and a few it passes on. */
export const pull = (number, title, created = "2026-05-20T10:00:00Z") => ({
  id: 9_000_000 + number, number, html_url: `https://github.com/acme/web/pull/${number}`, url: `https://api.github.com/repos/acme/web/pulls/${number}`,
  title, state: "open", user: { login: "dev" }, created_at: created, draft: false,
});

/** A Statuspage incident as its /history.atom serves it: a tag: id that stays, an <updated> that moves with each status
 *  post, its page as the alternate link, its posts as HTML content. */
export const incident = (n, title, updated, published = "2026-05-20T10:00:00Z") => ({
  id: `tag:status.faux.example,2005:Incident/${n}`, link: `https://status.faux.example/incidents/inc${n}`, title, published, updated,
  content: `<p><small>${updated}</small><br><strong>Investigating</strong> - We are looking into ${title.toLowerCase()}.</p>`,
});

/** The firing key a feed item fires under (trigger-support.mjs keyOf): the feed's URL, the item's key and, when it has
 *  one, its updated time, so an update is never a repeat of the item it updates. */
export const feedKey = (triggerId, url, itemKey, updated) => `fir_${createHash("sha256").update(`feed\n${triggerId}\n${[url, itemKey, ...(updated ? [new Date(updated).toISOString()] : [])].join("\n")}`).digest("hex").slice(0, 32)}`;

let named = 0;
/** A feed trigger's body: agent `agentId` started on each new item, with `content` as its input. */
export const feedTrigger = (agentId, source = {}, content = "Read this item.", extra = {}) => ({ name: `feed ${++named}`, source: { kind: "feed", ...source }, target: { kind: "start_run", agent_id: agentId, input: { content }, max_cost_usd: 0.5 }, ...extra });

/** The trigger made: 201, its body. */
export async function created(api, body) {
  const res = await api("POST", "/triggers", body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** A fired run's input as the run was given it (its launch), and the payload its feed tag holds, parsed. */
export function firedFeed(data, runId) {
  const { content } = JSON.parse(launchText(data, runId)).input;
  const tagged = /\n\n<trigger-payload source="feed"([^>]*) untrusted>\n([\s\S]*?)\n<\/trigger-payload>/.exec(content);
  return { content, attrs: tagged?.[1], payload: tagged ? JSON.parse(tagged[2]) : undefined };
}
