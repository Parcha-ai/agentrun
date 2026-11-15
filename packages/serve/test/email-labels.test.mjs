// The five email tools on the timeline, in a person's words (email/labels.ts): what was searched, read, drafted, sent or
// filed. A call's line reads its arguments while it runs ("Read an email", "Filed an email under Receipts") and its
// answer once that is in ("Read Plan", "Filed Invoice 7 under Receipts, out of the inbox"), as browser_read's does, so
// the call's row and its result's row both say it in one line. Addresses: the first, then " and N more"; cc is left
// out. Subjects are cut at 60 characters and a search's words at 40, their URLs scrubbed, as web_search's query is. No
// body text ever shows: neither a message's text (seeded, read, drafted or sent) nor a snippet is in any label or outcome.
// A search's `text` is the agent's own query, not mail, and shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldLabel, labelOf, nameOf } from "../dist/timeline/index.js";
import { outcomeOf } from "../dist/timeline/labels.js";
// The server's own tools' lines, registered as the run view loads (run-view.ts), as they are wherever rows are made.
import "../dist/run-view.js";
import { agent, follow, serve } from "./support.mjs";
import { ADDRESS, FAUX_EMAIL, mailbox, saved } from "./email-support.mjs";

const BODY = "zebra-quokka-7731 the body nobody may see";
const view = (answer, isError = false) => ({ text: typeof answer === "string" ? answer : JSON.stringify(answer), details: undefined, isError });
const TOOLS = ["email_search", "email_read", "email_draft", "email_send", "email_file"];

test("email_search: the query from the arguments set, its words quoted and cut at 40, ' in <mailbox>' past INBOX; many fold to a count", () => {
  assert.equal(labelOf("email_search", { text: "quarterly report", from: "alice@x.example", unread: true }), 'Searched mail for "quarterly report" from:alice@x.example unread');
  assert.equal(labelOf("email_search", { from: "alice@x.example", subject: "invoice", unread: true }), 'Searched mail for from:alice@x.example subject:"invoice" unread');
  assert.equal(labelOf("email_search", { to: "bo@example.com", since: "2026-05-01", unread: false, mailbox: "Archive" }), "Searched mail for to:bo@example.com since:2026-05-01 read in Archive");
  assert.equal(labelOf("email_search", { from: "alice@x.example", mailbox: "INBOX" }), "Searched mail for from:alice@x.example");
  assert.equal(labelOf("email_search", { mailbox: "Archive" }), "Searched mail in Archive");
  assert.equal(labelOf("email_search", {}), "Searched mail");
  assert.equal(labelOf("email_search", { text: `${"word ".repeat(20)}https://shop.example/r?token=fake-test-key` }), `Searched mail for "${"word ".repeat(20).slice(0, 37)}..."`, "its words cut at 40");
  assert.equal(labelOf("email_search", { text: "see https://shop.example/r?token=fake-test-key" }), 'Searched mail for "see https://shop.example/r?token=\u2026"', "a URL in its words scrubbed");
  assert.equal(labelOf("email_search", { from: "alice@x.example" }, view({ messages: [{ message_id: "<m1@example.com>", subject: "Plan", snippet: BODY }] })), "Searched mail for from:alice@x.example", "its answer changes nothing");
  assert.equal(foldLabel("email_search", [1, 2, 3].map(() => ({ input: null, output: null }))), "Searched mail 3 times");
  assert.equal(nameOf("email_search"), "Search mail");
});

test("email_read: 'Read an email' (or 'an email thread') while it runs, then the subject of the message it named", () => {
  const one = { messages: [{ message_id: "<m1@example.com>", subject: "Plan", from: "ana@example.com", text: BODY }] };
  const thread = { messages: [{ message_id: "<m1@example.com>", subject: "Plan", text: BODY }, { message_id: "<m3@example.com>", subject: "Re: Plan", text: BODY }] };
  assert.equal(labelOf("email_read", { message_id: "<m1@example.com>" }), "Read an email");
  assert.equal(labelOf("email_read", { message_id: "<m1@example.com>", thread: true }), "Read an email thread");
  assert.equal(labelOf("email_read", { message_id: "<m1@example.com>" }, view(one)), "Read Plan");
  assert.equal(labelOf("email_read", { message_id: "<m3@example.com>", thread: true }, view(thread)), "Read the thread Re: Plan", "the message it named, not the thread's first");
  assert.equal(labelOf("email_read", { message_id: "<m1@example.com>" }, view("email_read: No message <m1@example.com> in this account.", true)), "Read an email", "an error names no subject");
  assert.equal(nameOf("email_read"), "Read mail");
});

test("email_draft and email_send: a reply or an email, to the first address and how many more, with the subject; cc left out", () => {
  const many = ["ana@example.com", "bo@example.com", "cy@example.com"];
  assert.equal(labelOf("email_draft", { to: many, cc: ["dee@example.com"], subject: "Plan", text: BODY, in_reply_to: "<m1@example.com>" }), "Drafted a reply to ana@example.com and 2 more: Plan");
  assert.equal(labelOf("email_draft", { to: ["ana@example.com"], subject: "Plan", text: BODY }), "Drafted an email to ana@example.com: Plan");
  assert.equal(labelOf("email_send", { to: ["ana@example.com", "bo@example.com"], subject: "Re: Plan", text: BODY, in_reply_to: "<m1@example.com>" }), "Sent a reply to ana@example.com and 1 more: Re: Plan");
  assert.equal(labelOf("email_send", { to: ["ana@example.com"], cc: ["bo@example.com"], subject: "Hello", text: BODY }), "Sent an email to ana@example.com: Hello");
  const refused = { sent: true, message_id: "<s2@faux.example>", rejected: ["refuse@faux.example", "x@faux.example"], note: "not delivered to refuse@faux.example, x@faux.example: the mail server refused them" };
  assert.equal(labelOf("email_send", { to: ["ana@example.com"], subject: "Hello", text: BODY }, view(refused)), "Sent an email to ana@example.com: Hello (refused: 2)", "the refused counted from the answer");
  assert.equal(labelOf("email_send", { to: ["ana@example.com"], subject: "Hello", text: BODY }, view({ sent: true, message_id: "<s3@faux.example>" })), "Sent an email to ana@example.com: Hello");
  assert.equal(nameOf("email_draft"), "Draft mail");
  assert.equal(nameOf("email_send"), "Send mail");
});

test("email_file: 'Filed an email under <to>' while it runs, then its answer's subject, and ', out of the inbox' when it left it", () => {
  const args = { message_id: "<f1@example.com>", to: "Receipts", archive: true };
  assert.equal(labelOf("email_file", args), "Filed an email under Receipts");
  assert.equal(labelOf("email_file", args, view({ filed: true, message_id: "<f1@example.com>", to: "Receipts", archived: true, subject: "Invoice 7" })), "Filed Invoice 7 under Receipts, out of the inbox");
  assert.equal(labelOf("email_file", { ...args, archive: false }, view({ filed: true, message_id: "<f1@example.com>", to: "Receipts", archived: false, subject: "Invoice 7" })), "Filed Invoice 7 under Receipts");
  assert.equal(labelOf("email_file", args, view("this server has folders: filing moves the message out of the inbox; pass archive: true to move it", true)), "Filed an email under Receipts");
  assert.equal(nameOf("email_file"), "File mail");
});

test("a subject is cut at 60 characters and its URLs scrubbed, on every email tool's line", () => {
  const long = `Your receipt https://shop.example/r?token=fake-test-key ${"x".repeat(80)}`;
  const said = [
    labelOf("email_read", { message_id: "<m1@example.com>" }, view({ messages: [{ message_id: "<m1@example.com>", subject: long }] })),
    labelOf("email_draft", { to: ["ana@example.com"], subject: long, text: "t" }),
    labelOf("email_send", { to: ["ana@example.com"], subject: long, text: "t" }),
    labelOf("email_file", { message_id: "<m1@example.com>", to: "Receipts" }, view({ filed: true, message_id: "<m1@example.com>", to: "Receipts", archived: false, subject: long })),
    labelOf("email_search", { subject: long }),
  ];
  for (const line of said) {
    assert.ok(!line.includes("fake-test-key"), line);
    assert.ok(line.includes("https://shop.example/r?token=…"), line);
    assert.ok(!line.includes("x".repeat(60)), `cut at 60: ${line}`);
  }
});

test("no body text in any email tool's label or outcome, before or after its answer", () => {
  const answers = {
    email_search: { messages: [{ message_id: "<m1@example.com>", from: "ana@example.com", subject: "Plan", snippet: BODY }] },
    email_read: { messages: [{ message_id: "<m1@example.com>", subject: "Plan", text: BODY }] },
    email_draft: { saved: true, mailbox: "Drafts", message_id: "<d1@faux.example>" },
    email_send: { sent: true, message_id: "<s1@faux.example>" },
    email_file: { filed: true, message_id: "<m1@example.com>", to: "Receipts", archived: false, subject: "Plan" },
  };
  const args = {
    email_search: { from: "ana@example.com", text: "launch plan" },
    email_read: { message_id: "<m1@example.com>", thread: true },
    email_draft: { to: ["ana@example.com"], subject: "Plan", text: BODY },
    email_send: { to: ["ana@example.com"], subject: "Plan", text: BODY, in_reply_to: "<m1@example.com>" },
    email_file: { message_id: "<m1@example.com>", to: "Receipts" },
  };
  for (const tool of TOOLS) {
    const said = [labelOf(tool, args[tool]), labelOf(tool, args[tool], view(answers[tool])), outcomeOf(tool, view(answers[tool]))?.text ?? ""];
    for (const line of said) assert.ok(!line.includes("zebra-quokka"), `${tool}: ${line}`);
    assert.ok(!said[0].startsWith("Using tool"), `${tool} has a label: ${said[0]}`);
  }
});

test("a run's timeline says each email call in one line, its call row and its result row alike, and shows no body text", { timeout: 150_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_EMAIL });
  const faux = await mailbox(t, { layout: "gmail" });
  faux.seed({ from: "Ana <ana@example.com>", to: [ADDRESS], subject: "Plan", text: BODY, date: "2026-05-01T10:00:00Z", messageId: "<m1@example.com>" });
  faux.seed({ from: "Shop <shop@example.com>", to: [ADDRESS], subject: "Invoice 7", text: BODY, date: "2026-05-01T11:00:00Z", messageId: "<f1@example.com>" });
  await saved(api, faux, { preset: "gmail" });
  const created = await api("POST", "/agents", agent("mailer", { harness: "pi", tools: TOOLS, tool_settings: { email_send: { permission: "allow" } } }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const list = [
    ["email_search", { from: "ana@example.com", text: "launch plan" }],
    ["email_read", { message_id: "<m1@example.com>" }],
    ["email_draft", { to: ["ana@example.com"], subject: "Re: Plan", text: BODY, in_reply_to: "<m1@example.com>" }],
    ["email_send", { to: ["ana@example.com", "bo@example.com"], cc: ["cy@example.com"], subject: "Re: Plan", text: BODY, in_reply_to: "<m1@example.com>" }],
    ["email_file", { message_id: "<f1@example.com>", to: "Receipts", archive: true }],
  ];
  const started = await api("POST", "/agents/mailer/runs", { input: { content: `Email calls: ${JSON.stringify(list)}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const rows = (await api("GET", `/runs/${started.body.run_id}/timeline?wait_ms=0`)).body.rows ?? [];
  const of = (kind) => rows.filter((r) => r.kind === kind && TOOLS.includes(r.tool_name)).map((r) => r.summary);
  const said = [
    'Searched mail for "launch plan" from:ana@example.com',
    "Read Plan",
    "Drafted a reply to ana@example.com: Re: Plan",
    "Sent a reply to ana@example.com and 1 more: Re: Plan",
    "Filed Invoice 7 under Receipts, out of the inbox",
  ];
  assert.deepEqual(of("tool_use"), said, JSON.stringify(of("tool_use")));
  assert.deepEqual(of("tool_result"), said.map((line) => `${line}: ok`), JSON.stringify(of("tool_result")));
  const labelled = rows.filter((r) => TOOLS.includes(r.tool_name)).map((r) => r.summary ?? "");
  assert.ok(labelled.length >= 10 && labelled.every((line) => !line.includes("zebra-quokka")), JSON.stringify(labelled));
});
