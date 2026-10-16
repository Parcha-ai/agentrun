import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderText, timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { entriesOf, eventsOf, lines } from "./timeline-support.mjs";

const GOLDEN = fileURLToPath(new URL("./fixtures/timeline-reference-job.txt", import.meta.url));
const bare = (rows) => rows.map(({ seq, ...row }) => row);
const increasing = (rows) => rows.every((row, i) => i === 0 || row.seq > rows[i - 1].seq);

function check(actual) {
  if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, `${actual}\n`);
  assert.equal(`${actual}\n`, readFileSync(GOLDEN, "utf8"));
}

test("the reference run: entries and events give the same committed rows, and the text matches the golden file", () => {
  const recording = lines("reference-job");
  const stored = timelineOf(entriesOf(recording), { settled: true });

  const reducer = timelineReducer();
  for (const event of eventsOf(recording)) reducer.apply([event]);
  const live = reducer.rows();
  const committed = live.filter((row) => !row.id.includes(":run:"));

  assert.deepEqual(bare(committed), bare(stored));
  assert.ok(increasing(stored) && increasing(live));
  assert.deepEqual(live.filter((row) => row.id.includes(":run:")).map((row) => row.summary), ["Run started"]);
  check(renderText(stored));
  assert.equal(renderText(committed), renderText(stored));
});

test("one batch or one event at a time, the live path gives the same rows", () => {
  const events = eventsOf(lines("reference-job"));
  const whole = timelineReducer();
  whole.apply(events);
  const piecemeal = timelineReducer();
  for (const event of events) piecemeal.apply([event]);
  assert.deepEqual(bare(whole.rows()), bare(piecemeal.rows()));
});

test("the killed run gives the same rows, with the interruption notice in a result", () => {
  const killed = timelineOf(entriesOf(lines("ten-kills-seed21")), { settled: true });
  const clean = timelineOf(entriesOf(lines("reference-job")), { settled: true });
  assert.deepEqual(killed.map((row) => [row.kind, row.tool_name]), clean.map((row) => [row.kind, row.tool_name]));
  assert.ok(killed.some((row) => /interruption/.test(row.tool_result_preview ?? "")));
});
