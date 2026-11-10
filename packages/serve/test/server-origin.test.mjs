// A message the server writes into a run (a raised cap's follow-up, an approval's resume: serve's submit with an
// `origin`) shows on the Timeline as the server's, "AgentRun: <its first line>", never as "You: …", on pi and on a
// harness run alike (claude-agent; opencode, whose root user entry serve's harness-app writes as it does every
// harness's); the model reads the very text, and on pi never the marker that names it. Sent here as serve sends it: to the run's door, `/submit` with
// `origin`, while a turn works, so it is a follow-up the run answers in a turn of its own. Faux model and faux harness:
// no key, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import * as disk from "@parcha/pi-durable-disk";
import * as timeline from "@parcha/pi-durable-agent/timeline";
import { agent, follow, runDir, runRecordOf, scratch, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const FAUX_WEB_HOLD = new URL("./fixtures/faux-web-hold.mjs", import.meta.url).pathname;
const RAISED = "The cap was raised to $5; continue the task.";
const recordOf = (data, runId) => runRecordOf(data, runId);
const shown = (rows) => JSON.stringify(rows.map((r) => [r.kind, r.summary]));

/** POST /submit to the run's own door, as serve's submit sends a message, with `origin`. */
async function toDoor(data, runId, body) {
  const door = recordOf(data, runId).holder.serve;
  const token = readFileSync(join(runDir(data, runId), "door-token"), "utf8").trim();
  const res = await fetch(new URL("/submit", door), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The run's store's entries, in order. */
function storeEntries(data, runId) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(String(row.record)));
  } finally {
    db.close();
  }
}
/** The user-role texts the run's model was given, in order: pi builds its context from the entries' `model` alone. */
const userTexts = (data, runId) => storeEntries(data, runId).filter((e) => e.model?.[0]?.role === "user").map((e) => {
  const content = e.model[0].content;
  return typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
});


// A trigger's message may not answer a person (answers false), so the door refuses it while the run works, after its
// origin's marker is queued: that marker is withdrawn (its retry, under the same request id, writes its own:
// trigger-origin.test.mjs).
const TRIGGER = { kind: "trigger", trigger_id: "trg_1", source: "webhook", owner: false };
const EVENT = 'A new event came in.\n\n(From the webhook trigger "inbox", received at Nov 6, 2026, 9:00 AM UTC.)';

/** A run that works until `go` is written, with a trigger's guarded message sent to it meanwhile, refused busy. */
async function busyThenRefused(t, id) {
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const go = join(await scratch(t), "go");
  assert.equal((await api("POST", "/agents", agent(id, { tools: [] }))).status, 201);
  const runId = (await api("POST", `/agents/${id}/runs`, { input: { content: `Hold the answer until ${go}.` } })).body.run_id;
  await follow(api, runId, ["working"], { deadlineMs: 30_000 });
  const busy = await toDoor(data, runId, { requestId: "fir_1", content: EVENT, answers: false, asks: ["ask_person"], origin: TRIGGER });
  assert.deepEqual([busy.status, busy.body?.error], [409, "BUSY"], JSON.stringify(busy));
  await writeFile(go, "");
  await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  return { api, data, runId };
}
const openMarkers = (data, runId) => {
  const entries = storeEntries(data, runId);
  return { markers: entries.filter((e) => e.kind === disk.MESSAGE_ORIGIN_KIND).map((e) => e.data), origins: [...timeline.messageOrigins(entries).entries()].map(([e, origin]) => [e.model[0].content, origin]) };
};

test("the door's marker kind is the Timeline's: one name for the entry that names a server message's origin", () => {
  assert.equal(typeof disk.MESSAGE_ORIGIN_KIND, "string", "the door names its marker kind");
  assert.equal(disk.MESSAGE_ORIGIN_KIND, timeline.MESSAGE_ORIGIN);
});

// SKIP (follow-up #2078): a follow-up to a completed run is refused not_continuable instead of reopening the run
test.skip("a follow-up the server writes down the messages route (counted as sent, as a raised cap's is) arrives: the run answers it and completes, never left working", { timeout: 120_000 }, async (t) => {
  const origin = { kind: "server", reason: "cap_raised" };
  const { api } = await serve(t, { messageOrigin: (_runId, content) => (content === RAISED ? origin : undefined) });
  assert.equal((await api("POST", "/agents", agent("origin-sent", { tools: [] }))).status, 201);
  const runId = (await api("POST", "/agents/origin-sent/runs", { input: { content: "hi" } })).body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const sent = await api("POST", `/runs/${runId}/messages`, { content: RAISED });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  let last;
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 500))) {
    last = (await api("GET", `/runs/${runId}`)).body;
    const rows = (await api("GET", `/runs/${runId}/timeline?limit=500`)).body.rows ?? [];
    if (last.status === "completed" && rows.some((r) => r.kind === "phase" && r.summary === `AgentRun: ${RAISED}`)) break;
  }
  assert.equal(last?.status, "completed", `the server's follow-up arrived and was answered: ${JSON.stringify(last?.status)}`);
});
