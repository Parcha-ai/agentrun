// The runs app on fakes: a fake door that emits canned events, and a runs directory built in the test (run.json, a tiny
// store shaped like pi's entries table, work files). No network, no key, no model. Expected rows and headers are written
// by hand from the fixtures, not read back from the code.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assistant, call, fakeDoor, makeRun, result, text, thinking, transcript, user } from "./fixtures.mjs";
import { group, labelOf, Timeline } from "./rows.mjs";
import { startServer } from "./server.mjs";

async function app(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "web-test-"));
  const server = await startServer({ runs: root, ...options });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const get = (path, init) => fetch(server.url + path, init);
  const post = (path, body) => fetch(server.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { root, server, get, post, json: async (path) => (await get(path)).json() };
}

/** Read a run's SSE stream to its end and fold the `rows` messages the way the page does. */
async function liveRows(get, id) {
  const res = await get(`/api/runs/${id}/steps`);
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
  return { rows, state, costUsd, messages };
}

const shape = (rows) => rows.map((r) => [r.id, r.kind]);

test("runs are listed newest first, with status, times and the cost of a finished run", async (t) => {
  const { root, json } = await app(t);
  const at = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const oldEnd = at(29);
  makeRun(root, "old", { status: "done", entries: [user(1, "old one"), assistant(2, [text("ok")])], meta: { createdAt: at(30) }, updatedAt: oldEnd });
  makeRun(root, "newest", { status: "sleeping", entries: transcript, meta: { title: "Newest run", createdAt: at(1) } });
  makeRun(root, "middle", { status: "failed", meta: { createdAt: at(5) } });
  mkdirSync(join(root, "broken"));
  writeFileSync(join(root, "broken", "run.json"), "not json");
  writeFileSync(join(root, "broken", "web.json"), JSON.stringify({ createdAt: at(100) }));
  writeFileSync(join(root, "stray-file"), "x");
  mkdirSync(join(root, ".hidden"));
  const { runs } = await json("/api/runs");
  assert.deepEqual(runs.slice(0, 3).map((r) => [r.id, r.status, r.title]), [["newest", "sleeping", "Newest run"], ["middle", "failed", "middle"], ["old", "done", "old one"]]);
  assert.equal(runs.length, 4, "the broken run is listed as unknown; a stray file and a dot directory are not runs");
  assert.equal(runs.find((r) => r.id === "broken").status, "unknown");
  assert.equal(runs.find((r) => r.id === "newest").costUsd, 0.04);
  assert.equal(runs.find((r) => r.id === "old").costUsd, 0.01);
  assert.equal(runs.find((r) => r.id === "old").endedAt, oldEnd);
});

test("a live run's steps are its door's events as rows, and a released run's store gives the same rows", async (t) => {
  const { root, get, json } = await app(t);
  const door = await fakeDoor({
    snapshot: transcript.slice(0, 3),
    run: true,
    gapMs: 10,
    batches: [
      [{ type: "message_end", entry: transcript[3] }, { type: "tool_execution_start", toolCallId: "c2", toolName: "screenshot", args: {} }, { type: "tool_execution_start", toolCallId: "c3", toolName: "run", args: {} }],
      [{ type: "tool_execution_end", toolCallId: "c2", toolName: "screenshot", entry: transcript[4] }, { type: "tool_execution_end", toolCallId: "c3", toolName: "run", entry: transcript[5] }],
      [{ type: "message_end", entry: transcript[6] }, { type: "tool_execution_end", toolCallId: "c4", toolName: "write", entry: transcript[7] }],
      [{ type: "message_end", entry: transcript[8] }, { type: "entry_appended", entry: transcript[8] }],
      [{ type: "run_end", inputs: [1] }],
    ],
  });
  t.after(() => door.close());
  makeRun(root, "live", { status: "running", door: door.url });
  makeRun(root, "after", { status: "sleeping", entries: transcript });
  assert.equal((await json("/api/runs/live")).busy, "idle", "the history asks a live run's door whether it is working");
  assert.equal((await json("/api/runs/after")).busy, null);

  const live = await liveRows(get, "live");
  const stored = await json("/api/runs/after/timeline");
  assert.deepEqual(shape(live.rows), shape(stored.rows), "live and stored rows have the same ids and kinds");
  assert.equal(live.state, "waiting", "run_end alone changes the state, with no row changing");
  assert.equal(stored.state, "waiting");
  assert.equal(live.costUsd, 0.04, "an entry that arrives twice (message_end, then entry_appended) is counted once");
  assert.equal(stored.costUsd, 0.04);
  assert.equal(live.messages[0].data.reset, true, "the first message carries every row");
  const sets = live.messages.flatMap((m) => (m.data.set ?? m.data.rows ?? []).map((r) => r.id));
  assert.ok(sets.indexOf("tc3") >= 0 && sets.indexOf("tc3") < sets.indexOf("rc3"), "the call is shown before its result arrives");

  const items = group(live.rows);
  assert.deepEqual(
    items.map((i) => (i.kind === "group" ? `${i.family}:${i.items.map((x) => x.tool_use_id ?? x.kind).join(",")}` : i.kind)),
    ["user_message", "thinking", "text_block", "Browser:c1,thinking,c2,c3", "thinking", "Files:c4", "phase", "text_block", "waiting"],
  );
  assert.deepEqual(items[3].items.filter((x) => x.status).map((x) => x.status), ["ok", "ok", "ok"], "each call is paired with its result");
  assert.equal(items[3].items[3].result.tool_result_preview, "Clicked 1-9");
  const saved = live.rows.find((r) => r.kind === "phase");
  assert.deepEqual([saved.summary, saved.path], ["Saved notes.md", "notes.md"]);
  const goto = live.rows.find((r) => r.id === "tc1");
  assert.deepEqual([goto.summary, goto.tool_input_preview, goto.tool_name, goto.tool_use_id], ["Opened example.test/login", 'await page.goto("https://example.test/login")', "run", "c1"]);
  assert.equal(live.rows.find((r) => r.id === "tc3").tool_input_preview, "fill 1-4, click 1-9");
  assert.equal(live.rows.find((r) => r.id === "rc3").tool_status, "success");
});

test("a streaming message shows partial rows that its commit replaces, and thinking is timed", () => {
  const timeline = new Timeline();
  timeline.event({ type: "message_start", message: { role: "assistant" } }, 1000);
  timeline.event({ type: "message_update", usage: {}, changes: [{ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } }, { type: "thinking_delta", contentIndex: 0, delta: "hmm" }] }, 1000);
  timeline.event({ type: "message_update", usage: {}, changes: [{ type: "text_start", contentIndex: 1, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 1, delta: "Hel" }] }, 4000);
  const partial = timeline.take().set;
  assert.deepEqual(partial.map((r) => [r.id, r.kind, r.partial]), [["p0", "thinking", true], ["p1", "text_block", true]]);
  assert.equal(partial[0].startedAt, 1000);
  timeline.event({ type: "message_end", entry: assistant(5, [thinking("hmm"), text("Hello")]) }, 5000);
  const { set, drop } = timeline.take();
  assert.deepEqual(drop.sort(), ["p0", "p1"]);
  assert.deepEqual(set.map((r) => [r.id, r.kind, r.seconds ?? null]), [["a5.0", "thinking", 3], ["a5.1", "text_block", null], ["w5", "waiting", null]]);
  assert.equal(timeline.state, "waiting");
});

test("a call with no result is running while the run is live and interrupted once it is settled; an aborted turn and an error say so", () => {
  const timeline = new Timeline({ workDir: "/runs/r/work" });
  timeline.entry(assistant(1, [call("a", "write", { path: "/runs/r/work/out/a.txt" }), call("b", "write", { path: "/etc/passwd" }), call("c", "write", { path: ".env" })]));
  timeline.entry(result(2, "a", "write", "ok"));
  timeline.entry(result(3, "b", "write", "ok"));
  timeline.entry(result(4, "c", "write", "ok"));
  timeline.entry(assistant(5, [call("d", "run", { code: "x" })]));
  timeline.entry(assistant(6, [text("partial")], "aborted"));
  timeline.entry(assistant(7, [], "error", { errorMessage: "402 credit balance is too low" }));
  timeline.finish();
  assert.deepEqual(timeline.rows.filter((r) => r.path).map((r) => r.path), ["out/a.txt", "out/a.txt"], "files outside work/ and dotfiles are not offered (the call and its saved row)");
  const status = (settled) => group(timeline.rows, { settled }).flatMap((i) => i.items ?? []).find((c) => c.tool_use_id === "d").status;
  assert.deepEqual([status(false), status(true)], ["running", "interrupted"]);
  assert.deepEqual(timeline.rows.filter((r) => ["phase", "error"].includes(r.kind) && !r.path).map((r) => [r.kind, r.summary]), [["phase", "Stopped"], ["error", "Model request failed: 402 credit balance is too low"]]);
  assert.equal(timeline.state, "idle");
});

test("a call that names a parent is nested under it, and thinking only joins a group when a call of its family follows", () => {
  const call_ = (id, tool, extra = {}) => ({ id: `t${id}`, kind: "tool_use", tool_use_id: id, tool_name: tool, ...extra });
  const items = group([call_("p", "run"), call_("k1", "run", { parent_tool_use_id: "p" }), call_("k2", "run", { parent_tool_use_id: "p" }), { id: "x", kind: "thinking", text: "" }, call_("q", "web_fetch"), { id: "y", kind: "thinking", text: "" }, { id: "z", kind: "text_block", text: "" }]);
  assert.deepEqual(items.map((i) => (i.kind === "group" ? `${i.family}:${i.items.map((c) => c.tool_use_id ?? c.kind)}` : i.kind)), ["Browser:p", "thinking", "Web:q", "thinking", "text_block"]);
  assert.deepEqual(items[0].items[0].children.map((c) => c.tool_use_id), ["k1", "k2"]);
});

test("a live run's store is never opened; a released run's is opened read-only", async (t) => {
  const { root, get } = await app(t);
  const door = await fakeDoor();
  t.after(() => door.close());
  const live = makeRun(root, "live", { status: "running", door: door.url });
  mkdirSync(join(live, "store"));
  writeFileSync(join(live, "store", "run.sqlite"), "this is not a database");
  const refused = await get("/api/runs/live/timeline");
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).message, /live/);

  const released = makeRun(root, "released", { status: "paused", entries: transcript });
  const file = join(released, "store", "run.sqlite");
  const before = statSync(file);
  assert.equal((await get("/api/runs/released/timeline")).status, 200);
  assert.deepEqual(readdirSync(join(released, "store")), ["run.sqlite"], "no journal or wal file appears");
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(statSync(file).size, before.size);
});

test("files: dotfiles are hidden, nothing outside work/ is reachable, html is sandboxed, other types are downloads", async (t) => {
  const { root, get, json } = await app(t);
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const dir = makeRun(root, "r1", { status: "done", files: { "notes.md": "# Hi", "data/rows.csv": "a,b\n1,2\n", "report.html": "<h1>x</h1><script>alert(1)</script>", "shot.png": png, "blob.bin": "xx", ".secret": "no", ".git/config": "no", "big.txt": "x".repeat(600 * 1024) } });
  writeFileSync(join(dir, "run.json.bak"), "outside work");
  symlinkSync(join(dir, "run.json"), join(dir, "work", "leak.json"));
  symlinkSync(root, join(dir, "work", "linked"));

  const { files } = await json("/api/runs/r1/files");
  assert.deepEqual(files.map((f) => f.path), ["big.txt", "blob.bin", "data/rows.csv", "notes.md", "report.html", "shot.png"]);

  for (const bad of [".secret", ".git/config", "../run.json", "sub/../../run.json", "%2e%2e/run.json", "/etc/passwd", "leak.json", "linked/r1/run.json", "data", "nope.txt", "", "a%00b"]) {
    const res = await get(`/api/runs/r1/file?path=${bad.includes("%") ? bad : encodeURIComponent(bad)}`);
    assert.equal(res.status, 404, `refused: ${JSON.stringify(bad)}`);
  }

  const html = await get("/api/runs/r1/file?path=report.html");
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  const csp = html.headers.get("content-security-policy");
  assert.ok(csp.startsWith("default-src 'none'; style-src 'unsafe-inline'; img-src data:"), csp);
  assert.match(csp, /\bsandbox\b/);
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  const asDownload = await get("/api/runs/r1/file?path=report.html&download=1");
  assert.match(asDownload.headers.get("content-disposition"), /^attachment/);
  assert.equal(asDownload.headers.get("content-type"), "application/octet-stream");

  for (const path of ["notes.md", "data/rows.csv"]) assert.equal((await get(`/api/runs/r1/file?path=${encodeURIComponent(path)}`)).headers.get("content-type"), "text/plain; charset=utf-8", path);
  const image = await get("/api/runs/r1/file?path=shot.png");
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.match(image.headers.get("content-disposition"), /^attachment/);
  const blob = await get("/api/runs/r1/file?path=blob.bin");
  assert.equal(blob.headers.get("content-type"), "application/octet-stream");
  assert.match(blob.headers.get("content-disposition"), /^attachment/);

  const big = await get("/api/runs/r1/file?path=big.txt");
  assert.equal(big.headers.get("x-truncated"), "1");
  assert.equal((await big.arrayBuffer()).byteLength, 512 * 1024);
});

test("search finds file contents, file names and a finished run's transcript, and skips dotfiles", async (t) => {
  const { root, json } = await app(t);
  makeRun(root, "a", { status: "done", entries: [user(1, "Find the Quokka report"), assistant(2, [text("The quokka is a marsupial.")])], files: { "notes/animals.txt": "Zebra and QUOKKA live here", ".private": "quokka secret", "quokka-list.csv": "x\n" } });
  makeRun(root, "b", { status: "done", files: { "other.md": "nothing relevant" } });
  const { results } = await json("/api/search?q=quokka");
  const keys = results.map((r) => `${r.runId}:${r.kind}:${r.path ?? ""}`).sort();
  assert.deepEqual(keys, ["a:file:notes/animals.txt", "a:file:quokka-list.csv", "a:run:", "a:transcript:", "a:transcript:"].sort(), "the question and the answer both match");
  assert.match(results.find((r) => r.path === "notes/animals.txt").snippet, /Zebra and QUOKKA live here/);
  assert.deepEqual((await json("/api/search?q=q")).results, [], "one character is not a search");
  assert.deepEqual((await json("/api/search?q=secret")).results, [], "dotfiles are not searched");
});

test("chat: a submit steers while the run is busy and follows up when it is idle; stop aborts; a finished run refuses", async (t) => {
  const { root, post } = await app(t);
  const door = await fakeDoor();
  t.after(() => door.close());
  makeRun(root, "live", { status: "running", door: door.url });
  makeRun(root, "finished", { status: "done" });
  makeRun(root, "asleep", { status: "sleeping", entries: transcript });

  assert.equal((await post("/api/runs/live/submit", { content: "first" })).status, 200);
  door.busy = true;
  assert.equal((await post("/api/runs/live/submit", { content: "second" })).status, 200);
  assert.deepEqual(door.submits.map((s) => [s.content, s.whenBusy]), [["first", "followUp"], ["second", "steer"]]);
  assert.ok(door.submits.every((s) => /^[\x21-\x7e]{1,200}$/.test(s.requestId)));
  assert.notEqual(door.submits[0].requestId, door.submits[1].requestId);
  assert.equal((await post("/api/runs/live/submit", { content: "  " })).status, 400);

  assert.equal((await post("/api/runs/live/stop", {})).status, 200);
  assert.equal(door.aborts.length, 1);
  assert.equal((await post("/api/runs/asleep/stop", {})).status, 200, "stopping a parked run is a no-op");
  assert.equal((await post("/api/runs/finished/submit", { content: "x" })).status, 409);
  assert.equal((await post("/api/runs/asleep/submit", { content: "x" })).status, 501, "no start command, so a parked run cannot be woken");
});

test("a request with another Host, another Origin or a form content type is refused", async (t) => {
  const { server, root } = await app(t);
  makeRun(root, "r", { status: "done" });
  const url = new URL(server.url);
  const request = (headers, method = "GET", body) =>
    new Promise((resolve) => {
      const req = httpRequest({ hostname: url.hostname, port: url.port, path: "/api/runs", method, headers }, (res) => (res.resume(), resolve(res.statusCode)));
      req.end(body);
    });
  assert.equal(await request({ host: `evil.example:${url.port}` }), 403);
  assert.equal(await request({ host: `localhost:${url.port}` }), 200);
  assert.equal(await request({ host: `localhost:${url.port}`, "content-type": "application/json", origin: "http://evil.example" }, "POST", "{}"), 403);
  assert.equal(await request({ host: `localhost:${url.port}`, "content-type": "text/plain" }, "POST", "{}"), 403);
});

test("the live view is a redirect to the host's file; its address never appears in the page's data", async (t) => {
  const { root, get, json } = await app(t);
  makeRun(root, "r", { status: "sleeping", live: "https://live.example/view?token=SECRET123" });
  makeRun(root, "bad", { status: "sleeping", live: "javascript:alert(1)" });
  const summary = await json("/api/runs/r");
  assert.ok(summary.liveView.updatedAt);
  assert.ok(!JSON.stringify(await json("/api/runs")).includes("SECRET123"));
  assert.ok(!JSON.stringify(summary).includes("live.example"));
  const redirect = await get("/api/runs/r/live", { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://live.example/view?token=SECRET123");
  assert.equal((await get("/api/runs/bad/live", { redirect: "manual" })).status, 404);
  assert.equal((await json("/api/runs/bad")).liveView, null);
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
  const { server, root, post, json } = await app(t, { start: [process.execPath, script] });
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => bystander.kill());

  const created = await post("/api/runs", { content: "Do the thing" });
  assert.equal(created.status, 202);
  const { id } = await created.json();
  for (let i = 0; i < 100 && door.submits.length < 1; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(door.submits.map((s) => s.content), ["Do the thing"]);
  const pid = server.children.get(id).pid;
  assert.ok(existsSync(join(root, id, "web.json")));
  assert.equal((await json(`/api/runs/${id}`)).title, "Do the thing");
  assert.equal((await json(`/api/runs/${id}`)).live, true);

  makeRun(root, "asleep", { status: "sleeping", entries: transcript });
  assert.equal((await post("/api/runs/asleep/submit", { content: "wake up" })).status, 200);
  assert.deepEqual(door.submits.map((s) => s.content), ["Do the thing", "wake up"]);
  assert.ok(server.children.has("asleep"), "the parked run was started again by the start command");

  await server.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the run's process is gone");
  assert.doesNotThrow(() => process.kill(bystander.pid, 0), "a process that is not a run is left alone");
});

test("a call is labelled in words, and an unknown tool says so", () => {
  assert.equal(labelOf("run", { code: "await page.goto('https://shop.example/cart?x=1')" }), "Opened shop.example/cart");
  assert.equal(labelOf("run", { actions: [{ op: "click", id: "1-2" }] }), "Acted on the page");
  assert.equal(labelOf("write", { path: "report.md" }), "Wrote report.md");
  assert.equal(labelOf("browser_release"), "Released the browser session");
  assert.equal(labelOf("charge", {}), "Using tool: charge");
});

test("a door address in run.json that is not loopback http is never contacted", async (t) => {
  const { root, get, json } = await app(t);
  makeRun(root, "far", { status: "running", door: "http://203.0.113.9:8080" });
  makeRun(root, "tls", { status: "running", door: "https://127.0.0.1:9" });
  for (const id of ["far", "tls"]) {
    const summary = await json(`/api/runs/${id}`);
    assert.deepEqual([summary.live, summary.status, summary.busy], [false, "lost", null], id);
    assert.equal((await get(`/api/runs/${id}/steps`)).status, 409, id);
  }
});
