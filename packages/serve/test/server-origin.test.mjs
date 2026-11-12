// A message the server writes into a run (a raised cap's follow-up, the runner's steer when a raise resumes a run parked at
// its cap) is stored as the server's: on the run's journal its user entry carries {kind: "server", reason: "cap_raised"},
// and the Timeline shows it as "AgentRun: <its first line>", never as "You: …". The runner's other origin rows are proven
// in runner-pi-input-origin.test.mjs and trigger-origin.test.mjs. Faux model: no key, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as timeline from "../dist/timeline/index.js";
import { runEntries } from "../dist/store-reads/journal.js";
import { agent, follow, serve } from "./support.mjs";

/** The faux model priced on output only, $100 a million: a request's least (1,024 tokens) is $0.1024, over a $0.05 cap. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const RAISED = "The cap was raised to $1; continue the task.";
const textOf = (entry) => {
  const content = entry.model[0].content;
  return typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
};

test("a raised cap's follow-up is the server's: its steer is stored with the server's origin and shows as \"AgentRun: …\", never as the person's", { timeout: 120_000 }, async (t) => {
  const { api, store } = await serve(t, { faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("origin-sent", { instructions: "Make three requests." }))).status, 201);
  const runId = (await api("POST", "/agents/origin-sent/runs", { input: { content: "go" }, max_cost_usd: 0.05 })).body.run_id;
  await follow(api, runId, ["input_required", "completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.pending?.kind, "budget", "parked at its cap");
  const raised = await api("PATCH", `/runs/${runId}`, { max_cost_usd: 1 });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
  const { rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");

  // On the store: the follow-up's marker names the raise's request with the server's origin, and the user entry the model
  // was given in those words reads as the server's, as the learning grader reads it.
  const entries = await runEntries(store, runId, BACKGROUND_CONTEXT);
  const markers = entries.filter((e) => e.kind === timeline.MESSAGE_ORIGIN).map((e) => e.data);
  assert.deepEqual(markers, [{ origin: { kind: "server", reason: "cap_raised" }, text: RAISED, requestId: raised.body.message_id }], JSON.stringify(markers));
  const origins = timeline.messageOrigins(entries);
  const users = entries.filter((e) => e.model?.[0]?.role === "user").map((e) => [textOf(e), origins.get(e)]);
  assert.deepEqual(users.slice(0, 2), [["go", undefined], [RAISED, { kind: "server", reason: "cap_raised" }]], JSON.stringify(users));

  // On the Timeline: the server's row was found, and the person's side holds only their own message.
  const shown = rows.find((r) => r.kind === "phase" && r.summary === `AgentRun: ${RAISED}`);
  assert.ok(shown, `the follow-up shows as the server's: "AgentRun: ${RAISED}" in ${JSON.stringify(rows.map((r) => r.summary))}`);
  assert.equal(shown.text, RAISED);
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), ["You: go"], "never the person's message");
});
