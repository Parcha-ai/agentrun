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
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { WITHHELD_TITLE } from "../dist/run-view.js";
import { raw } from "./store-target.mjs";
import { agent, follow, runDir, serve, withEnv } from "./support.mjs";

const KEY = `not-a-secret-${"handed-cut-model-key"}-5e09b7`;
const KEY_TWO = `not-a-secret-${"handed-cut-message-key"}-0d2f91`;
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
 *  call: the server, the run, its work folder, and `release` to let its turn go on. `serverKey`: the server's own key.
 *  `setup`: what to do on the server before the run starts. */
async function liveRun(t, { start = {}, serverKey, text = "Answered.", setup } = {}) {
  const gw = await startFauxGateway({ text });
  t.after(() => gw.close());
  const front = await heldFront(t, gw);
  withEnv(t, { AGENT_MODEL_BASE_URL: front.url, AGENT_MODEL: "claude-sonnet-5-5", ...(serverKey ? { AGENT_MODEL_API_KEY: serverKey } : {}) }, NAMES);
  const server = await serve(t, { faux: undefined });
  if (setup) await setup(server);
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

/** A cut read of run `runId`'s file `path`: [status, text or error code]. Its bytes decoded with a byte order mark kept
 *  (Response.text() drops one). */
async function cutRead({ baseUrl, token, runId }, path) {
  const res = await get(baseUrl, token, `/runs/${runId}/files/${path}?cut=run`);
  return res.status === 200 ? [200, new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer())] : [res.status, (await res.json()).error?.code];
}

/** One raw write to the server's store under `data`, waiting out a live runner's write as long as a loaded box holds one. */
async function write(data, sql, ...params) {
  const db = await raw(join(data, "store.sqlite"), { timeout: 30_000 });
  try {
    await db.run(sql, ...params);
  } finally {
    await db.close();
  }
}

/** Run `runId`'s launch census set to `census` in the server's store, as an end that wrote it would leave it. */
const setCensus = (data, runId, census) => write(data, "UPDATE run_launch SET census = ? WHERE run_id = ?", census, runId);

/** Run `runId`'s launch sealed part replaced by bytes that don't open under any key. */
const damageSeal = (data, runId) => write(data, "UPDATE run_launch SET sealed = ? WHERE run_id = ?", new Uint8Array(64).fill(9), runId);

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
  await damageSeal(run.data, run.runId);
  assert.deepEqual(await cutRead(run, "notes.txt"), [403, "forbidden"], "what it was handed can't be read back: withheld, never cut of less");
  const rawNotes = await get(run.baseUrl, run.token, `/runs/${run.runId}/files/notes.txt`);
  assert.equal(rawNotes.status, 403, "read raw too: the whole run is withheld, never shown cut of a shorter list");
  assert.equal((await run.api("GET", `/runs/${run.runId}`)).body.title, WITHHELD_TITLE, "its view withheld");
  // Its kept listing was built while its launch opened, cut of the key then: built again (a write that moves what its
  // view shows), it is withheld too.
  await write(run.data, "UPDATE runs SET list_mark = list_mark + 1 WHERE id = ?", run.runId);
  const row = (await run.api("GET", "/runs")).body.runs.find((one) => one.run_id === run.runId);
  assert.equal(row?.title, WITHHELD_TITLE, `its list row withheld: ${JSON.stringify(row)}`);
  run.release();
});

/** What run `run` shows of itself: its view's title, and its view, list row and timeline as text. */
async function served(run) {
  const view = (await run.api("GET", `/runs/${run.runId}`)).body;
  const row = (await run.api("GET", "/runs")).body.runs.find((one) => one.run_id === run.runId);
  const timeline = (await run.api("GET", `/runs/${run.runId}/timeline`)).body;
  return { title: view.title, text: JSON.stringify([view, row, timeline]) };
}

test("a key its caller typed into a start's input is cut where the server writes it, so the run's title never shows it after its end erased the key", { timeout: 180_000 }, async (t) => {
  const run = await liveRun(t, { start: { model_key: KEY, input: { content: `Use the key ${KEY} for this.` } } });
  assert.equal((await served(run)).text.includes(KEY), false, "live: not in its view, list row or timeline");
  await run.ended();
  const ended = await served(run);
  assert.equal(ended.title.includes(KEY), false, `after the end, when the key is erased: not in its title (${ended.title})`);
  assert.equal(ended.text.includes(KEY), false, "nor anywhere in its view, list row or timeline");
  assert.match(ended.title, /Use the key \[redacted\] for this/, "cut in place");
  assert.equal(JSON.stringify((await run.store.runs.launch(run.runId)).body).includes(KEY), false, "not in the stored launch body");
});

test("a message's text is cut of the key it hands and of the one the run held, so neither shows after the run's end", { timeout: 180_000 }, async (t) => {
  const run = await liveRun(t, { start: { model_key: KEY } });
  const sent = await run.api("POST", `/runs/${run.runId}/messages`, { content: `Again: ${KEY_TWO}, not ${KEY}.`, model_key: KEY_TWO });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const held = (text) => text.includes(KEY) || text.includes(KEY_TWO);
  assert.equal(held((await served(run)).text), false, "live: not in its view, list row or timeline");
  await run.ended();
  assert.equal(held((await served(run)).text), false, "after the end: not in its view, list row or timeline");
  const commands = (await run.store.commands(run.runId, 0)).map((command) => command.body);
  assert.equal(held(JSON.stringify(commands)), false, "not in the message's stored command row");
  assert.match(JSON.stringify(commands), /Again: \[redacted\], not \[redacted\]\./, "cut in place");
});

test("a message that hands a new model_key mid-turn keeps the one it replaced cut from the run's files, live and after its end by its census", { timeout: 180_000 }, async (t) => {
  const run = await liveRun(t, { start: { model_key: KEY } });
  await writeFile(join(run.work, "notes.txt"), `first=${KEY}\n`);
  const sent = await run.api("POST", `/runs/${run.runId}/messages`, { content: "Go on.", model_key: KEY_TWO });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await writeFile(join(run.work, "both.txt"), `first=${KEY}\nsecond=${KEY_TWO}\n`);
  assert.deepEqual(await cutRead(run, "notes.txt"), [200, "first=[redacted]\n"], "live: the replaced key is still cut");
  assert.deepEqual(await cutRead(run, "both.txt"), [200, "first=[redacted]\nsecond=[redacted]\n"], "and the new one");
  await run.ended();
  assert.equal((await run.store.runs.launch(run.runId)).census.includes(KEY), false, "the census holds no key");
  assert.deepEqual(await cutRead(run, "notes.txt"), [200, "first=[redacted]\n"], "ended: its census counted the replaced key");
  assert.deepEqual(await cutRead(run, "both.txt"), [200, "first=[redacted]\nsecond=[redacted]\n"]);
});

test("a message sealed over a launch whose sealed part doesn't open here keeps the run withheld: what it held is not known", { timeout: 180_000 }, async (t) => {
  const run = await liveRun(t, { start: { model_key: KEY } });
  await writeFile(join(run.work, "notes.txt"), `first=${KEY}\n`);
  await damageSeal(run.data, run.runId);
  const sent = await run.api("POST", `/runs/${run.runId}/messages`, { content: "Go on.", model_key: KEY_TWO });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.deepEqual(await cutRead(run, "notes.txt"), [403, "forbidden"], "a fresh seal is no reason to read the run cut of the new key alone");
  run.release();
});

test("a file that starts with a byte order mark, or holds one later, is cut at the same bytes after the run's end as while it ran: no end of the key shows", { timeout: 180_000 }, async (t) => {
  const run = await liveRun(t, { start: { model_key: KEY } });
  const bom = `\uFEFFkey=${KEY}\nthe rest stays.\n`;
  const inner = `\uFEFFfirst\n\uFEFFkey=${KEY} done\n`;
  await writeFile(join(run.work, "bom.txt"), bom);
  await writeFile(join(run.work, "inner.txt"), inner);
  const live = [await cutRead(run, "bom.txt"), await cutRead(run, "inner.txt")];
  for (const [status, text] of live) assert.ok(status === 200 && text.includes("key=[redacted]") && !text.includes(KEY.slice(-3)), `live: cut by value (${text})`);
  await run.ended();
  const ended = [await cutRead(run, "bom.txt"), await cutRead(run, "inner.txt")];
  assert.deepEqual(ended, live, "ended: the census cuts the same characters, no end of the key left over");
  assert.deepEqual(live, [[200, "\uFEFFkey=[redacted]\nthe rest stays.\n"], [200, "\uFEFFfirst\n\uFEFFkey=[redacted] done\n"]], "the mark served as written, as a raw read serves it");
});

test("a handed MCP Basic header whose key is the user (`-u KEY:`) has the key cut from the run's files alone, live and after its end by its census", { timeout: 180_000 }, async (t) => {
  // The lead's case: an API that takes its key as the Basic user with no password, and a file that holds the key bare.
  const user = "k3y_live_abcdef123456";
  const fake = await startFakeMcp({ token: () => true });
  t.after(() => fake.close());
  const setup = async (server) => {
    const saved = await server.api("PUT", "/settings/mcp-servers/gw", { url: fake.url, auth: { type: "per_run", headers: { authorization: "Bearer listing-only" } } }, { authorization: `Bearer ${server.token}` });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  };
  const basic = Buffer.from(`${user}:`).toString("base64");
  const run = await liveRun(t, { setup, serverKey: SERVER_KEY, start: { mcp_auth: { gw: { headers: { authorization: `Basic ${basic}` } } } } });
  await writeFile(join(run.work, "env.txt"), `KEY=${user}\nthe rest stays.\n`);
  assert.deepEqual(await cutRead(run, "env.txt"), [200, "KEY=[redacted]\nthe rest stays.\n"], "live: the key alone is cut");
  await run.ended();
  assert.deepEqual(await cutRead(run, "env.txt"), [200, "KEY=[redacted]\nthe rest stays.\n"], "ended: its census counted the key alone");
});
