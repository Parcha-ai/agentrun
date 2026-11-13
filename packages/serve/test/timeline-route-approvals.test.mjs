// On the runner, the timeline route (GET /runs/{id}/timeline, the rows a client follows) reads each call that waits for a
// person's approval as the run view does (store-view.ts timelineOverStore): the call, then exactly one approval row for it.
// And with accounts off no one can approve: an ask is refused at once in words (tool-gate.ts noApproverText), never
// parked, while an agent whose approvals are "never" runs its clean ask.
import assert from "node:assert/strict";
import { test } from "node:test";
import { noApproverText } from "../dist/tool-gate.js";
import { fauxTable } from "./fixtures/faux-table.mjs";
import { agent, follow, serve } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), harnessTable: fauxTable(fixture("faux-gate.mjs")), fauxWeb: fixture("faux-gate-web.mjs") };
const PAGE = "http://public.example/";

/** Agent `id` on pi granted web_fetch (and `extra`), and one run of it told to fetch PAGE once. */
async function fetching(api, id, extra = {}) {
  const ask = `Fetch ${PAGE} once.`;
  const made = await api("POST", "/agents", agent(id, { harness: "pi", instructions: ask, tools: ["web_fetch"], ...extra }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: ask } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

test("a pi call set to ask: the timeline route reads the call, then exactly one approval row for it, while the run waits", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { ...GATE, accounts: true, openSetup: true });
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const runId = await fetching(api, "asking");
  const { rows } = await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.pending?.kind, "approval", JSON.stringify(view.pending));
  const asked = rows.filter((row) => row.kind === "tool_approval_requested");
  assert.deepEqual(asked.map((row) => row.tool_name), ["web_fetch"], `exactly one approval row: ${JSON.stringify(rows.map((r) => [r.kind, r.summary]))}`);
  const call = rows.find((row) => row.kind === "tool_use" && row.tool_name === "web_fetch");
  assert.ok(call, "the call's own row");
  assert.equal(asked[0].tool_use_id, call.tool_use_id, "the approval row is the call's");
  assert.ok(rows.indexOf(call) < rows.indexOf(asked[0]), "the call, then its approval");
});

test("accounts off: no one can approve, so an ask is refused at once in words and never parked; an agent that never asks runs its clean ask", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { ...GATE, accounts: false, openSetup: false });
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const refused = await fetching(api, "refused");
  const { last } = await follow(api, refused, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  const answer = (await api("GET", `/runs/${refused}`)).body;
  assert.ok(answer.pending == null, `nothing waits for an approval: ${JSON.stringify(answer.pending)}`);
  assert.ok(String(answer.result?.final_answer ?? "").includes(noApproverText("web_fetch")), `the model read the refusal: ${answer.result?.final_answer}`);
  const unattended = await fetching(api, "unattended", { approvals: "never" });
  const ran = await follow(api, unattended, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(ran.last.status, "completed", JSON.stringify(ran.last));
  const done = (await api("GET", `/runs/${unattended}`)).body;
  assert.ok(!String(done.result?.final_answer ?? "").includes("no one can give it"), `never runs the clean ask: ${done.result?.final_answer}`);
});
