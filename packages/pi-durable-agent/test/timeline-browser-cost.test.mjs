// A browser charge (a TOOL_COST of tool `browser`, serve's browser-cost.ts) folds into the row of the browser call it
// belongs to: that call's tool_use row carries it as `usage` ({ usd, requests: 0 }), and no "Tool cost" row is made. A
// charge booked after the answer (a session's release) changes that row, by its id, live too. The run's cost counts each
// charge once, as before. Other tools' charges keep their own row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderText, timelineOf, timelineReducer, TOOL_COST } from "../dist/timeline/index.js";
import { assistant, call, custom, result, user } from "./timeline-support.mjs";

/** A browser charge as serve books it: on the root (conversation 1 here), naming the call, its session and conversation. */
const charge = (usd, call, { tag = "s1", final = false, conversation = 1 } = {}) =>
  custom(TOOL_COST, { tool: "browser", charged_by: "browserbase", call, usd, seconds: 3, tag, conversation, at: "2026-11-05T12:00:00.000Z", final });

/** Two browser calls, each charged as it ran, then the answer, then the session's release, charged under its last call. */
const run = (release = charge(0.0016, "b2", { final: true })) => [
  user("Open the page twice", 0),
  assistant([call("b1", "snapshot")], 1),
  charge(0.0001, "b1"),
  result("b1", "snapshot", "[1-1] page", 2),
  assistant([call("b2", "browser_read", { what: "markdown" })], 3),
  charge(0.0001, "b2"),
  result("b2", "browser_read", "url: https://example.test/\ntitle: Example\n---\nbody", 4),
  assistant([{ type: "text", text: "Done." }], 5),
  release,
];

const browserRows = (rows) => rows.filter((row) => row.kind === "tool_use");
const pico = (usd) => Math.round(usd * 1e12) / 1e12;

test("a browser charge folds into its call's row: no Tool cost row, each call's row carries its charge, the release lands on the last call's row, and the run's cost is unchanged", () => {
  const rows = timelineOf(run());
  assert.deepEqual(rows.filter((row) => /^Tool cost/.test(row.summary ?? "")), [], "no row of its own");
  assert.ok(!rows.some((row) => row.kind === "phase" && row.tool_name === "browser"));
  const [first, last] = browserRows(rows);
  assert.deepEqual([first.tool_use_id, first.usage], ["b1", { usd: 0.0001, requests: 0 }]);
  assert.deepEqual([last.tool_use_id, last.usage], ["b2", { usd: 0.0017, requests: 0 }], "its own charge and the release's");
  assert.ok(!rows.some((row) => row.kind === "tool_result" && row.usage), "the call's row alone carries it, never its result's too");
  // Three model requests at $0.01 each and $0.0018 of browser time, three charges: as when each charge had its own row.
  assert.deepEqual(rows.at(-1).usage, { usd: 0.0318, requests: 3 });
  assert.equal(rows.at(-1).summary, "Cost so far: $0.0318 over 3 model requests and 2 paid tool calls", "two calls, each counted once: the release adds a charge, never a call");
  assert.equal(pico(browserRows(rows).reduce((sum, row) => sum + (row.usage?.usd ?? 0), 0)), 0.0018, "the rows sum to the browser's charges");
});

test("a release charge with no call (a session reopened after the run's last call) lands on the last browser call's row for its session, else its conversation's", () => {
  const bySession = browserRows(timelineOf(run(charge(0.0016, null, { final: true }))));
  assert.deepEqual(bySession.map((row) => row.usage), [{ usd: 0.0001, requests: 0 }, { usd: 0.0017, requests: 0 }]);
  const byConversation = browserRows(timelineOf(run(charge(0.0016, null, { tag: "s9", final: true }))));
  assert.deepEqual(byConversation.at(-1).usage, { usd: 0.0017, requests: 0 }, "a session no charge named before: its conversation's last browser call");
});

test("a charge of unknown cost makes its row's cost unknown, saying what is known and how many are not", () => {
  const rows = timelineOf(run(charge(null, "b2", { final: true })));
  assert.deepEqual(browserRows(rows).at(-1).usage, { usd: null, requests: 0, so_far_usd: 0.0001, unpriced: 1 });
  assert.equal(rows.at(-1).usage.usd, null, "the run's cost is unknown, as before");
});

test("live: a charge booked after the answer is an update of the call's row, the same id with its new cost, never a new row", () => {
  const reducer = timelineReducer();
  const entries = run();
  const before = entries.slice(0, -1);
  reducer.apply(before.map((entry) => ({ type: "entry_appended", entry })));
  const last = browserRows(reducer.rows()).at(-1);
  assert.deepEqual(last.usage, { usd: 0.0001, requests: 0 });
  const ids = reducer.rows().map((row) => row.id);
  const { rows: changed } = reducer.apply([{ type: "entry_appended", entry: entries.at(-1) }]);
  const updated = changed.find((row) => row.id === last.id);
  assert.ok(updated, JSON.stringify(changed.map((row) => row.id)));
  assert.deepEqual(updated.usage, { usd: 0.0017, requests: 0 });
  assert.deepEqual(changed.filter((row) => !ids.includes(row.id)).map((row) => row.kind), [], "no new row; the usage row is an update too");
  assert.deepEqual(reducer.rows().map((row) => row.id), ids);
});

test("another tool's charge keeps its own row", () => {
  const rows = timelineOf([assistant([call("m1", "monid_run")], 0), custom(TOOL_COST, { tool: "monid.run", charged_by: "monid", call: "m1", usd: 0.003 }), result("m1", "monid_run", "ok", 1)]);
  const phase = rows.find((row) => row.kind === "phase");
  assert.deepEqual([phase.summary, phase.usage], ["Tool cost: monid charged $0.0030 for monid.run", { usd: 0.003, requests: 0 }]);
  assert.equal(rows.find((row) => row.kind === "tool_use").usage, undefined);
});

test("the text view shows a browser call's charge on its line", () => {
  const text = renderText(timelineOf(run()).filter((row) => row.kind !== "usage"));
  assert.ok(!/Tool cost/.test(text), text);
  assert.match(text, /Looked at the page structure · \$0\.0001 +ok/, text);
  assert.match(text, /Read the page "Example" · \$0\.0017 +ok/, text);
  // Two browser calls of one tool fold into one line, with what they came to together.
  const twice = [user("Look twice", 0), assistant([call("s1", "snapshot")], 1), charge(0.0001, "s1"), result("s1", "snapshot", "a", 2), assistant([call("s2", "snapshot")], 3), charge(0.0001, "s2"), result("s2", "snapshot", "b", 4), charge(0.0016, "s2", { final: true })];
  assert.match(renderText(timelineOf(twice).filter((row) => row.kind !== "usage")), / · \$0\.0018 +2 ok/);
});

test("a paid tool call counts once however many charges it books: one browser call and its release is 1 paid tool call; a release with no call of its own adds none", () => {
  const one = (release) => [user("Open the page", 0), assistant([call("b1", "snapshot")], 1), charge(0.0001, "b1"), result("b1", "snapshot", "[1-1] page", 2), assistant([{ type: "text", text: "Done." }], 3), release];
  for (const [name, release] of [["under its call", charge(0.0016, "b1", { final: true })], ["with no call, its session's", charge(0.0016, null, { final: true })]]) {
    const usage = timelineOf(one(release)).at(-1);
    assert.equal(usage.summary, "Cost so far: $0.0217 over 2 model requests and 1 paid tool call", name);
    assert.deepEqual(usage.usage, { usd: 0.0217, requests: 2 }, `${name}: the charge still counts once in the cost`);
  }
  // A release whose session no charge named before, with no call: a charge the run cannot place adds a call of its own.
  assert.match(timelineOf(one(charge(0.0016, null, { tag: "s9", final: true }))).at(-1).summary, / and 2 paid tool calls$/);
});

test("a call whose charges have no price is one charge not priced, however many it books", () => {
  const usage = timelineOf([assistant([call("b1", "snapshot")], 0), charge(null, "b1"), result("b1", "snapshot", "a", 1), assistant([{ type: "text", text: "Done." }], 2), charge(null, "b1", { final: true })]).at(-1);
  assert.deepEqual(usage.usage, { usd: null, requests: 2, so_far_usd: 0.02, unpriced: 1 });
  assert.equal(usage.summary, "Cost so far: $0.0200 known, 1 not priced, over 2 model requests and 1 paid tool call");
});

test("other tools' counts do not change: one monid call is 1 paid tool call, two are 2", () => {
  const monid = (call, usd = 0.003) => custom(TOOL_COST, { tool: "monid.run", charged_by: "monid", call, usd });
  assert.match(timelineOf([assistant([call("m1", "monid_run")], 0), monid("m1"), result("m1", "monid_run", "ok", 1)]).at(-1).summary, / and 1 paid tool call$/);
  assert.match(timelineOf([assistant([call("m1", "monid_run"), call("m2", "monid_run")], 0), monid("m1"), monid("m2"), result("m1", "monid_run", "ok", 1), result("m2", "monid_run", "ok", 1)]).at(-1).summary, / and 2 paid tool calls$/);
});
