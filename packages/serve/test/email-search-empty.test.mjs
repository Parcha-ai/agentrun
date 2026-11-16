// An email search that matches nothing answers exactly {messages: []}: no `omitted` and no "did not fit" note. The note
// is for a search whose messages were cut to fit one answer; on an empty one it told the model to narrow a search that
// had found nothing, and a model that believed it (codex on the inbox template's digest and Monday brief, #2874 round 3)
// retried smaller searches and drafted "unable to assess" instead of the empty day it was. Fixed in #2874 round 4
// (email/answer.ts emailText); this pins it, in the answer's own words and through a run's email_search on the fake account.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emailText } from "../dist/email/answer.js";
import { agent, follow, serve } from "./support.mjs";
import { ADDRESS, FAUX_EMAIL, mailbox, saved, sawOf } from "./email-support.mjs";

test("an email answer with no messages is exactly {messages: []}, with no note of messages that did not fit", () => {
  assert.deepEqual(JSON.parse(emailText({ messages: [] })), { messages: [] });
});

test("a run's email_search that matches nothing answers {messages: []}, with no note to narrow it", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_EMAIL });
  const faux = await mailbox(t);
  faux.seed({ from: "Ana Díaz <ana@example.com>", to: [ADDRESS], subject: "Plan", text: "Shall we plan the launch?", date: "2026-05-01T10:00:00Z", messageId: "<m1@example.com>" });
  await saved(api, faux);
  assert.equal((await api("POST", "/agents", agent("searcher", { harness: "pi", tools: ["email_search"] }))).status, 201);
  const list = [
    ["email_search", { text: "no such words anywhere" }],
    ["email_search", { since: "2027-01-01T00:00:00Z", limit: 50 }],
    ["email_search", { from: "ana@example.com" }],
  ];
  const started = await api("POST", "/agents/searcher/runs", { input: { content: `Email calls: ${JSON.stringify(list)}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const [none, later, found] = sawOf((await api("GET", `/runs/${started.body.run_id}`)).body.result?.final_answer);
  assert.deepEqual(none, { messages: [] }, "no match by text");
  assert.deepEqual(later, { messages: [] }, "no match after a date to come");
  // The account is searchable: the same run finds the one message by its sender.
  assert.deepEqual(found.messages.map((m) => m.message_id), ["<m1@example.com>"]);
});
