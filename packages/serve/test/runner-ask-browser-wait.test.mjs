// ask_person with the browser open, on the runner. A pi run that browses and then asks the person waits for their answer
// IN its claim, as the browser's hand-over does, never parked: a park lets the claim go, and its release lets the browser
// go with it (the viewer row dropped, GET /computer "none", the page lost, a fresh session on the answer). While it waits
// the store keeps its viewer row, the owner's GET /computer answers live, the run reads input_required/waiting on its
// question with its claim held, and the person's time is held on the run's ledger (personHands.wait, the hand-over's
// mechanism). The answer resumes it on the SAME session (one create at the vendor, no fresh-session notice), and its end
// still lets the browser go and drains its release before the seal. A run with nothing open parks on ask_person as before.
// Through the server and its in-process runner, on the faux model and the faux browser: no network, no key.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { builtConsole, call, cookieOf, follow, scratch, serve, withEnv } from "./support.mjs";

const { journalRecords } = await import("../dist/runner/journal-reader.js");

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const BROWSE_ASK_BROWSE = new URL("./fixtures/faux-browse-ask-browse.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY", "FAUX_BROWSER_LOG", "FAUX_BROWSER_PERSON_MS", "AGENTRUN_SEAL_KEY"];
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

/** A signed-in owner's server with the faux browser, and a run of an agent with the browser and ask_person on `input`.
 *  `env`: more of the run's switches (FAUX_BROWSER_PERSON_MS: the person's windows, the wait's bound among them).
 *  `hook`: the server's outbound webhook, set before the run starts. */
async function asking(t, input, env = {}, hook = undefined) {
  const log = join(await scratch(t), "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project", FAUX_BROWSER_LOG: log, ...env }, KEYS);
  const server = await serve(t, { accounts: true, openSetup: true, console: await builtConsole(t), fauxBrowser: FAUX_BROWSER, faux: BROWSE_ASK_BROWSE, webhookPrivateTargets: true });
  const origin = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  // The webhook is a secret write: the owner's own session sets it.
  if (hook) assert.equal((await call(server.port, { method: "PUT", path: "/v2/settings/webhook", headers: { ...json, origin, cookie }, body: { url: hook } })).status, 201);
  assert.equal((await server.api("POST", "/agents", { definition: { id: "watch", name: "watch", instructions: "Browse, then ask.", tools: ["browser", "ask_person"] } })).status, 201);
  const started = await server.api("POST", "/agents/watch/runs", { input: { content: input } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const computer = async () => (await call(server.port, { path: `/v2/runs/${runId}/computer`, headers: { cookie } })).json;
  const records = () => journalRecords(server.store.readJournal(runId), ctx);
  const ops = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { server, runId, computer, records, ops };
}

/** Once the run asked: its park, or its wait in the claim with the person's time held (the hold's ledger entry). */
async function askedAndSettled(w) {
  await follow(w.server.api, w.runId, ["input_required"]);
  return until(async () => {
    const row = await w.server.store.runs.get(w.runId);
    if (row.state !== "running") return { row };
    const held = (await w.records()).entries.some((entry) => entry.kind === "runner.request" && entry.data?.model === WAIT_HOLD);
    return held && { row, held };
  }, "the run's park, or its wait in the claim with the person's time held");
}

/** The run let its browser go cleanly: its one session released at the vendor, its viewer row gone, and each release
 *  task completed before the seal. */
async function browserLetGo(w, what) {
  const created = w.ops().filter((op) => op.op === "create");
  assert.equal(created.length, 1, `${what}: one session at the vendor: ${JSON.stringify(created.map((op) => op.id))}`);
  assert.deepEqual(w.ops().filter((op) => op.op === "release").map((op) => op.id), [created[0].id], `${what}: the session released at the vendor, no orphan`);
  assert.deepEqual(await w.server.store.liveViewers.of(w.runId), [], `${what}: the viewer row is gone`);
  const { tasks } = await w.records();
  const releases = tasks.filter((task) => task.kind === "browser.release");
  assert.ok(releases.length >= 1, `${what}: the release task is in the journal: ${JSON.stringify(tasks.map((task) => task.kind))}`);
  assert.ok(releases.every((task) => task.state?.status === "terminal" && task.state.outcome?.status === "completed"), `${what}: each completed before the seal: ${JSON.stringify(releases.map((task) => task.state))}`);
}
/** The run's row once it is `state` and its claim let go. */
const released = (w, state) => until(async () => {
  const row = await w.server.store.runs.get(w.runId);
  return row.state === state && row.runner === null && row;
}, `the run ${state}, its claim let go`);

test("ask_person with the browser open waits in the claim: viewer row kept, GET /computer live, input_required with the claim held and the person's time held; the answer resumes on the same session; the end still drains the browser before the seal", { timeout: 180_000 }, async (t) => {
  const w = await asking(t, "Browse the example page.");
  // Settled one way or the other: the run parked (its claim let go), or it waits in its claim with the person's time held.
  const settled = await askedAndSettled(w);

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
  assert.equal((await released(w, "ended")).state, "ended");
  await browserLetGo(w, "at the run's end");
});

test("the wait in the claim is bounded as a hand-over is: past the bound the browser is let go, its time booked, and the run parks on its question as before", { timeout: 180_000 }, async (t) => {
  // The person's windows under --faux (browser-person.ts personWindows): the wait's bound, the hand-over's, is 3 s here.
  const w = await asking(t, "Browse the example page.", { FAUX_BROWSER_PERSON_MS: "3000,60000" });
  const parked = await released(w, "parked");
  assert.equal(parked.state, "parked", JSON.stringify({ state: parked.state, summary: parked.summary }));
  await browserLetGo(w, "past the bound");
  const booked = (await w.records()).entries.filter((entry) => entry.kind === "runner.request").map((entry) => entry.data?.model);
  assert.ok(booked.includes(WAIT_HOLD), `the person's time was held on the run's ledger while it waited: ${JSON.stringify(booked)}`);
  assert.ok(booked.includes("paid:this browser session's time"), `the session's time, the wait's included, is booked at its release: ${JSON.stringify(booked)}`);
  assert.equal((await w.computer()).state, "none", "no live view once the browser is let go");
  const view = await w.server.api("GET", `/runs/${w.runId}`);
  assert.equal(view.body.status, "input_required");
  assert.equal(view.body.pending?.kind, "question", JSON.stringify(view.body.pending));
});

for (const [act, state] of [["stop", "stopped"], ["cancel", "stopped"]]) {
  test(`a ${act} while the run waits in its claim ends it cleanly: the browser let go and drained before the seal, no orphan session`, { timeout: 180_000 }, async (t) => {
    const w = await asking(t, "Browse the example page.");
    const settled = await askedAndSettled(w);
    assert.equal(settled.row.state, "running", `the run waits in its claim: ${JSON.stringify({ state: settled.row.state })}`);
    const asked = await w.server.api("POST", `/runs/${w.runId}/${act}`, {});
    assert.ok(asked.status < 300, `${act}: ${asked.status} ${JSON.stringify(asked.body)}`);
    const row = await released(w, state);
    assert.equal(row.state, state);
    await browserLetGo(w, `after the ${act}`);
  });
}

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
  // The answer resumes it from the park, as today; from the answer's row on, the run reads as going on, never as still
  // waiting on its question (a client's runs.wait right after the message returned input_required again).
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "Yes." })).status, 202);
  const answered = await w.server.api("GET", `/runs/${w.runId}`);
  assert.notEqual(answered.body.status, "input_required", `right after the answer: ${JSON.stringify({ status: answered.body.status, state: answered.body.state })}`);
  await follow(w.server.api, w.runId, ["completed"]);
});

test("the wait in the claim tells run.needs_input once, as the park did: a webhook subscriber hears the question while the run's claim is held", { timeout: 180_000 }, async (t) => {
  const got = [];
  const receiver = createServer((req, res) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => { try { got.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* not a message */ } res.writeHead(200).end(); }); });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (receiver.close(resolve), receiver.closeAllConnections())));
  const w = await asking(t, "Browse the example page.", { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, `http://127.0.0.1:${receiver.address().port}/hook`);
  const settled = await askedAndSettled(w);
  assert.equal(settled.row.state, "running", "the run waits in its claim");
  const needs = await until(() => got.find((m) => m.type === "run.needs_input" && m.data.run_id === w.runId), "run.needs_input for the wait");
  assert.deepEqual(needs.data.pending, { kind: "question" }, "it says the run waits on its question");
  const row = await w.server.store.runs.get(w.runId);
  assert.equal(row.state, "running", "told while the claim is held");
  assert.notEqual(row.runner, null);
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "Yes, go on." })).status, 202);
  await released(w, "ended");
  await until(() => got.some((m) => m.type === "run.ended" && m.data.run_id === w.runId), "run.ended");
  assert.equal(got.filter((m) => m.type === "run.needs_input" && m.data.run_id === w.runId).length, 1, "told once for the ask");
});

test("a second question in the same claim is told too: run.needs_input once for each ask while the run waits in its claim", { timeout: 180_000 }, async (t) => {
  const got = [];
  const receiver = createServer((req, res) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => { try { got.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* not a message */ } res.writeHead(200).end(); }); });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (receiver.close(resolve), receiver.closeAllConnections())));
  const w = await asking(t, "Ask twice.", { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, `http://127.0.0.1:${receiver.address().port}/hook`);
  const needs = () => got.filter((m) => m.type === "run.needs_input" && m.data.run_id === w.runId);
  await until(() => needs().length >= 1, "the first question's notice");
  const first = await w.server.store.runs.get(w.runId);
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "Yes." })).status, 202);
  await until(() => needs().length >= 2, "the second question's notice");
  const second = await w.server.store.runs.get(w.runId);
  assert.equal(second.epoch, first.epoch, "both asks in the one claim");
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "Then stop." })).status, 202);
  await released(w, "ended");
  assert.equal(needs().length, 2, "one notice per ask");
});
