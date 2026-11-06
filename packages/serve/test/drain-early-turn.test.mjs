// A server stop (the instance's own drain) that lands while a harness turn's first model request is in flight, the run's
// process then reopened by the server: a drain is no one's stop, so the turn it cut is still open and the reopened
// process resumes it, and the person's message is answered (#1578's rule). On the harnesses' stand-ins (OpenCode's
// fake-opencode-serve, Codex's fake-app-server), their model requests through the adapter's proxy to serve's gateway (a
// loopback server here, holding the first request until the drain is done). No binary, no key, no network.
import assert from "node:assert/strict";
import { copyFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { agent, follow, runDir, scratch, serve } from "./support.mjs";

const GATEWAY_KEY = `not-a-secret-${"gateway"}`;
const STAND_INS = {
  opencode: { file: fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url)), env: (standIn) => ({ AGENTRUN_OPENCODE_STANDIN: "1", AGENTRUN_SERVE_OPENCODE_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn] }) }) },
  codex: { file: fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url)), env: (standIn) => ({ AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }) }) },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };

/** serve's gateway, on loopback: request i answered `text(i)` with its usage; the first is held until `release`. */
async function gateway(t, text) {
  const seen = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    for await (const _ of req);
    const i = seen.length;
    seen.push(req.url);
    if (i === 0) await gate;
    const events = [{ type: "response.output_text.delta", delta: text(i) }, { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 100 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, release, origin: `http://127.0.0.1:${server.address().port}` };
}

/** The turn ends on the run's root (adapter.turn_end), in order, read with the store open read-only. */
function sessionTurnEnds(data, runId) {
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(String(row.record)))
        .filter((e) => e.kind === "adapter.turn_end").map((e) => e.data?.status);
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
}

for (const harness of ["opencode", "codex"]) {
  test(`${harness}: a server stop while the turn's first request is in flight, then the server reopens the run: the turn resumes and the message is answered`, { timeout: 180_000 }, async (t) => {
    const gw = await gateway(t, (i) => (i === 0 ? "Before the drain." : "After the drain."));
    const dir = await scratch(t);
    const standIn = join(dir, `${harness}-stand-in.mjs`);
    await copyFile(STAND_INS[harness].file, standIn);
    const saved = { ...process.env };
    t.after(() => {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });
    Object.assign(process.env, { ...STAND_INS[harness].env(standIn), AGENT_MODEL_BASE_URL: gw.origin, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: GATEWAY_KEY, AGENT_MODEL_PRICE: "1,2,0.5" });
    const { api, data } = await serve(t, { faux: undefined, drainTimeout: "2s" });
    assert.equal((await api("POST", "/agents", agent("drained", { harness }))).status, 201);
    const run = await api("POST", "/agents/drained/runs", { input: { content: "Say what you did." } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    for (let i = 0; gw.seen.length === 0; i++) {
      assert.ok(i < 600, "the turn's first model request reaches the gateway");
      await sleep(100);
    }
    const record = async () => JSON.parse(await readFile(join(runDir(data, run.body.run_id), "run.json"), "utf8"));
    // The instance's own drain: SIGTERM to the run's process, as a server stop sends it.
    const drained = (await record()).holder.pid;
    process.kill(drained, "SIGTERM");
    for (let i = 0; !gone(drained); i++) {
      assert.ok(i < 300, "the drained process is gone");
      await sleep(100);
    }
    gw.release();
    // The server reopens the run (a new process, the next generation), and the reopened turn goes on, or does not.
    for (let i = 0; ((await record()).generation ?? 1) < 2; i++) {
      assert.ok(i < 600, "the server reopens the drained run");
      await sleep(100);
    }
    const { rows, last } = await follow(api, run.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 120_000 });
    const seen = { status: last.status, rows: rows.map((r) => [r.kind, r.summary]), requests: gw.seen.length };
    t.diagnostic(JSON.stringify(seen));
    assert.equal(last.status, "completed", `the drained turn resumes and the message is answered: ${JSON.stringify(seen)}`);
    assert.ok(rows.some((r) => r.kind === "phase" && r.summary === "Resumed after the server stopped"), `resumed: ${JSON.stringify(seen)}`);
    assert.equal(rows.findLast((r) => r.kind === "final_answer" || r.kind === "text_block")?.text, "After the drain.");
    // Once the run's process lets go of its store: one turn end on the root, the resumed turn's.
    for (let i = 0; ; i++) { const now = (await record()).holder?.pid; if (now === undefined || gone(now)) break; assert.ok(i < 600, "the run's process lets go"); await sleep(100); }
    assert.deepEqual(sessionTurnEnds(data, run.body.run_id), ["completed"], `one turn end, the resumed turn's: ${JSON.stringify(seen)}`);
  });
}

// A guard of the other side (it passes on main, and must stay so): a person's Stop is someone's stop. On OpenCode, a run
// stopped while its first request is in flight stays stopped when its process is replaced, and the follow-up is
// answered by a turn of its own, with nothing of the stopped turn resumed.
test("opencode, a guard: a person's stop while the first request is in flight stays stopped when the run's process is replaced; the follow-up is a turn of its own", { timeout: 180_000 }, async (t) => {
  const gw = await gateway(t, (i) => (i === 0 ? "Before the stop." : "After the stop."));
  const dir = await scratch(t);
  const standIn = join(dir, "opencode-stand-in.mjs");
  await copyFile(STAND_INS.opencode.file, standIn);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, { ...STAND_INS.opencode.env(standIn), AGENT_MODEL_BASE_URL: gw.origin, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: GATEWAY_KEY, AGENT_MODEL_PRICE: "1,2,0.5" });
  const { api, data } = await serve(t, { faux: undefined, drainTimeout: "2s" });
  assert.equal((await api("POST", "/agents", agent("stopped", { harness: "opencode" }))).status, 201);
  const run = await api("POST", "/agents/stopped/runs", { input: { content: "Say what you did." } });
  for (let i = 0; gw.seen.length === 0; i++) {
    assert.ok(i < 600, "the turn's first model request reaches the gateway");
    await sleep(100);
  }
  assert.equal((await api("POST", `/runs/${run.body.run_id}/stop`)).body.stopped, true);
  await follow(api, run.body.run_id, ["input_required"], { deadlineMs: 60_000 });
  // The run's process is replaced: killed, so the next message opens a new one from the store.
  const record = JSON.parse(await readFile(join(runDir(data, run.body.run_id), "run.json"), "utf8"));
  const pid = record.holder?.pid;
  if (pid && !gone(pid)) process.kill(pid, "SIGKILL");
  for (let i = 0; pid && !gone(pid); i++) {
    assert.ok(i < 300, "the replaced process is gone");
    await sleep(100);
  }
  gw.release();
  assert.equal((await api("POST", `/runs/${run.body.run_id}/messages`, { content: "Go on." })).status, 202);
  const { rows, last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 120_000 });
  const seen = { status: last.status, rows: rows.map((r) => [r.kind, r.summary]) };
  t.diagnostic(JSON.stringify(seen));
  assert.equal(last.status, "completed", JSON.stringify(seen));
  assert.ok(!rows.some((r) => r.kind === "phase" && /^Resumed/.test(String(r.summary))), `nothing resumed: ${JSON.stringify(seen)}`);
  assert.equal(rows.findLast((r) => r.kind === "final_answer" || r.kind === "text_block")?.text, "After the stop.");
  const after = async () => JSON.parse(await readFile(join(runDir(data, run.body.run_id), "run.json"), "utf8"));
  for (let i = 0; ; i++) { const now = (await after()).holder?.pid; if (now === undefined || gone(now)) break; assert.ok(i < 600, "the run's process lets go"); await sleep(100); }
  assert.deepEqual(sessionTurnEnds(data, run.body.run_id), ["interrupted", "completed"], `the stopped turn's end, then the follow-up's: ${JSON.stringify(seen)}`);
});

// A guard of the halt path (it passes on main, and must stay so): an answer the provider's content filter stops is a
// halt, not an interrupt. On OpenCode the run ends failed, moderated, after the ONE request, and nothing turns it into an
// open turn that a later open resumes and asks again.
test("opencode, a guard: an answer the provider's content filter stops ends the run moderated after one request, and nothing resumes it", { timeout: 180_000 }, async (t) => {
  const seen = [];
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    for await (const _ of req);
    seen.push(req.url);
    const end = { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" }, usage: { input_tokens: 40, output_tokens: 0 } } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: ${end.type}\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = await scratch(t);
  const standIn = join(dir, "opencode-stand-in.mjs");
  await copyFile(STAND_INS.opencode.file, standIn);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, { ...STAND_INS.opencode.env(standIn), AGENT_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}`, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: GATEWAY_KEY, AGENT_MODEL_PRICE: "1,2,0.5" });
  const { api, data } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("filtered", { harness: "opencode" }))).status, 201);
  const run = await api("POST", "/agents/filtered/runs", { input: { content: "Say what you did." } });
  const { last } = await follow(api, run.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 120_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  // Nothing goes on after the end: the run's process lets go, and no later request reaches the provider.
  for (let i = 0; ; i++) { const now = JSON.parse(await readFile(join(runDir(data, run.body.run_id), "run.json"), "utf8")).holder?.pid; if (now === undefined || gone(now)) break; assert.ok(i < 600, "the run's process lets go"); await sleep(100); }
  await sleep(2_000);
  const after = (await api("GET", `/runs/${run.body.run_id}`)).body;
  const outcome = { status: last.status, code: view.error?.code, requests: seen.length, later: after.status, ends: sessionTurnEnds(data, run.body.run_id) };
  t.diagnostic(JSON.stringify(outcome));
  assert.deepEqual(
    { status: outcome.status, code: outcome.code, requests: outcome.requests, later: outcome.later },
    { status: "failed", code: "moderated", requests: 1, later: "failed" },
    `moderated after one request, and it stays ended: ${JSON.stringify(outcome)}`,
  );
});
