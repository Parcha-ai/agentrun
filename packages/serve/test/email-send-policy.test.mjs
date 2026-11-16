// email_send's policy past its setting (email/tools.ts, through the gate's per-call ask: tools.ts ToolEntry.asks): set to
// allow, a run's first 5 sends go unasked and each one after asks, saying "this run has sent N emails", across a pause
// too (the count is the run's record's, not the process's). On a run an email started (its thread), a send to anyone
// outside the thread's participants (the account's own address and every From, To and Cc of the thread's messages)
// asks even on allow, naming them. A run that reads the whole account (scope "mailbox"), or one no email started, is
// held to the cap alone. A template eval's run never reads a real account to list its thread's people: with another
// account saved than its case's fake, a send asks nothing and is refused in the eval's words, no IMAP command sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, call, clientOwnerSession, follow, serve } from "./support.mjs";
import { fakeClock, firings, keyOf, until } from "./trigger-support.mjs";
import { ADDRESS, checked, emailTrigger, FAUX_EMAIL, mailbox, saved, sawOf } from "./email-support.mjs";

const TOOLS = ["email_search", "email_read", "email_draft", "email_send"];
const calls = (list) => `Email calls: ${JSON.stringify(list)}`;
const ALLOW = { email_send: { permission: "allow" } };
const mailAgent = (id, extra = {}) => agent(id, { harness: "pi", tools: TOOLS, ...extra });
/** What a pending approval shows a person: its summary and its card's arguments. */
const shown = (pending) => `${pending?.summary ?? ""}\n${pending?.args_preview ?? ""}`;

/** The run, once it waits on a person or has ended: its status and pending approval. */
async function settled(api, runId) {
  await follow(api, runId, ["input_required", "completed", "failed"], { deadlineMs: 55_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  return { status: view.status, pending: view.pending, view };
}

/** The server with sign-in for a person's approval, and a fake trigger clock; `decide` answers an approval. `extra`:
 *  more of serve's options (a template eval's fakes). */
async function served(t, extra = {}) {
  const clock = fakeClock("2026-06-01T00:00:30Z");
  const server = await serve(t, { faux: FAUX_EMAIL, triggerClock: clock, accounts: true, openSetup: true, ...extra });
  const session = await clientOwnerSession(server);
  const decide = async (runId, approvalId, decision) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { "content-type": "application/json", cookie: session.cookie, origin: session.origin }, body: { decision } })).status;
  return { api: server.api, clock, decide };
}

/** Agent `id`'s trigger with `list` as its calls, fired by message `trigger`: its run's id. */
async function fired({ api, clock }, faux, id, list, trigger, extra = {}) {
  assert.equal((await api("POST", "/agents", mailAgent(id, extra))).status, 201);
  const made = await api("POST", "/triggers", emailTrigger(id, { every_s: 60 }, calls(list)));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await firings(api, made.body.id, 1);
  const started = faux.seed({ date: "2026-06-01T00:00:40Z", ...trigger });
  clock.to("2026-06-01T00:01:00Z");
  await checked(api, made.body.id, "2026-06-01T00:01:00Z");
  const run = (await firings(api, made.body.id, 2)).find((f) => f.key === keyOf("email", made.body.id, started.messageId));
  assert.equal(run?.status, "started", JSON.stringify(run));
  return run.run_id;
}

/** Ana's thread: her first message, our reply in Sent, and her answer (cc bo), the message that starts the run. */
function thread(faux) {
  faux.seed({ from: "Ana Díaz <ana@example.com>", to: [ADDRESS], subject: "Plan", text: "Shall we plan the launch?", date: "2026-05-01T10:00:00Z", messageId: "<m1@example.com>" });
  faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["ana@example.com"], subject: "Re: Plan", text: "Yes, Tuesday.", date: "2026-05-01T11:00:00Z", messageId: "<m2@faux.example>", inReplyTo: "<m1@example.com>", references: ["<m1@example.com>"], flags: ["\\Seen"] });
  // Someone apart from the thread: their mail is in the account, but they took no part in ana's conversation.
  faux.seed({ from: "Eve <eve@example.com>", to: [ADDRESS], subject: "Hello", text: "Hi.", date: "2026-05-01T12:00:00Z", messageId: "<e1@example.com>" });
}
const ANSWER = { from: "Ana Díaz <ana@example.com>", to: [ADDRESS], cc: ["Bo <bo@example.com>"], subject: "Re: Plan", text: "Tuesday works.", messageId: "<m3@example.com>", inReplyTo: "<m2@faux.example>", references: ["<m1@example.com>", "<m2@faux.example>"] };

test("email_send on allow: a run's first 5 sends go unasked; the 6th asks, saying this run has sent 5 emails, and so does the 7th after that pause; a denied 7th isn't counted", { timeout: 150_000 }, async (t) => {
  const server = await served(t);
  const { api, decide } = server;
  const faux = await mailbox(t);
  await saved(api, faux);
  assert.equal((await api("POST", "/agents", mailAgent("chatty", { tool_settings: ALLOW }))).status, 201);
  const send = (n) => ["email_send", { to: ["ana@example.com"], subject: `Note ${n}`, text: `Note ${n}.` }];
  const started = await api("POST", "/agents/chatty/runs", { input: { content: calls([1, 2, 3, 4, 5, 6, 7, 8].map(send)) } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;

  const sixth = await settled(api, runId);
  assert.equal(faux.sent().length, 5, "the first five sent, none asked");
  assert.equal(sixth.status, "input_required", `the 6th send asks: ${JSON.stringify(sixth.pending)}`);
  assert.deepEqual([sixth.pending?.kind, sixth.pending?.tool], ["approval", "email_send"]);
  assert.match(shown(sixth.pending), /this run has sent 5 emails/, "the ask says why");
  assert.equal(await decide(runId, sixth.pending.id, "allow"), 204);

  // The pause let the run's claim go: the 7th send is asked on a new host, the count read from the run's record.
  const seventh = await until(async () => {
    const now = await settled(api, runId);
    // The run's view can read "working" a moment after the allow: only a new ask or its end settles it.
    return (now.status === "input_required" && now.pending?.id !== sixth.pending.id) || ["completed", "failed"].includes(now.status) ? now : undefined;
  }, 55_000);
  assert.equal(faux.sent().length, 6, "the approved 6th sent");
  assert.equal(seventh?.status, "input_required", `the 7th asks too: ${JSON.stringify(seventh?.pending)}`);
  assert.match(shown(seventh.pending), /this run has sent 6 emails/);
  assert.equal(await decide(runId, seventh.pending.id, "deny"), 204);

  // The cap counts sends that went out: the denied 7th is not one, so the 8th still says 6.
  const eighth = await until(async () => {
    const now = await settled(api, runId);
    return (now.status === "input_required" && now.pending?.id !== seventh.pending.id) || ["completed", "failed"].includes(now.status) ? now : undefined;
  }, 55_000);
  assert.equal(faux.sent().length, 6, "a deny sends nothing");
  assert.equal(eighth?.status, "input_required", `the 8th asks: ${JSON.stringify(eighth?.pending)}`);
  assert.match(shown(eighth.pending), /this run has sent 6 emails/, "a denied send is not counted");
  assert.equal(await decide(runId, eighth.pending.id, "deny"), 204);
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(faux.sent().length, 6);
});

test("email_send on allow, a turn's sends at once past the cap: after 4 sent, of 3 sends made together one goes unasked and the other two ask", { timeout: 150_000 }, async (t) => {
  const server = await served(t);
  const { api, decide } = server;
  const faux = await mailbox(t);
  await saved(api, faux);
  assert.equal((await api("POST", "/agents", mailAgent("batch", { tool_settings: ALLOW }))).status, 201);
  const send = (n) => ["email_send", { to: ["ana@example.com"], subject: `Note ${n}`, text: `Note ${n}.` }];
  const started = await api("POST", "/agents/batch/runs", { input: { content: calls([send(1), send(2), send(3), send(4), [send(5), send(6), send(7)]]) } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;

  // Each ask the run makes, denied: the two over the cap, each saying the run's sends so far.
  const asked = [];
  for (;;) {
    const now = await until(async () => {
      const one = await settled(api, runId);
      // The run's view can read "working" a moment after a deny: only a new ask or its end settles it.
      return (one.status === "input_required" && one.pending?.id && !asked.some((a) => a.id === one.pending.id)) || ["completed", "failed"].includes(one.status) ? one : undefined;
    }, 55_000);
    assert.ok(now, `the run settles after ${asked.length} asks`);
    if (now?.status !== "input_required") break;
    asked.push(now.pending);
    assert.deepEqual([now.pending?.kind, now.pending?.tool], ["approval", "email_send"]);
    assert.match(shown(now.pending), /this run has sent 5 emails/, `the ask says why: ${shown(now.pending)}`);
    assert.equal(await decide(runId, now.pending.id, "deny"), 204);
  }
  assert.equal(faux.sent().length, 5, "the 4 sent first and one of the 3 at once");
  assert.equal(asked.length, 2, "the other two asked");
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
});

test("on a thread run with email_send on allow, a send to the thread's sender goes unasked; one that also reaches someone outside the thread asks, naming them", { timeout: 150_000 }, async (t) => {
  const server = await served(t);
  const faux = await mailbox(t);
  thread(faux);
  await saved(server.api, faux);
  const runId = await fired(server, faux, "replier", [
    ["email_send", { to: ["ana@example.com"], cc: ["bo@example.com"], subject: "Re: Plan", text: "Tuesday it is.", in_reply_to: "<m3@example.com>" }],
    ["email_send", { to: ["ana@example.com"], cc: ["eve@example.com"], subject: "Re: Plan", text: "Looping in Eve.", in_reply_to: "<m3@example.com>" }],
  ], ANSWER, { tool_settings: ALLOW });
  const { status, pending } = await settled(server.api, runId);
  assert.equal(faux.sent().length, 1, "the reply to ana and bo, both in her thread, sent unasked");
  assert.equal(status, "input_required", `a send that reaches eve asks: ${JSON.stringify(pending)}`);
  assert.deepEqual([pending?.kind, pending?.tool], ["approval", "email_send"]);
  const outside = /([^\n"]*?) (?:is|are) outside this email's thread/.exec(shown(pending))?.[1];
  assert.match(outside ?? "", /eve@example\.com/, `the ask names who is outside it: ${shown(pending)}`);
  assert.doesNotMatch(outside ?? "", /ana@|bo@/, "and only them");
  assert.equal(await server.decide(runId, pending.id, "deny"), 204);
  await follow(server.api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(faux.sent().length, 1);
});

test("a thread run whose agent reads the whole account (scope \"mailbox\") sends to the same outsider unasked: only the cap holds it", { timeout: 150_000 }, async (t) => {
  const server = await served(t);
  const faux = await mailbox(t);
  thread(faux);
  await saved(server.api, faux);
  const runId = await fired(server, faux, "wide", [
    ["email_send", { to: ["eve@example.com"], subject: "Hello", text: "Hi Eve." }],
  ], ANSWER, { tool_settings: { ...ALLOW, email_read: { scope: "mailbox" }, email_search: { scope: "mailbox" } } });
  const { status, pending, view } = await settled(server.api, runId);
  assert.equal(status, "completed", `no ask: ${JSON.stringify(pending)}`);
  assert.equal(sawOf(view.result?.final_answer)[0]?.sent, true);
  assert.deepEqual(faux.sent().map((m) => m.to), [["eve@example.com"]]);
});

test("a template eval's thread run with a real account saved, not its case's fake: a send outside the thread reads nothing of that account (no IMAP command), asks nothing, and is refused in the eval's words", { timeout: 150_000 }, async (t) => {
  // The case's fake mailbox, which the eval's runner binds the run's agent to (runner/beside.ts evalFakes), and the
  // server's real account, saved meanwhile: the account the trigger watches, and the one the run must never read.
  const caseFake = await mailbox(t);
  const server = await served(t, { evalFakes: (agentId) => (agentId === "evalcase" ? { email: { imap: caseFake.imap, smtp: caseFake.smtp, kind: "folders" } } : undefined) });
  const real = await mailbox(t);
  thread(real);
  await saved(server.api, real);
  const runId = await fired(server, real, "evalcase", [
    // Asked first (its setting): the run waits, after the trigger's poll and before any send, so what the real account
    // has been sent so far is the trigger's alone.
    ["email_draft", { to: ["ana@example.com"], subject: "Re: Plan", text: "Draft.", in_reply_to: "<m3@example.com>" }],
    ["email_send", { to: ["ana@example.com"], cc: ["eve@example.com"], subject: "Re: Plan", text: "Looping in Eve.", in_reply_to: "<m3@example.com>" }],
  ], ANSWER, { tool_settings: { ...ALLOW, email_draft: { permission: "ask" } } });
  const draft = await settled(server.api, runId);
  assert.equal(draft.status, "input_required", JSON.stringify(draft.pending));
  assert.deepEqual([draft.pending?.kind, draft.pending?.tool], ["approval", "email_draft"]);
  const before = real.commands().length;
  assert.equal(await server.decide(runId, draft.pending.id, "allow"), 204);
  const { status, pending, view } = await until(async () => {
    const now = await settled(server.api, runId);
    // Settled: ended, or a new ask (the view can read "working", or the draft's ask still, a moment after the allow).
    return now.status === "completed" || now.status === "failed" || (now.status === "input_required" && now.pending?.id !== draft.pending.id) ? now : undefined;
  });
  assert.equal(status, "completed", `the send to eve asks nothing: the thread's people were never read off the real account: ${JSON.stringify(pending)}`);
  assert.deepEqual(real.commands().slice(before), [], "no IMAP command reached the real account from the run");
  const saw = sawOf(view.result?.final_answer).map((one) => (typeof one === "string" ? one : JSON.stringify(one)));
  assert.match(saw[1] ?? "", /^email_send: this eval run reads only its case's fake mailbox, and the server's email account is another\./, `the send refused in execute's words: ${saw.join(" | ")}`);
  assert.deepEqual([real.sent().length, caseFake.sent().length, caseFake.commands().length], [0, 0, 0], "nothing sent, and the case's fake, not the account saved, never reached either");
});
