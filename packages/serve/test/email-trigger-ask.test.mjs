// email_send on a run a trigger started (a schedule, a webhook, an email or any other source: the run's startedBy) asks
// a person, even on allow, before it sends to an address this account has never sent to: no message of its Sent folder
// is to it in To, Cc or Bcc (the exact address, case-blind; display names, groups and encoded words read). Mail received
// from someone counts for nothing; the account's own address and an address this run already sent to (unasked or
// approved, a copy in Sent or not) are never new. The server's search by TO, CC or BCC takes a substring, so it only finds
// candidates: "a@example.co" is not data@example.com. A Sent folder that can't be read asks, saying so. A playground or
// API run is held to the 5-send cap alone. The words: "<a> and <b>: this account has never sent to them".
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { agent, call, clientOwnerSession, follow, serve } from "./support.mjs";
import { fakeClock, firings, until } from "./trigger-support.mjs";
import { ADDRESS, FAUX_EMAIL, mailbox, saved, sawOf } from "./email-support.mjs";

const { Webhook } = createRequire(import.meta.url)("standardwebhooks");

const TOOLS = ["email_search", "email_read", "email_draft", "email_send"];
const calls = (list) => `Email calls: ${JSON.stringify(list)}`;
const ALLOW = { email_send: { permission: "allow" } };
const NEVER = ": this account has never sent to them";
const send = (to, cc = []) => ["email_send", { to, ...(cc.length ? { cc } : {}), subject: "Hello", text: "Hi." }];

/** The server with sign-in for a person's approval and a fake trigger clock; `decide` answers an approval. */
async function served(t) {
  const clock = fakeClock("2026-06-01T00:00:30Z");
  const server = await serve(t, { faux: FAUX_EMAIL, triggerClock: clock, accounts: true, openSetup: true });
  const session = await clientOwnerSession(server);
  const decide = async (runId, approvalId, decision) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { "content-type": "application/json", cookie: session.cookie, origin: session.origin }, body: { decision } })).status;
  return { server, api: server.api, clock, decide };
}

const target = (id, list) => ({ kind: "start_run", agent_id: id, input: { content: calls(list) }, max_cost_usd: 0.5 });

/** Agent `id`, its email_send on allow, run by a schedule whose calls are `list`: the run's id. */
async function scheduled({ api, clock }, id, list) {
  assert.equal((await api("POST", "/agents", agent(id, { harness: "pi", tools: TOOLS, tool_settings: ALLOW }))).status, 201);
  const made = await api("POST", "/triggers", { name: `every hour ${id}`, source: { kind: "schedule", every_s: 3600, start_at: "2026-06-01T00:01:00Z" }, target: target(id, list) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  clock.to("2026-06-01T00:01:00Z");
  const [fired] = await firings(api, made.body.id, 1);
  assert.equal(fired?.status, "started", JSON.stringify(fired));
  return fired.run_id;
}

/** Agent `id`, its email_send on allow, run by a webhook whose calls are `list`, sent one signed event: the run's id. */
async function hooked({ server, api }, id, list) {
  assert.equal((await api("POST", "/agents", agent(id, { harness: "pi", tools: TOOLS, tool_settings: ALLOW }))).status, 201);
  const made = await api("POST", "/triggers", { name: `on event ${id}`, source: { kind: "webhook" }, target: target(id, list) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const body = JSON.stringify({ event: "order.created" });
  const at = Math.floor(Date.now() / 1000);
  const signature = new Webhook(made.body.signing_secret).sign("msg_order_1", new Date(at * 1000), body);
  const res = await fetch(`${server.baseUrl}/hooks/${made.body.id}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "msg_order_1", "webhook-timestamp": String(at), "webhook-signature": signature }, body });
  assert.ok(res.status < 300, `the event is taken: ${res.status} ${await res.text()}`);
  const [fired] = await firings(api, made.body.id, 1);
  assert.equal(fired?.status, "started", JSON.stringify(fired));
  return fired.run_id;
}

/** The run, once it waits on a person or has ended: its status, pending approval and view. */
async function settled(api, runId) {
  await follow(api, runId, ["input_required", "completed", "failed"], { deadlineMs: 55_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  return { status: view.status, pending: view.pending, view };
}

/** The run's email_send waits on a person, saying `because` in its own field. */
function asks(now, because) {
  assert.equal(now.status, "input_required", `the send asks: ${JSON.stringify(now.pending ?? now.view?.result)}`);
  assert.deepEqual([now.pending?.kind, now.pending?.tool], ["approval", "email_send"]);
  if (typeof because === "string") assert.equal(now.pending.asks_because, because);
  else assert.match(now.pending.asks_because ?? "", because);
}

/** The run ended with every send made and none asked. */
function unasked(now) {
  assert.equal(now.status, "completed", `no ask: ${JSON.stringify(now.pending)}`);
  for (const saw of sawOf(now.view.result?.final_answer)) assert.equal(saw?.sent, true, JSON.stringify(saw));
}

test("a schedule-started run on allow asks before sending to an address this account has never sent to, naming it; denied, nothing is sent", { timeout: 150_000 }, async (t) => {
  const ctx = await served(t);
  const faux = await mailbox(t);
  await saved(ctx.api, faux);
  const runId = await scheduled(ctx, "nightly", [send(["someone3@example.com"])]);
  const now = await settled(ctx.api, runId);
  asks(now, `someone3@example.com${NEVER}`);
  assert.equal(faux.sent().length, 0);
  assert.equal(await ctx.decide(runId, now.pending.id, "deny"), 204);
  await follow(ctx.api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(faux.sent().length, 0, "a deny sends nothing");
});

test("a webhook-started run on allow asks the same, naming every new address in one list", { timeout: 150_000 }, async (t) => {
  const ctx = await served(t);
  const faux = await mailbox(t);
  await saved(ctx.api, faux);
  const runId = await hooked(ctx, "orders", [send(["someone3@example.com"], ["someone4@example.com"])]);
  const now = await settled(ctx.api, runId);
  asks(now, `someone3@example.com and someone4@example.com${NEVER}`);
  assert.equal(faux.sent().length, 0);
});

test("a playground or API run (no trigger) sends to a never-written-to address unasked: only the cap holds it", { timeout: 150_000 }, async (t) => {
  const ctx = await served(t);
  const faux = await mailbox(t);
  await saved(ctx.api, faux);
  assert.equal((await ctx.api("POST", "/agents", agent("desk", { harness: "pi", tools: TOOLS, tool_settings: ALLOW }))).status, 201);
  const started = await ctx.api("POST", "/agents/desk/runs", { input: { content: calls([send(["someone3@example.com"])]) } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  unasked(await settled(ctx.api, started.body.run_id));
  assert.deepEqual(faux.sent().map((m) => m.to), [["someone3@example.com"]]);
});

test("a trigger run sends unasked to an address in this account's Sent mail as To, as Cc and as Bcc, each alone", { timeout: 150_000 }, async (t) => {
  const ctx = await served(t);
  const faux = await mailbox(t);
  faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["to-only@example.com"], subject: "One", text: "One.", flags: ["\\Seen"] });
  faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["other@example.com"], cc: ["cc-only@example.com"], subject: "Two", text: "Two.", flags: ["\\Seen"] });
  faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["other@example.com"], bcc: ["bcc-only@example.com"], subject: "Three", text: "Three.", flags: ["\\Seen"] });
  await saved(ctx.api, faux);
  const runId = await scheduled(ctx, "known", [send(["to-only@example.com"]), send(["cc-only@example.com"]), send(["bcc-only@example.com"])]);
  unasked(await settled(ctx.api, runId));
  assert.deepEqual(faux.sent().map((m) => m.to), [["to-only@example.com"], ["cc-only@example.com"], ["bcc-only@example.com"]]);
});

test("the server's TO/CC/BCC search is a substring: Sent to data@example.com and jimbob@example.com does not make a@example.co or bob@example.com written to, so the send asks naming both", { timeout: 150_000 }, async (t) => {
  const ctx = await served(t);
  const faux = await mailbox(t);
  faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["data@example.com"], subject: "Data", text: "Data.", flags: ["\\Seen"] });
  faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["Jim <jimbob@example.com>"], subject: "Jim", text: "Jim.", flags: ["\\Seen"] });
  await saved(ctx.api, faux);
  const runId = await scheduled(ctx, "lookalike", [send(["a@example.co"], ["bob@example.com"])]);
  const now = await settled(ctx.api, runId);
  // The fake's search took the lookalikes (a real server's would too), and only their address headers were read.
  const commands = faux.commands();
  assert.ok(commands.some((c) => /SEARCH .*BCC "bob@example\.com"/i.test(c)), `searched by To, Cc and Bcc: ${commands.join(" | ")}`);
  assert.ok(commands.some((c) => /FETCH .*HEADER\.FIELDS \(TO CC BCC\)/i.test(c)), `read the hits' To, Cc and Bcc: ${commands.join(" | ")}`);
  asks(now, `a@example.co and bob@example.com${NEVER}`);
  assert.equal(faux.sent().length, 0);
});

test("a send to an address this run already sent to goes unasked, though the account filed no copy in Sent: one approval covers the next", { timeout: 150_000 }, async (t) => {
  const ctx = await served(t);
  const faux = await mailbox(t);
  await saved(ctx.api, faux);
  faux.refuseAppend(true);
  const runId = await scheduled(ctx, "twice", [send(["someone3@example.com"]), send(["someone3@example.com"])]);
  const first = await settled(ctx.api, runId);
  asks(first, `someone3@example.com${NEVER}`);
  assert.equal(await ctx.decide(runId, first.pending.id, "allow"), 204);
  const now = await until(async () => {
    const one = await settled(ctx.api, runId);
    // The view can read the first ask a moment after the allow: only a new ask or the run's end settles it.
    return (one.status === "input_required" && one.pending?.id !== first.pending.id) || ["completed", "failed"].includes(one.status) ? one : undefined;
  }, 55_000);
  assert.equal(now?.status, "completed", `the second send asks nothing: ${JSON.stringify(now?.pending)}`);
  assert.equal(faux.sent().length, 2, "both sent");
  assert.equal(faux.messages("Sent").length, 0, "no copy of either in Sent");
});

test("a Sent folder that can't be read asks, saying the recipients couldn't be checked and why", { timeout: 150_000 }, async (t) => {
  const ctx = await served(t);
  const faux = await mailbox(t);
  await saved(ctx.api, faux);
  faux.refuseLogin(true);
  const runId = await scheduled(ctx, "blind", [send(["someone3@example.com"])]);
  const now = await settled(ctx.api, runId);
  asks(now, /^its recipients couldn't be checked against this account's sent mail \(.*refused the sign-in/);
  assert.equal(await ctx.decide(runId, now.pending.id, "deny"), 204);
  await follow(ctx.api, runId, ["completed"], { deadlineMs: 55_000 });
});

test("an address that only ever wrote in (its From in INBOX) is still never written to: the send asks", { timeout: 150_000 }, async (t) => {
  const ctx = await served(t);
  const faux = await mailbox(t);
  faux.seed({ from: "Stranger <stranger@example.com>", to: [ADDRESS], subject: "Hi", text: "Write back?", date: "2026-05-01T10:00:00Z" });
  await saved(ctx.api, faux);
  const runId = await scheduled(ctx, "inbound", [send(["stranger@example.com"])]);
  asks(await settled(ctx.api, runId), `stranger@example.com${NEVER}`);
});

test("Sent's address headers are read as addresses: an encoded-word display name, a group and another case still match, and the account's own address is never new", { timeout: 150_000 }, async (t) => {
  const ctx = await served(t);
  const faux = await mailbox(t);
  faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["=?UTF-8?Q?Ana_D=C3=ADaz?= <ana@example.com>", "Crew: lee@example.com, \"Kim, K.\" <kim@example.com>;"], cc: ["Bo@Example.COM"], subject: "Crew", text: "Crew.", flags: ["\\Seen"] });
  await saved(ctx.api, faux);
  const runId = await scheduled(ctx, "crew", [send(["ana@example.com", "lee@example.com"], ["kim@example.com", "bo@example.com", ADDRESS])]);
  unasked(await settled(ctx.api, runId));
  assert.equal(faux.sent().length, 1);
});
