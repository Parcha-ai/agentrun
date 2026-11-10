// ask_person with the browser open, on the runner. A pi run that browses and then asks the person waits for their answer
// IN its claim, as the browser's hand-over does, never parked: a park lets the claim go, and its release lets the browser
// go with it (the viewer row dropped, GET /computer "none", the page lost, a fresh session on the answer). While it waits
// the store keeps its viewer row, the owner's GET /computer answers live, the run reads input_required/waiting on its
// question with its claim held, and the person's time is held on the run's ledger (personHands.wait, the hand-over's
// mechanism). The answer resumes it on the SAME session (one create at the vendor, no fresh-session notice), and its end
// still lets the browser go and drains its release before the seal. A run with nothing open parks on ask_person as before.
// Through the server and its in-process runner, on the faux model and the faux browser: no network, no key.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { builtConsole, call, cookieOf, follow, scratch, serve, withEnv } from "./support.mjs";

const { journalRecords } = await import("../dist/runner/journal-reader.js");

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const BROWSE_ASK_BROWSE = new URL("./fixtures/faux-browse-ask-browse.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY", "FAUX_BROWSER_LOG"];
const json = { "content-type": "application/json" };
/** A test password, no real one. */
const PASSWORD = ["not-a-secret", "owner"].join("-");
/** The run's ledger hold for the person's time while it waits with its browser open (browser-person.ts WAIT_WHAT). */
const WAIT_HOLD = "paid:keeping the browser open while you answer";

const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A signed-in owner's server with the faux browser, and a run of an agent with the browser and ask_person on `input`. */
async function asking(t, input) {
  const log = join(await scratch(t), "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project", FAUX_BROWSER_LOG: log }, KEYS);
  const server = await serve(t, { accounts: true, openSetup: true, console: await builtConsole(t), fauxBrowser: FAUX_BROWSER, faux: BROWSE_ASK_BROWSE });
  const origin = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  assert.equal((await server.api("POST", "/agents", { definition: { id: "watch", name: "watch", instructions: "Browse, then ask.", tools: ["browser", "ask_person"] } })).status, 201);
  const started = await server.api("POST", "/agents/watch/runs", { input: { content: input } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const computer = async () => (await call(server.port, { path: `/v2/runs/${runId}/computer`, headers: { cookie } })).json;
  const records = () => journalRecords(server.store.readJournal(runId), ctx);
  const ops = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { server, runId, computer, records, ops };
}

test("ask_person with the browser open waits in the claim: viewer row kept, GET /computer live, input_required with the claim held and the person's time held; the answer resumes on the same session; the end still drains the browser before the seal", { timeout: 180_000 }, async (t) => {
  const w = await asking(t, "Browse the example page.");
  await follow(w.server.api, w.runId, ["input_required"]);
  // Settled one way or the other: the run parked (its claim let go), or it waits in its claim with the person's time held.
  const settled = await until(async () => {
    const row = await w.server.store.runs.get(w.runId);
    if (row.state !== "running") return { row };
    const held = (await w.records()).entries.some((entry) => entry.kind === "runner.request" && entry.data?.model === WAIT_HOLD);
    return held && { row, held };
  }, "the run's park, or its wait in the claim with the person's time held");

  // (a) While it waits: the claim held, the viewer row kept, the owner's live view live, the run waiting on its question.
  assert.equal(settled.row.state, "running", `the run waits in its claim, never parked: ${JSON.stringify({ state: settled.row.state, summary: settled.row.summary })}`);
  assert.notEqual(settled.row.runner, null, "its claim is held");
  assert.ok(settled.held, "the person's time is held on the run's ledger");
  const viewers = await w.server.store.liveViewers.of(w.runId);
  assert.equal(viewers.length, 1, `the store keeps the run's viewer row: ${viewers.length}`);
  const live = await w.computer();
  assert.equal(live.state, "live", `the owner's GET /computer answers live while the run waits: ${JSON.stringify({ state: live.state, kind: live.kind })}`);
  const view = await w.server.api("GET", `/runs/${w.runId}`);
  assert.equal(view.body.status, "input_required", JSON.stringify({ status: view.body.status, state: view.body.state }));
  assert.equal(view.body.state, "waiting");
  assert.equal(view.body.pending?.kind, "question", JSON.stringify(view.body.pending));
  assert.deepEqual(w.ops().filter((op) => op.op === "release").map((op) => op.id), [], "nothing released at the vendor while it waits");

  // (b) The answer resumes it on the same session: its snapshot runs there, with no fresh-session notice, and the vendor
  // made one session in all.
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "Yes, go on." })).status, 202);
  const { rows } = await follow(w.server.api, w.runId, ["completed", "failed"]);
  const answer = rows.map((row) => JSON.stringify(row)).find((text) => text.includes("Saw again:"));
  assert.ok(answer, `the agent browsed again on the answer: ${JSON.stringify(rows.map((row) => row.kind))}`);
  assert.doesNotMatch(answer, /fresh session|previous browser session/i, "the session and its page were kept, no fresh session");
  const created = w.ops().filter((op) => op.op === "create");
  assert.equal(created.length, 1, `one session at the vendor across the wait: ${JSON.stringify(created.map((op) => op.id))}`);

  // (d) Its end lets the browser go: released at the vendor, the viewer row gone, the release task done before the seal,
  // and the person's time let go.
  const ended = await until(async () => {
    const row = await w.server.store.runs.get(w.runId);
    return row.state === "ended" && row.runner === null && row;
  }, "the run's end, its claim let go");
  assert.equal(ended.state, "ended");
  assert.deepEqual(w.ops().filter((op) => op.op === "release").map((op) => op.id), [created[0].id], "the one session released at the end");
  assert.deepEqual(await w.server.store.liveViewers.of(w.runId), [], "the viewer row is gone with the run");
  const { tasks } = await w.records();
  const releases = tasks.filter((task) => task.kind === "browser.release");
  assert.ok(releases.length >= 1, `the release task is in the journal: ${JSON.stringify(tasks.map((task) => task.kind))}`);
  assert.ok(releases.every((task) => task.state?.status === "terminal" && task.state.outcome?.status === "completed"), `each completed before the seal: ${JSON.stringify(releases.map((task) => task.state))}`);
});

test("ask_person with the browser granted but no session open parks as before: parked, its claim let go, input_required on its question", { timeout: 180_000 }, async (t) => {
  const w = await asking(t, "Ask first.");
  const row = await until(async () => {
    const now = await w.server.store.runs.get(w.runId);
    return ["parked", "ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's park");
  assert.equal(row.state, "parked", JSON.stringify({ state: row.state, summary: row.summary }));
  const view = await w.server.api("GET", `/runs/${w.runId}`);
  assert.equal(view.body.status, "input_required");
  assert.equal(view.body.pending?.kind, "question", JSON.stringify(view.body.pending));
  assert.equal(w.ops().filter((op) => op.op === "create").length, 0, "no session was opened");
  assert.equal((await w.records()).entries.some((entry) => entry.kind === "runner.request" && entry.data?.model === WAIT_HOLD), false, "no person time held");
  // The answer resumes it from the park, as today.
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "Yes." })).status, 202);
  await follow(w.server.api, w.runId, ["completed"]);
});
