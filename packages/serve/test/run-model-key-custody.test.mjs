// A run's own model key (model_key) end to end. A server that holds no model key of its own (a gateway at
// AGENT_MODEL_BASE_URL, no AGENT_MODEL_API_KEY, nothing saved in Settings) is one whose callers bring their own: the
// caller hands a key with the run and one with each message, as a host hands a LiteLLM virtual key it minted for that
// turn. A server that holds a key still spends it on a run that brings none, and never on one that brings its own. The model gateway is a
// loopback stand-in (fixtures/faux-gateway.mjs) that records the key each request carried. Proven here:
//   - on a server with no key, a start or a message that would start a turn with no model_key is 422
//     model_key_required, nothing written (never a failure at the first model call);
//   - the key reaches the gateway, through the run's model proxy, on every request tied to the run: its turn and its
//     end-of-run compile turn (spend outside the job's turn, before the run reports its turn ended);
//   - it is sealed in the run's launch bound to the gateway's origin, and erased by the write that ends the turn;
//   - a message's key replaces it from the turn the message starts;
//   - a runner that dies mid-turn is replaced by one that opens the sealed key from the store and goes on with it;
//   - the key is never in the run's view, timeline, command rows, the server's and runner's logs, this process's
//     environment, or the store's bytes in the clear.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openRunLaunch } from "../dist/store/index.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { learner, made } from "./learn-support.mjs";
import { agent, follow, serve, storeBytes, withEnv } from "./support.mjs";

const KEY_ONE = `not-a-secret-${"run-model-key-one"}-4f1d2c`;
const KEY_TWO = `not-a-secret-${"run-model-key-two"}-9a7e0b`;
const KEY_THREE = `not-a-secret-${"run-model-key-three"}-c03b51`;
/** Every variable these tests set or clear: the server holds no model key of its own. */
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SERVE_GRADE_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const CRASHABLE = { leaseMs: 1_500, renewEveryMs: 300, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The gateway's settings at `url`, a Claude model on Anthropic's Messages API there, and no key of the server's. */
const keylessEnv = (url) => ({ AGENT_MODEL_BASE_URL: url, AGENT_MODEL: "claude-sonnet-5-5" });

/** The bearer token each POST the gateway took carried, in order. */
const bearers = (gw) => gw.requests.filter((request) => request.method === "POST").map((request) => request.headers.authorization);

/** The server's seal key, as it keeps it in its data directory (seal-key.ts). */
const sealKeyOf = (data) => Buffer.from(readFileSync(join(data, "seal", "seal.key"), "utf8").split("\n")[0].trim(), "base64");

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

/** Every place a person or the agent reads, for `keys`: the run's view, timeline and command rows, every log line, this
 *  process's environment, and the store's bytes. */
async function assertNowhere(server, runId, keys, logs) {
  const { api, store, data } = server;
  const shown = JSON.stringify([(await api("GET", `/runs/${runId}`)).body, (await api("GET", `/runs/${runId}/timeline`)).body, (await store.commands(runId, 0)).map((command) => command.body), (await store.runs.launch(runId)).body]);
  await store.flush();
  const bytes = storeBytes(data);
  for (const key of keys) {
    assert.equal(shown.includes(key), false, "not in the run's view, timeline, command rows or launch body");
    assert.equal(logs.join("\n").includes(key), false, "not in any log line");
    assert.equal(Object.values(process.env).some((value) => value?.includes(key)), false, "not in this process's environment");
    assert.equal(bytes.includes(Buffer.from(key)), false, "not in the store's bytes in the clear");
  }
}

/** A front for gateway `gw` on loopback: it records the bearer each request carried (`seen`, in order) and holds the
 *  first POST until `release()`, so a test acts while a run's turn is in flight. */
async function heldFront(t, gw) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let first = true;
  const seen = [];
  const front = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === "POST") seen.push(req.headers.authorization);
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

/** A message with `model_key` sent while the run's first request is held, then let go once the runner took the message:
 *  the bearer of every request, in order. `start`: the start body's extra fields. */
async function keyMidTurn(t, { serverKey, start = {}, key }) {
  const gw = await startFauxGateway({ text: "Answered." });
  t.after(() => gw.close());
  const front = await heldFront(t, gw);
  withEnv(t, { ...keylessEnv(front.url), ...(serverKey ? { AGENT_MODEL_API_KEY: serverKey } : {}) }, NAMES);
  const logs = [];
  const server = await serve(t, { faux: undefined, log: (line) => logs.push(line) });
  const { api, store } = server;
  assert.equal((await api("POST", "/agents", agent("mid-turn"))).status, 201);
  const started = await api("POST", "/agents/mid-turn/runs", { input: { content: "Answer." }, ...start });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await until(() => front.seen.length >= 1, "the turn's first request reached the gateway's front");
  const sent = await api("POST", `/runs/${runId}/messages`, { content: "And then?", model_key: key });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await until(async () => (await store.commands(runId, 0)).some((command) => command.kind === "steer" && command.takenAt !== null), "the runner took the message");
  front.release();
  const { last, rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  assert.ok(front.seen.length >= 2, `a request after the message: ${front.seen.length}`);
  return { seen: front.seen, server, runId, logs };
}

test("a server with no model key: a run and a message without model_key are 422 model_key_required; the run's key goes to the gateway on its turn and its compile turn, sealed for the run and erased at its turn's end; a message's key replaces it; it is nowhere else", { timeout: 180_000 }, async (t) => {
  const gw = await startFauxGateway({ text: "Answered." });
  t.after(() => gw.close());
  withEnv(t, keylessEnv(gw.url), NAMES);
  const logs = [];
  const server = await serve(t, { learning: "on", faux: undefined, log: (line) => logs.push(line) });
  const { api, store, data } = server;
  // An agent whose first compile is due at its first completed run asks its compile turn at that run's end: model spend
  // outside the job's own turn, on the same run.
  await made(api, learner("keyed", { learning: { compile_after: 1 } }));

  const refused = await api("POST", "/agents/keyed/runs", { input: { content: "Answer." } });
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.fields?.[0]?.field], [422, "model_key_required", "model_key"], JSON.stringify(refused.body));
  const badType = await api("POST", "/agents/keyed/runs", { input: { content: "Answer." }, model_key: 7 });
  assert.deepEqual([badType.status, badType.body.error?.fields?.[0]?.field], [422, "model_key"], JSON.stringify(badType.body));
  assert.equal((await store.runs.list({})).length, 0, "no run made");

  const started = await api("POST", "/agents/keyed/runs", { input: { content: "Answer." }, model_key: KEY_ONE }, { "idempotency-key": "keyed-1" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  // Sealed for this run alone, bound to the gateway's origin; a retry with a fresh key answers the first run, its key kept.
  const sealKey = sealKeyOf(data);
  const retried = await api("POST", "/agents/keyed/runs", { input: { content: "Answer." }, model_key: KEY_THREE }, { "idempotency-key": "keyed-1" });
  assert.deepEqual([retried.status, retried.body.run_id], [202, runId], JSON.stringify(retried.body));
  const first = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(first.last.status, "completed", JSON.stringify(first.rows.slice(-3)));
  // The compile turn is asked before the run's end is written: wait for its request too.
  await until(async () => (await api("GET", `/runs/${runId}`)).body.learning?.state !== "running" && bearers(gw).length >= 2, "the job's request and the compile turn's");
  assert.ok(bearers(gw).length >= 2, `the job's turn and its compile turn both asked the gateway: ${bearers(gw).length}`);
  assert.deepEqual([...new Set(bearers(gw))], [`Bearer ${KEY_ONE}`], "every request tied to the run carried the run's first key, and only it");
  await until(async () => (await store.runs.launch(runId)).sealed === null, "the turn's end erases the run's key");

  const commandsBefore = (await store.commands(runId, 0)).length;
  const missing = await api("POST", `/runs/${runId}/messages`, { content: "And then?" });
  assert.deepEqual([missing.status, missing.body.error?.code], [422, "model_key_required"], JSON.stringify(missing.body));
  // Refused inside the message's own write, which then writes nothing: the run is not opened again, no steer is queued.
  assert.deepEqual([(await api("GET", `/runs/${runId}`)).body.status, (await store.commands(runId, 0)).length], ["completed", commandsBefore], "nothing written");
  const before = bearers(gw).length;
  const sent = await api("POST", `/runs/${runId}/messages`, { content: "And then?", model_key: KEY_TWO });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const opened = openRunLaunch(sealKey, runId, (await store.runs.launch(runId)).sealed);
  assert.deepEqual(opened?.model, { key: KEY_TWO, origin: gw.url }, "the message's key, sealed for this run and bound to the gateway's origin");
  assert.equal(openRunLaunch(sealKey, "another-run", (await store.runs.launch(runId)).sealed), undefined, "and for no other run");
  await until(async () => bearers(gw).length > before && (await store.runs.launch(runId)).sealed === null, "the follow-up's turn ends");
  assert.deepEqual([...new Set(bearers(gw).slice(before))], [`Bearer ${KEY_TWO}`], "the follow-up's requests carried the message's key alone");

  await assertNowhere(server, runId, [KEY_ONE, KEY_TWO, KEY_THREE], logs);
});

test("model_key where the run's model never goes through a gateway is 422 at model_key, nothing made", async (t) => {
  withEnv(t, {}, NAMES);
  const { api, store } = await serve(t, { runner: false });
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const refused = await api("POST", "/agents/plain/runs", { input: { content: "Hi" }, model_key: KEY_ONE });
  assert.deepEqual([refused.status, refused.body.error?.fields?.[0]?.field, refused.body.error?.fields?.[0]?.reason], [422, "model_key", "not_an_option"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /AGENT_MODEL_BASE_URL/);
  assert.equal((await store.runs.list({})).length, 0, "no run made");
});

test("a server that holds a gateway key spends it on a run that brings none, and never on a run that brings its own, its compile turn included", { timeout: 180_000 }, async (t) => {
  const gw = await startFauxGateway({ text: "Answered." });
  t.after(() => gw.close());
  const SERVER_KEY = `not-a-secret-${"server-gateway-key"}-77aa`;
  withEnv(t, { ...keylessEnv(gw.url), AGENT_MODEL_API_KEY: SERVER_KEY }, NAMES);
  const { api } = await serve(t, { learning: "on", faux: undefined });
  // Two agents, each compiling at its first completed run (an agent compiles once: a compile whose draft failed stops
  // its next), so each run asks a compile turn at its end.
  await made(api, learner("plain", { learning: { compile_after: 1 } }));
  await made(api, learner("keyed", { learning: { compile_after: 1 } }));
  const plain = await api("POST", "/agents/plain/runs", { input: { content: "Answer." } });
  assert.equal(plain.status, 202, JSON.stringify(plain.body));
  await follow(api, plain.body.run_id, ["completed"], { deadlineMs: 90_000 });
  await until(async () => (await api("GET", `/runs/${plain.body.run_id}`)).body.learning?.state !== "running" && bearers(gw).length >= 2, "the job's request and the compile turn's");
  assert.deepEqual([...new Set(bearers(gw))], [`Bearer ${SERVER_KEY}`], "a run that brings no key spends the server's");
  const before = bearers(gw).length;
  const keyed = await api("POST", "/agents/keyed/runs", { input: { content: "Answer." }, model_key: KEY_ONE });
  assert.equal(keyed.status, 202, JSON.stringify(keyed.body));
  await follow(api, keyed.body.run_id, ["completed"], { deadlineMs: 90_000 });
  await until(async () => (await api("GET", `/runs/${keyed.body.run_id}`)).body.learning?.state !== "running" && bearers(gw).length >= before + 2, "the keyed run's job and compile turn");
  assert.deepEqual([...new Set(bearers(gw).slice(before))], [`Bearer ${KEY_ONE}`], "a run that brings its key spends it alone, its compile turn included, never the server's");
});

test("a runner that dies mid-turn: the next runner opens the run's sealed key from the store and goes on with it", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ text: "Answered after the crash." });
  t.after(() => gw.close());
  // A front for the gateway that holds the first request until the test lets it go, so the runner dies mid-turn.
  const { url, seen, release: hold } = await heldFront(t, gw);
  withEnv(t, keylessEnv(url), NAMES);
  const logs = [];
  const server = await serve(t, { faux: undefined, runnerTiming: CRASHABLE, log: (line) => logs.push(line) });
  const { api, crashRunner } = server;
  assert.equal((await api("POST", "/agents", agent("crashy"))).status, 201);
  const started = await api("POST", "/agents/crashy/runs", { input: { content: "Answer." }, model_key: KEY_ONE });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await until(() => seen.length >= 1, "the first request reached the gateway's front");
  await crashRunner();
  hold();
  const { last, rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  assert.ok(seen.length >= 2, `the next runner asked the gateway again: ${seen.length}`);
  assert.deepEqual([...new Set(seen)], [`Bearer ${KEY_ONE}`], "before and after the crash, the run's sealed key alone");
  await assertNowhere(server, runId, [KEY_ONE], logs);
});

test("a run started on the server's key, then a message with model_key while its turn is live: the very next request carries the message's key, never the server's again (red before: the claim held no key holder, and the message's key was ignored)", { timeout: 120_000 }, async (t) => {
  const SERVER_KEY = `not-a-secret-${"server-gateway-key"}-5b6c`;
  const { seen, server, runId, logs } = await keyMidTurn(t, { serverKey: SERVER_KEY, key: KEY_TWO });
  assert.equal(seen[0], `Bearer ${SERVER_KEY}`, "the turn began on the server's key");
  assert.deepEqual([...new Set(seen.slice(1))], [`Bearer ${KEY_TWO}`], "every request after the message, the first included, carried the message's key");
  await assertNowhere(server, runId, [KEY_TWO], logs);
});

test("a replacement key: a message's model_key is used on the very next request (red before: the proxy read the credential before beforeRequest refreshed it, so that request carried the old key)", { timeout: 120_000 }, async (t) => {
  const { seen, server, runId, logs } = await keyMidTurn(t, { start: { model_key: KEY_ONE }, key: KEY_TWO });
  assert.equal(seen[0], `Bearer ${KEY_ONE}`, "the turn began on the run's first key");
  assert.deepEqual([...new Set(seen.slice(1))], [`Bearer ${KEY_TWO}`], "every request after the message, the first included, carried the replacement");
  await assertNowhere(server, runId, [KEY_ONE, KEY_TWO], logs);
});
