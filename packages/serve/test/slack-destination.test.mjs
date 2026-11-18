// Slack (slack.ts, /v2/settings/slack): one incoming-webhook URL this server posts readable messages to, over the
// outbound webhook's outbox. The URL is the credential: only the owner's session saves it, and it is in no answer, log
// line, delivery or store row, and cut from what a run shows. Each event's message is the Slack JSON below; a try that
// fails is tried again; a 404 or 410 turns Slack off. Every case posts to a fake Slack on this machine (the slackTarget
// seam), never to Slack.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { SECRET_WRITE_REFUSAL } from "../dist/secret-writes.js";
import { slackMessage, SlackPosts } from "../dist/slack.js";
import { openSqliteStore } from "../dist/store/index.js";
import { agent, follow, scratch, secretWritePath, serve, startRun } from "./support.mjs";

// Saving Slack's URL and removing Slack are secret writes: the client sends them from the owner's session, as the console
// does. A case that means the token sends its request itself (asToken).
secretWritePath(["PUT", "DELETE"], /^\/settings\/slack$/);

/** A Slack URL no Slack has: its token a canary, which no answer, log line, row or run may hold. */
const canaryUrl = () => {
  const token = `CANARY${randomBytes(12).toString("hex").toUpperCase()}`.slice(0, 24);
  return { url: `https://hooks.slack.com/services/TTEST0000/BTEST0000/${token}`, token };
};
const BASE = "https://agentrun.example.test";

/** A fake Slack on 127.0.0.1: each post, with its path and its body, answered `answer(n)` as [status, text] (n from 1;
 *  Slack's own 200 "ok" by default). `when(n)`: once it holds n posts. */
async function fakeSlack(t, answer = () => [200, "ok"]) {
  const got = [];
  const waiting = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      got.push({ method: req.method, path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const [status, text] = answer(got.length);
      res.writeHead(status, { "content-type": "text/plain" }).end(text);
      for (const w of [...waiting]) if (got.length >= w.n) (waiting.splice(waiting.indexOf(w), 1), w.resolve(got));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())));
  const when = (n) => (got.length >= n ? Promise.resolve(got) : new Promise((resolve) => waiting.push({ n, resolve })));
  return { origin: `http://127.0.0.1:${server.address().port}`, got, when };
}

/** SlackPosts over a store of its own, posting to `slack` (a fakeSlack), its agent a1 named "Lead triage". */
async function slackOn(t, slack, { retryMs = [] } = {}) {
  const dir = await scratch(t);
  const store = await openSqliteStore({ file: join(dir, "store.sqlite") });
  t.after(() => store.close());
  await store.agents.create({ id: "a1", name: "Lead triage" }, { id: "rev-a1", kind: "agentic", body: {} });
  for (const id of ["r1", "r2", "r3"]) await store.runs.create({ id, agentId: "a1", revisionId: "rev-a1" });
  const lines = [];
  const posts = new SlackPosts(store, randomBytes(32), (fields) => lines.push(JSON.stringify(fields)), { retryMs, sendTo: slack.origin, nameOf: async (id) => (await store.agents.get(id))?.name });
  t.after(() => posts.close());
  await posts.load();
  posts.attach(BASE);
  return { posts, store, lines, dir };
}

/** The files under `dir` that hold `text`: the store's database and its log among them. */
const everyFileHolding = (dir, text) => readdirSync(dir, { recursive: true }).map((name) => join(dir, String(name))).filter((file) => statSync(file).isFile() && readFileSync(file).toString("latin1").includes(text));
const arrived = async (check, what, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > end) throw new Error(`${what} did not come within ${ms / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("Slack's messages", () => {
  test("each event is the Slack JSON a channel shows: the agent's name, the status in a word, the title, the run's link; a wait says what it waits on; a trigger's failure its name and error", async (t) => {
    const slack = await fakeSlack(t);
    const { posts } = await slackOn(t, slack);
    const { url } = canaryUrl();
    assert.equal((await posts.saveSlack({ url })).created, true);
    const ended = new Date(Date.now() + 1_000).toISOString();
    assert.equal(await posts.emit("run.ended", { run_id: "r1", agent_id: "a1", status: "completed", title: "Qualify <ACME> & co" }, ended), "queued");
    assert.equal(await posts.emit("run.needs_input", { run_id: "r2", agent_id: "a1", status: "input_required", title: "Refund #42", pending: { kind: "approval" } }, "approval:call-1"), "queued");
    assert.equal(await posts.emitTrigger({ trigger_id: "t1", name: "nightly digest", firing_key: "f1", nominal_at: "2026-11-18T09:00:00Z", error: { code: "agent_not_runnable", message: "No model key is set." }, auto_paused: true }, "f1"), "queued");
    const got = await slack.when(3);
    const byText = (prefix) => got.find((post) => post.body.text.startsWith(prefix))?.body;
    assert.ok(got.every((post) => post.method === "POST" && post.path === new URL(url).pathname && post.headers["content-type"] === "application/json"), "posted as JSON to the URL's own path");
    assert.ok(got.every((post) => post.headers["webhook-signature"] === undefined), "unsigned: Slack checks only its URL");
    assert.deepEqual(byText("Lead triage: run completed"), {
      text: "Lead triage: run completed: Qualify &lt;ACME&gt; &amp; co",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*Lead triage* · run completed\n<${BASE}/#/runs/r1|Qualify &lt;ACME&gt; &amp; co>` } },
        { type: "context", elements: [{ type: "mrkdwn", text: "AgentRun · run.ended · run `r1`" }] },
      ],
    });
    assert.deepEqual(byText("Lead triage: run needs you"), {
      text: "Lead triage: run needs you: Refund #42",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*Lead triage* · run needs you\n<${BASE}/#/runs/r2|Refund #42>\nIt waits for your approval of a tool call.` } },
        { type: "context", elements: [{ type: "mrkdwn", text: "AgentRun · run.needs_input · run `r2`" }] },
      ],
    });
    assert.deepEqual(byText("Trigger nightly digest"), {
      text: "Trigger nightly digest could not start its run: agent_not_runnable",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `Trigger <${BASE}/#/triggers/t1|nightly digest> could not start its run.\n\`agent_not_runnable\`: No model key is set.\nIt failed too many times in a row, so it is off now: turn it on again in the console.` } },
        { type: "context", elements: [{ type: "mrkdwn", text: "AgentRun · trigger.failed · firing `f1`" }] },
      ],
    });
  });

  test("an agent with no name is named by its id; a run with no title links as \"Open the run\"; a wait on nothing named asks for a message; no title makes a mention or a link", () => {
    const named = slackMessage("run.needs_input", { run_id: "r9", agent_id: "a9", status: "input_required", title: "", url: `${BASE}/#/runs/r9` }, { agent: "a9", base: BASE });
    assert.equal(named.blocks[0].text.text, `*a9* · run needs you\n<${BASE}/#/runs/r9|Open the run>\nIt waits for a message from you.`);
    const loud = slackMessage("run.ended", { run_id: "r8", status: "failed", title: "<!channel> see <https://evil.example|here>", url: `${BASE}/#/runs/r8` }, { agent: "a8", base: BASE });
    assert.equal(loud.text, "a8: run failed: &lt;!channel&gt; see &lt;https://evil.example|here&gt;");
    assert.ok(!JSON.stringify(loud).includes("<!channel>") && !JSON.stringify(loud).includes("<https://evil"), "the title is escaped everywhere");
    const cancelled = slackMessage("run.ended", { run_id: "r7", status: "cancelled", title: "x", url: `${BASE}/#/runs/r7` }, { agent: "a7", base: BASE });
    assert.match(cancelled.text, /run was cancelled/);
    const test = slackMessage("slack.test", {}, { base: BASE });
    assert.deepEqual(test.blocks[0], { type: "section", text: { type: "mrkdwn", text: `AgentRun can post here: run notices from <${BASE}|this server> will come to this channel.` } });
  });

  test("a message Slack does not take is tried again under the same id and body, and its attempts say Slack's answer", async (t) => {
    const slack = await fakeSlack(t, (n) => (n === 1 ? [500, "rollup_error"] : [200, "ok"]));
    const { posts } = await slackOn(t, slack, { retryMs: [50] });
    await posts.saveSlack({ url: canaryUrl().url });
    const marker = new Date(Date.now() + 1_000).toISOString();
    await posts.emit("run.ended", { run_id: "r1", agent_id: "a1", status: "completed", title: "t" }, marker);
    const got = await slack.when(2);
    assert.deepEqual(got[1].body, got[0].body, "the same message");
    const { attempts } = await arrived(async () => ((await posts.attemptsView()).attempts.length === 2 ? posts.attemptsView() : undefined), "both attempts in the log");
    assert.equal(attempts[1].error, "answered 500 rollup_error");
    assert.ok(attempts[1].retry_at, "a retry was armed");
    assert.equal(attempts[0].error, null);
    assert.equal(attempts[0].webhook_id, attempts[1].webhook_id);
    // The same moment told again is the same message: nothing more is queued or sent.
    assert.equal(await posts.emit("run.ended", { run_id: "r1", agent_id: "a1", status: "completed", title: "t" }, marker), "queued");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(slack.got.length, 2, "told again, sent no more");
  });

  for (const [status, word] of [[404, "no_service"], [410, "channel_is_archived"]]) {
    test(`Slack's ${status} ${word} turns Slack off with its word: nothing more is sent, a test is refused, and a saved URL turns it on again`, async (t) => {
      let answer = [status, word];
      const slack = await fakeSlack(t, () => answer);
      const { posts, lines } = await slackOn(t, slack, { retryMs: [50, 50] });
      const { url, token } = canaryUrl();
      await posts.saveSlack({ url });
      await posts.emit("run.ended", { run_id: "r1", agent_id: "a1", status: "completed", title: "t" }, new Date(Date.now() + 1_000).toISOString());
      await slack.when(1);
      const off = await arrived(() => posts.slackView().disabled, "Slack turned off");
      assert.equal(off.reason, `Slack answered ${status} ${word}: the URL posts nowhere now`);
      assert.equal(posts.slackView().configured && posts.slackView().url_state, "sealed");
      assert.equal(await posts.emit("run.ended", { run_id: "r2", agent_id: "a1", status: "completed", title: "t" }, new Date(Date.now() + 1_000).toISOString()), "off");
      await assert.rejects(posts.test(), (error) => error.code === "slack_off");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(slack.got.length, 1, "no try after Slack's answer");
      assert.ok(lines.some((line) => line.includes("webhook_disabled")), "said in the log");
      assert.ok(lines.every((line) => !line.includes(token)), "the log holds no URL");
      answer = [200, "ok"];
      await posts.saveSlack({ url });
      assert.equal(posts.slackView().disabled, null, "on again");
      assert.equal((await posts.test()).status_code, 200);
    });
  }

  test("an event turned off is not sent; the others are; turned on again, it is", async (t) => {
    const slack = await fakeSlack(t);
    const { posts } = await slackOn(t, slack);
    await posts.saveSlack({ url: canaryUrl().url, events: { "run.ended": false } });
    assert.deepEqual(posts.slackView().events, { "run.ended": false, "run.needs_input": true, "trigger.failed": true });
    assert.equal(await posts.emit("run.ended", { run_id: "r1", agent_id: "a1", status: "completed", title: "t" }, new Date(Date.now() + 1_000).toISOString()), "off");
    assert.equal(await posts.emit("run.needs_input", { run_id: "r2", agent_id: "a1", status: "input_required", title: "t", pending: { kind: "question" } }, "wait-1"), "queued");
    await slack.when(1);
    assert.match(slack.got[0].body.text, /needs you/);
    // Events alone change no URL.
    await posts.saveSlack({ events: { "run.ended": true } });
    assert.equal(await posts.emit("run.ended", { run_id: "r3", agent_id: "a1", status: "completed", title: "t" }, new Date(Date.now() + 1_000).toISOString()), "queued");
    await slack.when(2);
    assert.match(slack.got[1].body.text, /run completed/);
  });
});

describe("Slack's settings over the API", () => {
  /** The token's own request, as a script or a run's process would send it: never the owner's session. */
  const asToken = (server) => async (method, path, body) => {
    const res = await fetch(`${server.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${server.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  };

  test("the owner's session saves the URL; the API token is refused, and saves or removes nothing; the token may turn events on or off", async (t) => {
    const server = await serve(t, { runner: false });
    const { api } = server;
    const token = asToken(server);
    const { url } = canaryUrl();
    const refused = await token("PUT", "/settings/slack", { url });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.error.message, SECRET_WRITE_REFUSAL);
    assert.equal((await api("GET", "/settings/slack")).body.configured, false, "nothing saved");
    const saved = await api("PUT", "/settings/slack", { url });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.url, `https://hooks.slack.com/…${url.slice(-4)}`);
    assert.deepEqual(saved.body.secret, { name: "slack:outbound", set: true, source: "console", changed_at: saved.body.updated_at });
    const events = await token("PUT", "/settings/slack", { events: { "trigger.failed": false } });
    assert.equal(events.status, 200, events.text);
    assert.equal(events.json.events["trigger.failed"], false);
    const removal = await token("DELETE", "/settings/slack");
    assert.equal(removal.status, 403, removal.text);
    assert.equal((await api("GET", "/settings/slack")).body.configured, true, "still set");
    assert.equal((await api("DELETE", "/settings/slack")).status, 204);
    assert.equal((await api("GET", "/settings/slack")).body.configured, false);
    const caps = (await api("GET", "/capabilities")).body.features.slack;
    assert.deepEqual(caps, { routes: true, events: ["run.needs_input", "run.ended", "trigger.failed"], at_rest: "sealed" });
  });

  test("a URL that is not Slack's incoming webhook is refused, naming none of it", async (t) => {
    const { api } = await serve(t, { runner: false });
    const { token } = canaryUrl();
    for (const url of [`http://hooks.slack.com/services/T1/B1/${token}`, `https://hooks.slack.com.evil.example/services/T1/B1/${token}`, `https://hooks.slack.com:8443/services/T1/B1/${token}`, `https://hooks.slack.com/services/T1/B1/${token}?x=1`, `https://hooks.slack.com/triggers/T1/${token}`, Object.assign(new URL(`https://hooks.slack.com/services/T1/B1/${token}`), { username: "someone" }).href, "not a url"]) {
      const answer = await api("PUT", "/settings/slack", { url });
      assert.equal(answer.status, 422, url);
      assert.equal(answer.body.error.details?.issues?.[0]?.field ?? answer.body.error.issues?.[0]?.field ?? "url", "url");
      assert.ok(!JSON.stringify(answer.body).includes(token), "the refusal names none of the URL");
    }
    assert.equal((await api("PUT", "/settings/slack", { events: { "run.ended": true } })).status, 422, "the first save names a URL");
    assert.equal((await api("PUT", "/settings/slack", { url: canaryUrl().url, events: { "run.started": true } })).status, 422, "an unknown event");
  });

  test("the URL is in no answer, log line, delivery or store file, and a run that quotes it shows neither it nor its token; a test send posts the test message", { timeout: 120_000 }, async (t) => {
    const slack = await fakeSlack(t);
    const lines = [];
    const server = await serve(t, { slackTarget: slack.origin, webhookRetryMs: [50], log: (line) => lines.push(String(line)) });
    const { api, data } = server;
    const { url, token } = canaryUrl();
    const answers = [];
    const keep = (answer) => (answers.push(JSON.stringify(answer.body)), answer);
    assert.equal(keep(await api("PUT", "/settings/slack", { url })).status, 201);
    keep(await api("PUT", "/settings/slack", { url, events: { "run.needs_input": true } }));
    const tested = keep(await api("POST", "/settings/slack/test", {}));
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.type, "slack.test");
    assert.equal(tested.body.status_code, 200);
    assert.equal(slack.got[0].body.text, "AgentRun can post here.");
    // Saved and sent: no file of the data directory holds it in the clear (it is sealed). The runs below quote it, and a
    // run's own rows keep what its tools read, cut when read; so after them, Slack's own rows are read.
    assert.deepEqual(everyFileHolding(data, token), [], "no file under the data directory holds the URL in the clear");
    // A run whose answer quotes the URL, and one that quotes its token alone: each one's end is posted, and neither
    // shows what it quoted.
    assert.equal((await api("POST", "/agents", agent("quotes", { name: "Quoter", tools: ["read"] }))).status, 201);
    for (const secret of [url, token]) {
      const file = join(await scratch(t), "key.txt");
      await writeFile(file, secret);
      const started = await api("POST", "/agents/quotes/runs", { input: { content: `Quote the key in ${file}` } });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      await follow(api, started.body.run_id, ["completed", "failed"]);
      keep(await api("GET", `/runs/${started.body.run_id}`));
      keep(await api("GET", `/runs/${started.body.run_id}/timeline`));
    }
    await slack.when(3);
    const ended = slack.got.slice(1).map((post) => post.body);
    assert.ok(ended.every((body) => body.text.startsWith("Quoter: run ")), JSON.stringify(ended));
    const view = keep(await api("GET", "/settings/slack"));
    assert.equal(view.body.configured, true);
    const deliveries = keep(await api("GET", "/settings/slack/deliveries"));
    assert.ok(deliveries.body.attempts.length >= 3);
    keep(await api("POST", `/settings/slack/deliveries/${deliveries.body.attempts[0].webhook_id}/redeliver`, {}));
    keep(await api("GET", "/capabilities"));
    for (const text of [...answers, ...lines, ...slack.got.map((post) => JSON.stringify(post.body))]) {
      assert.ok(!text.includes(token), `no answer, log line or message holds the URL's token: ${text.slice(0, 300)}`);
    }
    const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
    try {
      const rows = [
        ...db.prepare("SELECT * FROM channel_posts WHERE channel = 'slack-out'").all(),
        ...db.prepare("SELECT * FROM channel_attempts WHERE channel = 'slack-out'").all(),
        ...db.prepare("SELECT * FROM channel_told WHERE channel = 'slack-out'").all(),
        ...db.prepare("SELECT * FROM settings").all(),
        ...db.prepare("SELECT * FROM trigger_settings WHERE adapter = 'slack-out'").all(),
      ];
      assert.ok(rows.length > 3, "Slack's rows are read");
      assert.ok(!JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).includes(token), "no row of Slack's holds the URL");
    } finally {
      db.close();
    }
  });

  test("a run's end is posted to Slack under the agent's name, with its link on this server", { timeout: 60_000 }, async (t) => {
    const slack = await fakeSlack(t);
    const server = await serve(t, { slackTarget: slack.origin });
    const { api } = server;
    assert.equal((await api("PUT", "/settings/slack", { url: canaryUrl().url })).status, 201);
    const run = await startRun(api, "triage", "hi", { name: "Lead triage" });
    await follow(api, run.run_id, ["completed"]);
    const [post] = await slack.when(1);
    assert.equal(post.body.blocks[0].text.text.split("\n")[0], "*Lead triage* · run completed");
    assert.match(post.body.blocks[0].text.text, new RegExp(`<${server.baseUrl.replace(/\/v2$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/#/runs/${run.run_id}\\|`));
  });
});
