// The agent's own words show their URLs whole: its answer row and its text rows, settled and live, keep a URL's fragment
// and query (a console link's #/runs/<id>?x=1), with a held key redacted (the host's `redact`), as a person's own message
// does. scrubUrls is for URLs from what the model read: a tool's result, a page's title. Thinking keeps the scrub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";

/** A held key, made at runtime: no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "answer-url-key", "0123456789ab"].join("-");
const redact = (text) => text.split(KEY).join("[redacted]");
const CONSOLE = "http://127.0.0.1:7340/#/runs/01a1a961-3257-7131-a652-c6fb78880244?x=1"; // key-gate: loopback-rule a console link an agent's answer gives, as text
const SAID = `Open ${CONSOLE} and see https://api.example/v1?k=${KEY}&y=2 for it.`;
const SHOWN = `Open ${CONSOLE} and see https://api.example/v1?k=[redacted]&y=2 for it.`;

test("an answer with a console link and a held key in a URL's query: its row's summary and text keep the link whole and show the key as [redacted]", () => {
  const rows = timelineOf([user("Where is it?"), assistant([{ type: "text", text: SAID }])], { redact });
  const answer = rows.find((r) => r.kind === "final_answer");
  assert.ok(answer, JSON.stringify(rows.map((r) => r.kind)));
  assert.equal(answer.summary, SHOWN);
  assert.equal(answer.text, SHOWN);
});

test("the agent's text before a tool call keeps the link whole too, and the live text block while it streams", () => {
  const rows = timelineOf([user("Where is it?"), assistant([{ type: "text", text: SAID }, call("b1", "bash", { command: "true" })]), result("b1", "bash", "ok")], { redact });
  const said = rows.find((r) => r.kind === "text_block");
  assert.ok(said, JSON.stringify(rows.map((r) => r.kind)));
  assert.equal(said.text, SHOWN);
  const reducer = timelineReducer({ redact });
  reducer.apply([{ type: "entry_appended", entry: user("Where is it?") }, { type: "message_start", message: { role: "assistant", content: [] } }, { type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: `${SAID} ` }] }]);
  const live = reducer.rows().find((r) => r.id.includes(":live:text_block"));
  assert.ok(live, JSON.stringify(reducer.rows().map((r) => r.id)));
  assert.equal(live.text, SHOWN);
});

test("what the model read still drops a URL's fragment and query: a tool result's preview, a page's title; and thinking keeps the scrub", () => {
  const rows = timelineOf([
    user("Read it."),
    assistant([{ type: "thinking", thinking: `Looking at ${CONSOLE} now.` }, call("r1", "browser_read")]),
    result("r1", "browser_read", `url: https://x.example/p\ntitle: Login ${CONSOLE}\n---\nbody at https://api.example/v1?k=v`),
  ]);
  const shown = JSON.stringify(rows.filter((r) => r.kind !== "user_message").map((r) => [r.kind, r.summary, r.tool_result_preview, r.text]));
  assert.ok(!shown.includes("#/runs/") && !shown.includes("k=v") && !shown.includes("x=1"), shown);
});
