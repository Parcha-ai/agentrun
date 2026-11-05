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
import { agent, follow, scratch, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const FAUX_WEB_HOLD = new URL("./fixtures/faux-web-hold.mjs", import.meta.url).pathname;
const RAISED = "The cap was raised to $5; continue the task.";
const recordOf = (data, runId) => JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8"));
const shown = (rows) => JSON.stringify(rows.map((r) => [r.kind, r.summary]));

/** POST /submit to the run's own door, as serve's submit sends a message, with `origin`. */
async function toDoor(data, runId, body) {
  const door = recordOf(data, runId).holder.serve;
  const token = readFileSync(join(data, "runs", runId, "door-token"), "utf8").trim();
  const res = await fetch(new URL("/submit", door), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The run's store's entries, in order. */
function storeEntries(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
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

for (const harness of ["pi", "claude-agent", "opencode"]) {
  test(`${harness}: a follow-up the server writes (its submit's origin) shows as the server's row, "AgentRun: …", never "You: …"; the model reads its very text`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, fauxWeb: FAUX_WEB_HOLD });
    const go = join(await scratch(t), "go");
    const id = `origin-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, harness === "pi" ? { tools: [] } : { harness, instructions: `Hold the answer until ${go}.`, tools: ["fetch_page"] }))).status, 201);
    const run = await api("POST", `/agents/${id}/runs`, { input: { content: harness === "pi" ? `Hold the answer until ${go}.` : "hi" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const runId = run.body.run_id;
    await follow(api, runId, ["working"], { deadlineMs: 30_000 });
    const sent = await toDoor(data, runId, { requestId: "cap-raise-1", content: RAISED, whenBusy: "followUp", origin: { kind: "server", reason: "cap_raised" } });
    assert.ok(sent.status < 400, `the door took the server's message: ${JSON.stringify(sent)}`);
    await writeFile(go, "");
    const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
    assert.equal(rows.filter((r) => r.kind === "user_message" && r.text === RAISED).length, 0, `no "You:" row for the server's message: ${shown(rows)}`);
    assert.deepEqual(rows.filter((r) => r.kind === "phase" && r.summary?.startsWith("AgentRun:")).map((r) => [r.summary, r.text]), [[`AgentRun: ${RAISED}`, RAISED]], `the server's row: ${shown(rows)}`);
    assert.ok(userTexts(data, runId).includes(RAISED), `the model was given the very text: ${JSON.stringify(userTexts(data, runId))}`);
    // pi's marker is an entry with no model message, so it never reaches the model's context; a harness run's entry
    // carries the origin itself and writes none.
    const markers = storeEntries(data, runId).filter((e) => e.kind === "agentrun.message_origin");
    assert.deepEqual(markers.map((e) => [e.model, e.data?.text]), harness === "pi" ? [[undefined, RAISED]] : [], `the marker, for pi alone, with no model message: ${JSON.stringify(markers)}`);
    // What the model is given is every entry's model messages: none names the marker, and the server's text is there once.
    const context = storeEntries(data, runId).flatMap((e) => e.model ?? []);
    assert.ok(!JSON.stringify(context).includes("agentrun.message_origin"), "the model's context holds no marker");
    assert.equal(context.filter((m) => JSON.stringify(m.content).includes(RAISED)).length, 1, "the server's message reaches the model once, as its own user message");
  });
}

test("the door refuses an origin that is not the server's, and writes nothing for it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const go = join(await scratch(t), "go");
  assert.equal((await api("POST", "/agents", agent("origin-bad", { tools: [] }))).status, 201);
  const runId = (await api("POST", "/agents/origin-bad/runs", { input: { content: `Hold the answer until ${go}.` } })).body.run_id;
  await follow(api, runId, ["working"], { deadlineMs: 30_000 });
  for (const [at, origin] of [{ kind: "person" }, { kind: "server" }, { kind: "server", reason: "Cap Raised" }, "server"].entries()) {
    const sent = await toDoor(data, runId, { requestId: `bad-${at}`, content: RAISED, whenBusy: "followUp", origin });
    assert.equal(sent.status, 400, `refused: ${JSON.stringify(origin)} ${JSON.stringify(sent)}`);
  }
  await writeFile(go, "");
  await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  assert.ok(!userTexts(data, runId).includes(RAISED), "nothing written for a refused origin");
});

test("the door's marker kind is the Timeline's: one name for the entry that names a server message's origin", () => {
  assert.equal(typeof disk.MESSAGE_ORIGIN_KIND, "string", "the door names its marker kind");
  assert.equal(disk.MESSAGE_ORIGIN_KIND, timeline.MESSAGE_ORIGIN);
});
