// A message the server writes into a run (a raised cap's follow-up, written down the messages route with an `origin`)
// shows on the Timeline as the server's, "AgentRun: <its first line>", never as "You: …". The runner's own origin rows
// are proven in runner-pi-input-origin.test.mjs and trigger-origin.test.mjs; this file keeps the follow-up to a
// completed run, which waits on reopening it. Faux model: no key, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const RAISED = "The cap was raised to $5; continue the task.";
// SKIP (follow-up #2058): the server no longer reads serve()'s messageOrigin hook (server.ts: "the runner's now (E2r)"), so
// this POST is an ordinary person's message, never the server's. It needs a seam that writes the follow-up's steer with an
// origin (runs-over-store.ts message() takes one; the route never passes it), then a check that the AgentRun row was found.
test.skip("a follow-up the server writes down the messages route (counted as sent, as a raised cap's is) arrives: the run answers it and completes, never left working", { timeout: 120_000 }, async (t) => {
  const origin = { kind: "server", reason: "cap_raised" };
  const { api } = await serve(t, { messageOrigin: (_runId, content) => (content === RAISED ? origin : undefined) });
  assert.equal((await api("POST", "/agents", agent("origin-sent", { tools: [] }))).status, 201);
  const runId = (await api("POST", "/agents/origin-sent/runs", { input: { content: "hi" } })).body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const sent = await api("POST", `/runs/${runId}/messages`, { content: RAISED });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  let last;
  let shown = false;
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 500))) {
    last = (await api("GET", `/runs/${runId}`)).body;
    const rows = (await api("GET", `/runs/${runId}/timeline?limit=500`)).body.rows ?? [];
    shown = rows.some((r) => r.kind === "phase" && r.summary === `AgentRun: ${RAISED}`);
    if (last.status === "completed" && shown) break;
  }
  assert.equal(last?.status, "completed", `the server's follow-up arrived and was answered: ${JSON.stringify(last?.status)}`);
  assert.ok(shown, `the follow-up shows as the server's: "AgentRun: ${RAISED}"`);
});
