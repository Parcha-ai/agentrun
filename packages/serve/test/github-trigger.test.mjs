// A GitHub trigger through the API, with deliveries signed in the test (no tunnel, no account): the server's GitHub
// settings set with PUT /v2/settings/github and kept sealed, every request to /v2/hooks/github checked by GitHub's
// X-Hub-Signature-256 on its raw body before anything else, and a mention of the handle by an owner, a member or a
// collaborator (an issue's comment, a pull request's, a review comment), or an issue assigned to the configured login,
// starting one run for that issue or pull request. A delivery sent again, and the same comment under another delivery,
// are one firing; a bot, an outsider, the handle's own comment, an edit, a comment that mentions no one and a repo no
// trigger lists start nothing.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { call, follow, serve, withEnv } from "./support.mjs";
import { firings, made } from "./trigger-support.mjs";

const SECRET = "not-a-secret-webhook";
const TOKEN = "not-a-secret-token";
const HANDLE = "agentrun-dev";
const REPO = { id: 1001, name: "widgets", full_name: "example-org/widgets", owner: { login: "example-org", id: 2001, type: "Organization" } };
const OTHER_REPO = { id: 1002, name: "gadgets", full_name: "example-org/gadgets", owner: REPO.owner };
const user = (login, id, type = "User") => ({ login, id, type });
const OWNER = user("octo-owner", 3001);
const MEMBER = user("octo-member", 3002);
const COLLAB = user("octo-collab", 3003);
const OUTSIDER = user("octo-outsider", 3004);
const DEPENDABOT = user("dependabot[bot]", 3005, "Bot");
const SELF = user(`${HANDLE}[bot]`, 3006, "Bot");
const issue = (number, extra = {}) => ({ id: 5000 + number, number, title: `Widget ${number} is slow`, body: `It takes a minute to open widget ${number}.`, user: OUTSIDER, html_url: `https://github.com/example-org/widgets/issues/${number}`, ...extra });

/** An issue_comment delivery, as GitHub sends one: the comment by `who` with `association`, on `number`. */
function commented(number, text, { who = OWNER, association = "OWNER", id = 7000 + number, action = "created", repo = REPO, sender = who, pull = false } = {}) {
  return { event: "issue_comment", body: { action, issue: issue(number, pull ? { pull_request: { url: `https://api.github.com/repos/${repo.full_name}/pulls/${number}` } } : {}), comment: { id, body: text, user: who, author_association: association, html_url: `https://github.com/${repo.full_name}/issues/${number}#issuecomment-${id}` }, repository: repo, sender } };
}
function reviewComment(number, text, { who = COLLAB, association = "COLLABORATOR", id = 8000 + number } = {}) {
  return { event: "pull_request_review_comment", body: { action: "created", comment: { id, body: text, user: who, author_association: association, path: "src/widget.ts", line: 12, original_line: 12, commit_id: "0".repeat(40), pull_request_review_id: 9000 + number, html_url: `https://github.com/example-org/widgets/pull/${number}#discussion_r${id}` }, pull_request: { id: 6000 + number, number, title: `Speed up widget ${number}`, body: "Caches the widget.", user: MEMBER, html_url: `https://github.com/example-org/widgets/pull/${number}` }, repository: REPO, sender: who } };
}
const assigned = (number, to, { sender = MEMBER } = {}) => ({ event: "issues", body: { action: "assigned", issue: issue(number), assignee: user(to, 3100), repository: REPO, sender } });

/** GitHub's request for `delivery`: the body serialised once, signed over those bytes as GitHub signs it. */
function signed({ event, body }, { secret = SECRET, delivery = randomBytes(16).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"), headers = {} } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return { raw, delivery, headers: { "content-type": "application/json", "user-agent": "GitHub-Hookshot/0000000", "x-github-event": event, "x-github-delivery": delivery, "x-github-hook-id": "4242", "x-hub-signature-256": signature, ...headers } };
}

async function gitHubServer(t, extra = {}) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SEAL_KEY"]);
  const server = await serve(t, { publicUrl: "https://agentrun.example", ...extra });
  /** A POST to /v2/hooks/github, with no token: its status, headers and body. */
  const hook = async (delivery, options) => {
    const { raw, headers } = signed(delivery, options);
    const res = await fetch(`${server.baseUrl}/hooks/github`, { method: "POST", headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)), body: raw });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { ...server, hook };
}

const settings = { webhook_secret: SECRET, token: TOKEN, handle: HANDLE, assignee_login: HANDLE };
const REFUSED = { code: "unauthenticated", message: "this route needs a request signed by the server's GitHub webhook secret", retryable: false };
const errorOf = (body) => {
  const { request_id: _, ...error } = body.error;
  return error;
};

async function until(check, what) {
  for (const end = Date.now() + 30_000; ; await sleep(50)) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < end, `waited for ${what}`);
  }
}

test("GitHub's documented signature: its test secret over \"Hello, World!\" is the sha256 its page shows; a mention is the handle as a word, any case", async () => {
  const { gitHubRefusal, mentions } = await import("../dist/github.js");
  const body = Buffer.from("Hello, World!");
  const signature = ["sha256=757107ea0eb2509fc211221cce984b8a", "37570b6d7586c22c46f4379c8b043e17"].join("");
  const headers = { "x-hub-signature-256": signature, "x-github-event": "ping", "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958" };
  assert.equal(gitHubRefusal("It's a Secret to Everybody", headers, body), undefined);
  assert.equal(gitHubRefusal("It's another secret", headers, body), "bad_signature");
  assert.equal(gitHubRefusal("It's a Secret to Everybody", { ...headers, "x-hub-signature-256": signature.toUpperCase().replace("SHA256=", "sha256=") }, body), "malformed_headers");
  assert.equal(gitHubRefusal("It's a Secret to Everybody", { ...headers, "x-hub-signature-256": `${signature}, ${signature}` }, body), "malformed_headers", "a header sent twice");
  for (const [text, yes] of [["@agentrun-dev look", true], ["hey @AgentRun-Dev.", true], ["(@agentrun-dev)", true], ["@agentrun-dev[bot] please", true], ["@agentrun-dev2 look", false], ["mail me@agentrun-dev.example", false], ["@agentrun-devs", false], ["agentrun-dev", false], ["@agentrun-dev/team", false]]) {
    assert.equal(mentions(text, HANDLE), yes, text);
  }
});

test("the server's GitHub settings are set once, kept sealed and never shown; every request to the hook is checked by its signature on the raw body, and a ping is answered only after it", { timeout: 120_000 }, async (t) => {
  const { api, hook, data, baseUrl } = await gitHubServer(t);
  const ping = { event: "ping", body: { zen: "Keep it logically awesome.", hook_id: 4242, hook: { id: 4242, type: "Repository" }, repository: REPO, sender: OWNER } };
  const none = await hook(ping);
  assert.deepEqual([none.status, errorOf(none.body)], [401, REFUSED], "no GitHub set: refused");
  for (const [body, fields] of [[{ ...settings, webhook_secret: "short" }, ["webhook_secret"]], [{ ...settings, handle: "not a login" }, ["handle"]], [{ ...settings, assignee_login: "-x-" }, ["assignee_login"]], [{ webhook_secret: SECRET, handle: HANDLE }, ["token"]], [{ ...settings, post_answer: true }, ["post_answer"]]]) {
    const refused = await api("PUT", "/settings/github", body);
    assert.deepEqual([refused.status, refused.body.error.fields.map((f) => f.field)], [422, fields], JSON.stringify(body));
  }
  const saved = await api("PUT", "/settings/github", settings);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, { configured: true, handle: HANDLE, assignee_login: HANDLE, links: true, at_rest: "sealed", disabled: null, updated_at: saved.body.updated_at });
  const read = await api("GET", "/settings/github");
  assert.deepEqual(read.body, saved.body);
  const file = await readFile(join(data, "github.json"), "utf8");
  for (const text of [JSON.stringify(read.body), file]) assert.ok(!text.includes(SECRET) && !text.includes(TOKEN), "never in the clear");
  assert.deepEqual(await hook(ping).then((r) => [r.status, r.body]), [200, { ok: "pong" }]);
  // Another secret, the legacy SHA-1 header alone, no signature, no event or delivery, a malformed one: one answer.
  const sha1 = { "x-hub-signature-256": undefined, "x-hub-signature": `sha1=${createHmac("sha1", SECRET).update(JSON.stringify(ping.body)).digest("hex")}` };
  for (const options of [{ secret: "not-a-secret-wrong" }, { headers: sha1 }, { headers: { "x-hub-signature-256": undefined } }, { headers: { "x-github-event": undefined } }, { headers: { "x-github-delivery": undefined } }, { headers: { "x-github-delivery": "not a guid" } }, { headers: { "x-hub-signature-256": "sha256=zz" } }]) {
    const answer = await hook(ping, options);
    assert.deepEqual([answer.status, errorOf(answer.body)], [401, REFUSED], JSON.stringify(options));
  }
  // A signature header sent twice, as raw bytes: one header's value or the other's would pass, the pair is refused.
  const { raw, headers } = signed(ping);
  const doubled = await call(Number(new URL(baseUrl).port), { method: "POST", path: "/v2/hooks/github", headers: { ...headers, "x-hub-signature-256": [headers["x-hub-signature-256"], headers["x-hub-signature-256"]], "content-length": String(Buffer.byteLength(raw)) }, body: raw });
  assert.deepEqual([doubled.status, errorOf(doubled.json)], [401, REFUSED], "a doubled signature header");
  // Gone: the hook refuses again.
  assert.equal((await api("DELETE", "/settings/github")).status, 204);
  assert.equal((await hook(ping)).status, 401);
  assert.deepEqual((await api("GET", "/settings/github")).body, { configured: false });
});

test("a GitHub trigger's repos are its own: another trigger listing one is 409, naming it; it starts runs, never messages a run, and its repos are owner/name", { timeout: 120_000 }, async (t) => {
  const { api } = await gitHubServer(t);
  await made(api, "triage");
  const target = { kind: "start_run", agent_id: "triage", input: { content: "Look into this." }, max_cost_usd: 0.5 };
  const first = await api("POST", "/triggers", { name: "widgets", source: { kind: "github", repos: [REPO.full_name] }, target });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(first.body.source, { kind: "github", repos: [REPO.full_name], post_answer: false });
  const taken = await api("POST", "/triggers", { name: "again", source: { kind: "github", repos: [OTHER_REPO.full_name, "Example-Org/Widgets"] }, target });
  assert.deepEqual([taken.status, taken.body.error.code, taken.body.error.details], [409, "repo_taken", { repo: "Example-Org/Widgets", trigger_id: first.body.id }]);
  for (const repos of [[], ["widgets"], ["example-org/widgets", "example-org/widgets"], ["-bad-/x"], Array.from({ length: 51 }, (_, i) => `example-org/r${i}`)]) {
    const bad = await api("POST", "/triggers", { name: "bad", source: { kind: "github", repos }, target });
    assert.deepEqual([bad.status, bad.body.error.fields?.[0]?.field], [422, "source.repos"], JSON.stringify(repos));
  }
  const messaging = await api("POST", "/triggers", { name: "msg", source: { kind: "github", repos: [OTHER_REPO.full_name] }, target: { kind: "message_run", run_id: "01a1aaaa-0000-7000-8000-000000000000", input: { content: "x" } } });
  assert.deepEqual([messaging.status, messaging.body.error.fields?.[0]?.field], [422, "target.kind"]);
});

test("a mention of the handle by an owner, a member or a collaborator, on an issue, a pull request or a review comment, or an issue assigned to the configured login, starts one capped run per issue or pull request; a delivery sent again and the same comment under another delivery are one firing; outsiders, bots, the handle itself, edits, comments that mention no one and unlisted repos start nothing", { timeout: 180_000 }, async (t) => {
  const { api, hook, data } = await gitHubServer(t);
  /** What the run was started with (its serve.json): the input and the cap. */
  const metaOf = async (runId) => JSON.parse(await readFile(join(data, "runs", runId, "serve.json"), "utf8"));
  await made(api, "triage");
  assert.equal((await api("PUT", "/settings/github", settings)).status, 200);
  const { id } = (await api("POST", "/triggers", { name: "widgets", source: { kind: "github", repos: [REPO.full_name] }, target: { kind: "start_run", agent_id: "triage", input: { content: "Look into this." }, max_cost_usd: 0.5 } })).body;
  const first = commented(7, `@${HANDLE} why is this slow?`);
  const sent = signed(first);
  const answer = await hook(first, { delivery: sent.delivery });
  assert.deepEqual([answer.status, answer.body], [200, { ok: "received" }]);
  const [fired] = await firings(api, id, 1);
  assert.deepEqual([fired.by, fired.status], ["github", "started"], JSON.stringify(fired));
  assert.deepEqual((await api("GET", `/runs/${fired.run_id}`)).body.trigger, { id, firing_key: fired.key });
  const meta = await metaOf(fired.run_id);
  assert.equal(meta.max_cost_usd, 0.5);
  const input = meta.input.content;
  assert.ok(input.startsWith("Look into this.\n\n<trigger-payload source=\"github\" user=\"octo-owner\" repo=\"example-org/widgets\" number=\"7\" untrusted>\n"), input);
  assert.ok(input.includes("Widget 7 is slow") && input.includes("why is this slow?") && !input.includes(`@${HANDLE}`), input);
  await follow(api, fired.run_id, ["completed"]);
  // The same delivery again, and the same comment under another delivery (a repo's webhook and an org's): replayed.
  for (const delivery of [sent.delivery, undefined]) {
    const again = await hook(first, delivery ? { delivery } : {});
    assert.deepEqual([again.status, again.body], [200, { ok: "replayed" }]);
  }
  // Nothing to act on: 200 and ignored, so GitHub counts no failure.
  const ignored = [
    commented(8, `@${HANDLE} please`, { who: OUTSIDER, association: "CONTRIBUTOR" }),
    commented(8, `@${HANDLE} please`, { who: OUTSIDER, association: "NONE", id: 7801 }),
    commented(8, `@${HANDLE} bump`, { who: DEPENDABOT, association: "NONE", id: 7802 }),
    commented(8, `@${HANDLE} done`, { who: SELF, association: "NONE", id: 7803 }),
    commented(8, `@${HANDLE} please`, { repo: OTHER_REPO, id: 7804 }),
    commented(8, `@${HANDLE} please`, { action: "edited", id: 7805 }),
    commented(8, "no one is mentioned here", { id: 7806 }),
    commented(8, `@${HANDLE}2 please`, { id: 7807 }),
    commented(8, `@${HANDLE} please`, { id: 7808, sender: MEMBER }),
    assigned(8, "someone-else"),
    assigned(8, HANDLE, { sender: DEPENDABOT }),
  ];
  for (const delivery of ignored) {
    const answer = await hook(delivery);
    assert.deepEqual([answer.status, answer.body], [200, { ok: "ignored" }], JSON.stringify(delivery.body.comment ?? delivery.body.assignee));
  }
  assert.equal((await api("GET", `/triggers/${id}/firings`)).body.firings.length, 1, "nothing fired for them");
  // A member's mention on a pull request, a collaborator's review comment, and an issue assigned to the login.
  for (const delivery of [commented(9, `Hey @${HANDLE}, review this`, { who: MEMBER, association: "MEMBER", pull: true }), reviewComment(10, `@${HANDLE} is this line right?`), assigned(11, HANDLE)]) {
    assert.deepEqual(await hook(delivery).then((r) => [r.status, r.body]), [200, { ok: "received" }]);
  }
  const all = await firings(api, id, 4);
  assert.deepEqual(all.map((f) => [f.by, f.status]), [["github", "started"], ["github", "started"], ["github", "started"], ["github", "started"]]);
  const inputs = await Promise.all(all.slice(0, 3).map(async (f) => (await metaOf(f.run_id)).input.content));
  assert.ok(inputs[0].includes("number=\"11\"") && inputs[0].includes("Widget 11 is slow") && inputs[0].includes("It takes a minute to open widget 11."), inputs[0]);
  assert.ok(inputs[1].includes("number=\"10\"") && inputs[1].includes("src/widget.ts:12") && inputs[1].includes("is this line right?"), inputs[1]);
  assert.ok(inputs[2].includes("user=\"octo-member\"") && inputs[2].includes("number=\"9\"") && inputs[2].includes("review this"), inputs[2]);
  for (const f of all) await follow(api, f.run_id, ["completed"]);
});
