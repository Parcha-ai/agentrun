// A run ends on its turn's end record (pi's settlement of the person's message, the bridge's turn end on claude-agent and
// codex), never on the order of its rows or on when its door read idle. One case per way the row order went wrong, on
// each harness that can take it: pi on the faux model, claude-agent and codex on the faux harness. Every case also
// checks that the first terminal status a poller reads is the run's last. No model, no network.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const WEB_HOLD = new URL("./fixtures/faux-web-hold.mjs", import.meta.url).pathname;
const HELD_EXIT = new URL("./fixtures/faux-harness-held-exit.mjs", import.meta.url).pathname;
const TERMINAL = ["completed", "failed", "cancelled"];
const ADAPTERS = ["claude-agent", "codex"];
const ALL = ["pi", ...ADAPTERS];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a run of a new agent on `harness` whose turn `phrase` scripts: the faux harness reads it from the agent's
 *  instructions, the faux model from the run's first message, so both get it. */
async function start(api, harness, phrase, { id = `${harness}-${Math.random().toString(36).slice(2, 8)}`, tools = [], input = phrase, ...run } = {}) {
  const definition = harness === "pi" ? { tools } : { harness, instructions: phrase, tools };
  assert.equal((await api("POST", "/agents", agent(id, definition))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: input }, ...run });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body.run_id;
}

/** Reads the run every 50 ms until `until(view)`; the view then, and every status read on the way (each change once). */
async function watch(api, runId, until, what, { deadlineMs = 30_000, seen = [] } = {}) {
  for (const end = Date.now() + deadlineMs; ; await sleep(50)) {
    const { body: view } = await api("GET", `/runs/${runId}`);
    if (seen.at(-1) !== view.status) seen.push(view.status);
    if (until(view)) return { view, seen };
    assert.ok(Date.now() < end, `${what}: the run reads ${view.status}/${view.state}, answer ${JSON.stringify(view.result?.final_answer)} (statuses read: ${seen.join(" > ")})`);
  }
}

/** Follows the run to its settled end, then checks the first terminal status read in `seen` is that end. */
async function endsAs(api, runId, seen, status) {
  await follow(api, runId, TERMINAL, { deadlineMs: 60_000 });
  const { body: view } = await api("GET", `/runs/${runId}`);
  assert.equal(view.status, status, JSON.stringify({ error: view.error, result: view.result }));
  const first = seen.find((s) => TERMINAL.includes(s));
  assert.equal(first ?? view.status, view.status, `the first terminal status read is the run's last: ${seen.join(" > ")} > ${view.status}`);
  return view;
}

const terminal = (view) => TERMINAL.includes(view.status);
const rowsOf = async (api, runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows;
const until = async (what, check, ms = 30_000) => {
  for (const end = Date.now() + ms; !(await check()); await sleep(50)) assert.ok(Date.now() < end, what);
};

// ---- a pi turn whose final stop shows no text (#1450, #1453) ------------------------------------------------------

for (const [what, phrase] of [["one empty text block (#1450)", "Answer with one empty text block."], ["only a thinking block (#1453)", "Answer only by thinking."], ["no content at all (#1453)", "Answer with no content."]]) {
  test(`pi: a final stop of the model's own with ${what} completes the run, its answer ""`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t);
    const runId = await start(api, "pi", phrase);
    const { seen } = await watch(api, runId, terminal, "the stop ends the turn");
    const view = await endsAs(api, runId, seen, "completed");
    assert.equal(view.result?.final_answer, "", "the answer is the stop's own text: none");
  });
}

for (const [what, follow_up] of [["only a thinking block", "Now answer only by thinking."], ["no content at all", "Now answer with no content."]]) {
  test(`pi: a follow-up whose final stop has ${what} completes the run with "", never the earlier turn's answer`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t);
    const runId = await start(api, "pi", "hi");
    await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
    assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "On hi: done.");
    assert.equal((await api("POST", `/runs/${runId}/messages`, { content: follow_up })).status, 202);
    const { seen } = await watch(api, runId, (view) => terminal(view) && view.result?.final_answer !== "On hi: done.", "the follow-up's stop ends the run", { seen: [] });
    const view = await endsAs(api, runId, seen, "completed");
    assert.equal(view.result?.final_answer, "", "the follow-up's own answer: no text, and not the earlier answer");
  });
}

// ---- an answerless claude-agent or codex turn (#1424: /compact, a cost-only request) ---------------------------------

for (const harness of ADAPTERS) {
  test(`${harness}: a follow-up whose turn ends with nothing to show (a /compact) completes the run at once, its answer ""`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
    const runId = await start(api, harness, "The second turn answers nothing.", { input: "hi" });
    await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
    assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "/compact" })).status, 202);
    const { seen } = await watch(api, runId, (view) => terminal(view) && view.result?.final_answer !== "Answer 1.", "the answerless turn ends the run", { deadlineMs: 20_000 });
    const view = await endsAs(api, runId, seen, "completed");
    assert.equal(view.result?.final_answer, "", "the turn's own answer: none, never the earlier turn's");
  });
}

// ---- a cancel and the run's end ---------------------------------------------------------------------------------------

for (const harness of ADAPTERS) {
  test(`${harness}: a cancel after the turn's answer is in, before the turn is over, ends the run cancelled; it reads cancelled from the 202 on, never completed`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
    const signal = join(await scratch(t), "admitted");
    const runId = await start(api, harness, `Answer, then hold a request unanswered (signal ${signal}).`, { input: "hi" });
    await until("the second request is admitted", async () => existsSync(signal));
    await until("the answer's row is in", async () => (await rowsOf(api, runId)).some((r) => r.kind === "final_answer" && r.text === "Done."));
    const seen = [(await api("GET", `/runs/${runId}`)).body.status];
    const cancel = await api("POST", `/runs/${runId}/cancel`, {});
    assert.deepEqual([cancel.status, cancel.body.cancel_requested, cancel.body.already_terminal, cancel.body.status], [202, true, false, "cancelled"], JSON.stringify(cancel.body));
    seen.push(cancel.body.status);
    await watch(api, runId, terminal, "the cancel ends the run", { seen });
    const view = await endsAs(api, runId, seen, "cancelled");
    assert.equal(view.result, null, JSON.stringify(view.result));
  });

  test(`${harness}: a cancel, then a cost that takes the run over its cap, ends the run cancelled, never failed first`, { timeout: 90_000 }, async (t) => {
    // The run's process cannot exit until the gate's file exists: the server reads the cost its cut turn writes on the
    // way out while that process still lives.
    const dir = await scratch(t);
    const [signal, gate] = [join(dir, "admitted"), join(dir, "gate")];
    withEnv(t, { EXIT_GATE: gate });
    const { api } = await serve(t, { harnessTable: fauxTable(HELD_EXIT) });
    const runId = await start(api, harness, `Answer, then hold a request the cancel cuts and books (signal ${signal}).`, { input: "hi", max_cost_usd: 0.001 });
    await until("the second request is admitted", async () => existsSync(signal));
    await until("the answer's row is in, under the cap", async () => (await rowsOf(api, runId)).some((r) => r.kind === "final_answer" && r.text === "Done."));
    const seen = [(await api("GET", `/runs/${runId}`)).body.status];
    assert.equal(seen[0], "working", "under the cap until the cancel");
    const cancel = await api("POST", `/runs/${runId}/cancel`, {});
    assert.deepEqual([cancel.status, cancel.body.cancel_requested], [202, true], JSON.stringify(cancel.body));
    seen.push(cancel.body.status);
    await watch(api, runId, terminal, "the cancel ends the run", { seen });
    // The cost the cut request books on the way out, over the cap, while the process is held.
    await until("the cut request's cost is in", async () => ((await api("GET", `/runs/${runId}`)).body.cost?.usd ?? 0) > 0.001);
    await watch(api, runId, () => true, "", { seen });
    await writeFile(gate, "");
    const view = await endsAs(api, runId, seen, "cancelled");
    assert.ok(typeof view.cost?.usd === "number" && view.cost.usd > 0.001, `the case: the cut request's cost came in after the cancel, over the cap: ${JSON.stringify(view.cost)}`);
  });
}

test("pi: a cancel while a turn holds on a tool ends the run cancelled from the 202 on, never completed", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { fauxWeb: WEB_HOLD });
  const dir = await scratch(t);
  const runId = await start(api, "pi", `Fetch the pages held until ${join(dir, "one")} and ${join(dir, "two")}.`, { tools: ["web_fetch"] });
  await until("the turn holds on its first fetch", async () => (await rowsOf(api, runId)).some((r) => r.kind === "tool_use"));
  const seen = [(await api("GET", `/runs/${runId}`)).body.status];
  const cancel = await api("POST", `/runs/${runId}/cancel`, {});
  assert.deepEqual([cancel.status, cancel.body.cancel_requested, cancel.body.status], [202, true, "cancelled"], JSON.stringify(cancel.body));
  seen.push(cancel.body.status);
  await writeFile(join(dir, "one"), "");
  await watch(api, runId, terminal, "the cancel ends the run", { seen });
  await endsAs(api, runId, seen, "cancelled");
});

// ---- an answerless turn after failing parallel calls ----------------------------------------------------------------

for (const harness of ALL) {
  test(`${harness}: a turn whose two parallel calls fail and that then stops with no text ends the run, never working for good`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
    // On claude-agent the answer's cost comes in after its calls ran, as the Claude CLI's does: results before calls.
    const phrase = harness === "claude-agent" ? "Fetch two pages at once and both fail (booked late), then stop." : "Fetch two pages at once and both fail, then stop.";
    const runId = await start(api, harness, phrase);
    await until("both calls fail", async () => (await rowsOf(api, runId)).filter((r) => r.kind === "tool_result" && r.tool_status === "failed").length >= 2);
    const { seen } = await watch(api, runId, terminal, "the turn's end ends the run");
    const view = await endsAs(api, runId, seen, "completed");
    assert.equal(view.result?.final_answer, "", "the turn said nothing");
  });
}

// ---- a turn the harness itself ends interrupted (no stop, no cancel) -------------------------------------------------

for (const harness of ADAPTERS) {
  test(`${harness}: a turn the harness ends interrupted with no stop or cancel waits for the person (input_required), never working for good; a message goes on`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
    const runId = await start(api, harness, "The turn ends interrupted.", { input: "hi", tools: ["read"] });
    const { seen } = await watch(api, runId, (view) => view.status === "input_required" || terminal(view), "the interrupted turn moves the run");
    assert.equal(seen.at(-1), "input_required", seen.join(" > "));
    assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Go on." })).status, 202);
    await watch(api, runId, terminal, "the next turn ends the run", { seen });
    await endsAs(api, runId, seen, "completed");
  });
}

// ---- a failed turn with a message queued behind it ----------------------------------------------------------------

// The run's status is its last turn's end: the queued message's turn ran and completed, so the run completed, and the
// failed turn stays in its timeline as history, as an error in a chat followed by a good answer does.
for (const harness of ADAPTERS) {
  test(`${harness}: a turn that fails with a message queued behind it, whose own turn then completes, ends the run completed with that turn's answer; the failure stays in the timeline`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxWeb: WEB_HOLD });
    const go = join(await scratch(t), "go");
    const runId = await start(api, harness, `Fail a turn held until ${go}, with a follow-up behind it.`, { input: "hi", tools: ["web_fetch"] });
    // Held on its fetch until `go` exists: the follow-up waits its place behind it.
    await watch(api, runId, (view) => view.status === "working" && view.state === "working", "the first turn works");
    await until("the first turn has the person's message", async () => (await rowsOf(api, runId)).some((r) => r.kind === "user_message"));
    const sent = await api("POST", `/runs/${runId}/messages`, { content: "and then?" });
    assert.deepEqual([sent.status, sent.body.mode], [202, "follow_up"], JSON.stringify(sent.body));
    await writeFile(go, "");
    const { seen } = await watch(api, runId, terminal, "the queued turn ends the run");
    const view = await endsAs(api, runId, seen, "completed");
    assert.equal(view.result?.final_answer, "Answer 2.", "the last turn's answer");
    const rows = await rowsOf(api, runId);
    assert.ok(rows.some((r) => r.kind === "error" && String(r.text ?? r.summary).includes("the faux turn failed")), `the failed turn stays in the timeline: ${JSON.stringify(rows.map((r) => [r.kind, r.summary]))}`);
    assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), ["You: hi", "You: and then?"]);
  });
}

// ---- a working turn's liveness -----------------------------------------------------------------------------------

for (const harness of ALL) {
  test(`${harness}: a run working through a long tool phase shows its last progress, advancing as the turn writes, and none once it ends`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), fauxWeb: WEB_HOLD });
    const dir = await scratch(t);
    const [one, two] = [join(dir, "one"), join(dir, "two")];
    const runId = await start(api, harness, `Fetch the pages held until ${one} and ${two}.`, { tools: ["web_fetch"] });
    // Held on the first fetch: once its request's start is in, the turn writes nothing until the fetch ends, so the last
    // progress holds still (read twice, 300 ms apart).
    let held;
    await watch(api, runId, (view) => view.status === "working" && typeof view.last_progress_at === "string", "the run shows its last progress");
    for (let tries = 0; ; tries++) {
      const before = (await api("GET", `/runs/${runId}`)).body.last_progress_at;
      await sleep(300);
      held = (await api("GET", `/runs/${runId}`)).body;
      if (held.last_progress_at === before && held.status === "working") break;
      assert.ok(tries < 50, `the last progress holds still while the fetch holds: ${before} then ${held.last_progress_at}`);
    }
    const first = Date.parse(held.last_progress_at);
    assert.ok(Number.isFinite(first) && first <= Date.now(), JSON.stringify(held.last_progress_at));
    await writeFile(one, "");
    const { view: moved } = await watch(api, runId, (view) => typeof view.last_progress_at === "string" && Date.parse(view.last_progress_at) > first, "the first fetch's end moves the last progress");
    assert.equal(moved.status, "working", "still working: the second fetch holds");
    await writeFile(two, "");
    const { seen } = await watch(api, runId, terminal, "the turn ends");
    const view = await endsAs(api, runId, seen, "completed");
    assert.equal(view.last_progress_at, null, "an ended run has no turn in progress");
  });
}

// ---- a drain cuts a claude-agent turn (the server restarts): it is resumed, not read as a stop ---------------------

test("claude-agent: a turn the server's restart drains mid-way is resumed by the next server and ends completed, never input_required", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const go = join(dir, "go");
  const options = { data, port: 0, faux: FAUX, harnessTable: fauxTable(FAUX_HARNESS), drainTimeout: "2s" };
  const one = await startServe(options);
  let closed = false;
  t.after(() => (closed ? undefined : one.close()));
  let api = client(one.baseUrl, one.token);
  const runId = await start(api, "claude-agent", `Hold mid-turn until ${go}.`, { input: "hi", tools: ["read"] });
  await until("the turn holds after its read", async () => (await rowsOf(api, runId)).some((r) => r.kind === "tool_result"));
  await one.close();
  closed = true;
  await writeFile(go, "");
  const two = await startServe(options);
  t.after(() => two.close());
  api = client(two.baseUrl, two.token);
  const { seen } = await watch(api, runId, (view) => terminal(view) || view.status === "input_required", "the next server resumes the turn", { deadlineMs: 90_000 });
  const view = await endsAs(api, runId, seen, "completed");
  assert.equal(view.result?.final_answer, "Resumed and done.");
});
