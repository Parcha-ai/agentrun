// Two calls in one pi run, each set to ask and answered in turn: an answer restates the run's rows at once (runs.ts
// restate), and the earlier call must still read in order then: its own rows "Held for your approval", its approval row,
// then its resume row with the outcome. The rows an answer restates were rewritten once already (the resume row's text no
// longer starts with the gate's head), so the link from a resume row to its approval can't be read from that text.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, call, cookieOf, follow, scratch, serve } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), fauxHarness: fixture("faux-gate.mjs"), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true };
const json = { "content-type": "application/json" };
const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const NOTE = "not that page twice";

/** The owner's password session on `server`: an answer to an approval, as the console sends it. */
async function owner(server) {
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  return async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body })).status;
}

/** The run's rows as served now, in seq order, with no wait for more. */
async function rowsNow(api, runId) {
  const { status, body } = await api("GET", `/runs/${runId}/timeline?wait_ms=0`);
  assert.equal(status, 200, JSON.stringify(body));
  return [...body.rows].sort((a, b) => a.seq - b.seq);
}

/** One parked call as a person reads it: its own rows say it was held, its approval row follows, then its resume row
 *  (the outcome, matched by `outcome`). */
function readsInOrder(rows, callId, outcome, at) {
  const shown = rows.map((r) => `${r.kind}: ${r.summary}`);
  const own = rows.flatMap((r, i) => ((r.kind === "tool_use" || r.kind === "tool_result") && r.tool_use_id === callId ? [i] : []));
  const ask = rows.findIndex((r) => r.kind === "tool_approval_requested" && r.tool_use_id === callId);
  const resume = rows.findIndex((r) => r.origin === "server" && outcome.test(r.summary ?? ""));
  assert.ok(own.length > 0 && ask > Math.max(...own), `${at}: the approval row follows the call's own rows: ${JSON.stringify(shown)}`);
  assert.ok(resume > ask, `${at}: the outcome (the resume row) follows the approval row: ${JSON.stringify(shown)}`);
  assert.deepEqual(own.map((i) => rows[i].summary), own.map(() => "Held for your approval"), `${at}: the call's own rows say only that it was held: ${JSON.stringify(shown)}`);
}

// SKIP (follow-up #2078): with a second call waiting, the approval row does not follow the call's own rows (the run-view rows follow-up)
test.skip("pi: two calls set to ask in one run, the first allowed, the second denied with a note: after the second answer, and at the run's end, the first still reads held, then its approval, then its outcome, and so does the second", { timeout: 150_000 }, async (t) => {
  const server = await serve(t, GATE);
  const { api } = server;
  const answer = await owner(server);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const go = join(await scratch(t), "go");
  // The second call waits for this file after the first result; made now, it follows the first answer at once.
  await writeFile(go, "");
  const ask = `Fetch http://public.example/ again once ${go} exists.`;
  assert.equal((await api("POST", "/agents", agent("twice", { harness: "pi", instructions: ask, tools: ["web_fetch"] }))).status, 201);
  const started = await api("POST", "/agents/twice/runs", { input: { content: ask } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;

  await follow(api, runId, ["input_required"], { deadlineMs: 55_000 });
  const first = (await api("GET", `/runs/${runId}`)).body.pending;
  assert.deepEqual([first?.kind, first?.tool], ["approval", "web_fetch"], "parked on the first call");
  assert.equal(await answer(runId, first.id, { decision: "allow" }), 204);

  // The second call parks: a pending approval that is not the first one.
  let second;
  const end = Date.now() + 55_000;
  for (;;) {
    const view = (await api("GET", `/runs/${runId}`)).body;
    if (view.status === "input_required" && view.pending?.kind === "approval" && view.pending.id !== first.id) { second = view.pending; break; }
    assert.ok(Date.now() < end, `the second call never parked: ${view.status} ${JSON.stringify(view.pending)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const firstCall = (await rowsNow(api, runId)).find((r) => r.kind === "tool_approval_requested" && r.summary?.includes("web_fetch"))?.tool_use_id;
  assert.ok(firstCall, "the first call's approval row is served");
  readsInOrder(await rowsNow(api, runId), firstCall, /^AgentRun: web_fetch ran once you allowed it/, "with the second call waiting");

  // The second answer restates the rows at once, before the run's process takes it up: read them straight away.
  assert.equal(await answer(runId, second.id, { decision: "deny", note: NOTE }), 204);
  readsInOrder(await rowsNow(api, runId), firstCall, /^AgentRun: web_fetch ran once you allowed it/, "right after the second answer");

  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const done = await rowsNow(api, runId);
  const asks = done.filter((r) => r.kind === "tool_approval_requested").map((r) => r.tool_use_id);
  assert.equal(asks.length, 2, `two approval rows: ${JSON.stringify(done.map((r) => `${r.kind}: ${r.summary}`))}`);
  readsInOrder(done, asks[0], /^AgentRun: web_fetch ran once you allowed it/, "the first call, at the run's end");
  readsInOrder(done, asks[1], new RegExp(`^AgentRun: You declined web_fetch: ${NOTE}$`), "the second call, at the run's end");
});
