// The runs app on fakes: a fake door that emits canned events, and a runs directory built in the test (run.json, a tiny
// store shaped like pi's entries table, work files). No network, no key, no model. Expected rows and headers are written
// by hand from the fixtures, not read back from the code.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { durableProfileStore, readAgentHome, startRun } from "@parcha/pi-durable-agent";
import { foldCalls, groupTimeline } from "@parcha/pi-durable-agent/timeline";
import { PROFILE } from "./agent/app.ts";
import { ensureAgentHome } from "./agent/home.mjs";
import { assistant, call, fakeDoor, makeRun, result, text, transcript, user } from "./fixtures.mjs";
import { startServer } from "./server.mjs";

/** A server over a new agent home made from examples/web/agent; `root` is the home's runs directory. */
async function app(t, options = {}) {
  const tmp = await mkdtemp(join(tmpdir(), "web-test-"));
  const home = await ensureAgentHome(join(tmp, "home"));
  const server = await startServer({ home, ...options });
  t.after(async () => {
    await server.close();
    await rm(tmp, { recursive: true, force: true });
  });
  const get = (path, init) => fetch(server.url + path, init);
  const post = (path, body) => fetch(server.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { home, root: join(home.dir, "runs"), server, get, post, json: async (path) => (await get(path)).json() };
}

/** Read a live run's timeline stream to its end and fold the `rows` messages the way the page does. */
async function liveRows(get, id) {
  const res = await get(`/runs/${id}/timeline`, { headers: { accept: "text/event-stream" } });
  const messages = (await res.text()).trim().split("\n\n").map((block) => ({ event: /^event: (.*)$/m.exec(block)[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) }));
  let rows = [];
  let state;
  let costUsd;
  for (const { event, data } of messages) {
    if (event !== "rows") continue;
    if (data.reset) rows = data.rows;
    else {
      rows = rows.filter((r) => !data.drop.includes(r.id));
      for (const row of data.set) {
        const i = rows.findIndex((r) => r.id === row.id);
        if (i < 0) rows.push(row);
        else rows[i] = row;
      }
    }
    state = data.state;
    costUsd = data.costUsd;
  }
  return { rows: rows.sort((a, b) => a.seq - b.seq), state, costUsd, messages };
}

const fileUrl = (id, path) => `/runs/${id}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
const shape = (rows) => rows.filter((r) => !r.id.includes(":run:")).map((r) => [r.id, r.kind]);

test("runs are the agent home's, listed newest first, with agent, status, times and the cost of a finished run", async (t) => {
  const { home, root, get, json } = await app(t);
  const at = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const oldEnd = at(29);
  await makeRun(home, "old", { status: "done", entries: [user(1, "old one"), assistant(2, [text("ok")])], meta: { createdAt: at(30) }, updatedAt: oldEnd });
  await makeRun(home, "newest", { status: "sleeping", entries: transcript, meta: { title: "Newest run", agent: "Site reporter", createdAt: at(1) } });
  await makeRun(home, "middle", { status: "failed", meta: { createdAt: at(5) } });
  await makeRun(home, "broken", { meta: { createdAt: at(100) } });
  writeFileSync(join(root, "broken", "run.json"), "not json");
  writeFileSync(join(root, "stray-file"), "x");
  mkdirSync(join(root, ".hidden"));
  mkdirSync(join(root, "unindexed"));
  const { runs } = await json("/runs");
  assert.deepEqual(runs.slice(0, 3).map((r) => [r.id, r.status, r.title, r.agent]), [["newest", "sleeping", "Newest run", "Site reporter"], ["middle", "failed", "middle", "Site reporter"], ["old", "done", "old one", "Site reporter"]]);
  assert.equal(runs.length, 4, "the broken run is listed as unknown; a stray file, a dot directory and a directory the runs index does not name are not runs");
  assert.equal((await get("/runs/unindexed")).status, 404);
  assert.equal(runs.find((r) => r.id === "broken").status, "unknown");
  assert.equal(runs.find((r) => r.id === "newest").costUsd, 0.05, "five answers at one cent");
  assert.equal(runs.find((r) => r.id === "old").costUsd, 0.01);
  assert.equal(runs.find((r) => r.id === "old").endedAt, oldEnd);
});

test("a live run's timeline is its door's events as rows, a released run's store gives the same rows, and a sign-in request is a wait", async (t) => {
  const { home, root, get, json } = await app(t);
  const door = await fakeDoor({
    snapshot: transcript.slice(0, 3),
    run: true,
    gapMs: 10,
    batches: [
      [{ type: "message_start", message: { role: "assistant" } }, { type: "message_update", usage: {}, changes: [{ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } }, { type: "thinking_delta", contentIndex: 0, delta: "It sent me to a sign-in form." }] }],
      [{ type: "message_end", entry: transcript[3] }, { type: "tool_execution_start", toolCallId: "c2", toolName: "snapshot", args: {} }, { type: "tool_execution_start", toolCallId: "c3", toolName: "screenshot", args: {} }],
      [{ type: "tool_execution_end", toolCallId: "c2", toolName: "snapshot", entry: transcript[4] }, { type: "tool_execution_end", toolCallId: "c3", toolName: "screenshot", entry: transcript[5] }],
      [{ type: "message_end", entry: transcript[6] }, { type: "tool_execution_end", toolCallId: "c4", toolName: "request_sign_in", entry: transcript[7] }, { type: "entry_appended", entry: transcript[7] }],
      [{ type: "run_end", inputs: [1] }],
    ],
  });
  t.after(() => door.close());
  await makeRun(home, "live", { status: "running", door: door.url });
  await makeRun(home, "after", { status: "sleeping", entries: transcript.slice(0, 8) });
  assert.equal((await json("/runs/live")).busy, "idle", "the history asks a live run's door whether it is working");
  assert.equal((await json("/runs/after")).busy, null);

  const live = await liveRows(get, "live");
  const stored = await json("/runs/after/timeline");
  assert.deepEqual(shape(live.rows), shape(stored.rows), "live and stored rows have the same ids and kinds");
  assert.equal(live.state, "waiting", "run_end after a sign-in request leaves the run waiting for the person");
  assert.equal(stored.state, "waiting");
  assert.equal(live.costUsd, 0.03, "an entry that arrives twice (message_end, then entry_appended) is counted once");
  assert.equal(stored.costUsd, 0.03);
  assert.equal(live.messages[0].data.reset, true, "the first message carries every row");

  const sent = live.messages.flatMap((m) => (m.data.set ?? m.data.rows ?? []).map((r) => r.id));
  assert.ok(sent.includes("1:live:thinking"), "the streaming thinking is shown while it streams");
  assert.ok(live.messages.some((m) => m.data.drop?.includes("1:live:thinking")), "and replaced by its committed row");
  const waiting = live.rows.find((r) => r.kind === "waiting");
  assert.equal(waiting.summary, "Waiting for you: Sign in to the practice site to read its secure area");
  assert.equal(stored.rows.find((r) => r.kind === "waiting").summary, waiting.summary);
  const goto = live.rows.find((r) => r.tool_use_id === "c1" && r.kind === "tool_use");
  assert.deepEqual([goto.summary, goto.tool_input_preview, goto.tool_name], ['Opened the-internet.herokuapp.com/secure', 'await page.goto("https://the-internet.herokuapp.com/secure")', "run"]);
  assert.equal((await json("/runs/after")).state, "waiting");
});

const ASKED = "Asked the person to sign in to the practice site in the live view; waiting for them to reply done.";
/** The agent's sign-in turn as it is stored: the call alone (no prose), then the tool result that ended the run. */
const asking = [
  user(1, "Log in and report."),
  assistant(2, [call("c1", "request_sign_in", { site: "the practice site", reason: "The secure page needs a sign-in." })]),
  result(3, "c1", "request_sign_in", ASKED, false, { site: "the practice site", reason: "The secure page needs a sign-in." }),
];

test("a turn that ends on request_sign_in is a wait: its own group, the reason, the waiting state, no blank assistant bubble", async (t) => {
  const { home, root, get, post, json } = await app(t);
  const door = await fakeDoor({
    snapshot: asking.slice(0, 1),
    run: true,
    gapMs: 10,
    answer: { entry: 3, text: "" },
    batches: [
      [{ type: "message_end", entry: asking[1] }, { type: "tool_execution_start", toolCallId: "c1", toolName: "request_sign_in", args: {} }],
      [{ type: "tool_execution_end", toolCallId: "c1", toolName: "request_sign_in", entry: asking[2] }],
      [{ type: "run_end", inputs: [1] }],
    ],
  });
  t.after(() => door.close());
  await makeRun(home, "live", { status: "running", door: door.url });
  await makeRun(home, "stored", { status: "sleeping", entries: asking });

  const live = await liveRows(get, "live");
  const stored = await json("/runs/stored/timeline");
  for (const { rows, state } of [live, stored]) {
    assert.equal(state, "waiting");
    const groups = groupTimeline(rows.filter((r) => r.kind !== "usage" && !r.id.includes(":run:")));
    assert.deepEqual(groups.map((g) => (g.type === "row" ? g.row.kind : `calls:${g.calls.map((c) => c.use.tool_name)}`)), ["user_message", "calls:request_sign_in", "waiting"]);
    assert.equal(groups[1].calls[0].result.tool_result_preview, ASKED);
    assert.equal(groups[2].row.summary, "Waiting for you: The secure page needs a sign-in.");
    assert.deepEqual(rows.filter((r) => ["text_block", "final_answer"].includes(r.kind)), [], "no assistant bubble: the turn had no prose");
  }
  assert.equal((await json("/runs/stored")).state, "waiting");
  const sent = await post("/runs/live/messages", { content: "done" });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).answer.text, "", "the door's empty answer on this turn is passed on; the page draws rows, not answers");
});

test("a live run that ended on a successful tool result is waiting; one that is working, answered or failed is not", async (t) => {
  const { home, root, get } = await app(t);
  const ended = [user(1, "File the form."), assistant(2, [call("c1", "submit_form", {})]), result(3, "c1", "submit_form", "Form sent; waiting for the person to approve.")];
  const doors = {
    ended: await fakeDoor({ snapshot: ended }),
    working: await fakeDoor({ snapshot: ended, run: true, hold: false }),
    answered: await fakeDoor({ snapshot: [...ended, assistant(4, [text("Done.")])] }),
    failed: await fakeDoor({ snapshot: [...ended.slice(0, 2), result(3, "c1", "submit_form", "boom", true)] }),
  };
  t.after(() => Promise.all(Object.values(doors).map((d) => d.close())));
  for (const [id, door] of Object.entries(doors)) await makeRun(home, id, { status: "running", door: door.url });
  const states = {};
  for (const id of Object.keys(doors)) states[id] = (await liveRows(get, id)).state;
  assert.deepEqual(states, { ended: "waiting", working: "working", answered: "idle", failed: "idle" });
  const listed = Object.fromEntries((await (await get("/runs")).json()).runs.map((r) => [r.id, r.state]));
  assert.deepEqual(listed, states, "the history shows each live run in the state its page shows");
});

test("rows group the way the page draws them: rounds, pairs by call id, saved files and the final answer", async (t) => {
  const { home, root, json } = await app(t);
  await makeRun(home, "full", { status: "done", entries: transcript });
  const { rows, state } = await json("/runs/full/timeline");
  assert.equal(state, "idle", "the person answered and the agent finished");
  const groups = groupTimeline(rows.filter((r) => r.kind !== "usage"));
  assert.deepEqual(
    groups.map((g) => (g.type === "row" ? g.row.kind : `calls:${g.calls.map((c) => c.use.tool_name)}`)),
    ["user_message", "thinking", "text_block", "phase", "calls:run", "thinking", "calls:snapshot,screenshot", "text_block", "calls:request_sign_in", "waiting", "user_message", "thinking", "calls:write", "phase", "final_answer"],
  );
  assert.deepEqual(rows.filter((r) => r.kind === "phase").map((r) => r.summary), ["Opened a live browser session", "Saved notes.md"]);
  assert.equal(rows.find((r) => r.summary === "Saved notes.md").path, "notes.md", "the page links a saved file by its path, not by its summary");
  const round = groups[6];
  assert.deepEqual(round.calls.map((c) => [c.use.tool_use_id, c.result.tool_status]), [["c2", "success"], ["c3", "success"]], "each call is paired with its result by id");
  assert.deepEqual(foldCalls(round.calls).map((f) => f.tool), ["snapshot", "screenshot"]);
  assert.equal(rows.find((r) => r.kind === "final_answer").text, "I saved **notes.md**.");
  assert.equal(rows.filter((r) => r.kind === "usage").length, 1);
});

test("a call that never got a result is interrupted in a released run", async (t) => {
  const { home, root, json } = await app(t);
  await makeRun(home, "cut", { status: "sleeping", entries: transcript.slice(0, 4) });
  const { rows } = await json("/runs/cut/timeline");
  const results = rows.filter((r) => r.kind === "tool_result" && ["c2", "c3"].includes(r.tool_use_id));
  assert.deepEqual(results.map((r) => [r.tool_status, r.tool_result_size_bytes]), [["failed", null], ["failed", null]]);
});

test("a person's answer ends the wait: the run is idle again", async (t) => {
  const { home, root, json } = await app(t);
  await makeRun(home, "answered", { status: "sleeping", entries: transcript.slice(0, 9) });
  assert.equal((await json("/runs/answered")).state, "idle");
  await makeRun(home, "asking", { status: "sleeping", entries: transcript.slice(0, 8) });
  assert.equal((await json("/runs/asking")).state, "waiting");
});

test("a live run's store is never opened; a released run's is opened read-only", async (t) => {
  const { home, root, get } = await app(t);
  const door = await fakeDoor();
  t.after(() => door.close());
  const live = await makeRun(home, "live", { status: "running", door: door.url });
  rmSync(join(live, "store"), { recursive: true });
  mkdirSync(join(live, "store"));
  writeFileSync(join(live, "store", "run.sqlite"), "this is not a database");
  const refused = await get("/runs/live/timeline");
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).message, /live/);

  const released = await makeRun(home, "released", { status: "paused", entries: transcript });
  const file = join(released, "store", "run.sqlite");
  const before = statSync(file);
  assert.equal((await get("/runs/released/timeline")).status, 200);
  assert.deepEqual(readdirSync(join(released, "store")), ["run.sqlite"], "no journal or wal file appears");
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(statSync(file).size, before.size);
});

test("files: dotfiles are hidden, nothing outside work/ is reachable, html is sandboxed, other types are downloads", async (t) => {
  const { home, root, get, json } = await app(t);
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const dir = await makeRun(home, "r1", { status: "done", files: { "notes.md": "# Hi", "my report.md": "# Spaced", "data/rows.csv": "a,b\n1,2\n", "report.html": "<h1>x</h1><script>alert(1)</script>", "shot.png": png, "blob.bin": "xx", ".secret": "no", ".git/config": "no", "big.txt": "x".repeat(600 * 1024) } });
  writeFileSync(join(dir, "run.json.bak"), "outside work");
  symlinkSync(join(dir, "run.json"), join(dir, "work", "leak.json"));
  symlinkSync(root, join(dir, "work", "linked"));

  const { files } = await json("/runs/r1/files");
  assert.deepEqual(files.map((f) => f.path), ["big.txt", "blob.bin", "data/rows.csv", "my report.md", "notes.md", "report.html", "shot.png"]);

  for (const bad of [".secret", ".git/config", "../run.json", "sub/../../run.json", "/etc/passwd", "leak.json", "linked/r1/run.json", "data", "nope.txt", "a\0b"]) {
    const res = await get(`/runs/r1/files/${encodeURIComponent(bad)}`);
    assert.equal(res.status, 404, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal((await get("/runs/r1/files/.secret")).status, 404);
  assert.equal((await get("/runs/r1/files/%E0%A4%A")).status, 404, "a bad escape is a miss, not a crash");

  const html = await get(fileUrl("r1", "report.html"));
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  const csp = html.headers.get("content-security-policy");
  assert.ok(csp.startsWith("default-src 'none'; style-src 'unsafe-inline'; img-src data:"), csp);
  assert.match(csp, /\bsandbox\b/);
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  const asDownload = await get(`${fileUrl("r1", "report.html")}?download=1`);
  assert.match(asDownload.headers.get("content-disposition"), /^attachment/);
  assert.equal(asDownload.headers.get("content-type"), "application/octet-stream");

  assert.equal(await (await get(fileUrl("r1", "my report.md"))).text(), "# Spaced", "a name with a space is read back through its escaped path");
  for (const path of ["notes.md", "data/rows.csv"]) assert.equal((await get(fileUrl("r1", path))).headers.get("content-type"), "text/plain; charset=utf-8", path);
  const image = await get(fileUrl("r1", "shot.png"));
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.match(image.headers.get("content-disposition"), /^attachment/);
  const blob = await get(fileUrl("r1", "blob.bin"));
  assert.equal(blob.headers.get("content-type"), "application/octet-stream");
  assert.match(blob.headers.get("content-disposition"), /^attachment/);

  const big = await get(fileUrl("r1", "big.txt"));
  assert.equal(big.headers.get("x-truncated"), "1");
  assert.equal((await big.arrayBuffer()).byteLength, 512 * 1024);
});

test("search finds file contents, file names and a finished run's transcript, and skips dotfiles", async (t) => {
  const { home, root, json } = await app(t);
  await makeRun(home, "a", { status: "done", entries: [user(1, "Find the Quokka report"), assistant(2, [text("The quokka is a marsupial.")])], files: { "notes/animals.txt": "Zebra and QUOKKA live here", ".private": "quokka secret", "quokka-list.csv": "x\n" } });
  await makeRun(home, "b", { status: "done", files: { "other.md": "nothing relevant" } });
  const { results } = await json("/search?q=quokka");
  const keys = results.map((r) => `${r.runId}:${r.kind}:${r.path ?? ""}`).sort();
  assert.deepEqual(keys, ["a:file:notes/animals.txt", "a:file:quokka-list.csv", "a:run:", "a:transcript:", "a:transcript:"].sort(), "the question and the answer both match");
  assert.match(results.find((r) => r.path === "notes/animals.txt").snippet, /Zebra and QUOKKA live here/);
  assert.deepEqual((await json("/search?q=q")).results, [], "one character is not a search");
  assert.deepEqual((await json("/search?q=secret")).results, [], "dotfiles are not searched");
});

test("chat: a message steers while the run is busy and follows up when it is idle; stop aborts; a finished run refuses", async (t) => {
  const { home, root, post } = await app(t);
  const door = await fakeDoor();
  t.after(() => door.close());
  await makeRun(home, "live", { status: "running", door: door.url });
  await makeRun(home, "finished", { status: "done" });
  await makeRun(home, "asleep", { status: "sleeping", entries: transcript });

  assert.equal((await post("/runs/live/messages", { content: "first" })).status, 200);
  door.busy = true;
  assert.equal((await post("/runs/live/messages", { content: "second" })).status, 200);
  assert.deepEqual(door.submits.map((s) => [s.content, s.whenBusy]), [["first", "followUp"], ["second", "steer"]]);
  assert.ok(door.submits.every((s) => /^[\x21-\x7e]{1,200}$/.test(s.requestId) && s.conversationId === undefined));
  assert.notEqual(door.submits[0].requestId, door.submits[1].requestId);
  assert.equal((await post("/runs/live/messages", { content: "  " })).status, 400);

  assert.equal((await post("/runs/live/stop", {})).status, 200);
  assert.equal(door.aborts.length, 1);
  assert.equal((await post("/runs/asleep/stop", {})).status, 200, "stopping a parked run is a no-op");
  assert.equal((await post("/runs/finished/messages", { content: "x" })).status, 409);
  assert.equal((await post("/runs/asleep/messages", { content: "x" })).status, 501, "no start command, so a parked run cannot be woken");
});

test("a request with another Host, another Origin or a form content type is refused", async (t) => {
  const { home, server, root } = await app(t);
  await makeRun(home, "r", { status: "done" });
  const url = new URL(server.url);
  const request = (headers, method = "GET", body) =>
    new Promise((resolve) => {
      const req = httpRequest({ hostname: url.hostname, port: url.port, path: "/runs", method, headers }, (res) => (res.resume(), resolve(res.statusCode)));
      req.end(body);
    });
  assert.equal(await request({ host: `evil.example:${url.port}` }), 403);
  assert.equal(await request({ host: `localhost:${url.port}` }), 200);
  assert.equal(await request({ host: `localhost:${url.port}`, "content-type": "application/json", origin: "http://evil.example" }, "POST", "{}"), 403);
  assert.equal(await request({ host: `localhost:${url.port}`, "content-type": "text/plain" }, "POST", "{}"), 403);
});

test("the live view is a redirect to the host's file; its address never appears in the page's data; the frame key follows the address only", async (t) => {
  const { home, root, get, json } = await app(t);
  const dir = await makeRun(home, "r", { status: "sleeping", live: "https://live.example/view?token=SECRET123" });
  await makeRun(home, "bad", { status: "sleeping", live: "javascript:alert(1)" });
  const summary = await json("/runs/r");
  assert.match(summary.liveView.key, /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(await json("/runs")).includes("SECRET123"));
  assert.ok(!JSON.stringify(summary).includes("live.example"));
  const redirect = await get("/runs/r/live", { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://live.example/view?token=SECRET123");
  assert.equal(redirect.headers.get("cache-control"), "no-store");
  assert.equal((await get("/runs/bad/live", { redirect: "manual" })).status, 404);
  assert.equal((await json("/runs/bad")).liveView, null);

  const live = (url, change) => writeFileSync(join(dir, "live.json"), JSON.stringify({ liveViewUrl: url, sessionId: "s1", change, updatedAt: new Date().toISOString() }));
  live("https://live.example/view?token=SECRET123", "updated");
  assert.equal((await json("/runs/r")).liveView.key, summary.liveView.key, "a rewrite of live.json that keeps the address keeps the frame");
  live("https://live.example/view?token=OTHER456", "launched");
  assert.notEqual((await json("/runs/r")).liveView.key, summary.liveView.key);
  live(null, "released");
  assert.equal((await json("/runs/r")).liveView, null, "a released browser has no live view");
});

test("a new run starts the start command on its own directory and sends the first message to its door; a parked run is woken by a message; close ends only those pids", async (t) => {
  const door = await fakeDoor();
  t.after(() => door.close());
  process.env.FAKE_DOOR = door.url;
  const dir = await mkdtemp(join(tmpdir(), "web-start-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "start.mjs");
  writeFileSync(
    script,
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
mkdirSync(join(dir, "work"), { recursive: true });
const write = (status) => writeFileSync(join(dir, "run.json"), JSON.stringify({ run: "x", status, generation: 2, sealedSeq: null, wakeAt: null, holder: status === "running" ? { driver: "local", host: "h", bootId: null, pid: process.pid, since: new Date().toISOString(), serve: process.env.FAKE_DOOR } : null, heartbeatAt: status === "running" ? new Date().toISOString() : null, updatedAt: new Date().toISOString(), detail: null }));
write("running");
process.on("SIGTERM", () => { write("sleeping"); process.exit(0); });
setInterval(() => {}, 1000);
`,
  );
  const { home, server, root, post, json } = await app(t, { start: [process.execPath, script] });
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => bystander.kill());

  const created = await post("/runs", { content: "Do the thing" });
  assert.equal(created.status, 202);
  const { id } = await created.json();
  assert.match(id, /^[a-z0-9][a-z0-9-]*$/, "an id the agent's start script accepts");
  for (let i = 0; i < 100 && door.submits.length < 1; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(door.submits.map((s) => s.content), ["Do the thing"]);
  const pid = server.children.get(id).pid;
  assert.ok(existsSync(join(root, id, "web.json")));
  const summary = await json(`/runs/${id}`);
  assert.deepEqual([summary.title, summary.agent, summary.live], ["Do the thing", "Site reporter", true]);

  await makeRun(home, "asleep", { status: "sleeping", entries: transcript });
  assert.equal((await post("/runs/asleep/messages", { content: "wake up" })).status, 200);
  assert.deepEqual(door.submits.map((s) => s.content), ["Do the thing", "wake up"]);
  assert.ok(server.children.has("asleep"), "the parked run was started again by the start command");

  await server.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the run's process is gone");
  assert.doesNotThrow(() => process.kill(bystander.pid, 0), "a process that is not a run is left alone");
});

/** A start command that plays a run's instance: run.json running with the door in FAKE_DOOR, sleeping on SIGTERM. */
function fakeInstance(dir) {
  const script = join(dir, "start.mjs");
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const dir = process.argv[2];
const door = process.env.FAKE_DOOR;
// What the run's store holds when it is released: FAKE_ENTRIES names a file of entries, as pi would have committed them.
const commit = () => {
  if (!process.env.FAKE_ENTRIES) return;
  const db = new DatabaseSync(join(dir, "store", "run.sqlite"));
  const insert = db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, ?, ?)");
  for (const entry of JSON.parse(readFileSync(process.env.FAKE_ENTRIES, "utf8"))) insert.run(entry.id, entry.conversationId, entry.id, JSON.stringify(entry));
  db.close();
};
const write = (status) => writeFileSync(join(dir, "run.json"), JSON.stringify({ run: "x", status, generation: 1, sealedSeq: null, wakeAt: null, holder: status === "running" ? { driver: "local", host: "h", bootId: null, pid: process.pid, since: new Date().toISOString(), serve: door } : null, heartbeatAt: status === "running" ? new Date().toISOString() : null, updatedAt: new Date().toISOString(), detail: null }));
write("running");
process.on("SIGTERM", () => { commit(); write("sleeping"); process.exit(0); });
setInterval(() => {}, 1000);
`,
  );
  return script;
}

test("a run that answered is released and carried back once, with the sign-in it made and the answer its store holds; then it is finished; a run waiting for the person is left running", async (t) => {
  const answered = await fakeDoor({ snapshot: transcript, hold: true, busy: true });
  const waiting = await fakeDoor({ snapshot: asking, hold: true });
  t.after(() => Promise.all([answered.close(), waiting.close()]));
  const dir = await mkdtemp(join(tmpdir(), "web-carry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { home, server, post } = await app(t, { start: [process.execPath, fakeInstance(dir)], watchMs: 50 });

  // The door showed the answer when the run was stopped; a follow-up was admitted and answered while it drained, so the
  // released store holds a later answer, and that is the one kept.
  const late = [...transcript, user(13, "And one more thing?"), assistant(14, [text("Here is the late answer.")])];
  writeFileSync(join(dir, "late.json"), JSON.stringify(late));
  process.env.FAKE_DOOR = answered.url;
  process.env.FAKE_ENTRIES = join(dir, "late.json");
  t.after(() => void delete process.env.FAKE_ENTRIES);
  const { id } = await (await post("/runs", { content: "Log in to the practice site and save notes.md" })).json();
  // The run's own sign-in, as the agent app commits it while the run works: a Browserbase context in its store.
  const run = (await readAgentHome(home)).runs[id];
  const harness = await Harness.open(await openNodeSqliteStorage(join(home.dir, run.path, "store", "run.sqlite")), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  await durableProfileStore(harness).resolve(PROFILE, async () => "ctx-signed-in");
  await harness.close(ctx);
  answered.busy = false;
  for (let i = 0; i < 100 && server.children.has(id); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!server.children.has(id), "the run that answered was released");
  let state = await readAgentHome(home);
  for (let i = 0; i < 100 && !state.runs[id].endedAt; i++) await new Promise((r) => setTimeout(r, 50)), (state = await readAgentHome(home));
  assert.deepEqual([state.runs[id].outcome, state.runs[id].finalAnswer, state.runs[id].cost], ["completed", "Here is the late answer.", 0.06]);
  assert.equal(state.profiles[PROFILE].ref, "ctx-signed-in", "the sign-in went back to the agent home");

  // Carried back, the run is finished: a message is refused with a code, and the run is never woken.
  const refused = await post(`/runs/${id}/messages`, { content: "one more?" });
  assert.deepEqual([refused.status, (await refused.json()).error], [409, "RUN_FINISHED"]);
  assert.ok(!server.children.has(id), "a finished run is not started again");
  assert.equal((await (await fetch(`${server.url}/runs/${id}`)).json()).status, "done");
  delete process.env.FAKE_ENTRIES;

  process.env.FAKE_DOOR = waiting.url;
  const second = await (await post("/runs", { content: "Log in again" })).json();
  const next = await startRun(home, { host: "test" });
  assert.deepEqual(next.leases, [], "the waiting run holds the profile's save lease");
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(server.children.has(second.id), "a run waiting for the person keeps its browser and its process");
  assert.equal((await readAgentHome(home)).runs[second.id].endedAt, undefined);
});

test("a request target that is not a URL is answered 400, and the server goes on", async (t) => {
  const { server, json } = await app(t);
  const url = new URL(server.url);
  const answer = await new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => socket.write(`GET http://[ HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`));
    let data = "";
    socket.on("data", (chunk) => (data += chunk)).on("end", () => resolve(data)).on("error", reject);
  });
  assert.match(answer, /^HTTP\/1\.1 400 /);
  assert.deepEqual((await json("/runs")).runs, [], "the server still answers");
});

test("a door address in run.json that is not loopback http is never contacted", async (t) => {
  const { home, root, get, json } = await app(t);
  await makeRun(home, "far", { status: "running", door: "http://203.0.113.9:8080" });
  await makeRun(home, "tls", { status: "running", door: "https://127.0.0.1:9" });
  for (const id of ["far", "tls"]) {
    const summary = await json(`/runs/${id}`);
    assert.deepEqual([summary.live, summary.status, summary.busy], [false, "lost", null], id);
    assert.equal((await get(`/runs/${id}/timeline`, { headers: { accept: "text/event-stream" } })).status, 409, id);
  }
});

test("the page and its timeline module are served; nothing else under /timeline is", async (t) => {
  const { get } = await app(t);
  assert.equal((await get("/")).status, 200);
  assert.match((await get("/")).headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal((await get("/timeline/index.js")).status, 200);
  assert.equal((await get("/timeline/group.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
  for (const path of ["/timeline/../server.mjs", "/timeline/%2e%2e/server.mjs", "/timeline/x.mjs", "/timeline/", "/rows.mjs"]) assert.equal((await get(path)).status, 404, path);
});
