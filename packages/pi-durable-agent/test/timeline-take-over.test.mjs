// A person's take-over in the timeline, as a run's log has it (Manuel's walk of #1703): the take's row and the hand-back's
// are the server's (HOST_PHASE) and carry the time each happened (`at`), not the time of the message before them; the
// agent's browser call that waited for the hand-back says so, and for how long (pi-browser's waited_for_person_ms), so it
// never reads as the agent opening a page while the person had the browser. Fixed times: no clock, no sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_PHASE, timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { assistant, call, custom, result } from "./timeline-support.mjs";

const T0 = Date.UTC(2026, 9, 15, 20, 14, 0);
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const PAGE = "https://www.bundesarchiv.de/DE/Navigation/Finden/finden.html";
const goto = { code: `await page.goto("${PAGE}")` };

/** The log as the run writes it: the agent's last call returns at 0 s; its next request starts at 0.2 s; the person takes
 *  the browser at 1 s (committed before that request's answer is); the answer asks to open a page, and that call parks;
 *  the person hands back at 12 s; the call opens the page and returns at 14.4 s, having waited 11 s. */
const takeOver = () => [
  assistant([call("c0", "snapshot")], -3),
  result("c0", "snapshot", "[1] the page", 0),
  custom(HOST_PHASE, { summary: "You took over the browser", at: T0 + 1_000 }),
  assistant([call("c1", "run", goto)], 0.2),
  custom(HOST_PHASE, { summary: "You handed the browser back", at: T0 + 12_000 }),
  result("c1", "run", JSON.stringify({ ok: true, completed: 1, url: PAGE }), 14.4, { details: { waited_for_person_ms: 11_000 } }),
  assistant([{ type: "text", text: "Opened it." }], 14.5),
];

const told = (rows) => rows.filter((row) => (row.kind === "phase" && row.summary !== "A live browser session started") || (row.kind === "tool_use" && row.tool_name === "run")).map((row) => [row.summary, row.timestamp]);

test("a take-over reads true: the take and the hand-back at their own times, 11 s apart, and the call between them says it waited for the person, then opened the page", () => {
  const rows = timelineOf(takeOver(), { settled: true });
  const opened = rows.find((row) => row.kind === "tool_use" && row.tool_name === "run");
  assert.match(opened.summary, /^Waited for you 11 s, then opened www\.bundesarchiv\.de/, "the call says it waited, and how long");
  assert.deepEqual(told(rows), [
    ["You took over the browser", iso(1)],
    [opened.summary, iso(0.2)],
    ["You handed the browser back", iso(12)],
  ], "in the order they happened in the log, each phase at its own time");
  const [taken, , given] = told(rows);
  assert.equal(Date.parse(given[1]) - Date.parse(taken[1]), 11_000, "the hold reads as long as it was");
  const back = rows.find((row) => row.kind === "tool_result" && row.tool_name === "run");
  assert.match(back.summary, /^Waited for you 11 s, then opened /, "its result row reads the same");
  assert.equal(back.timestamp, iso(14.4));

  const live = timelineReducer();
  live.apply(takeOver().map((entry) => ({ type: "entry_appended", entry })));
  assert.deepEqual(told(live.rows()), told(rows), "live, the same rows at the same times");
});

test("a phase with no time of its own keeps the time of the log before it; a call that waited under a second says so in ms; one that did not wait reads as before", () => {
  const rows = timelineOf([
    assistant([call("c1", "run", goto)], 1),
    custom(HOST_PHASE, { summary: "Preparing the box image" }),
    result("c1", "run", "{}", 2, { details: { waited_for_person_ms: 400 } }),
    assistant([call("c2", "run", goto)], 3),
    result("c2", "run", "{}", 4),
  ], { settled: true });
  assert.equal(rows.find((row) => row.summary === "Preparing the box image").timestamp, iso(1));
  const calls = rows.filter((row) => row.kind === "tool_use").map((row) => row.summary);
  assert.match(calls[0], /^Waited for you 400 ms, then opened www\.bundesarchiv\.de/);
  assert.match(calls[1], /^Opened www\.bundesarchiv\.de/);
});
