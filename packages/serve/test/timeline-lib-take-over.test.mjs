// A person's take-over in the timeline, as a run's log has it (Manuel's walk of #1703): the take's row and the hand-back's
// are the server's (HOST_PHASE) and carry the time each happened (`at`), not the time of the message before them; the
// agent's browser call that waited for the hand-back says so, and for how long (pi-browser's waited_for_person_ms), so it
// never reads as the agent opening a page while the person had the browser. Fixed times: no clock, no sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_PHASE, timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { assistant, call, custom, result } from "./timeline-lib-support.mjs";

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

test("a call that waited for the person and then failed never reads as having acted: no 'then opened', the wait said and the failure after it; a call stopped while it waited carries no wait and reads as the failure it is", () => {
  const failed = JSON.stringify({ code: "navigation_failed", message: "The page did not load." });
  const stopped = JSON.stringify({ code: "aborted", message: "The call was stopped while it waited for the person to hand the browser back; nothing was done." });
  const rows = timelineOf([
    assistant([call("f1", "run", goto)], 1),
    result("f1", "run", failed, 13, { isError: true, details: { waited_for_person_ms: 11_000 } }),
    assistant([call("s1", "run", goto)], 14),
    result("s1", "run", stopped, 20, { isError: true }),
  ], { settled: true });
  const of = (id) => rows.filter((row) => row.tool_use_id === id).map((row) => row.summary);
  for (const summary of [...of("f1"), ...of("s1")]) assert.doesNotMatch(summary, /then opened/, summary);
  const [use, back] = of("f1");
  assert.match(use, /^Waited for you 11 s: Opened www\.bundesarchiv\.de/, "the wait said, the call's own label after it");
  assert.match(back, /^Waited for you 11 s: Opened www\.bundesarchiv\.de\S* failed: /, "and its failure");
  assert.ok(of("s1").every((summary) => !summary.startsWith("Waited")), "a stopped wait claims no wait");
});

// A take-over that changed the page (QA, run 01a1c256): the agent's held act ran on the snapshot the person's hand made
// stale, and its row read as a red failure ("Acted on the page failed: No hydrated snapshot exists …"), though the agent
// takes a new look at once. pi-browser answers that act as no error, marked page_changed_while_held, and the row says so
// in plain words, neutral. A stale snapshot with no take reads as it always did.
const PAGE_CHANGED = "The page changed while you had the browser; the agent takes a new look";
const STALE = "No hydrated snapshot exists for the active page; call snapshot first.";

test("an act the person's take made stale reads neutral, in plain words, its call row and its result row alike, with no error row; a stale snapshot with no take reads as before", () => {
  const changed = JSON.stringify({ notice: "This call waited while the person had the browser.", done: false, page_changed: true, next: "snapshot", message: "The person changed the page while they had the browser, so this action was not done. Take a snapshot first, then act on the page as it is now." });
  const rows = timelineOf([
    assistant([call("a1", "run", { code: "await page.click('[1-1]')" })], 1),
    custom(HOST_PHASE, { summary: "You took over the browser", at: T0 + 2_000 }),
    custom(HOST_PHASE, { summary: "You handed the browser back", at: T0 + 9_000 }),
    result("a1", "run", changed, 9.5, { details: { waited_for_person_ms: 7_000, page_changed_while_held: true } }),
    assistant([call("a2", "run", { code: "await page.click('[1-2]')" })], 10),
    result("a2", "run", JSON.stringify({ ok: false, code: "stale_snapshot", retryable: true, effect: "none", message: STALE }), 10.5, { isError: true }),
  ], { settled: true });
  const of = (id) => rows.filter((row) => row.tool_use_id === id);
  const [use, done] = [of("a1").find((row) => row.kind === "tool_use"), of("a1").find((row) => row.kind === "tool_result")];
  assert.equal(use.summary, PAGE_CHANGED, "the call's row");
  assert.deepEqual([done.summary, done.tool_status], [PAGE_CHANGED, "success"], "its result's row: neutral, never failed");
  assert.equal(rows.filter((row) => row.kind === "error").length, 0, "no error row");
  // No take: today's row, unchanged.
  const stale = of("a2").find((row) => row.kind === "tool_result");
  assert.deepEqual([stale.summary, stale.tool_status], [`Acted on the page failed: ${STALE}`, "failed"]);
});
