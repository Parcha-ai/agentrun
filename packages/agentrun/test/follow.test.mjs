// `runs start --wait`, `runs wait` and `runs timeline --follow` against a server started with a faux model on loopback:
// a run that ends, one that asks its person a question, one that takes its time; the stream's pages against the JSON
// timeline, and a connection cut mid-stream resumed with Last-Event-ID. The token is in no output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const SERVE = new URL("../../serve/dist/cli.js", import.meta.url).pathname;
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES"];

// Asks its person which region when told to ask, and answers with what they said; takes its time, until it is stopped,
// when told to; else answers at once.
const FAUX = `const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default (context, faux) => {
  const users = context.messages.filter((m) => m.role === "user").map(textOf);
  const answered = context.messages.at(-1)?.role === "toolResult";
  if (users[0].includes("Ask me")) return users.length === 1 && !answered ? faux.message(faux.toolCall("ask_person", { question: "Which region?" }), { stopReason: "toolUse" }) : faux.message("Region " + users.at(-1) + ".");
  if (users[0].includes("Take your time")) return new Promise((resolve) => faux.signal?.addEventListener("abort", () => resolve(faux.message("", { stopReason: "aborted" })), { once: true }));
  return faux.message("The answer is 42.");
};
`;

async function serve(t) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-follow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name))), HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") };
  writeFileSync(join(dir, "faux.mjs"), FAUX);
  const data = join(dir, "data");
  const child = spawn(process.execPath, [SERVE, "--data", data, "--port", "0", "--faux", join(dir, "faux.mjs")], { stdio: ["ignore", "pipe", "pipe"], env: { ...env, AGENTRUN_ACCOUNTS: "0" } });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  let err = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !existsSync(join(data, ".server.json")); i++) {
    assert.ok(i < 600 && child.exitCode === null, `the server started: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const record = JSON.parse(readFileSync(join(data, ".server.json"), "utf8"));
  return { dir, env, data, base: record.base_url, token: readFileSync(join(data, ".token"), "utf8").trim() };
}

/** The CLI, run without blocking this process (the proxy below runs in it); `heard` sees its stdout so far. */
function cliOf(env, seen) {
  return (args, extra = {}, heard = () => {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => heard((out += chunk)));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.once("close", (code) => {
        clearTimeout(timer);
        seen.push(out, err);
        resolve({ code, out, err, json: () => JSON.parse(out), lines: () => out.trim().split("\n").map((line) => JSON.parse(line)) });
      });
    });
}

/** A proxy to `upstream` that passes its first request's first whole event and then, on `cut()`, breaks the connection; it
 *  holds its second request until `release()`, and `second` resolves once that one came. `seen` holds each request's
 *  Last-Event-ID. */
async function cuttingProxy(t, upstream) {
  const seen = [];
  let cut;
  const cutting = new Promise((resolve) => (cut = resolve));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let arrived;
  const second = new Promise((resolve) => (arrived = resolve));
  const server = createServer(async (req, res) => {
    const n = seen.push(req.headers["last-event-id"]);
    if (n === 2) {
      arrived();
      await gate;
    }
    // The server takes only its own Host.
    const up = request(new URL(req.url, upstream), { method: req.method, headers: { ...req.headers, host: new URL(upstream).host } }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      if (n !== 1 || answer.statusCode !== 200) return void answer.pipe(res);
      let held = "";
      answer.on("data", (chunk) => {
        if (held === null) return;
        held += chunk;
        const end = held.indexOf("\n\n");
        if (end < 0) return;
        const first = held.slice(0, end + 2);
        held = null;
        answer.destroy();
        res.write(first, () => cutting.then(() => res.destroy()));
      });
    });
    req.pipe(up);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => (server.closeAllConnections(), server.close()));
  return { base: `http://127.0.0.1:${server.address().port}/v2`, seen, cut, second, release };
}

/** The rows the pages leave, applied in order: upserted by id, the drops removed, a reset dropping all first. */
function applied(pages) {
  const rows = new Map();
  for (const page of pages) {
    if (page.reset) rows.clear();
    for (const row of page.rows) rows.set(row.id, row);
    for (const id of page.drop) rows.delete(id);
  }
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}

async function closedPort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("runs start --wait, runs wait and runs timeline --follow: exit by how the run ended, the stream resumed with no change twice, the token in no output", { timeout: 180_000 }, async (t) => {
  const server = await serve(t);
  const seen = [readFileSync(join(server.data, ".server.json"), "utf8")];
  const cli = cliOf(server.env, seen);
  const data = ["--data", server.data];
  writeFileSync(join(server.dir, "agent.json"), JSON.stringify({ definition: { id: "demo", version: 1, name: "demo", instructions: "Answer.", skills: [], tools: ["ask_person"] } }));
  assert.equal((await cli(["agents", "create", "--body", `@${join(server.dir, "agent.json")}`, ...data])).code, 0);
  const start = (content, ...flags) => cli(["runs", "start", "demo", "--body", JSON.stringify({ input: { content } }), ...flags, ...data]);

  await t.test("runs start --wait prints the completed run, exit 0; --follow's pages, applied, are the JSON timeline", async () => {
    const done = await start("What is the answer?", "--wait");
    assert.equal(done.code, 0, done.err);
    const run = done.json();
    assert.equal(run.status, "completed");
    assert.match(run.result.final_answer, /42/);
    assert.equal(done.out.trim().split("\n").length, 1, "one JSON document: the run as it ended");

    const followed = await cli(["runs", "timeline", run.run_id, "--follow", ...data]);
    assert.equal(followed.code, 0, followed.err);
    const pages = followed.lines();
    assert.equal(pages.at(-1).final, true);
    const timeline = await cli(["runs", "timeline", run.run_id, ...data]);
    assert.deepEqual(applied(pages), timeline.json().rows);
  });

  await t.test("a run that asks its person: --wait exits 8 with the question, runs message answers it, runs wait exits 0; --follow cut mid-stream resumes with no change twice", async (t) => {
    const asked = await start("Ask me which region.", "--wait");
    assert.equal(asked.code, 8, asked.err);
    const run = asked.json();
    assert.deepEqual([run.status, run.pending?.kind, run.pending?.question], ["input_required", "question", "Which region?"]);
    assert.match(asked.err, new RegExp(`runs message ${run.run_id} --content TEXT.*runs wait ${run.run_id}`));
    const again = await cli(["runs", "wait", run.run_id, ...data]);
    assert.equal(again.code, 8, "a run that waits on its person still does");

    // The stream through a proxy that cuts it once its first page is printed, and holds the reconnect until the answer is in.
    const proxy = await cuttingProxy(t, server.base);
    const following = cli(["runs", "timeline", run.run_id, "--follow", "--base-url", proxy.base], { AGENTRUN_API_KEY: server.token }, (out) => out.includes("\n") && proxy.cut());
    await proxy.second;
    const answer = await cli(["runs", "message", run.run_id, "--content", "eu", ...data]);
    assert.equal(answer.code, 0, answer.err);
    proxy.release();
    const followed = await following;
    assert.equal(followed.code, 0, `${followed.err}\n${followed.out}\n${JSON.stringify(proxy.seen)}`);

    const waited = await cli(["runs", "wait", run.run_id, ...data]);
    assert.equal(waited.code, 0, waited.err);
    assert.deepEqual([waited.json().status, waited.json().result.final_answer], ["completed", "Region eu."]);

    const pages = followed.lines();
    assert.ok(pages.length >= 2, "a page before the cut and one after");
    assert.equal(pages[0].status, "input_required");
    assert.deepEqual(proxy.seen, [undefined, String(pages[0].next_after)], "the reconnect resumed from the last page it had");
    assert.ok(pages.slice(1).every((page) => !page.reset), "no page after the cut starts over");
    for (let i = 1; i < pages.length; i++) assert.ok(pages[i].next_after > pages[i - 1].next_after, "each page is past the one before");
    const versions = new Set();
    for (const row of pages.flatMap((page) => page.rows)) {
      const version = JSON.stringify(row);
      assert.ok(!versions.has(version), `no change comes twice: ${version}`);
      versions.add(version);
    }
    assert.equal(pages.at(-1).final, true);
    const timeline = await cli(["runs", "timeline", run.run_id, ...data]);
    assert.deepEqual(applied(pages), timeline.json().rows);
    assert.ok(timeline.json().rows.some((row) => row.text?.includes("Region eu.") || row.summary?.includes("Region eu.")), "the answer's rows came after the cut");
  });

  await t.test("--timeout: past it, the run as it is and a line saying how to wait again, exit 1; nothing answering, exit 3", async () => {
    const started = await start("Take your time.");
    assert.equal(started.code, 0, started.err);
    const id = started.json().run_id;
    const waited = await cli(["runs", "wait", id, "--timeout", "1", ...data]);
    assert.equal(waited.code, 1, waited.err);
    assert.ok(["queued", "working"].includes(waited.json().status), waited.out);
    assert.match(waited.err, new RegExp(`^Run ${id} is still \\w+ after 1 s; it goes on: wait again with \`agentrun runs wait ${id}\`\\.\\n$`));
    assert.equal((await cli(["runs", "cancel", id, ...data])).code, 0);
    const cancelled = await cli(["runs", "wait", id, ...data]);
    assert.deepEqual([cancelled.code, cancelled.json().status], [1, "cancelled"]);

    const port = await closedPort();
    const nowhere = await cli(["runs", "wait", id, "--base-url", `http://127.0.0.1:${port}/v2`], { AGENTRUN_API_KEY: "fake-test-key" });
    assert.equal(nowhere.code, 3);
    assert.match(nowhere.err, /Cannot reach the server/);
    assert.equal((await cli(["runs", "wait", id, "--timeout", "soon", ...data])).code, 2);
    assert.equal((await cli(["runs", "get", id, "--wait", ...data])).code, 2, "--wait is runs start's alone");
  });

  for (const text of seen) assert.ok(!text.includes(server.token), "no output holds the token");
});
