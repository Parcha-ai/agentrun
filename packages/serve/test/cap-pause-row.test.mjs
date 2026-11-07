// A run paused at its cap says the cap's sentence once, in its banner (pending.said). Its timeline's row for the refusal is
// the server's phase row, "Paused at the run's cap" (origin server, its id ending ":note", so no message: isMessageRow),
// marked `paused`, never a failure's error row, and the waiting row follows it;
// raised, the run goes on and the phase row stays as history before the follow-up's message. A run its cap refuses for
// good fails, and its refusal's row stays an error row. The row is the same live, on a full re-read of the timeline, and
// from a server started again: it is the refusal's own, never read from the run's status.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { isMessageRow, NOTE_SUFFIX } from "@parcha/pi-durable-agent/timeline";
import { startServe } from "../dist/index.js";
import { agent, client, follow, letGo, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

/** The tests' faux model priced on output only, $100 a million: a request's least (1,024 tokens) is $0.1024. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
/** The same price with no output ceiling: the cap refuses every request for good. */
const NO_CEILING = new URL("./fixtures/faux-no-ceiling.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const ENDED = ["completed", "failed", "cancelled"];
const PAUSED = "Paused at the run's cap";
const WAITING = "Waiting for you to raise the cap";
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
/** Every row of the run's timeline, read from its start: a full re-read. */
const reread = async (api, runId, until) => (await follow(api, runId, until)).rows;

/** A paused run's rows: no error row, the refusal's phase row then the waiting row, and the banner's sentence on none. */
function pausedRows(rows, said, where) {
  assert.deepEqual(rows.filter((row) => row.kind === "error").map((row) => row.kind), [], `${where}: no error row: ${JSON.stringify(rows.filter((row) => row.kind === "error"))}`);
  const at = rows.findIndex((row) => row.paused === true);
  const pause = rows[at];
  assert.deepEqual([pause?.kind, pause?.origin, pause?.id?.endsWith(NOTE_SUFFIX), pause?.summary, pause?.text, isMessageRow(pause ?? { kind: "" })], ["phase", "server", true, PAUSED, PAUSED, false], `${where}: the refusal's row: ${JSON.stringify(pause)}`);
  const next = rows.slice(at + 1).find((row) => row.kind !== "usage");
  assert.deepEqual([next?.kind, next?.summary, Object.hasOwn(next ?? {}, "paused"), next?.origin, isMessageRow(next ?? { kind: "" })], ["waiting", WAITING, false, undefined, false], `${where}: the waiting row after it: ${JSON.stringify(next)}`);
  const told = rows.filter((row) => [row.summary, row.text].some((words) => words?.includes(said) || words?.includes("Raise the cap")));
  assert.deepEqual(told.map((row) => row.kind), [], `${where}: the banner's sentence is on no row: ${JSON.stringify(told)}`);
  return [pause.id, pause.kind, pause.origin, pause.summary, pause.text, next.id, next.kind, next.summary];
}

test("a run paused at its cap: its refusal's row is a phase row, \"Paused at the run's cap\", never an error row, and the banner's sentence is on no row; live, on a full re-read, and from a server started again", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  let server = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  t.after(() => server?.close());
  let api = client(server.baseUrl, server.token);
  assert.equal((await api("POST", "/agents", agent("paused-row"))).status, 201);
  const { run_id } = (await api("POST", "/agents/paused-row/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
  const live = (await follow(api, run_id, SETTLED)).rows;
  const run = await view(api, run_id);
  assert.deepEqual([run.status, run.state, run.error, run.pending?.kind], ["input_required", "waiting", null, "budget"], JSON.stringify(run));
  const shown = pausedRows(live, run.pending.said, "live");
  assert.deepEqual(pausedRows(await reread(api, run_id, SETTLED), run.pending.said, "a full re-read"), shown);
  await letGo(data, run_id);
  await server.close();
  server = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  api = client(server.baseUrl, server.token);
  const again = await view(api, run_id);
  assert.deepEqual([again.status, again.pending?.said], ["input_required", run.pending.said], JSON.stringify(again));
  assert.deepEqual(pausedRows(await reread(api, run_id, SETTLED), run.pending.said, "a server started again"), shown);
});

test("raised, a paused run goes on: the pause's phase row stays as history, its waiting row goes, and the follow-up's message comes after it; live and on a full re-read", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("raised-row"))).status, 201);
  const { run_id } = (await api("POST", "/agents/raised-row/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
  await follow(api, run_id, SETTLED);
  assert.equal((await view(api, run_id)).pending?.kind, "budget", "paused at its cap");
  assert.equal((await api("PATCH", `/runs/${run_id}`, { max_cost_usd: 1 })).status, 200);
  const live = (await follow(api, run_id, ENDED, { deadlineMs: 60_000 })).rows;
  assert.deepEqual([(await view(api, run_id)).status, (await view(api, run_id)).error], ["completed", null]);
  for (const [where, rows] of [["live", live], ["a full re-read", await reread(api, run_id, ENDED)]]) {
    assert.deepEqual(rows.filter((row) => row.kind === "error").map((row) => row.kind), [], `${where}: no error row: ${JSON.stringify(rows.filter((row) => row.kind === "error"))}`);
    const order = rows.filter((row) => row.paused === true || isMessageRow(row) || row.kind === "waiting").map((row) => [row.kind, row.paused === true ? row.summary : row.text, row.origin ?? null, row.paused === true ? row.id.endsWith(NOTE_SUFFIX) : isMessageRow(row)]);
    // The pause's row stays as the server's, no message, between the person's message and the raise's follow-up.
    assert.deepEqual(order, [["user_message", "Write one.md", null, true], ["phase", PAUSED, "server", true], ["phase", "The cap was raised to $1; continue the task.", "server", true]], `${where}: ${JSON.stringify(order)}`);
  }
});

test("a run its cap refuses for good (a model with no output ceiling) fails: its refusal's row stays an error row, unmarked, and no pause row is shown; live and on a full re-read", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { faux: NO_CEILING });
  assert.equal((await api("POST", "/agents", agent("refused-row"))).status, 201);
  const { run_id } = (await api("POST", "/agents/refused-row/runs", { input: { content: "Write one.md" }, max_cost_usd: 1 })).body;
  const live = (await follow(api, run_id, SETTLED)).rows;
  const run = await view(api, run_id);
  assert.deepEqual([run.status, run.error?.code, run.pending], ["failed", "spend_cap_reached", null], JSON.stringify(run));
  for (const [where, rows] of [["live", live], ["a full re-read", await reread(api, run_id, ENDED)]]) {
    const errors = rows.filter((row) => row.kind === "error");
    assert.deepEqual(errors.map((row) => [row.kind, Object.hasOwn(row, "paused")]), [["error", false]], `${where}: ${JSON.stringify(errors)}`);
    assert.match(errors[0].text, /^spend_cap_reached: Not sent: the next model request's model has no output ceiling here/, where);
    assert.deepEqual(rows.filter((row) => row.paused === true || row.kind === "waiting").map((row) => row.kind), [], `${where}: no pause row`);
  }
});

/** The output-priced faux model in a process that cannot exit until EXIT_GATE exists: a paused run's let-go held open. */
const SLOW_EXIT = new URL("./fixtures/faux-output-priced-slow-exit.mjs", import.meta.url).pathname;

test("raised while its paused process is still being let go (a live process still feeding its timeline), the run shows no waiting row on a fresh full read: at once, once it completes, and from a server started again", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const gate = join(dir, "exit");
  withEnv(t, { EXIT_GATE: gate });
  const data = join(dir, "agents");
  let server = await startServe({ data, port: 0, faux: SLOW_EXIT, drainTimeout: "30s" });
  t.after(() => server?.close());
  let api = client(server.baseUrl, server.token);
  assert.equal((await api("POST", "/agents", agent("held-raise"))).status, 201);
  const { run_id } = (await api("POST", "/agents/held-raise/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
  await follow(api, run_id, SETTLED);
  assert.equal((await view(api, run_id)).pending?.kind, "budget", "paused at its cap");
  const waitingRows = async () => (await api("GET", `/runs/${run_id}/timeline`)).body.rows.filter((row) => row.kind === "waiting").map((row) => row.id);
  assert.equal((await waitingRows()).length, 1, "paused: its waiting row");
  // Its process told to go and held there: the raise lands while that live process still feeds the timeline.
  const pid = runRecordOf(data, run_id).holder.pid;
  assert.ok(processAlive(pid), "the paused run's process is still being let go");
  assert.equal((await api("PATCH", `/runs/${run_id}`, { max_cost_usd: 1 })).status, 200);
  assert.deepEqual(await waitingRows(), [], "raised, its process still live: no waiting row");
  writeFileSync(gate, "");
  await follow(api, run_id, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  assert.equal((await view(api, run_id)).status, "completed");
  assert.deepEqual(await waitingRows(), [], "completed: no waiting row");
  await server.close();
  server = await startServe({ data, port: 0, faux: SLOW_EXIT, drainTimeout: "5s" });
  api = client(server.baseUrl, server.token);
  assert.deepEqual(await waitingRows(), [], "a server started again: no waiting row");
});
