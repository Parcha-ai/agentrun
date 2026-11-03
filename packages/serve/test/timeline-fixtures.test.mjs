// The timeline fixture a client tests against (fixtures/timeline-action-rows.json): one run's rows as /v2 serves them,
// completed and live, rebuilt here from the run's entries (fixtures/timeline-run.mjs) through the timeline module and
// serve's own pass over its rows, so the fixture is always what this code serves. UPDATE_FIXTURES=1 writes it again.
// fixtures/timeline-legacy-rows.json is the same run as the timeline served it before one row per action (main at
// 529c3882e): a snapshot for clients that still read that shape, never rebuilt.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import * as timeline from "@parcha/pi-durable-agent/timeline";
import { RowLog } from "../dist/rows.js";
import { withAsks } from "../dist/runs.js";
import { recordings } from "./fixtures/timeline-run.mjs";

const FIXTURE = new URL("./fixtures/timeline-action-rows.json", import.meta.url);
const LEGACY = new URL("./fixtures/timeline-legacy-rows.json", import.meta.url);

test("the action-rows fixture is what this code serves for its run, completed and live", () => {
  const now = `${JSON.stringify(recordings({ timeline, withAsks, RowLog }), null, 2)}\n`;
  if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, now);
  assert.equal(now, readFileSync(FIXTURE, "utf8"));
});

test("the fixture's run shows each kind of action: a probe that found nothing, a folded group, a search and a page, a failure, a write with its path, an answered question, an interrupted call, a running one", () => {
  const { completed, working } = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const calls = completed.body.rows.filter((row) => row.kind === "tool_use");
  assert.deepEqual(calls.map((row) => [row.tool_name, row.tool_status]), [
    ["read", "missing"], ["read", "success"], ["read", "success"], ["read", "success"], ["web_search", "success"], ["web_fetch", "success"], ["write", "failed"],
    ["write", "success"], ["ask_person", "success"], ["write", "interrupted"], ["write", "success"],
  ]);
  assert.deepEqual(completed.body.rows.filter((row) => row.kind === "tool_result" || row.kind === "waiting"), [], "no result row, and the answered question waits no more");
  assert.match(completed.body.rows.at(-1).summary, /^Total: \$0\.0801 · 10 model requests · 41 s$/);
  assert.deepEqual(working.body.rows.filter((row) => row.tool_status === "running").map((row) => row.tool_use_id), ["toolu_w2"]);
  const legacy = JSON.parse(readFileSync(LEGACY, "utf8"));
  assert.deepEqual(legacy.completed.body.rows.filter((row) => row.kind === "tool_result").map((row) => row.tool_use_id), ["toolu_r1", "toolu_r2", "toolu_r3", "toolu_r4", "toolu_s1", "toolu_f1", "toolu_w1", "toolu_w2", "toolu_a1", "toolu_w3", "toolu_w4"], "the legacy shape: a result row after every call");
});
