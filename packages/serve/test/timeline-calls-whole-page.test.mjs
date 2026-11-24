// A timeline read with calls=whole carries each call's result whole to CALL_RESULT_CHARS, so a page of it holds at most
// CALLS_PAGE_ROWS rows: that is its default, and a larger limit is refused in words. A read without calls still takes
// up to 500 rows a page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CALLS_PAGE_ROWS } from "../dist/timeline/index.js";
import { agent, follow, serve } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;

test("a calls=whole timeline page holds at most 100 rows: its default, and a larger limit is refused in words; a read without calls still takes more", { timeout: 180_000 }, async (t) => {
  assert.equal(CALLS_PAGE_ROWS, 100);
  const { api } = await serve(t, { faux: FAUX });
  assert.equal((await api("POST", "/agents", agent("writer", { tools: ["write"] }))).status, 201);
  // Sixty writes, a tool_use and a tool_result row each: more rows than a calls=whole page holds.
  const writes = Array.from({ length: 60 }, (_, i) => `Write notes/${i}.txt: line ${i}`).join("\n");
  const started = await api("POST", "/agents/writer/runs", { input: { content: `${writes}\nAnswer:\nWrote them.` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 150_000 });
  const all = await api("GET", `/runs/${runId}/timeline?limit=500`);
  assert.ok(all.body.rows.length > 120, `${all.body.rows.length} rows`);
  const whole = await api("GET", `/runs/${runId}/timeline?calls=whole`);
  assert.equal(whole.status, 200, JSON.stringify(whole.body));
  assert.equal(whole.body.rows.length, 100);
  assert.equal(whole.body.has_more, true);
  assert.equal((await api("GET", `/runs/${runId}/timeline?calls=whole&limit=100`)).body.rows.length, 100);
  const refused = await api("GET", `/runs/${runId}/timeline?calls=whole&limit=101`);
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /limit is an integer from 1 to 100 with calls=whole/);
  assert.equal((await api("GET", `/runs/${runId}/timeline?limit=101`)).body.rows.length, 101, "a read without calls takes more");
});
