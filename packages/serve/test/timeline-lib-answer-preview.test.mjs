// An answer row's summary is what the Timeline's Answer row previews. A JSON answer the model fenced (```json … ```)
// previews its JSON, never the fence's label ("json…"), cut at the summary's cap; the row's text keeps the answer whole.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPS, timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { assistant, user } from "./timeline-lib-support.mjs";

const answerOf = (text) => timelineOf([user("Run KYB."), assistant([{ type: "text", text }])]).find((r) => r.kind === "final_answer");

test("a fenced JSON answer: its summary is the JSON inside the fence, one line, and its text is the answer as the model wrote it", () => {
  const said = '```json\n{\n  "company": "Monzo Bank Limited",\n  "number": "09446231",\n  "risk": "medium"\n}\n```';
  const answer = answerOf(said);
  assert.equal(answer.summary, '{ "company": "Monzo Bank Limited", "number": "09446231", "risk": "medium" }');
  assert.equal(answer.text, said);
});

test("a fence closed before more words: the summary is the code alone; a fence with no language and a ~~~ fence read the same", () => {
  assert.equal(answerOf('```json\n{"ok": true}\n```\nThe report is above.').summary, '{"ok": true}');
  assert.equal(answerOf('```\n{"ok": true}\n```').summary, '{"ok": true}');
  assert.equal(answerOf('~~~json\n{"ok": true}\n~~~').summary, '{"ok": true}');
});

test("a closing fence longer than its opening one closes it (CommonMark); a shorter one, or the other character, does not", () => {
  assert.equal(answerOf('~~~json\n{"ok":true}\n~~~~\nMore prose.').summary, '{"ok":true}');
  assert.equal(answerOf('```json\n{"ok":true}\n`````\nMore prose.').summary, '{"ok":true}');
  assert.equal(answerOf('````json\n{"a":1}\n```\n{"b":2}\n````\nMore prose.').summary, '{"a":1} ``` {"b":2}');
  assert.equal(answerOf('```json\n{"a":1}\n~~~\n{"b":2}\n```').summary, '{"a":1} ~~~ {"b":2}');
});

test("a closing fence indented 4 or more spaces, or by a tab, is code inside the fence, not its close; up to 3 spaces still closes it", () => {
  assert.equal(answerOf('```json\n{"a":1}\n    ```\n{"b":2}\n```\nMore prose.').summary, '{"a":1} ``` {"b":2}');
  assert.equal(answerOf('```json\n{"a":1}\n\t```\n{"b":2}\n```\nMore prose.').summary, '{"a":1} ``` {"b":2}');
  assert.equal(answerOf('```json\n{"a":1}\n   ```\nMore prose.').summary, '{"a":1}');
});

test("plain words: the summary is still their first line, and inline code on that line is no fence", () => {
  assert.equal(answerOf("Done.\n\nThe report is in report.md.").summary, "Done.");
  assert.equal(answerOf("```npm test``` passes.\nMore below.").summary, "```npm test``` passes.");
  assert.equal(answerOf("The result:\n```json\n{\"ok\": true}\n```").summary, "The result:");
});

test("a long fenced JSON answer: the summary is the JSON's first characters, cut at the cap, and the text is whole", () => {
  const rows = Array.from({ length: 200 }, (_, i) => `  "field_${i}": "value ${i}"`).join(",\n");
  const said = "```json\n{\n" + rows + "\n}\n```";
  const answer = answerOf(said);
  assert.equal(answer.summary.length, CAPS.summary);
  assert.ok(answer.summary.startsWith('{ "field_0": "value 0", "field_1": "value 1",'), answer.summary.slice(0, 80));
  assert.ok(answer.summary.endsWith("..."), answer.summary.slice(-20));
  assert.ok(!answer.summary.includes("```") && !answer.summary.startsWith("json"), answer.summary.slice(0, 40));
  // The row's text is the answer as written, fence and all, under its own cap as before (CAPS.text).
  assert.equal(answer.text, said.length > CAPS.text ? `${said.slice(0, CAPS.text - 3)}...` : said);
});

test("while the answer streams, its live row previews the JSON inside the fence too", () => {
  const reducer = timelineReducer({});
  reducer.apply([{ type: "entry_appended", entry: user("Run KYB.") }, { type: "message_start", message: { role: "assistant", content: [] } }, { type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: '```json\n{\n  "company": "Monzo Bank Limited",\n' }] }]);
  const live = reducer.rows().find((r) => r.id.includes(":live:text_block"));
  assert.ok(live, JSON.stringify(reducer.rows().map((r) => r.id)));
  assert.equal(live.summary, '{ "company": "Monzo Bank Limited",');
});
