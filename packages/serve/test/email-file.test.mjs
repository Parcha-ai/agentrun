// email_file (email/tools.ts) in pi runs, against the fake mail account: it files a message under `to` and never deletes
// one. On Gmail (X-GM-EXT-1) it adds the label `to`, creating it first if missing, and the message stays in the inbox
// (no archive, or archive: false); `archive: true` also takes its \Inbox label off. Elsewhere (a folders server) filing is
// a move: with no archive, one call files the message and moves it out of the inbox to the folder `to` (UID MOVE),
// creating it if missing, as archive: true does; only an explicit `archive: false` is refused in words, nothing moved;
// the account holds as many messages, and the answer's note says "moved out of the inbox to <to>". Its description,
// built for the server it is bound on, says which in one line. The trash and junk folders are refused, by special use or
// by name, with nothing changed. It is allowed by default, scoped to a run's thread as email_read and email_search are
// (`scope: "mailbox"` widens it). Its answer is {filed, message_id, to, archived, subject, note?} (the note on a move
// only), and its timeline line, read from that answer, says "Filed <subject> under <to>".
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";
import { fakeClock, firings } from "./trigger-support.mjs";
import { ADDRESS, checked, emailTrigger, FAUX_EMAIL, mailbox, saved, sawOf } from "./email-support.mjs";

const TOOLS = ["email_search", "email_read", "email_draft", "email_send", "email_file"];
const calls = (list) => `Email calls: ${JSON.stringify(list)}`;
const mailAgent = (id, extra = {}) => agent(id, { harness: "pi", tools: TOOLS, ...extra });
const FOLDERS = "this server has folders: filing moves the message out of the inbox; pass archive: true to move it";
const REFUSED = (to) => `email_file files mail, it never deletes it: ${to} is the trash or junk folder.`;

/** A run of agent `id` with `list` as its calls, to its end with no stop for a person: the answers, parsed, and its rows. */
async function ran(api, id, list) {
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: calls(list) } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const rows = (await api("GET", `/runs/${started.body.run_id}/timeline?wait_ms=0`)).body;
  return { saw: sawOf(view.result?.final_answer), rows: rows.rows ?? [] };
}

/** Each mailbox's messages by Message-ID, and the total: what a filing may move and never lose. */
const holding = (faux) => {
  const by = Object.fromEntries(faux.mailboxes().map((box) => [box, faux.messages(box).map((m) => m.messageId)]));
  return { by, total: Object.values(by).reduce((n, ids) => n + ids.length, 0) };
};
const resultSummaries = (rows) => rows.filter((r) => r.kind === "tool_result" && r.tool_name === "email_file").map((r) => r.summary);

test("on Gmail: email_file adds the label, creating it if missing, and the message stays in the inbox; archive takes \\Inbox off; the timeline says Filed", { timeout: 150_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_EMAIL });
  const faux = await mailbox(t, { layout: "gmail" });
  faux.seed({ from: "ana@example.com", to: [ADDRESS], subject: "Invoice 7", text: "Pay me.", messageId: "<f1@example.com>" });
  faux.seed({ from: "news@example.com", to: [ADDRESS], subject: "Newsletter", text: "News.", messageId: "<f2@example.com>" });
  await saved(api, faux, { preset: "gmail" });
  assert.equal((await api("POST", "/agents", mailAgent("filer"))).status, 201);
  assert.ok(!faux.mailboxes().includes("Receipts"));

  const { saw, rows } = await ran(api, "filer", [
    ["email_file", { message_id: "<f1@example.com>", to: "Receipts" }],
    ["email_file", { message_id: "<f2@example.com>", to: "Receipts", archive: true }],
  ]);
  const [kept, archived] = saw;
  // A label, not a move: no note on Gmail (deepEqual: no field beyond these).
  assert.deepEqual(kept, { filed: true, message_id: "<f1@example.com>", to: "Receipts", archived: false, subject: "Invoice 7" });
  assert.deepEqual(archived, { filed: true, message_id: "<f2@example.com>", to: "Receipts", archived: true, subject: "Newsletter" });
  assert.ok(faux.mailboxes().includes("Receipts"), `the missing label was created: ${faux.mailboxes()}`);
  assert.deepEqual(faux.messages().map((m) => [m.messageId, [...m.labels].sort()]), [["<f1@example.com>", ["Receipts", "\\Inbox"].sort()]], "labelled, still in the inbox");
  assert.deepEqual(faux.messages("[Gmail]/All Mail").map((m) => [m.messageId, m.labels]), [["<f2@example.com>", ["Receipts"]]], "archived: out of the inbox, its label kept");
  assert.ok(faux.commands().some((c) => /^UID STORE \d+ \+X-GM-LABELS/i.test(c)), faux.commands().join("\n"));
  assert.ok(!faux.commands().some((c) => /\bMOVE\b|\bEXPUNGE\b|\\Deleted/i.test(c)), "a label, never a move or a delete");

  const [first, second] = resultSummaries(rows);
  assert.match(first ?? "", /^Filed Invoice 7 under Receipts(: |$)/, JSON.stringify(resultSummaries(rows)));
  assert.match(second ?? "", /^Filed Newsletter under Receipts, out of the inbox(: |$)/, JSON.stringify(resultSummaries(rows)));
});

test("elsewhere (folders): with no archive one call files and moves the message out of the inbox, creating the folder if missing, as archive: true does; an explicit archive: false is refused and nothing moves; the account holds as many messages", { timeout: 150_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_EMAIL });
  const faux = await mailbox(t);
  faux.seed({ from: "ana@example.com", to: [ADDRESS], subject: "Invoice 7", messageId: "<f1@example.com>" });
  faux.seed({ from: "bo@example.com", to: [ADDRESS], subject: "Old thread", messageId: "<f2@example.com>" });
  faux.seed({ from: "cy@example.com", to: [ADDRESS], subject: "Stays", messageId: "<f3@example.com>" });
  await saved(api, faux);
  assert.equal((await api("POST", "/agents", mailAgent("mover"))).status, 201);
  const before = holding(faux);

  // An explicit archive: false never takes mail out of INBOX: on a folders server, filing is a move, so it is refused.
  const refused = await ran(api, "mover", [["email_file", { message_id: "<f2@example.com>", to: "Archive", archive: false }]]);
  assert.equal(refused.saw.length, 1, JSON.stringify(refused.saw));
  for (const said of refused.saw) assert.match(String(said), new RegExp(FOLDERS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), JSON.stringify(said));
  assert.deepEqual(holding(faux), before, "nothing moved, no folder made");
  assert.ok(!faux.commands().some((c) => /^(UID )?(MOVE|STORE|COPY|EXPUNGE)\b|^CREATE\b/i.test(c)), faux.commands().join("\n"));

  // No archive: filed and moved out of the inbox in one call. archive: true, the same.
  const { saw, rows } = await ran(api, "mover", [
    ["email_file", { message_id: "<f1@example.com>", to: "Receipts" }],
    ["email_file", { message_id: "<f2@example.com>", to: "Archive", archive: true }],
  ]);
  assert.deepEqual(saw, [
    { filed: true, message_id: "<f1@example.com>", to: "Receipts", archived: true, subject: "Invoice 7", note: "moved out of the inbox to Receipts" },
    { filed: true, message_id: "<f2@example.com>", to: "Archive", archived: true, subject: "Old thread", note: "moved out of the inbox to Archive" },
  ], "the answer says the move: the model reads the answer, not the timeline");
  const after = holding(faux);
  assert.equal(after.total, before.total, "nothing deleted: as many messages as before");
  assert.deepEqual(after.by.INBOX, ["<f3@example.com>"]);
  assert.deepEqual(after.by.Receipts, ["<f1@example.com>"], "the folder created, the message in it");
  assert.deepEqual(after.by.Archive, ["<f2@example.com>"]);
  assert.ok(faux.commands().some((c) => /^CREATE "?Receipts"?$/i.test(c)), faux.commands().join("\n"));
  assert.ok(!faux.commands().some((c) => /^CREATE "?Archive"?$/i.test(c)), "a folder that is there is not created again");
  assert.ok(faux.commands().some((c) => /^UID MOVE \d+ "?Receipts"?$/i.test(c)), faux.commands().join("\n"));
  assert.match(resultSummaries(rows)[0] ?? "", /^Filed Invoice 7 under Receipts, out of the inbox(: |$)/, JSON.stringify(resultSummaries(rows)));
});

/** The one line email_file's description says for the server it is bound on. */
const FOLDERS_LINE = "On this server filing moves the message out of the inbox into the folder.";
const GMAIL_LINE = "On Gmail filing adds a label and keeps the message in the inbox; archive: true also removes it from the inbox.";

test("email_file's description says in one line what filing does on the connected server: a move out of the inbox on folders, a label that keeps it in the inbox on Gmail", { timeout: 150_000 }, async (t) => {
  for (const [layout, extra, line, other] of [["standard", {}, FOLDERS_LINE, GMAIL_LINE], ["gmail", { preset: "gmail" }, GMAIL_LINE, FOLDERS_LINE]]) {
    const { api } = await serve(t, { faux: FAUX_EMAIL });
    const faux = await mailbox(t, { layout });
    await saved(api, faux, extra);
    assert.equal((await api("POST", "/agents", mailAgent("describer"))).status, 201);
    const started = await api("POST", "/agents/describer/runs", { input: { content: "Describe: email_file" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed"], { deadlineMs: 55_000 });
    const said = (await api("GET", `/runs/${started.body.run_id}`)).body.result?.final_answer ?? "";
    const description = JSON.parse(/^Described: (.*)$/m.exec(said)?.[1] ?? "null");
    assert.equal(typeof description, "string", `${layout}: the model was handed email_file's description: ${said}`);
    assert.ok(description.includes(line), `${layout}: ${JSON.stringify(description)}`);
    assert.ok(!description.includes(other), `${layout}: not the other server's line: ${JSON.stringify(description)}`);
    assert.ok(description.includes("Answers JSON {filed: true, message_id, to, archived, subject, note?}"), `${layout}: the answer's note is named: ${JSON.stringify(description)}`);
  }
});

test("the trash and junk folders are refused, by name or special use, and nothing changes", { timeout: 150_000 }, async (t) => {
  for (const [layout, targets] of [["standard", ["Trash", "\\Trash", "Junk", "Spam", "trash"]], ["gmail", ["[Gmail]/Trash", "[Gmail]/Spam", "\\Junk", "Trash"]]]) {
    const { api } = await serve(t, { faux: FAUX_EMAIL });
    const faux = await mailbox(t, { layout });
    faux.seed({ from: "ana@example.com", to: [ADDRESS], subject: "Keep me", messageId: "<k1@example.com>" });
    await saved(api, faux, layout === "gmail" ? { preset: "gmail" } : {});
    assert.equal((await api("POST", "/agents", mailAgent("binner"))).status, 201);
    const before = holding(faux);
    const labels = faux.messages().map((m) => m.labels);
    const { saw } = await ran(api, "binner", targets.map((to) => ["email_file", { message_id: "<k1@example.com>", to }]));
    targets.forEach((to, i) => assert.match(String(saw[i]), new RegExp(REFUSED(to).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${layout} ${to}: ${JSON.stringify(saw[i])}`));
    assert.deepEqual(holding(faux), before, `${layout}: nothing moved, nothing created`);
    assert.deepEqual(faux.messages().map((m) => m.labels), labels, `${layout}: no label changed`);
    assert.ok(!faux.commands().some((c) => /^(UID )?(MOVE|STORE|COPY|EXPUNGE)\b|^CREATE\b/i.test(c)), `${layout}: ${faux.commands().join("\n")}`);
  }
});

const KEPT = (to) => `email_file never files into Sent or Drafts: ${to} is the account's sent or drafts mail, which only email_send and email_draft write.`;

test("the Sent and Drafts folders are refused, by name or special use, and nothing changes: a filing can't make mail look sent", { timeout: 150_000 }, async (t) => {
  for (const [layout, targets] of [["standard", ["Sent", "Drafts", "sent", "\\Sent", "\\Drafts"]], ["gmail", ["[Gmail]/Sent Mail", "[Gmail]/Drafts", "\\Sent", "\\Draft", "Sent", "Drafts"]]]) {
    const { api } = await serve(t, { faux: FAUX_EMAIL });
    const faux = await mailbox(t, { layout });
    faux.seed({ from: "ana@example.com", to: [ADDRESS, "eve@example.com"], subject: "Keep me", messageId: "<s1@example.com>" });
    faux.seed({ mailbox: "Drafts", from: ADDRESS, to: ["eve@example.com"], subject: "Draft", messageId: "<s2@example.com>", flags: ["\\Draft", "\\Seen"] });
    await saved(api, faux, layout === "gmail" ? { preset: "gmail" } : {});
    assert.equal((await api("POST", "/agents", mailAgent("keeper"))).status, 201);
    const before = holding(faux);
    const labels = faux.messages().map((m) => m.labels);
    const list = targets.flatMap((to) => [["email_file", { message_id: "<s1@example.com>", to }], ["email_file", { message_id: "<s2@example.com>", to }]]);
    const { saw } = await ran(api, "keeper", list);
    list.forEach(([, args], i) => assert.match(String(saw[i]), new RegExp(KEPT(args.to).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${layout} ${args.message_id} to ${args.to}: ${JSON.stringify(saw[i])}`));
    assert.deepEqual(holding(faux), before, `${layout}: nothing moved, nothing created`);
    assert.deepEqual(faux.messages().map((m) => m.labels), labels, `${layout}: no label changed`);
    assert.ok(!faux.commands().some((c) => /^(UID )?(MOVE|STORE|COPY|EXPUNGE)\b|^CREATE\b/i.test(c)), `${layout}: ${faux.commands().join("\n")}`);
  }
});

test("a run an email started files only within its thread; `scope: \"mailbox\"` on email_file widens it", { timeout: 150_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:30Z");
  const { api } = await serve(t, { faux: FAUX_EMAIL, triggerClock: clock });
  const faux = await mailbox(t);
  faux.seed({ from: "Ana <ana@example.com>", to: [ADDRESS], subject: "Plan", text: "Plan?", date: "2026-05-01T10:00:00Z", messageId: "<m1@example.com>" });
  faux.seed({ from: "Cy <cy@example.com>", to: [ADDRESS], subject: "Lunch", text: "Lunch?", date: "2026-05-01T12:00:00Z", messageId: "<u1@example.com>" });
  await saved(api, faux);
  const list = [["email_file", { message_id: "<u1@example.com>", to: "Elsewhere", archive: true }], ["email_file", { message_id: "<m1@example.com>", to: "Plans", archive: true }]];
  assert.equal((await api("POST", "/agents", mailAgent("narrow"))).status, 201);
  const wide = await api("POST", "/agents", mailAgent("wide", { tool_settings: { email_file: { scope: "mailbox" } } }));
  assert.equal(wide.status, 201, `scope is email_file's own setting too: ${JSON.stringify(wide.body)}`);
  const narrowT = await api("POST", "/triggers", emailTrigger("narrow", { every_s: 60 }, calls(list)));
  assert.equal(narrowT.status, 201, JSON.stringify(narrowT.body));
  clock.to("2026-06-01T00:01:00Z");
  await checked(api, narrowT.body.id, "2026-06-01T00:01:00Z");
  faux.seed({ from: "Ana <ana@example.com>", to: [ADDRESS], subject: "Re: Plan", text: "Tuesday.", date: "2026-05-01T13:00:00Z", messageId: "<m3@example.com>", inReplyTo: "<m1@example.com>", references: ["<m1@example.com>"] });
  clock.to("2026-06-01T00:02:00Z");
  const fired = (await firings(api, narrowT.body.id, 2)).find((f) => f.status === "started");
  assert.ok(fired, "the reply started a run");
  await follow(api, fired.run_id, ["completed"], { deadlineMs: 55_000 });
  const [apart, inThread] = sawOf((await api("GET", `/runs/${fired.run_id}`)).body.result?.final_answer);
  assert.match(String(apart), /outside this run's thread/, JSON.stringify(apart));
  assert.deepEqual(inThread, { filed: true, message_id: "<m1@example.com>", to: "Plans", archived: true, subject: "Plan", note: "moved out of the inbox to Plans" });
  assert.deepEqual(faux.messages("INBOX").map((m) => m.messageId).sort(), ["<m3@example.com>", "<u1@example.com>"].sort(), "the message apart from the thread was not touched");
  assert.ok(!faux.mailboxes().includes("Elsewhere"), "nor its folder made");

  const { saw } = await ran(api, "wide", [["email_file", { message_id: "<u1@example.com>", to: "Elsewhere", archive: true }]]);
  assert.deepEqual(saw, [{ filed: true, message_id: "<u1@example.com>", to: "Elsewhere", archived: true, subject: "Lunch", note: "moved out of the inbox to Elsewhere" }], "a run with no thread files across the account");
  // The wide agent's own scope, read in a run a trigger started, is tried by the tool plane's check (tool-plane.ts), as
  // email_read's is: accepted above.
});

test("email_file's default is allow, as read and search are; it is no workflow node's tool", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { runner: false, accounts: true, openSetup: true });
  const { tools } = (await api("GET", "/capabilities")).body;
  const file = tools.find((tool) => tool.name === "email_file");
  assert.deepEqual([file?.name, file?.default_permission, file?.permission, file?.nodes], ["email_file", "allow", "allow", false], JSON.stringify(file));
});
