// A run's file read under the run's own cut (GET /v2/runs/{id}/files/{path}?cut=run) for what its caller handed it: its
// own model key (model_key), as its MCP credentials and tool keys, sealed in its launch (store/seal.ts). While the run
// holds them, a cut read cuts them from its files by value. Its end erases them, and writes in their place its census:
// where in each file they sat, never the values (run-census.ts). After the end a cut read cuts a file by its census entry
// while the file's bytes are the ones counted, and withholds it (403) otherwise: edited or written after the end, or a
// run whose end erased them with no census (a runner from before the census: its launch still "pending"). A run never
// handed a secret reads as before. A launch whose sealed part doesn't open here withholds the run, as an unreadable sign-in
// does. Read raw, a file of a run that is shown is the bytes as written. The model gateway is a loopback stand-in (fixtures/faux-gateway.mjs) behind a front that holds
// the run's first model call, so the test acts while the run is live.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { WITHHELD_TITLE } from "../dist/run-view.js";
import { raw } from "./store-target.mjs";
import { agent, follow, runDir, serve, withEnv } from "./support.mjs";

const KEY = `not-a-secret-${"handed-cut-model-key"}-5e09b7`;
const SERVER_KEY = `not-a-secret-${"handed-cut-server-key"}-a41c33`;
/** Every variable these tests set or clear. */
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SERVE_GRADE_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (baseUrl, token, path) => fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

/** Waits for `check` to hold, up to `ms`. */
async function until(check, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(50);
  }
}

/** A front for gateway `gw` on loopback that holds the first POST until `release()`. */
async function heldFront(t, gw) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let first = true;
  const seen = [];
  const front = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === "POST") seen.push(req.url);
    if (req.method === "POST" && first) {
      first = false;
      await held;
    }
    try {
      const answer = await fetch(`${gw.url}${req.url}`, { method: req.method, headers: { "content-type": "application/json", authorization: req.headers.authorization ?? "" }, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
      res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (front.closeAllConnections(), front.close(resolve))));
  return { url: `http://127.0.0.1:${front.address().port}`, seen, release: () => release() };
}

/** A run started with `start` (extra start fields) on a server whose model gateway answers `text`, held at its first model
 *  call: the server, the run, its work folder, and `release` to let its turn go on. `serverKey`: the server's own key. */
async function liveRun(t, { start = {}, serverKey, text = "Answered." } = {}) {
  const gw = await startFauxGateway({ text });
  t.after(() => gw.close());
  const front = await heldFront(t, gw);
  withEnv(t, { AGENT_MODEL_BASE_URL: front.url, AGENT_MODEL: "claude-sonnet-5-5", ...(serverKey ? { AGENT_MODEL_API_KEY: serverKey } : {}) }, NAMES);
  const server = await serve(t, { faux: undefined });
  assert.equal((await server.api("POST", "/agents", agent("handed"))).status, 201);
  const started = await server.api("POST", "/agents/handed/runs", { input: { content: "Answer." }, ...start });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await until(() => front.seen.length >= 1, "the turn's first model call reached the front");
  const work = join(runDir(server.data, runId), "work");
  await mkdir(join(work, "out"), { recursive: true });
  const ended = async () => {
    front.release();
    const { last, rows } = await follow(server.api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
    await until(async () => (await server.store.runs.launch(runId)).sealed === null, "its end erased what it was handed");
  };
  return { ...server, runId, work, release: () => front.release(), ended };
}

/** A cut read of run `runId`'s file `path`: [status, text or error code]. */
async function cutRead({ baseUrl, token, runId }, path) {
  const res = await get(baseUrl, token, `/runs/${runId}/files/${path}?cut=run`);
  return res.status === 200 ? [200, await res.text()] : [res.status, (await res.json()).error?.code];
}

/** Run `runId`'s launch census set to `census` in the server's store, as an end that wrote it would leave it. */
async function setCensus(data, runId, census) {
  const db = await raw(join(data, "store.sqlite"));
  try {
    await db.run("UPDATE run_launch SET census = ? WHERE run_id = ?", census, runId);
  } finally {
    await db.close();
  }
}

test("a run's own model_key is cut from its files by a cut read while it runs, and after its end by its census; a file edited or written after the end is withheld; read raw, the bytes as written", { timeout: 180_000 }, async (t) => {
  // The model's answer says the key too: what the runner keeps of the run (its view, its list row) is cut as it is written.
  const run = await liveRun(t, { start: { model_key: KEY }, text: `Done, with ${KEY}.` });
  const notes = `key=${KEY}\nthe rest stays.\n`;
  const deep = `# ñandú\n\n→ ${KEY} ✓\n`;
  await writeFile(join(run.work, "notes.txt"), notes);
  await writeFile(join(run.work, "out", "deep.md"), deep);
  await writeFile(join(run.work, "clean.txt"), "nothing held here\n");

  assert.deepEqual(await cutRead(run, "notes.txt"), [200, "key=[redacted]\nthe rest stays.\n"], "live: cut by the value its launch holds");
  assert.deepEqual(await cutRead(run, "out/deep.md"), [200, "# ñandú\n\n→ [redacted] ✓\n"]);

  await run.ended();
  const launch = await run.store.runs.launch(run.runId);
  assert.ok(launch.census && JSON.parse(launch.census).files["notes.txt"], `its census in the erased key's place: ${launch.census}`);
  assert.equal(launch.census.includes(KEY), false, "the census holds no key");
  assert.deepEqual(await cutRead(run, "notes.txt"), [200, "key=[redacted]\nthe rest stays.\n"], "ended: cut by its census");
  assert.deepEqual(await cutRead(run, "out/deep.md"), [200, "# ñandú\n\n→ [redacted] ✓\n"], "a file in a folder, past multibyte text");
  assert.deepEqual(await cutRead(run, "clean.txt"), [200, "nothing held here\n"], "a file that held none reads whole");
  const rawNotes = await get(run.baseUrl, run.token, `/runs/${run.runId}/files/notes.txt`);
  assert.equal(await rawNotes.text(), notes, "read raw: the bytes as written");

  // What a list row or the run's view shows was cut as it was written, under the key: the listing's cache, keyed on the
  // server's secrets, holds no row a later read could cut of more.
  const shown = JSON.stringify([(await run.api("GET", `/runs/${run.runId}`)).body, (await run.api("GET", "/runs")).body]);
  assert.equal(shown.includes(KEY), false, "not in its view or its list row");

  await writeFile(join(run.work, "notes.txt"), `${notes}one more line\n`);
  assert.deepEqual(await cutRead(run, "notes.txt"), [403, "forbidden"], "edited after the end: not the bytes counted, withheld");
  await writeFile(join(run.work, "later.txt"), `copied ${KEY}\n`);
  assert.deepEqual(await cutRead(run, "later.txt"), [403, "forbidden"], "written after the end: no entry, withheld");
  await writeFile(join(run.work, "clean.txt"), "nothing held here\n");
  assert.deepEqual(await cutRead(run, "clean.txt"), [200, "nothing held here\n"], "the same bytes again read as counted");
});

test("an ended run whose end erased its secrets with no census (its launch left pending, or the marker) withholds its files", { timeout: 180_000 }, async (t) => {
  const handed = await liveRun(t, { start: { model_key: KEY } });
  await writeFile(join(handed.work, "notes.txt"), "plain words\n");
  await handed.ended();
  assert.deepEqual(await cutRead(handed, "notes.txt"), [200, "plain words\n"], "counted at its end");
  // A runner from before the census erases the sealed key and writes nothing else.
  await setCensus(handed.data, handed.runId, JSON.stringify("pending"));
  assert.deepEqual(await cutRead(handed, "notes.txt"), [403, "forbidden"], "pending with nothing sealed: withheld");
  await setCensus(handed.data, handed.runId, JSON.stringify("unscanned"));
  assert.deepEqual(await cutRead(handed, "notes.txt"), [403, "forbidden"], "the marker: withheld");
});

test("a run never handed a secret has no census and its files read cut by the server's secrets alone, before and after its end", { timeout: 180_000 }, async (t) => {
  const plain = await liveRun(t, { serverKey: SERVER_KEY });
  await writeFile(join(plain.work, "notes.txt"), `server=${SERVER_KEY}\n`);
  assert.deepEqual(await cutRead(plain, "notes.txt"), [200, "server=[redacted]\n"]);
  await plain.release();
  const { last } = await follow(plain.api, plain.runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed");
  assert.equal((await plain.store.runs.launch(plain.runId)).census, null, "never handed one: no census");
  await writeFile(join(plain.work, "later.txt"), `server=${SERVER_KEY}\n`);
  assert.deepEqual(await cutRead(plain, "later.txt"), [200, "server=[redacted]\n"], "a file written after its end reads as before");
});

test("a run whose launch's sealed part doesn't open here is withheld, as a run whose sign-in can't be read: its files from a cut read and a raw one, its view", { timeout: 180_000 }, async (t) => {
  const run = await liveRun(t, { start: { model_key: KEY } });
  await writeFile(join(run.work, "notes.txt"), "plain words\n");
  assert.deepEqual(await cutRead(run, "notes.txt"), [200, "plain words\n"]);
  const db = await raw(join(run.data, "store.sqlite"));
  try {
    await db.run("UPDATE run_launch SET sealed = ? WHERE run_id = ?", new Uint8Array(64).fill(9), run.runId);
  } finally {
    await db.close();
  }
  assert.deepEqual(await cutRead(run, "notes.txt"), [403, "forbidden"], "what it was handed can't be read back: withheld, never cut of less");
  const rawNotes = await get(run.baseUrl, run.token, `/runs/${run.runId}/files/notes.txt`);
  assert.equal(rawNotes.status, 403, "read raw too: the whole run is withheld, never shown cut of a shorter list");
  assert.equal((await run.api("GET", `/runs/${run.runId}`)).body.title, WITHHELD_TITLE, "its view withheld");
  // Its kept listing was built while its launch opened, cut of the key then: built again (a write that moves what its
  // view shows), it is withheld too.
  const marks = await raw(join(run.data, "store.sqlite"));
  try {
    await marks.run("UPDATE runs SET list_mark = list_mark + 1 WHERE id = ?", run.runId);
  } finally {
    await marks.close();
  }
  const row = (await run.api("GET", "/runs")).body.runs.find((one) => one.run_id === run.runId);
  assert.equal(row?.title, WITHHELD_TITLE, `its list row withheld: ${JSON.stringify(row)}`);
  run.release();
});
