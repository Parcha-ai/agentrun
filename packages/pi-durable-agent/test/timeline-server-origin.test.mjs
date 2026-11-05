// A message the server writes into a run (a raised cap's follow-up, an approval's resume) is the server's, not the
// person's: the Timeline shows it as a phase row, "AgentRun: <its first line>", never "You: …", whether its user entry
// carries its origin itself (a harness run's entry, which the host writes) or a marker before it names it by its text (a
// pi run's, whose entry pi writes with no data). The model's text is the entry's, unchanged. The row is redacted as a
// person's is, so a server message is no way around the host's redaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as timeline from "../dist/timeline/index.js";
import { assistant, custom, inConv, user } from "./timeline-support.mjs";

const { timelineOf } = timeline;
/** The marker's kind, as the door writes it (pi-durable-disk's MESSAGE_ORIGIN_KIND): the module's own is checked below. */
const MESSAGE_ORIGIN = "agentrun.message_origin";
const RAISED = "The cap was raised to $5; continue the task.";
const SERVER = { kind: "server", reason: "cap_raised" };
const said = (rows) => rows.filter((r) => r.kind === "user_message").map((r) => r.summary);
const phases = (rows) => rows.filter((r) => r.kind === "phase").map((r) => [r.summary, r.text]);

test("a user entry that carries a server origin shows as the server's phase row, never as the person's", () => {
  const rows = timelineOf([user("Write the report."), assistant([{ type: "text", text: "Stopped at the cap." }]), user(RAISED, 0, { data: { origin: SERVER } }), assistant([{ type: "text", text: "Done." }])]);
  assert.deepEqual(said(rows), ["You: Write the report."], "only the person's own message is theirs");
  assert.deepEqual(phases(rows), [[`AgentRun: ${RAISED}`, RAISED]], "the server's message is its row");
  // A phase row with a path folds into the tool row before it in the console: the server's row has none.
  assert.equal(rows.find((r) => r.kind === "phase")?.path, undefined, "the server's row carries no path");
});

test("a pi user entry named by the marker before it (its exact text) shows as the server's phase row, once", () => {
  const entries = [user("Write the report."), custom(MESSAGE_ORIGIN, { origin: SERVER, text: RAISED }), user(RAISED), user(RAISED)];
  const rows = timelineOf(entries);
  assert.deepEqual(said(rows), ["You: Write the report.", `You: ${RAISED}`], "the marker names one entry: the next same text is the person's again");
  assert.deepEqual(phases(rows), [[`AgentRun: ${RAISED}`, RAISED]], "the marked entry is the server's");
  assert.equal(timeline.MESSAGE_ORIGIN, MESSAGE_ORIGIN, "the module's marker kind is the door's");
  assert.deepEqual([...(timeline.messageOrigins?.(entries) ?? new Map()).entries()].map(([entry, origin]) => [entries.indexOf(entry), origin]), [[2, SERVER]], "the shared reader names the same entry");
});

test("a guard: a marker names no other conversation's entry, nor one with another text: those stay the person's", () => {
  const rows = timelineOf([custom(MESSAGE_ORIGIN, { origin: SERVER, text: RAISED }), inConv(user(RAISED), 7), user("Something else.")]);
  assert.deepEqual(said(rows), [`You: ${RAISED}`, "You: Something else."], "another conversation's entry and another text are the person's");
});

const KEY = ["not-a-secret", "server-row-key", "0123456789ab"].join("-");
const redact = (text) => text.split(KEY).join("[redacted]");
/** An approval's resume as the gate writes it: its head line, then the call's result, where a held key can be. */
const resume = (result) => `[tool approval] This answers your fetch_page call call_1 (arguments {"url":"https://api.example/"}), which waited for a person's approval; it is not a new message from them.\nThe call ran. Its result:\n${result}`;

test("a server message's row is redacted whole as a person's is, its result's lines too, before its first line is taken: no way around the host's redaction", () => {
  const rows = timelineOf([user(resume(`{"token":"${KEY}"}`), 0, { data: { origin: { kind: "server", reason: "approval" } } })], { redact });
  const [summary, text] = phases(rows)[0] ?? [];
  assert.equal(summary, `AgentRun: [tool approval] This answers your fetch_page call call_1 (arguments {"url":"https://api.example/"}), which waited for a person's approval; it is not a new message from them.`);
  assert.ok(text?.endsWith('{"token":"[redacted]"}') && !text.includes(KEY), `the result's key is redacted in the row's text: ${text}`);
});

test("an approval a person's message declined shows two rows: the server's resume, and the person's own words as theirs, under a person's rules", () => {
  const said = `No, not that one. Use http://127.0.0.1:7340/#/runs/01a1a88c-4f2e-7abc-8def-0123456789ab and ${KEY} instead.`; // key-gate: loopback-rule a console link a person pastes, as text
  const declined = { kind: "server", reason: "approval_declined", said };
  const rows = timelineOf([user("Fetch the page."), user(resume("The person declined the call."), 0, { data: { origin: declined } })], { redact });
  assert.deepEqual(rows.filter((r) => ["user_message", "phase"].includes(r.kind)).map((r) => [r.kind, r.summary]), [
    ["user_message", "You: Fetch the page."],
    ["phase", `AgentRun: [tool approval] This answers your fetch_page call call_1 (arguments {"url":"https://api.example/"}), which waited for a person's approval; it is not a new message from them.`],
    ["user_message", "You: No, not that one. Use http://127.0.0.1:7340/#/runs/01a1a88c-4f2e-7abc-8def-0123456789ab and [redacted] instead."],
  ], "the person's words are never hidden: a row of theirs, their console link's fragment kept, their pasted key redacted");
});

test("a guard: a declined approval with no words of the person's is no origin (its message stays the person's)", () => {
  const rows = timelineOf([user("Declined.", 0, { data: { origin: { kind: "server", reason: "approval_declined" } } })]);
  assert.deepEqual(said(rows), ["You: Declined."]);
});

test("a guard: an origin that is not a server's (a stray or partial one) leaves the message the person's", () => {
  const rows = timelineOf([user("Mine.", 0, { data: { origin: { kind: "person" } } }), custom(MESSAGE_ORIGIN, { origin: { kind: "server", reason: "other" }, text: "Also mine." }), user("Also mine.")]);
  assert.deepEqual(said(rows), ["You: Mine.", "You: Also mine."]);
});
