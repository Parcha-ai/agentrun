// The email tools (email/tools.ts) in pi runs, against the fake mail account: email_search answers newest first,
// email_read a thread oldest first with its references, email_draft appends to the account's Drafts with \Draft, and
// email_send asks first (its approval says to whom and what), sends nothing on a deny, and on an allow sends a reply
// threaded with In-Reply-To and References, marked X-AgentRun-Sent, its copy appended to Sent unless the provider keeps
// one (Gmail). Mailbox names: INBOX; "Drafts" and "Sent" (or "\\Drafts", "\\Sent") the account's special-use folders, its
// folder of that name else; any other a folder's own name, as a Gmail layout shows. Reads are PEEKs: the inbox reads
// unread after. A run an email started sees only its thread (the message that started it and every message linked to
// it by References or In-Reply-To, in any mailbox) unless the agent's tool setting says `scope: "mailbox"`; any other
// run sees the whole account. The password is in no answer, row or run input; one a tool's error ever echoed is cut from
// everything the server shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, call, clientOwnerSession, follow, serve } from "./support.mjs";
import { fakeClock, firings, keyOf, made } from "./trigger-support.mjs";
import { ADDRESS, checked, emailTrigger, FAUX_EMAIL, launchText, mailbox, saved, sawOf } from "./email-support.mjs";

const TOOLS = ["email_search", "email_read", "email_draft", "email_send"];
const calls = (list) => `Email calls: ${JSON.stringify(list)}`;

/** A thread of three in the account, and a message apart from it in INBOX and one in Archive: ana's first message, our
 *  reply in Sent, ana's answer; then the others. Each Message-ID fixed, so a run's calls can name them. */
function thread(faux, archive = "Archive") {
  const first = faux.seed({ from: "Ana Díaz <ana@example.com>", to: [ADDRESS], subject: "Plan", text: "Shall we plan the launch?", date: "2026-05-01T10:00:00Z", messageId: "<m1@example.com>" });
  const reply = faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["ana@example.com"], subject: "Re: Plan", text: "Yes, Tuesday.", date: "2026-05-01T11:00:00Z", messageId: "<m2@faux.example>", inReplyTo: "<m1@example.com>", references: ["<m1@example.com>"], flags: ["\\Seen"] });
  const apart = faux.seed({ from: "Cy <cy@example.com>", to: [ADDRESS], subject: "Lunch", text: "Lunch on Friday?", date: "2026-05-01T12:00:00Z", messageId: "<u1@example.com>" });
  const archived = faux.seed({ mailbox: archive, from: "Dee <dee@example.com>", subject: "Old news", text: "Archived.", date: "2026-04-01T12:00:00Z", messageId: "<a1@example.com>", flags: ["\\Seen"] });
  return { first, reply, apart, archived };
}
const answer = (faux) => faux.seed({ from: "Ana Díaz <ana@example.com>", to: [ADDRESS], cc: ["Bo <bo@example.com>"], subject: "Re: Plan", text: "Tuesday works. Bring the slides.", date: "2026-05-01T13:00:00Z", messageId: "<m3@example.com>", inReplyTo: "<m2@faux.example>", references: ["<m1@example.com>", "<m2@faux.example>"], attachments: [{ name: "slides.txt", type: "text/plain", content: "one two" }] });

const { setSocketTimeoutForTests } = await import("../dist/email/mail.js");

/** The fake account for a layout: "standard", a plain account's; "gmail", Gmail's (X-GM-EXT-1), whose search by In-Reply-To
 *  never answers, as Gmail's on a large mailbox, with every IMAP socket timeout 3 s so a search by it fails in a test's
 *  time. */
async function account(t, layout, options = {}) {
  if (layout === "standard") return mailbox(t, options);
  return slowSearch(t, { layout: "gmail", ...options });
}
/** A fake account whose search by In-Reply-To never answers, every IMAP socket timeout 3 s. */
async function slowSearch(t, options = {}) {
  setSocketTimeoutForTests(3_000);
  t.after(() => setSocketTimeoutForTests(undefined));
  return mailbox(t, { slowInReplyTo: true, ...options });
}
/** Where an archived message is on a layout. */
const archiveOf = (layout) => (layout === "gmail" ? "[Gmail]/All Mail" : "Archive");

/** Agent `id` on pi with the four email tools (or `tools`), told nothing of its own. */
const mailAgent = (id, extra = {}) => agent(id, { harness: "pi", tools: TOOLS, ...extra });

/** A run of agent `id` with `list` as its calls, to its end: the answers it was handed, parsed. */
async function ran(api, id, list) {
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: calls(list) } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  return { runId: started.body.run_id, saw: sawOf(view.result?.final_answer) };
}

test("search newest first, a thread read oldest first, a draft in Drafts with \\Draft; every read a PEEK", { timeout: 150_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX_EMAIL });
  const faux = await mailbox(t);
  const { first, apart } = thread(faux);
  answer(faux);
  await saved(api, faux);
  assert.equal((await api("POST", "/agents", mailAgent("reader"))).status, 201);

  const { runId, saw } = await ran(api, "reader", [
    ["email_search", { from: "ana@example.com" }],
    ["email_read", { message_id: "<m3@example.com>", thread: true }],
    ["email_draft", { to: ["ana@example.com"], cc: ["bo@example.com"], subject: "Re: Plan", text: "Slides attached soon.", in_reply_to: "<m3@example.com>" }],
    ["email_search", { mailbox: "Archive" }],
    ["email_search", { text: "Lunch", unread: true, limit: 5 }],
  ]);
  const [search, read, draft, archive, lunch] = saw;
  assert.deepEqual(search.messages.map((m) => m.message_id), ["<m3@example.com>", "<m1@example.com>"], "newest first, INBOX by default");
  assert.deepEqual(search.messages[0], { message_id: "<m3@example.com>", from: "ana@example.com", to: [ADDRESS], subject: "Re: Plan", date: "2026-05-01T13:00:00.000Z", snippet: "Tuesday works. Bring the slides.", unread: true, attachments: [{ name: "slides.txt", size: 7, type: "text/plain" }] });

  assert.deepEqual(read.messages.map((m) => m.message_id), ["<m1@example.com>", "<m2@faux.example>", "<m3@example.com>"], "the thread oldest first, our reply in Sent with it");
  assert.deepEqual(read.messages[2], {
    from: "ana@example.com", from_name: "Ana Díaz", to: [ADDRESS], cc: ["bo@example.com"], subject: "Re: Plan", date: "2026-05-01T13:00:00.000Z", message_id: "<m3@example.com>", in_reply_to: "<m2@faux.example>",
    text: "Tuesday works. Bring the slides.", attachments: [{ name: "slides.txt", size: 7, type: "text/plain" }], references: ["<m1@example.com>", "<m2@faux.example>"],
  });

  assert.deepEqual([draft.saved, draft.mailbox], [true, "Drafts"]);
  const [kept] = faux.messages("Drafts");
  assert.ok(kept.flags.includes("\\Draft"), `flags: ${kept.flags}`);
  assert.equal(kept.messageId, draft.message_id);
  assert.match(kept.raw, /^In-Reply-To: <m3@example\.com>\r$/m);
  assert.match(kept.raw, /^References: <m1@example\.com> <m2@faux\.example> <m3@example\.com>\r$/m);
  assert.match(kept.raw, /^From: agent@faux\.example\r$/m);
  assert.deepEqual(faux.sent(), [], "a draft sends nothing");

  assert.deepEqual(archive.messages.map((m) => m.message_id), ["<a1@example.com>"], "a folder by its own name");
  assert.deepEqual(lunch.messages.map((m) => m.message_id), [apart.messageId]);

  assert.deepEqual(faux.messages().map((m) => [m.messageId, m.flags.includes("\\Seen")]), [[first.messageId, false], [apart.messageId, false], ["<m3@example.com>", false]], "every read left the inbox unread");
  assert.ok(!faux.commands().some((c) => /\bSTORE\b/i.test(c) || (/BODY\[/i.test(c) && !/BODY\.PEEK\[/i.test(c))), "no read set a flag");

  // The password: in no answer the run was handed, no row, no input.
  const rows = JSON.stringify((await api("GET", `/runs/${runId}/timeline?wait_ms=0`)).body);
  const meta = launchText(data, runId);
  for (const where of [JSON.stringify(saw), rows, meta]) assert.ok(!where.includes(faux.password));
});

test("Gmail's layout: Drafts and Sent are [Gmail]/Drafts and [Gmail]/Sent Mail, by name or by \\Drafts and \\Sent; a folder by its own name; a thread read across INBOX and Sent Mail; a sent reply is left for Gmail to file", { timeout: 150_000 }, async (t) => {
  const server = await serve(t, { faux: FAUX_EMAIL, accounts: true, openSetup: true });
  const { api } = server;
  const faux = await mailbox(t, { layout: "gmail" });
  faux.seed({ from: "ana@example.com", subject: "Plan", text: "Plan?", date: "2026-05-01T10:00:00Z", messageId: "<g1@example.com>" });
  faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["ana@example.com"], subject: "Re: Plan", text: "Yes.", date: "2026-05-01T11:00:00Z", messageId: "<g2@faux.example>", inReplyTo: "<g1@example.com>", references: ["<g1@example.com>"] });
  faux.seed({ mailbox: "[Gmail]/All Mail", from: "old@example.com", subject: "All mail only", date: "2026-04-01T00:00:00Z", messageId: "<g0@example.com>" });
  await saved(api, faux, { preset: "gmail" });
  assert.equal((await api("POST", "/agents", mailAgent("gmail", { tool_settings: { email_send: { permission: "allow" } } }))).status, 201);

  const { saw } = await ran(api, "gmail", [
    ["email_draft", { to: ["ana@example.com"], subject: "Draft one", text: "One." }],
    ["email_search", { mailbox: "\\Drafts" }],
    ["email_search", { mailbox: "Sent" }],
    ["email_search", { mailbox: "\\Sent" }],
    ["email_search", { mailbox: "[Gmail]/All Mail" }],
    ["email_read", { message_id: "<g1@example.com>", thread: true }],
    ["email_send", { to: ["ana@example.com"], subject: "Re: Plan", text: "See you Tuesday.", in_reply_to: "<g2@faux.example>" }],
  ]);
  const [draft, drafts, sent, sentFlag, all, read, send] = saw;
  assert.deepEqual([draft.saved, draft.mailbox], [true, "[Gmail]/Drafts"]);
  assert.equal(faux.messages("[Gmail]/Drafts").length, 1);
  assert.deepEqual(drafts.messages.map((m) => m.subject), ["Draft one"]);
  assert.deepEqual([sent.messages.map((m) => m.message_id), sentFlag.messages.map((m) => m.message_id)], [["<g2@faux.example>"], ["<g2@faux.example>"]]);
  assert.deepEqual(all.messages.map((m) => m.message_id), ["<g0@example.com>"]);
  assert.deepEqual(read.messages.map((m) => m.message_id), ["<g1@example.com>", "<g2@faux.example>"]);
  assert.equal(send.sent, true, JSON.stringify(send));
  assert.equal(faux.sent().length, 1);
  assert.deepEqual(faux.messages("[Gmail]/Sent Mail").map((m) => m.messageId), ["<g2@faux.example>"], "Gmail files what its SMTP sent: no second copy appended");
});

test("email_send asks, saying to whom and what; a deny sends nothing; an allow sends the reply threaded, marked as this server's, and files a copy in Sent", { timeout: 150_000 }, async (t) => {
  const server = await serve(t, { faux: FAUX_EMAIL, accounts: true, openSetup: true });
  const { api } = server;
  const faux = await mailbox(t);
  thread(faux);
  answer(faux);
  await saved(api, faux);
  assert.equal((await api("POST", "/agents", mailAgent("sender"))).status, 201);
  const session = await clientOwnerSession(server);
  const decide = async (runId, approvalId, decision) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { "content-type": "application/json", cookie: session.cookie, origin: session.origin }, body: { decision } })).status;
  const long = `Tuesday it is. ${"More words. ".repeat(40)}`;
  const send = ["email_send", { to: ["ana@example.com"], cc: ["bo@example.com"], subject: "Re: Plan", text: long, in_reply_to: "<m3@example.com>" }];

  for (const decision of ["deny", "allow"]) {
    const started = await api("POST", "/agents/sender/runs", { input: { content: calls([send]) } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    await follow(api, runId, ["input_required"], { deadlineMs: 55_000 });
    const pending = (await api("GET", `/runs/${runId}`)).body.pending;
    assert.deepEqual([pending?.kind, pending?.tool], ["approval", "email_send"], "send asks by default");
    assert.equal(pending.summary, `Send email to ana@example.com, cc bo@example.com: Re: Plan\n\n${long.slice(0, 300)}`);
    assert.deepEqual(faux.sent(), [], "nothing sent while it waits");
    assert.equal(await decide(runId, pending.id, decision), 204);
    await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
    const [said] = sawOf((await api("GET", `/runs/${runId}`)).body.result?.final_answer);
    if (decision === "deny") {
      assert.deepEqual(faux.sent(), [], "a deny sends nothing");
      assert.deepEqual(faux.messages("Sent").map((m) => m.messageId), ["<m2@faux.example>"], "nor files anything");
      continue;
    }
    assert.equal(said.sent, true, JSON.stringify(said));
    const [mail] = faux.sent();
    assert.equal(faux.sent().length, 1);
    assert.deepEqual([mail.from, [...mail.to].sort()], [ADDRESS, ["ana@example.com", "bo@example.com"]]);
    assert.match(mail.raw, /^In-Reply-To: <m3@example\.com>\r$/m);
    assert.match(mail.raw, /^References: <m1@example\.com> <m2@faux\.example> <m3@example\.com>\r$/m);
    assert.match(mail.raw, new RegExp(`^X-AgentRun-Sent: ${runId}\\r$`, "m"));
    assert.match(mail.raw, new RegExp(`^Message-ID: ${said.message_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r$`, "mi"));
    const filed = faux.messages("Sent");
    assert.deepEqual(filed.map((m) => m.messageId), ["<m2@faux.example>", said.message_id], "a copy filed in Sent");
    assert.ok(filed[1].flags.includes("\\Seen"));
  }
});

for (const layout of ["standard", "gmail"]) test(`${layout}: a run an email started sees its thread alone, in any mailbox; \`scope: "mailbox"\` on the agent's tools widens it; a scheduled run sees the whole account`, { timeout: 150_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:30Z");
  const { api } = await serve(t, { faux: FAUX_EMAIL, triggerClock: clock });
  const faux = await account(t, layout);
  thread(faux, archiveOf(layout));
  await saved(api, faux);
  const list = [
    ["email_read", { message_id: "<m1@example.com>" }],
    ["email_read", { message_id: "<m2@faux.example>" }],
    ["email_read", { message_id: "<u1@example.com>" }],
    ["email_search", {}],
    ["email_read", { message_id: "<m3@example.com>", thread: true }],
  ];
  assert.equal((await api("POST", "/agents", mailAgent("narrow"))).status, 201);
  assert.equal((await api("POST", "/agents", mailAgent("wide", { tool_settings: { email_read: { scope: "mailbox" }, email_search: { scope: "mailbox" } } }))).status, 201);
  const narrow = await api("POST", "/triggers", emailTrigger("narrow", { every_s: 60 }, calls(list)));
  const wide = await api("POST", "/triggers", emailTrigger("wide", { every_s: 60 }, calls(list)));
  for (const made of [narrow, wide]) assert.equal(made.status, 201, JSON.stringify(made.body));
  clock.to("2026-06-01T00:01:00Z");
  for (const made of [narrow, wide]) await checked(api, made.body.id, "2026-06-01T00:01:00Z");
  await firings(api, narrow.body.id, 1);
  await firings(api, wide.body.id, 1);
  answer(faux);
  clock.to("2026-06-01T00:02:00Z");

  const sawOfTrigger = async (id) => {
    const [fired] = await firings(api, id, 2);
    assert.equal(fired.status, "started", JSON.stringify(fired));
    await follow(api, fired.run_id, ["completed"], { deadlineMs: 55_000 });
    return sawOf((await api("GET", `/runs/${fired.run_id}`)).body.result?.final_answer);
  };
  const [m1, m2, u1, search, whole] = await sawOfTrigger(narrow.body.id);
  assert.equal(m1.messages[0].message_id, "<m1@example.com>", "in the thread: what it answers");
  assert.equal(m2.messages[0].message_id, "<m2@faux.example>", "in the thread, in Sent");
  assert.match(String(u1), /outside this run's thread/, "a message apart from it is never fetched");
  assert.deepEqual(search.messages.map((m) => m.message_id), ["<m3@example.com>", "<m1@example.com>"], "a search finds the thread's messages alone");
  assert.deepEqual(whole.messages.map((m) => m.message_id), ["<m1@example.com>", "<m2@faux.example>", "<m3@example.com>"]);

  const [, , wideU1, wideSearch] = await sawOfTrigger(wide.body.id);
  assert.equal(wideU1.messages?.[0]?.message_id, "<u1@example.com>", `scope "mailbox" reads the whole account: ${JSON.stringify(wideU1)}`);
  assert.deepEqual(wideSearch.messages.map((m) => m.message_id), ["<m3@example.com>", "<u1@example.com>", "<m1@example.com>"]);

  // A schedule's run: no thread, the whole account.
  const nightly = await api("POST", "/triggers", { name: "nightly", source: { kind: "schedule", every_s: 60, start_at: "2026-06-01T00:00:00Z" }, target: { kind: "start_run", agent_id: "narrow", input: { content: calls([["email_read", { message_id: "<u1@example.com>" }]]) }, max_cost_usd: 0.5 } });
  assert.equal(nightly.status, 201, JSON.stringify(nightly.body));
  clock.to("2026-06-01T00:03:00Z");
  const [scheduled] = await firings(api, nightly.body.id, 1);
  await follow(api, scheduled.run_id, ["completed"], { deadlineMs: 55_000 });
  const [read] = sawOf((await api("GET", `/runs/${scheduled.run_id}`)).body.result?.final_answer);
  assert.equal(read.messages?.[0]?.message_id, "<u1@example.com>", JSON.stringify(read));
});

test("scope is an agent's own setting on email_read and email_search, \"thread\" or \"mailbox\": anywhere else it is refused", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { runner: false });
  const refused = async (body, field) => {
    const res = await api("POST", "/agents", body);
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.ok(res.body.error.fields.some((f) => f.field === field), JSON.stringify(res.body));
  };
  await refused(mailAgent("a", { tool_settings: { email_send: { scope: "mailbox" } } }), "definition.tool_settings.email_send.scope");
  await refused(mailAgent("b", { tool_settings: { email_read: { scope: "everything" } } }), "definition.tool_settings.email_read.scope");
  assert.equal((await api("POST", "/agents", mailAgent("c", { tool_settings: { email_read: { scope: "mailbox" }, email_search: { scope: "thread" } } }))).status, 201);
  const server = await api("PUT", "/settings/tools", { email_read: { scope: "mailbox" } });
  assert.equal(server.status, 422, JSON.stringify(server.body));
});

test("the email tools' defaults: search, read and draft allow; send asks; none is a workflow node's tool", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { runner: false, accounts: true, openSetup: true });
  const { tools } = (await api("GET", "/capabilities")).body;
  const listed = TOOLS.map((name) => tools.find((tool) => tool.name === name));
  assert.deepEqual(listed.map((tool) => [tool?.name, tool?.default_permission, tool?.permission, tool?.nodes]), [["email_search", "allow", "allow", false], ["email_read", "allow", "allow", false], ["email_draft", "allow", "allow", false], ["email_send", "ask", "ask", false]]);
});

test("a tool's error that echoes the password shows it nowhere: the server cuts it from the run's rows, its answer, its title and the runs list", { timeout: 150_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_EMAIL });
  const faux = await mailbox(t);
  await saved(api, faux);
  assert.equal((await api("POST", "/agents", mailAgent("echo"))).status, 201);
  // The model names the password as a mailbox: the tool's error says the name back, whole.
  const started = await api("POST", "/agents/echo/runs", { input: { content: calls([["email_search", { mailbox: faux.password }]]) } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  const rows = JSON.stringify((await api("GET", `/runs/${runId}/timeline?wait_ms=0`)).body);
  const list = JSON.stringify((await api("GET", "/runs")).body);
  assert.match(view.result.final_answer, /^Saw: .*no mailbox named .*\[redacted\]/, "the tool's error reached the model, the password in it cut where it is shown");
  assert.ok(rows.includes("[redacted]"), "the tool's row is cut too");
  for (const [where, text] of [["the run's view", JSON.stringify(view)], ["its timeline", rows], ["the runs list", list]]) assert.ok(!text.includes(faux.password), `${where} shows the password`);
});

test("email_send to a recipient the mail server refuses: the others get it, and the answer names the refused in `rejected` and a note; its copy is still filed; all refused is an error in words", { timeout: 150_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_EMAIL });
  const faux = await mailbox(t);
  await saved(api, faux);
  assert.equal((await api("POST", "/agents", mailAgent("sender", { tool_settings: { email_send: { permission: "allow" } } }))).status, 201);
  const { saw } = await ran(api, "sender", [
    ["email_send", { to: ["ana@example.com", "refuse@faux.example"], subject: "Hello", text: "Hi both." }],
    ["email_send", { to: ["refuse@faux.example"], subject: "Nobody", text: "Hi." }],
  ]);
  const [some, none] = saw;
  assert.equal(some.sent, true, JSON.stringify(some));
  assert.deepEqual(some.rejected, ["refuse@faux.example"], JSON.stringify(some));
  assert.equal(some.note, "not delivered to refuse@faux.example: the mail server refused them");
  assert.deepEqual(faux.sent().map((m) => m.to), [["ana@example.com"]], "delivered to the one it took, and sent once: no retry");
  assert.deepEqual(faux.messages("Sent").map((m) => m.messageId), [some.message_id], "the copy filed in Sent all the same");
  assert.equal(typeof none, "string", `all refused is an error: ${JSON.stringify(none)}`);
  assert.match(none, /^email_send: .*(refused|rejected)/i);
  assert.equal(faux.sent().length, 1, "nothing more sent");
});

test("email_read of a long thread reads the newest 20 at most: the bodies fetched are bounded before any is read, and the answer says truncated, how many more and their ids, oldest first", { timeout: 150_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_EMAIL });
  const faux = await mailbox(t);
  const at = (i) => new Date(Date.parse("2026-05-01T10:00:00Z") + i * 60_000).toISOString();
  const id = (i) => `<t${i}@example.com>`;
  for (let i = 0; i < 60; i++) {
    faux.seed({ from: "ana@example.com", to: [ADDRESS], subject: i ? "Re: Long thread" : "Long thread", text: `Message ${i}.`, date: at(i), messageId: id(i), ...(i ? { inReplyTo: id(i - 1), references: [id(0), id(i - 1)] } : {}) });
  }
  await saved(api, faux);
  assert.equal((await api("POST", "/agents", mailAgent("reader"))).status, 201);
  const before = faux.commands().length;
  const { saw } = await ran(api, "reader", [["email_read", { message_id: id(0), thread: true }]]);
  const [said] = saw;
  assert.deepEqual(said.messages.map((m) => m.message_id), Array.from({ length: 20 }, (_, i) => id(40 + i)), "the newest 20, oldest first");
  assert.equal(said.truncated, true);
  assert.equal(said.more, 40);
  assert.deepEqual(said.omitted, Array.from({ length: 40 }, (_, i) => id(i)), "the ids not read, oldest first, to read one at a time");
  assert.equal(said.note, "40 earlier messages in this thread not read; email_read one by message_id");
  // The bodies fetched: each UID a whole-message fetch (BODY.PEEK[]) named. The thread's 20, and the message it was asked
  // for, looked up first.
  const uidsIn = (set) => set.split(",").flatMap((part) => { const [a, b] = part.split(":").map(Number); return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, k) => a + k); });
  const bodies = faux.commands().slice(before).filter((c) => /FETCH/i.test(c) && /BODY\.PEEK\[\]/i.test(c)).flatMap((c) => uidsIn(/FETCH ([\d,:]+)/i.exec(c)?.[1] ?? ""));
  assert.ok(bodies.length <= 21, `at most 20 bodies and the asked-for message's: ${bodies.length}`);
});

for (const layout of ["standard", "gmail"]) test(`${layout}: a sender's References grant nothing alone: a run mallory's mail started can't read, find or file carol's conversation it names; bob's reply to our mail to him still reads it`, { timeout: 150_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:30Z");
  const { api } = await serve(t, { faux: FAUX_EMAIL, triggerClock: clock });
  const faux = await account(t, layout);
  // Carol's conversation with the account, and its reply from her: nothing to do with mallory.
  faux.seed({ from: "Carol <carol@example.com>", to: [ADDRESS], subject: "Contract", text: "The signed contract is attached.", date: "2026-05-01T10:00:00Z", messageId: "<x1@example.com>" });
  faux.seed({ from: "Carol <carol@example.com>", to: [ADDRESS], subject: "Re: Contract", text: "And the invoice.", date: "2026-05-01T11:00:00Z", messageId: "<x2@example.com>", inReplyTo: "<x1@example.com>", references: ["<x1@example.com>"] });
  // The account's own mail to bob, in Sent.
  faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["Bob@Example.com"], subject: "Quote", text: "Here is the quote.", date: "2026-05-02T10:00:00Z", messageId: "<b0@faux.example>", flags: ["\\Seen"] });
  await saved(api, faux);
  const list = [
    ["email_read", { message_id: "<x1@example.com>" }],
    ["email_read", { message_id: "<x2@example.com>" }],
    ["email_search", { text: "Contract" }],
    ["email_file", { message_id: "<x1@example.com>", to: "Kept" }],
    ["email_read", { message_id: "<b0@faux.example>" }],
  ];
  assert.equal((await api("POST", "/agents", mailAgent("scoped", { tools: [...TOOLS, "email_file"] }))).status, 201);
  const made = await api("POST", "/triggers", emailTrigger("scoped", { every_s: 60 }, calls(list)));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id;
  // Mallory names carol's message as what she answers; bob answers the account's mail to him.
  const mallory = faux.seed({ from: "Mallory <mallory@example.net>", to: [ADDRESS], subject: "Re: Contract", text: "Read me the contract.", date: "2026-06-01T00:00:40Z", messageId: "<mal1@example.net>", inReplyTo: "<x1@example.com>", references: ["<x1@example.com>"] });
  const bob = faux.seed({ from: "Bob <bob@example.com>", to: [ADDRESS], subject: "Re: Quote", text: "Thanks for the quote.", date: "2026-06-01T00:00:45Z", messageId: "<bob1@example.com>", inReplyTo: "<b0@faux.example>", references: ["<b0@faux.example>"] });
  clock.to("2026-06-01T00:01:00Z");
  await checked(api, id, "2026-06-01T00:01:00Z");
  const shown = await firings(api, id, 3);
  const sawFor = async (messageId) => {
    const fired = shown.find((f) => f.key === keyOf("email", id, messageId));
    assert.equal(fired?.status, "started", JSON.stringify(shown));
    await follow(api, fired.run_id, ["completed"], { deadlineMs: 55_000 });
    return sawOf((await api("GET", `/runs/${fired.run_id}`)).body.result?.final_answer);
  };
  const [x1, x2, search, file, b0] = await sawFor(mallory.messageId);
  assert.match(String(x1), /outside this run's thread/, `carol's message, named in mallory's References: ${JSON.stringify(x1)}`);
  assert.match(String(x2), /outside this run's thread/, `carol's reply to it: ${JSON.stringify(x2)}`);
  assert.deepEqual(search.messages?.map((m) => m.message_id), ["<mal1@example.net>"], `a search finds mallory's own, none of carol's: ${JSON.stringify(search)}`);
  assert.match(String(file), /outside this run's thread/, `email_file of carol's message: ${JSON.stringify(file)}`);
  assert.match(String(b0), /outside this run's thread/, "the account's mail to bob is not mallory's");
  assert.deepEqual(faux.messages("INBOX").find((m) => m.messageId === "<x1@example.com>")?.labels ?? [], layout === "gmail" ? ["\\Inbox"] : [], "carol's message filed nowhere");
  assert.ok(!faux.mailboxes().includes("Kept"), "no folder made for it");

  const [, , , , bobB0] = await sawFor(bob.messageId);
  assert.equal(bobB0.messages?.[0]?.message_id, "<b0@faux.example>", `bob's reply reads the account's mail to him (addresses compared without case): ${JSON.stringify(bobB0)}`);
});

test("on a thread run, email_search's limit counts only what the sender may read: a newer linked message between others never takes the slot of an older one of theirs", { timeout: 150_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:30Z");
  const { api } = await serve(t, { faux: FAUX_EMAIL, triggerClock: clock });
  const faux = await mailbox(t);
  // In Archive: alice's first message, then a newer one linked to it that only bob and carol are on.
  faux.seed({ mailbox: "Archive", from: "Alice <alice@example.com>", to: [ADDRESS], subject: "Budget", text: "The budget draft.", date: "2026-05-01T10:00:00Z", messageId: "<al1@example.com>" });
  faux.seed({ mailbox: "Archive", from: "Bob <bob@example.com>", to: ["carol@example.com"], subject: "Re: Budget", text: "Between us two.", date: "2026-05-02T10:00:00Z", messageId: "<bc1@example.com>", inReplyTo: "<al1@example.com>", references: ["<al1@example.com>"] });
  await saved(api, faux);
  assert.equal((await api("POST", "/agents", mailAgent("limited"))).status, 201);
  const made = await api("POST", "/triggers", emailTrigger("limited", { every_s: 60 }, calls([["email_search", { subject: "Budget", mailbox: "Archive", limit: 1 }]])));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const alice = faux.seed({ from: "Alice <alice@example.com>", to: [ADDRESS], subject: "Re: Budget", text: "Any news?", date: "2026-06-01T00:00:40Z", messageId: "<al2@example.com>", inReplyTo: "<al1@example.com>", references: ["<al1@example.com>"] });
  clock.to("2026-06-01T00:01:00Z");
  await checked(api, made.body.id, "2026-06-01T00:01:00Z");
  const fired = (await firings(api, made.body.id, 2)).find((f) => f.key === keyOf("email", made.body.id, alice.messageId));
  assert.equal(fired?.status, "started");
  await follow(api, fired.run_id, ["completed"], { deadlineMs: 55_000 });
  const [search] = sawOf((await api("GET", `/runs/${fired.run_id}`)).body.result?.final_answer);
  assert.deepEqual(search.messages?.map((m) => m.message_id), ["<al1@example.com>"], `limit 1 finds alice's own message, not nothing: ${JSON.stringify(search)}`);
});

/** A thread run of agent `id` (`tools`) with `list` as its calls, started by message `trigger` seeded once the trigger is
 *  made, to its end: what its calls were answered. */
async function threadRun({ api, clock }, faux, id, list, trigger, tools = TOOLS) {
  assert.equal((await api("POST", "/agents", mailAgent(id, { tools }))).status, 201);
  const made = await api("POST", "/triggers", emailTrigger(id, { every_s: 60 }, calls(list)));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = faux.seed({ date: "2026-06-01T00:00:40Z", ...trigger });
  clock.to("2026-06-01T00:01:00Z");
  await checked(api, made.body.id, "2026-06-01T00:01:00Z");
  const fired = (await firings(api, made.body.id, 2)).find((f) => f.key === keyOf("email", made.body.id, started.messageId));
  assert.equal(fired?.status, "started");
  await follow(api, fired.run_id, ["completed"], { deadlineMs: 55_000 });
  return sawOf((await api("GET", `/runs/${fired.run_id}`)).body.result?.final_answer);
}
/** The server with a fake trigger clock. */
async function served(t) {
  const clock = fakeClock("2026-06-01T00:00:30Z");
  const { api } = await serve(t, { faux: FAUX_EMAIL, triggerClock: clock });
  return { api, clock };
}
/** Ana's answer to our reply, the message that starts the run: m3 of thread(). */
const ANSWER = { from: "Ana Díaz <ana@example.com>", to: [ADDRESS], subject: "Re: Plan", text: "Tuesday works.", messageId: "<m3@example.com>", inReplyTo: "<m2@faux.example>", references: ["<m1@example.com>", "<m2@faux.example>"] };

test("on Gmail, which searches by In-Reply-To for minutes on a large mailbox: a thread run's search, thread read and file all answer, and no search by In-Reply-To is ever sent", { timeout: 150_000 }, async (t) => {
  const server = await served(t);
  const faux = await account(t, "gmail");
  thread(faux, archiveOf("gmail"));
  await saved(server.api, faux);
  const [search, whole, file] = await threadRun(server, faux, "gmailer", [
    ["email_search", {}],
    ["email_read", { message_id: "<m3@example.com>", thread: true }],
    ["email_file", { message_id: "<m3@example.com>", to: "Handled" }],
  ], ANSWER, [...TOOLS, "email_file"]);
  assert.deepEqual(search.messages?.map((m) => m.message_id), ["<m3@example.com>", "<m1@example.com>"], `search: ${JSON.stringify(search)}`);
  assert.deepEqual(whole.messages?.map((m) => m.message_id), ["<m1@example.com>", "<m2@faux.example>", "<m3@example.com>"], `thread read: ${JSON.stringify(whole)}`);
  assert.equal(file?.filed, true, `file: ${JSON.stringify(file)}`);
  assert.deepEqual(faux.messages("INBOX").find((m) => m.messageId === "<m3@example.com>")?.labels, ["\\Inbox", "Handled"]);
  assert.deepEqual(faux.commands().filter((c) => /HEADER\s+"?In-Reply-To/i.test(c)), [], "no search by In-Reply-To");
});

test("elsewhere a thread is still found by In-Reply-To too: our reply that names ana's message by In-Reply-To alone is in her thread", { timeout: 150_000 }, async (t) => {
  const server = await served(t);
  const faux = await mailbox(t);
  faux.seed({ from: "Ana Díaz <ana@example.com>", to: [ADDRESS], subject: "Plan", text: "Shall we plan the launch?", date: "2026-05-01T10:00:00Z", messageId: "<m1@example.com>" });
  faux.seed({ mailbox: "Sent", from: ADDRESS, to: ["ana@example.com"], subject: "Re: Plan", text: "Yes, Tuesday.", date: "2026-05-01T11:00:00Z", messageId: "<m2@faux.example>", inReplyTo: "<m1@example.com>", flags: ["\\Seen"] });
  await saved(server.api, faux);
  const [whole] = await threadRun(server, faux, "linked", [["email_read", { message_id: "<m3@example.com>", thread: true }]], { ...ANSWER, inReplyTo: "<m1@example.com>", references: ["<m1@example.com>"] });
  assert.deepEqual(whole.messages?.map((m) => m.message_id), ["<m1@example.com>", "<m2@faux.example>", "<m3@example.com>"], JSON.stringify(whole));
  assert.ok(faux.commands().some((c) => /HEADER\s+"?In-Reply-To/i.test(c)), "searched by In-Reply-To");
});

test("elsewhere, a search the mail server takes too long to answer says so, not that the server couldn't be reached", { timeout: 150_000 }, async (t) => {
  const server = await served(t);
  const faux = await slowSearch(t);
  thread(faux);
  await saved(server.api, faux);
  const [search] = await threadRun(server, faux, "patient", [["email_search", {}]], ANSWER);
  assert.match(String(search), /took too long to search/, JSON.stringify(search));
  assert.doesNotMatch(String(search), /Couldn't reach/);
});
