// The launch hook (trigger-launch-hook.ts): a server started with a hook URL and its signing secret hands each trigger
// firing that would start a run to the host instead, as a signed POST (Standard Webhooks, the firing's id its
// webhook-id), and starts no run of its own for it. The run the host starts through the API with `trigger_firing` is the
// firing's (started, counted by the overlap check), on its trigger's target (its cap, its effort, its previous result);
// a 2xx with no such run records it sent; any other answer, or none within the bound, is a failed try under the
// trigger's retry policy, hook_failed with its cause. The hook's receiver here is a server on 127.0.0.1 that checks the
// signature as any receiver would.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { follow, scratch, serve, withEnv } from "./support.mjs";
import { fakeClock, firings, made, schedule, until } from "./trigger-support.mjs";

const { mintSecret, signatureOf, verify } = await import("../dist/standard-webhooks.js");
const { LAUNCH_HOOK_LATE_START_MS, LAUNCH_HOOK_TIMEOUT_MS, launchHookFrom } = await import("../dist/trigger-launch-hook.js");
const { previousResultWords } = await import("../dist/trigger-targets.js");
const { uuidv7 } = await import("../dist/ids.js");
const { claimSecrets } = await import("../dist/runner/claim-secrets.js");
const { heldRedactor, secretRedactor } = await import("../dist/runner/redact.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { openRunLaunch } = await import("../dist/store/index.js");

/** A host's hook on 127.0.0.1: each request kept (its headers and body), answered by `answer`. One the sender cut short
 *  (its bound passed mid-body, or the test's end) is answered 400, never left to throw in the test. */
async function hookServer(t, answer) {
  const got = [];
  const server = createServer(async (req, res) => {
    let sent;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      got.push({ method: req.method, headers: req.headers, body });
      sent = JSON.parse(body.toString("utf8"));
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(400).end();
      return;
    }
    // An answer that throws (its server stopped under it) fails its test by what it leaves undone, not here.
    await Promise.resolve(answer(res, sent, got.length)).catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { url: `http://127.0.0.1:${server.address().port}/agentrun/firings`, got };
}

const answerJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const runsOf = async (api, agentId) => (await api("GET", `/runs?agent=${agentId}`)).body.runs;

test("a schedule trigger's firing is handed to the host, signed with the setting's secret, and starts no run here", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const secret = mintSecret();
  const hook = await hookServer(t, (res) => answerJson(res, 200, {}));
  const { api, store } = await serve(t, { triggerClock: clock, launchHook: { url: hook.url, secret } });
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  clock.to("2026-06-01T00:10:00Z");
  const [firing] = await firings(api, created.body.id, 1);
  assert.deepEqual([firing.status, firing.run_id], ["sent", null], JSON.stringify(firing));
  assert.match(firing.reason, /launch hook/);

  assert.equal(hook.got.length, 1, "one POST for the one firing");
  const [{ method, headers, body }] = hook.got;
  assert.equal(method, "POST");
  assert.equal(verify(secret, headers, body, Date.now()), undefined, "signed with the setting's secret");
  assert.equal(verify(mintSecret(), headers, body, Date.now()), "bad_signature", "and no other");
  assert.equal(headers["webhook-id"], firing.key, "the firing's id is the message's id");
  const sent = JSON.parse(body.toString("utf8"));
  assert.deepEqual(Object.keys(sent).sort(), ["agent_id", "fired_at", "firing_id", "input", "revision_id", "trigger_id"]);
  assert.equal(sent.firing_id, firing.key);
  assert.equal(sent.trigger_id, created.body.id);
  assert.equal(sent.agent_id, "nightly");
  assert.equal(sent.revision_id, (await store.agents.get("nightly")).currentRevision);
  assert.equal(sent.fired_at, "2026-06-01T00:10:00Z");
  assert.match(sent.input.content, /^Say hello\./);
  assert.deepEqual(await runsOf(api, "nightly"), [], "the install started no run for the firing");
});

test("the host starts the firing's run through the API with trigger_firing: the run is the trigger's, the firing started, and the overlap check counts it", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const secret = mintSecret();
  let api;
  const starts = [];
  const hook = await hookServer(t, async (res, sent) => {
    starts.push(await api("POST", `/agents/${sent.agent_id}/runs`, { input: sent.input, max_cost_usd: 0.5, trigger_firing: { trigger_id: sent.trigger_id, firing_id: sent.firing_id } }));
    answerJson(res, 202, {});
  });
  // No runner: the host's run stays queued, so it is still active at the next time.
  ({ api } = await serve(t, { triggerClock: clock, runner: false, launchHook: { url: hook.url, secret } }));
  await made(api, "nightly");
  await made(api, "other");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  clock.to("2026-06-01T00:10:00Z");
  const [first] = await firings(api, created.body.id, 1);
  // The host's start links the firing as it lands, before its answer reaches the host.
  assert.ok(await until(() => starts.length === 1), "the host started the firing's run");
  assert.equal(starts[0]?.status, 202, JSON.stringify(starts[0]?.body));
  const runId = starts[0].body.run_id;
  assert.deepEqual([first.status, first.run_id], ["started", runId], JSON.stringify(first));
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual(run.trigger, { id: created.body.id, firing_key: first.key }, "the run is the trigger's, as one started here");
  const ref = { trigger_id: created.body.id, firing_id: first.key };
  const again = await api("POST", "/agents/nightly/runs", { input: { content: "Again." }, max_cost_usd: 0.5, trigger_firing: ref });
  assert.deepEqual([again.status, again.body.run_id, again.headers.get("idempotent-replayed")], [202, runId, "true"], "a second start for the firing answers its run");
  // The firing is the run's key: an Idempotency-Key beside it, whose check across a restart rides on the run's origin, is refused.
  const keyed = await api("POST", "/agents/nightly/runs", { input: { content: "Again." }, max_cost_usd: 0.5, trigger_firing: ref }, { "idempotency-key": "host-1" });
  assert.deepEqual([keyed.status, keyed.body.error.fields[0].field], [422, "trigger_firing"], JSON.stringify(keyed.body));
  const elsewhere = await api("POST", "/agents/other/runs", { input: { content: "Hi." }, max_cost_usd: 0.5, trigger_firing: ref });
  assert.equal(elsewhere.status, 422, "another agent's run is never this trigger's");
  assert.equal(elsewhere.body.error.fields[0].field, "trigger_firing.trigger_id", JSON.stringify(elsewhere.body));

  clock.to("2026-06-01T00:20:00Z");
  const [second] = await firings(api, created.body.id, 2);
  assert.deepEqual([second.status, second.run_id], ["skipped", null], JSON.stringify(second));
  assert.equal(hook.got.length, 1, "the time its run overlapped was never handed to the host");
  const late = await api("POST", "/agents/nightly/runs", { input: { content: "Late." }, max_cost_usd: 0.5, trigger_firing: { trigger_id: created.body.id, firing_id: second.key } });
  assert.equal(late.status, 422, "a skipped firing starts no run");
  assert.match(JSON.stringify(late.body), /not_due/);
  assert.equal((await runsOf(api, "nightly")).length, 1, "the host's one run");
});

test("a host may answer 2xx first and start the firing's run after: within 10 minutes of its answer its one start is the firing's, counted by the overlap check, and a second answers the same run", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const sent = [];
  const hook = await hookServer(t, (res, body) => {
    sent.push(body);
    answerJson(res, 202, {});
  });
  // No runner: the host's run stays queued, so it is still active at the next time.
  const { api } = await serve(t, { triggerClock: clock, runner: false, launchHook: { url: hook.url, secret: mintSecret() } });
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  clock.to("2026-06-01T00:10:00Z");
  const [handed] = await firings(api, id, 1);
  assert.deepEqual([handed.status, handed.run_id], ["sent", null], "the host answered first, with no run yet");
  assert.equal(handed.start_by, "2026-06-01T00:20:00.000Z", "its host may start its run until 10 minutes after its answer");

  clock.to("2026-06-01T00:15:00Z");
  const ref = { trigger_id: id, firing_id: handed.key };
  const late = await api("POST", "/agents/nightly/runs", { input: sent[0].input, max_cost_usd: 0.5, trigger_firing: ref });
  assert.equal(late.status, 202, JSON.stringify(late.body));
  const runId = late.body.run_id;
  assert.deepEqual((await api("GET", `/runs/${runId}`)).body.trigger, { id, firing_key: handed.key }, "the run is the trigger's, as one started first would be");
  const [now] = (await api("GET", `/triggers/${id}/firings`)).body.firings;
  assert.deepEqual([now.key, now.status, now.run_id, "start_by" in now], [handed.key, "started", runId, false], "the firing ends up started with the host's run, and no start_by");
  assert.equal((await api("GET", `/triggers/${id}`)).body.last_run_id, runId);

  clock.to("2026-06-01T00:20:00Z");
  const [next] = await firings(api, id, 2);
  assert.deepEqual([next.status, next.run_id], ["skipped", null], JSON.stringify(next));
  assert.match(next.reason, new RegExp(runId), "the overlap check counts the late run");
  assert.equal(hook.got.length, 1, "the overlapping time was never handed to the host");

  clock.to("2026-06-01T00:25:00Z");
  const again = await api("POST", "/agents/nightly/runs", { input: sent[0].input, max_cost_usd: 0.5, trigger_firing: ref });
  assert.deepEqual([again.status, again.body.run_id, again.headers.get("idempotent-replayed")], [202, runId, "true"], "a second start answers the first run, past the bound too");
  assert.equal((await runsOf(api, "nightly")).length, 1, "one run for the firing");
});

test("a firing whose host answered 2xx with no run starts none once its start_by, 10 minutes after that answer, has passed: not_due, in words", { timeout: 120_000 }, async (t) => {
  assert.equal(LAUNCH_HOOK_LATE_START_MS, 10 * 60_000);
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const hook = await hookServer(t, (res) => answerJson(res, 200, {}));
  const { api } = await serve(t, { triggerClock: clock, runner: false, launchHook: { url: hook.url, secret: mintSecret() } });
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  clock.to("2026-06-01T00:10:00Z");
  const [handed] = await firings(api, created.body.id, 1);
  assert.deepEqual([handed.status, handed.run_id], ["sent", null]);

  clock.to("2026-06-01T00:20:01Z");
  const late = await api("POST", "/agents/nightly/runs", { input: { content: "Late." }, max_cost_usd: 0.5, trigger_firing: { trigger_id: created.body.id, firing_id: handed.key } });
  assert.equal(late.status, 422, JSON.stringify(late.body));
  const [issue] = late.body.error.fields;
  assert.deepEqual([issue.field, issue.reason], ["trigger_firing.firing_id", "not_due"]);
  assert.match(issue.message, /10 minutes after its host answered.*2026-06-01T00:20:00\.000Z/);
  assert.deepEqual(await runsOf(api, "nightly"), [], "no run for it");
  const [still] = (await api("GET", `/triggers/${created.body.id}/firings`)).body.firings;
  assert.deepEqual([still.status, still.run_id, still.start_by], ["sent", null, "2026-06-01T00:20:00.000Z"]);
});

/** The host's start of firing `key` of trigger `id`, through the API, as the launch hook's host makes it. */
const hostStart = (api, agentId, id, key, input = { content: "Late." }) => api("POST", `/agents/${agentId}/runs`, { input, max_cost_usd: 0.5, trigger_firing: { trigger_id: id, firing_id: key } });

test("a catch-up handed 30 minutes after its fired_at gets its 10 minutes from its host's answer: start_by in the firings (never retry_at or attempts), and a start within it is the firing's", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const hook = await hookServer(t, (res) => answerJson(res, 200, {}));
  const { api } = await serve(t, { triggerClock: clock, runner: false, launchHook: { url: hook.url, secret: mintSecret() } });
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  // The timer comes 30 minutes late (the server was down): the 00:10 time fires at 00:40, within the catch-up window.
  clock.to("2026-06-01T00:40:00Z");
  const [handed] = await firings(api, id, 1);
  assert.deepEqual([handed.status, handed.run_id, handed.nominal_at, handed.catch_up], ["sent", null, "2026-06-01T00:10:00Z", true], JSON.stringify(handed));
  assert.equal(JSON.parse(hook.got[0].body.toString("utf8")).fired_at, "2026-06-01T00:10:00Z");
  assert.equal(handed.start_by, "2026-06-01T00:50:00.000Z", "10 minutes from the host's answer, not from fired_at");
  assert.deepEqual(["retry_at", "attempts"].filter((field) => field in handed), [], "the deadline never reads as a retry");

  clock.to("2026-06-01T00:45:00Z");
  const late = await hostStart(api, "nightly", id, handed.key);
  assert.equal(late.status, 202, JSON.stringify(late.body));
  const [now] = (await api("GET", `/triggers/${id}/firings`)).body.firings;
  assert.deepEqual([now.key, now.status, now.run_id], [handed.key, "started", late.body.run_id]);
});

test("a firing the server's stop cut short is handed again at the next start, 30 minutes after its fired_at, and its host gets its 10 minutes from that answer", { timeout: 180_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const secret = mintSecret();
  // The first host never answers: the stop cuts the handover short, and the firing stays due.
  const silent = await hookServer(t, () => new Promise(() => {}));
  const first = await serve(t, { data, triggerClock: clock, runner: false, launchHook: { url: silent.url, secret } });
  await made(first.api, "nightly");
  const created = await first.api("POST", "/triggers", schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  clock.to("2026-06-01T00:10:00Z");
  assert.ok(await until(() => silent.got.length === 1), "handed to the first host");
  await first.close();
  const [left] = (await first.store.triggers.firings(id));
  assert.equal(left.status, "due", "the stop left it due");

  clock.to("2026-06-01T00:40:00Z");
  const hook = await hookServer(t, (res) => answerJson(res, 200, {}));
  const second = await serve(t, { data, triggerClock: clock, runner: false, launchHook: { url: hook.url, secret } });
  const [handed] = await firings(second.api, id, 1);
  assert.deepEqual([handed.key, handed.status, handed.start_by], [left.key, "sent", "2026-06-01T00:50:00.000Z"], JSON.stringify(handed));
  assert.equal(hook.got[0].headers["webhook-id"], left.key, "under the same webhook-id");

  clock.to("2026-06-01T00:45:00Z");
  const late = await hostStart(second.api, "nightly", id, handed.key);
  assert.equal(late.status, 202, JSON.stringify(late.body));
  assert.equal((await second.api("GET", `/triggers/${id}/firings`)).body.firings[0].status, "started");
});

/** What a stop between a host's late start and its firing's start leaves (the run is written first, then the firing is
 *  started with it): a queued run under the firing's key, and the firing still sent with no run. Answers the run's id. */
async function unlinkedRun(store, agentId, key) {
  const agent = await store.agents.get(agentId);
  return (await store.runs.create({ id: uuidv7(), agentId, revisionId: agent.currentRevision, origin: { key } })).id;
}

test("a sent firing whose host's run was written but never linked (a stop between the two) is started with it by the host's repeated start, and the overlap check counts it", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const hook = await hookServer(t, (res) => answerJson(res, 200, {}));
  // No runner: the host's run stays queued, so it is still active at the next time.
  const { api, store } = await serve(t, { triggerClock: clock, runner: false, launchHook: { url: hook.url, secret: mintSecret() } });
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  clock.to("2026-06-01T00:10:00Z");
  const [sent] = await firings(api, id, 1);
  assert.equal(sent.status, "sent", JSON.stringify(sent));
  const runId = await unlinkedRun(store, "nightly", sent.key);

  clock.to("2026-06-01T00:12:00Z");
  const again = await hostStart(api, "nightly", id, sent.key);
  assert.deepEqual([again.status, again.body.run_id, again.headers.get("idempotent-replayed")], [202, runId, "true"], JSON.stringify(again.body));
  const [linked] = (await api("GET", `/triggers/${id}/firings`)).body.firings;
  assert.deepEqual([linked.status, linked.run_id, linked.start_by], ["started", runId, undefined], JSON.stringify(linked));

  clock.to("2026-06-01T00:20:00Z");
  const [next] = await firings(api, id, 2);
  assert.deepEqual([next.status, next.run_id], ["skipped", null], JSON.stringify(next));
  assert.match(next.reason, new RegExp(runId), "skipped naming the host's run");
  assert.equal(hook.got.length, 1, "the time its run overlapped was never handed to the host");
});

for (const [restart, hooked] of [["the hook still set", true], ["the hook since unset", false]]) test(`a sent firing whose host's run was written but never linked (a stop between the two) is started with it at the next server's start, ${restart}, and the overlap check counts it`, { timeout: 180_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const secret = mintSecret();
  const hook = await hookServer(t, (res) => answerJson(res, 200, {}));
  const first = await serve(t, { data, triggerClock: clock, runner: false, launchHook: { url: hook.url, secret } });
  await made(first.api, "nightly");
  const created = await first.api("POST", "/triggers", schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  clock.to("2026-06-01T00:10:00Z");
  const [sent] = await firings(first.api, id, 1);
  assert.equal(sent.status, "sent", JSON.stringify(sent));
  const runId = await unlinkedRun(first.store, "nightly", sent.key);
  await first.close();

  clock.to("2026-06-01T00:12:00Z");
  const second = await serve(t, { data, triggerClock: clock, runner: false, ...(hooked ? { launchHook: { url: hook.url, secret } } : {}) });
  const read = async () => (await second.api("GET", `/triggers/${id}/firings`)).body.firings[0];
  assert.ok(await until(async () => (await read()).status === "started"), JSON.stringify(await read()));
  assert.deepEqual([(await read()).run_id, hook.got.length], [runId, 1], "started with the host's run, never handed again");

  clock.to("2026-06-01T00:20:00Z");
  const [next] = await firings(second.api, id, 2);
  assert.deepEqual([next.status, next.run_id], ["skipped", null], JSON.stringify(next));
  assert.match(next.reason, new RegExp(runId), "skipped naming the host's run");
  assert.equal(hook.got.length, 1, "the time its run overlapped was never handed to the host");
});

test("a firing that waited on its trigger's max_active_runs is handed when its room comes, 30 minutes after its fired_at, and its host gets its 10 minutes from that answer", { timeout: 180_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const gate = join(await scratch(t), "gate");
  let api;
  const hook = await hookServer(t, async (res, sent, n) => {
    // The first firing's run starts before the answer and holds its answer until the gate opens: the trigger's one place.
    if (n === 1) await hostStart(api, sent.agent_id, sent.trigger_id, sent.firing_id, sent.input);
    answerJson(res, 200, {});
  });
  const server = await serve(t, { triggerClock: clock, launchHook: { url: hook.url, secret: mintSecret() } });
  ({ api } = server);
  await made(api, "triage");
  const created = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "triage", input: { content: `Hold the answer until ${gate}.` }, max_cost_usd: 0.5 }, max_active_runs: 1 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, signing_secret: hookSecret } = created.body;
  const deliver = (event) => {
    const at = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event });
    return fetch(`${server.baseUrl}/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": event, "webhook-timestamp": at, "webhook-signature": signatureOf(hookSecret, event, at, body) }, body });
  };
  assert.equal((await deliver("evt-1")).status, 202);
  const [first] = await firings(api, id, 1);
  assert.deepEqual([first.status, typeof first.run_id], ["started", "string"], JSON.stringify(first));
  await follow(api, first.run_id, ["working"]);
  assert.equal((await deliver("evt-2")).status, 202);
  const waits = await until(async () => (await api("GET", `/triggers/${id}/firings`)).body.firings.find((f) => f.key !== first.key && /max_active_runs/.test(f.reason ?? "")));
  assert.ok(waits, "the second waits on the trigger's one place");
  assert.equal(waits.nominal_at, "2026-06-01T00:00:00Z");

  clock.to("2026-06-01T00:30:00Z");
  await writeFile(gate, "");
  await follow(api, first.run_id, ["completed"]);
  // The engine polls a waiting firing on its timer: the clock steps a second at a time until the second is handed.
  assert.ok(await until(() => hook.got.length === 2 || void clock.to(new Date(clock.now() + 1000).toISOString())), "the second is handed once its room comes");
  const handed = await until(async () => (await api("GET", `/triggers/${id}/firings`)).body.firings.find((f) => f.key === waits.key && f.status === "sent"));
  assert.ok(handed, "its host took it with no run");
  const startBy = Date.parse(handed.start_by);
  assert.ok(startBy >= Date.parse("2026-06-01T00:40:00Z") && startBy <= Date.parse("2026-06-01T00:41:00Z"), `10 minutes from the answer: ${handed.start_by}`);

  clock.to("2026-06-01T00:35:00Z");
  const late = await hostStart(api, "triage", id, handed.key);
  assert.equal(late.status, 202, JSON.stringify(late.body));
  assert.equal((await api("GET", `/triggers/${id}/firings`)).body.firings.find((f) => f.key === handed.key).status, "started");
  await follow(api, late.body.run_id, ["completed"]);
});

test("a sent firing waiting on its host's start is never driven or handed again: not pending, the timer at the trigger's next time and never its start_by, and past start_by no second POST", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const hook = await hookServer(t, (res) => answerJson(res, 200, {}));
  const { api, store } = await serve(t, { triggerClock: clock, runner: false, launchHook: { url: hook.url, secret: mintSecret() } });
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  clock.to("2026-06-01T00:10:00Z");
  const [handed] = await firings(api, id, 1);
  assert.deepEqual([handed.status, handed.start_by], ["sent", "2026-06-01T00:20:00.000Z"], JSON.stringify(handed));
  assert.deepEqual((await store.triggers.pending()).map((f) => f.key), [], "a sent firing is not pending (tick's drive, arm's soonest)");
  assert.equal(await store.triggers.soonest(), Date.parse("2026-06-01T01:10:00Z"), "the store's soonest is the trigger's next time");
  assert.ok(await until(() => clock.timer?.at === Date.parse("2026-06-01T01:10:00Z")), `the engine's timer waits for the next time: ${clock.timer && new Date(clock.timer.at).toISOString()}`);

  clock.to("2026-06-01T00:20:01Z");
  clock.to("2026-06-01T01:10:00Z");
  const [next, before] = await firings(api, id, 2);
  assert.deepEqual([before.key, before.status, before.run_id], [handed.key, "sent", null], "past its start_by it stays sent, never handed again");
  assert.equal(next.status, "sent");
  assert.deepEqual(hook.got.map((got) => got.headers["webhook-id"]), [handed.key, next.key], "one POST for each firing");
});

/** A server with the launch hook and AGENTRUN_RUN_KEYS=1, holding no Parallel key, whose agent (a template's, applied)
 *  declares PARALLEL_API_KEY; a schedule trigger on it, at 00:10. `answer` is the host's. Its seal key, to open what a
 *  run's claim gets (run-keys-claim). `manifest`: more lines of the template's manifest. */
async function keyedHook(t, answer, { manifest = [] } = {}) {
  const sealKey = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey.toString("base64") }, ["PARALLEL_API_KEY", "AGENTRUN_RUN_KEYS"]);
  const dir = join(await scratch(t), "templates", "searcher");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "agent.md"), ["---", "name: searcher", "version: 1.0.0", "description: Searches the web for what it is asked.", "model: { tier: strong }", "tools: [web_search, read]", "secrets: [PARALLEL_API_KEY]", ...manifest, "---", "Search the web for what you are asked, then answer.", ""].join("\n"));
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const hook = await hookServer(t, answer);
  // No runner: the host's run stays queued, its launch holding the keys it carried.
  const server = await serve(t, { triggerClock: clock, runner: false, runKeys: true, templates: join(dir, ".."), launchHook: { url: hook.url, secret: mintSecret() } });
  const applied = await server.api("POST", "/templates/searcher/apply", {});
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agentId = applied.body.agent_id;
  const created = await server.api("POST", "/triggers", schedule(agentId, { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { ...server, clock, hook, sealKey, agentId, applied: applied.body, triggerId: created.body.id };
}

/** The tool keys run `runId`'s claim lays over its tools' environment (claim-secrets.ts), on a host with none of its own. */
async function claimedKeys(store, sealKey, runId) {
  const row = await store.runs.get(runId);
  const env = await claimSecrets({ store, sealKey, env: {}, redact: heldRedactor(secretRedactor([])) }, await store.agents.revision(row.revisionId), readLaunchBody((await store.runs.launch(runId)).body), runId);
  return { PARALLEL_API_KEY: env.PARALLEL_API_KEY };
}

const runKey = () => ["not-a-secret", "run-key", randomBytes(8).toString("hex")].join("-");

test("AGENTRUN_RUN_KEYS=1 with the launch hook: the template's own schedule trigger is made, as one through the API is, since each firing goes to the host that brings the key; a message_run trigger at one of the agent's runs is still 409 naming the key, nothing made", { timeout: 120_000 }, async (t) => {
  const morning = ["budget: { per_run_usd: 0.5 }", "triggers:", "  - name: morning", "    source: { kind: schedule, cron: \"0 9 * * *\", timezone: UTC }", "    target: { kind: start_run, input: { content: \"Search.\" } }"];
  const keyed = await keyedHook(t, (res) => answerJson(res, 202, {}), { manifest: morning });
  const { api, store, agentId } = keyed;
  assert.deepEqual(keyed.applied.triggers.map((one) => one.name), ["morning"], JSON.stringify(keyed.applied));
  assert.ok(!keyed.applied.warnings.some((one) => /^triggers\./.test(one.field)), JSON.stringify(keyed.applied.warnings));

  const run = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Search." }, max_cost_usd: 0.5, keys: { PARALLEL_API_KEY: runKey() } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const poke = await api("POST", "/triggers", { name: "poke", source: { kind: "schedule", every_s: 3600 }, target: { kind: "message_run", run_id: run.body.run_id, input: { content: "Once more." } } });
  assert.deepEqual([poke.status, poke.body.error?.code, poke.body.error?.fields?.map((one) => [one.field, one.reason])], [409, "agent_not_runnable", [["keys.PARALLEL_API_KEY", "not_set_up_here"]]], JSON.stringify(poke.body));
  assert.deepEqual((await store.triggers.list(agentId)).map((one) => one.name).sort(), ["morning", "nightly"], "the template's and the API's start_run triggers, and no other");
});

test("AGENTRUN_RUN_KEYS=1: the host's trigger_firing start carrying the key its agent declares is taken, the firing started, and the run's claim gets the key", { timeout: 120_000 }, async (t) => {
  const key = runKey();
  let api;
  const starts = [];
  const keyed = await keyedHook(t, async (res, sent) => {
    starts.push(await api("POST", `/agents/${sent.agent_id}/runs`, { input: sent.input, max_cost_usd: 0.5, keys: { PARALLEL_API_KEY: key }, trigger_firing: { trigger_id: sent.trigger_id, firing_id: sent.firing_id } }));
    answerJson(res, 202, {});
  });
  ({ api } = keyed);
  keyed.clock.to("2026-06-01T00:10:00Z");
  const [firing] = await firings(api, keyed.triggerId, 1);
  assert.ok(await until(() => starts.length === 1), "the host's start answered");
  assert.equal(starts[0].status, 202, JSON.stringify(starts[0].body));
  const runId = starts[0].body.run_id;
  assert.deepEqual([firing.status, firing.run_id], ["started", runId], JSON.stringify(firing));
  assert.deepEqual(await claimedKeys(keyed.store, keyed.sealKey, runId), { PARALLEL_API_KEY: key }, "the run's claim lays the key its host's start carried");
  assert.ok(!JSON.stringify(starts[0].body).includes(key), "the start's answer holds no key");
});

test("AGENTRUN_RUN_KEYS=1: the host's trigger_firing start without the declared key is 409 naming it, no run is left, and the firing stays sent and takes a start inside its window", { timeout: 120_000 }, async (t) => {
  const keyed = await keyedHook(t, (res) => answerJson(res, 202, {}));
  const { api } = keyed;
  keyed.clock.to("2026-06-01T00:10:00Z");
  const [handed] = await firings(api, keyed.triggerId, 1);
  assert.deepEqual([handed.status, handed.run_id], ["sent", null], "the host answered first, with no run yet");
  const ref = { trigger_id: keyed.triggerId, firing_id: handed.key };

  keyed.clock.to("2026-06-01T00:15:00Z");
  const bare = await api("POST", `/agents/${keyed.agentId}/runs`, { input: { content: "Search." }, max_cost_usd: 0.5, trigger_firing: ref });
  assert.deepEqual([bare.status, bare.body.error?.code, bare.body.error?.fields?.map((one) => [one.field, one.reason])], [409, "agent_not_runnable", [["keys.PARALLEL_API_KEY", "not_set_up_here"]]], JSON.stringify(bare.body));
  assert.deepEqual(await runsOf(api, keyed.agentId), [], "no run is left");
  const [still] = (await api("GET", `/triggers/${keyed.triggerId}/firings`)).body.firings;
  assert.deepEqual([still.key, still.status, still.run_id, still.start_by], [handed.key, "sent", null, handed.start_by], "the firing stays sent, its window as it was");

  const key = runKey();
  const carried = await api("POST", `/agents/${keyed.agentId}/runs`, { input: { content: "Search." }, max_cost_usd: 0.5, keys: { PARALLEL_API_KEY: key }, trigger_firing: ref });
  assert.equal(carried.status, 202, JSON.stringify(carried.body));
  const [now] = (await api("GET", `/triggers/${keyed.triggerId}/firings`)).body.firings;
  assert.deepEqual([now.status, now.run_id], ["started", carried.body.run_id], "a start inside its window that carries the key is the firing's");
  assert.deepEqual(await claimedKeys(keyed.store, keyed.sealKey, carried.body.run_id), { PARALLEL_API_KEY: key });
});

test("AGENTRUN_RUN_KEYS=1: a key the agent does not declare in the host's trigger_firing start gets the answer an ordinary start gives, and the firing stays sent", { timeout: 120_000 }, async (t) => {
  const keyed = await keyedHook(t, (res) => answerJson(res, 202, {}));
  const { api } = keyed;
  keyed.clock.to("2026-06-01T00:10:00Z");
  const [handed] = await firings(api, keyed.triggerId, 1);
  assert.equal(handed.status, "sent");
  const keys = { PARALLEL_API_KEY: runKey(), MONID_API_KEY: runKey() };
  const ordinary = await api("POST", `/agents/${keyed.agentId}/runs`, { input: { content: "Search." }, max_cost_usd: 0.5, keys });
  assert.equal(ordinary.status, 422, JSON.stringify(ordinary.body));
  const firing = await api("POST", `/agents/${keyed.agentId}/runs`, { input: { content: "Search." }, max_cost_usd: 0.5, keys, trigger_firing: { trigger_id: keyed.triggerId, firing_id: handed.key } });
  // Each answer names its own request; the rest is the same.
  const answered = ({ status, body: { error: { request_id, ...error } } }) => [status, error];
  assert.deepEqual(answered(firing), answered(ordinary), "the same answer as the ordinary start's");
  assert.deepEqual(await runsOf(api, keyed.agentId), [], "no run for either");
  const [still] = (await api("GET", `/triggers/${keyed.triggerId}/firings`)).body.firings;
  assert.deepEqual([still.status, still.run_id], ["sent", null]);
});

test("the host's start runs on its trigger's target: the target's cap, which the host's max_cost_usd may lower and never raise, over the agent's default; the target's effort when it sets one, else the host's", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  let api;
  // Each trigger's host sends its own max_cost_usd (none, more than the target's, or less) and effort.
  const host = new Map();
  const hook = await hookServer(t, async (res, sent) => {
    const { cap, effort } = host.get(sent.trigger_id);
    const started = await api("POST", `/agents/${sent.agent_id}/runs`, { input: sent.input, ...(cap === undefined ? {} : { max_cost_usd: cap }), ...(effort ? { effort } : {}), trigger_firing: { trigger_id: sent.trigger_id, firing_id: sent.firing_id } });
    answerJson(res, started.status === 202 ? 202 : 400, {});
  });
  ({ api } = await serve(t, { triggerClock: clock, runner: false, launchHook: { url: hook.url, secret: mintSecret() } }));
  await made(api, "nightly", { max_cost_usd: 5 });
  const ids = {};
  for (const [name, cap, effort, targetEffort] of [["none", undefined, undefined, "high"], ["more", 10, "low", "high"], ["less", 0.2, undefined, "high"], ["own", undefined, "low", undefined]]) {
    const target = { kind: "start_run", agent_id: "nightly", input: { content: "Say hello." }, max_cost_usd: 0.5, ...(targetEffort ? { effort: targetEffort } : {}) };
    const created = await api("POST", "/triggers", { ...schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }), name, target });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    host.set(created.body.id, { cap, effort });
    ids[name] = created.body.id;
  }
  clock.to("2026-06-01T00:10:00Z");
  const runOf = async (name) => {
    const [firing] = await firings(api, ids[name], 1);
    assert.equal(firing.status, "started", JSON.stringify(firing));
    return (await api("GET", `/runs/${firing.run_id}`)).body;
  };
  const none = await runOf("none");
  const more = await runOf("more");
  assert.equal(none.cost.cap_usd, 0.5, "the target's cap, never the agent's $5 default");
  assert.equal(more.cost.cap_usd, 0.5, "a host's cap never raises the target's");
  assert.equal((await runOf("less")).cost.cap_usd, 0.2, "a host's cap lowers it");
  assert.equal(none.effort, "high", "the target's effort");
  assert.equal(more.effort, "high", "the target's effort over the host's");
  assert.equal((await runOf("own")).effort, "low", "the host's effort when the target sets none");
});

/** Every model setting a keyless server's tests set or clear: it holds no model key of its own. */
const MODEL_NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SERVE_GRADE_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

test("the host's start lays its body over the target's run as any start takes it: mcp_auth and model_key sealed for the run, as its claim opens them; max_cost_usd under the target's cap; effort the target's, else the host's", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ text: "Answered." });
  t.after(() => gw.close());
  const sealKey = randomBytes(32);
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "claude-sonnet-5-5", AGENTRUN_SEAL_KEY: sealKey.toString("base64") }, [...MODEL_NAMES, "AGENTRUN_SEAL_KEY"]);
  const listToken = `not-a-secret-list-${randomBytes(6).toString("hex")}`;
  const runToken = `not-a-secret-run-${randomBytes(6).toString("hex")}`;
  const modelKey = `not-a-secret-model-${randomBytes(6).toString("hex")}`;
  const mcp = await startFakeMcp({ token: (authorization) => [listToken, runToken].some((token) => authorization === `Bearer ${token}`) });
  t.after(() => mcp.close());
  const clock = fakeClock("2026-06-01T00:00:00Z");
  let api;
  const hostCap = new Map();
  const starts = [];
  const hook = await hookServer(t, async (res, sent) => {
    const body = { input: sent.input, mcp_auth: { gw: { headers: { authorization: `Bearer ${runToken}` } } }, model_key: modelKey, max_cost_usd: hostCap.get(sent.trigger_id), effort: "low", trigger_firing: { trigger_id: sent.trigger_id, firing_id: sent.firing_id } };
    const started = await api("POST", `/agents/${sent.agent_id}/runs`, body);
    starts.push(started);
    answerJson(res, started.status === 202 ? 202 : 400, {});
  });
  const server = await serve(t, { faux: undefined, triggerClock: clock, runner: false, launchHook: { url: hook.url, secret: mintSecret() } });
  ({ api } = server);
  const saved = await api("PUT", "/settings/mcp-servers/gw", { url: mcp.url, auth: { type: "per_run", headers: { authorization: `Bearer ${listToken}` } } }, { authorization: `Bearer ${server.token}` });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await made(api, "nightly", { tools: ["mcp:gw/add"] });
  const ids = {};
  for (const [name, cap, effort] of [["own", 10, undefined], ["set", 0.2, "high"]]) {
    const target = { kind: "start_run", agent_id: "nightly", input: { content: "Add two and two." }, max_cost_usd: 0.5, ...(effort ? { effort } : {}) };
    const created = await api("POST", "/triggers", { ...schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }), name, target });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    hostCap.set(created.body.id, cap);
    ids[name] = created.body.id;
  }
  clock.to("2026-06-01T00:10:00Z");
  assert.ok(await until(() => starts.length === 2), "both hosts started their firing's run");
  for (const started of starts) {
    assert.equal(started.status, 202, JSON.stringify(started.body));
    for (const secret of [runToken, modelKey]) assert.ok(!JSON.stringify(started.body).includes(secret), "the start's answer holds no credential");
  }
  const runOf = async (name) => {
    const [firing] = await firings(api, ids[name], 1);
    assert.equal(firing.status, "started", JSON.stringify(firing));
    return (await api("GET", `/runs/${firing.run_id}`)).body;
  };
  for (const [name, cap, effort] of [["own", 0.5, "low"], ["set", 0.2, "high"]]) {
    const run = await runOf(name);
    assert.deepEqual([run.cost.cap_usd, run.effort], [cap, effort], `${name}: the cap is the lower of the two, the effort the target's, else the host's`);
    const opened = openRunLaunch(sealKey, run.run_id, (await server.store.runs.launch(run.run_id)).sealed);
    assert.deepEqual(opened?.mcp?.gw?.headers, { authorization: `Bearer ${runToken}` }, `${name}: the host's mcp_auth, sealed for the run`);
    assert.equal(opened?.model?.key, modelKey, `${name}: the host's model_key, sealed for the run's turns`);
  }
});

test("a failed hook's firing, its trigger and its trigger.failed name the failure, never the hook's URL, its query or the hook's secret", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SEAL_KEY"]);
  const token = `not-a-secret-query-${randomBytes(8).toString("hex")}`;
  const secret = mintSecret();
  const hidden = (url) => [["the hook URL", url], ["its query token", token], ["its path", "/agentrun/firings"], ["the secret", secret], ["the secret's key", secret.slice("whsec_".length)]];
  const shownNone = (text, url, what) => {
    for (const [name, part] of hidden(url)) assert.ok(!text.includes(part), `${what} holds ${name}`);
  };

  // A hook that answers 400: the firing fails at once, and trigger.failed is sent.
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const hook = await hookServer(t, (res) => answerJson(res, 400, { error: "no" }));
  const receiver = await hookServer(t, (res) => answerJson(res, 200, {}));
  const url = `${hook.url}?token=${token}`;
  const { api } = await serve(t, { triggerClock: clock, webhookPrivateTargets: true, launchHook: { url, secret } });
  assert.equal((await api("PUT", "/settings/webhook", { url: receiver.url })).status, 201);
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  clock.to("2026-06-01T00:10:00Z");
  const [refused] = await firings(api, created.body.id, 1);
  assert.deepEqual([refused.status, refused.error?.code], ["failed", "hook_failed"], JSON.stringify(refused));
  const failed = await until(() => receiver.got.filter((got) => got.method === "POST").map((got) => JSON.parse(got.body.toString("utf8"))).find((message) => message.type === "trigger.failed"));
  assert.match(failed?.data?.error?.message ?? "", /^hook_failed \(400\)/, JSON.stringify(failed));
  const firingsShown = JSON.stringify((await api("GET", `/triggers/${created.body.id}/firings`)).body);
  shownNone(firingsShown, url, "the firings");
  shownNone(JSON.stringify((await api("GET", `/triggers/${created.body.id}`)).body), url, "the trigger");
  shownNone(JSON.stringify(failed), url, "trigger.failed");

  // A hook that is not reached: the firing's reason names the errno, never where it went.
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const gone = `http://127.0.0.1:${closed.address().port}/agentrun/firings?token=${token}`;
  await new Promise((resolve) => closed.close(resolve));
  const laterClock = fakeClock("2026-06-01T00:00:00Z");
  const unreached = await serve(t, { triggerClock: laterClock, launchHook: { url: gone, secret } });
  await made(unreached.api, "nightly");
  const later = await unreached.api("POST", "/triggers", schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(later.status, 201, JSON.stringify(later.body));
  laterClock.to("2026-06-01T00:10:00Z");
  const waiting = await tried(unreached.api, later.body.id, 1);
  assert.match(waiting.reason ?? "", /^hook_failed \(unreachable\): the launch hook was not reached \(ECONNREFUSED\)/, JSON.stringify(waiting));
  shownNone(JSON.stringify(waiting), gone, "the unreached firing");
  shownNone(waiting.reason, `127.0.0.1:${new URL(gone).port}`, "its reason");
});

test("the host's start of a schedule's second firing is handed the trigger's previous result, as a run started here is", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  let api;
  const hook = await hookServer(t, async (res, sent) => {
    await hostStart(api, sent.agent_id, sent.trigger_id, sent.firing_id, sent.input);
    answerJson(res, 202, {});
  });
  let store;
  ({ api, store } = await serve(t, { triggerClock: clock, launchHook: { url: hook.url, secret: mintSecret() } }));
  const answer = { quiet: false, items: ["Acme launched Pulse"] };
  const schema = { type: "object", required: ["quiet", "items"], properties: { quiet: { type: "boolean" }, items: { type: "array", items: { type: "string" } } } };
  await made(api, "digest", { output_schema: schema });
  const created = await api("POST", "/triggers", { ...schedule("digest", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }), target: { kind: "start_run", agent_id: "digest", input: { content: `Answer with this json: ${JSON.stringify(answer)}` }, max_cost_usd: 0.5 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  clock.to("2026-06-01T00:10:00Z");
  const [first] = await firings(api, id, 1);
  assert.equal(first.status, "started", JSON.stringify(first));
  await follow(api, first.run_id, ["completed"]);
  const done = (await api("GET", `/runs/${first.run_id}`)).body;
  assert.deepEqual(done.result.output, answer, "its structured answer");

  clock.to("2026-06-01T00:20:00Z");
  const [second] = await firings(api, id, 2);
  assert.equal(second.status, "started", JSON.stringify(second));
  const { content } = readLaunchBody((await store.runs.launch(second.run_id)).body).input;
  assert.ok(content.endsWith(previousResultWords(first.run_id, done.ended_at, JSON.stringify(answer, null, 2))), `the second run is handed the first's result: ${content}`);
});

test("a host start that lands after the hook's bound, while its firing waits on its retry, starts the firing with that run right then, and the next firing's overlap check sees it", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  let api;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let late;
  // The host holds its start until the test lets it go, after the server's bound passed with no answer.
  const hook = await hookServer(t, async (_res, sent) => {
    await held;
    late = await hostStart(api, sent.agent_id, sent.trigger_id, sent.firing_id, sent.input);
  });
  // No runner: the host's run stays queued, so it is still active at the next time.
  ({ api } = await serve(t, { triggerClock: clock, runner: false, launchHook: { url: hook.url, secret: mintSecret(), timeoutMs: 300 } }));
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  clock.to("2026-06-01T00:10:00Z");
  const waiting = await tried(api, id, 1);
  release();
  assert.ok(await until(() => late !== undefined), "the host's start answered");
  const [now] = (await api("GET", `/triggers/${id}/firings`)).body.firings;
  assert.deepEqual([now.key, now.status, now.run_id], [waiting.key, "started", late.body.run_id], `started with the host's run, before its retry_at: ${JSON.stringify(now)} ${JSON.stringify(late.body)}`);
  assert.equal(late.status, 202);
  assert.equal(waiting.status, "due", "it waited on its retry when the host's start landed");
  assert.equal((await api("GET", `/triggers/${id}`)).body.last_run_id, late.body.run_id);

  // Past its retry_at and on to the next time: the timer, armed for the retry, fires once for both.
  assert.ok(await until(() => clock.timer !== null), "the timer armed");
  clock.to("2026-06-01T01:10:00Z");
  const [next] = await firings(api, id, 2);
  assert.deepEqual([next.status, next.run_id], ["skipped", null], JSON.stringify(next));
  assert.match(next.reason, new RegExp(late.body.run_id), "the overlap check counts the host's run");
  assert.equal(posts(hook).length, 1, "neither its retry nor the overlapping time was handed again");
});

test("a server without the launch hook refuses a run for a trigger firing", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, {});
  await made(api, "nightly");
  const refused = await api("POST", "/agents/nightly/runs", { input: { content: "Hi." }, max_cost_usd: 0.5, trigger_firing: { trigger_id: "trg_0123456789abcdef01234567", firing_id: `fir_${"0".repeat(32)}` } });
  assert.equal(refused.status, 422);
  assert.match(JSON.stringify(refused.body), /no launch hook/);
});

/** The trigger's newest firing once it has had `n` tries (attempts) or is no longer due: a hook failure's try settled. */
async function tried(api, id, n) {
  const read = async () => (await api("GET", `/triggers/${id}/firings`)).body.firings[0];
  await until(async () => {
    const firing = await read();
    return firing && (firing.status !== "due" || (firing.attempts ?? 0) >= n);
  }, 10_000);
  return read();
}
/** The hook's POSTs: a firing handed is one each try. */
const posts = (hook) => hook.got.filter((got) => got.method === "POST");

test("a hook that fails is a failed try under the trigger's retry policy: a 5xx or no answer keeps the firing due with retry_at and hook_failed with its cause, handed again under the same webhook-id; past the backoff table it fails, the streak turns the trigger off, and trigger.failed is sent", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SEAL_KEY"]);
  const clock = fakeClock("2026-06-01T00:00:00Z");
  // The first try is answered 500, the second not within its bound, every other 503.
  const hook = await hookServer(t, (res, _sent, n) => (n === 2 ? undefined : answerJson(res, n === 1 ? 500 : 503, { error: "down" })));
  const receiver = await hookServer(t, (res) => answerJson(res, 200, {}));
  const { api } = await serve(t, { triggerClock: clock, webhookPrivateTargets: true, launchHook: { url: hook.url, secret: mintSecret(), timeoutMs: 300 } });
  assert.equal((await api("PUT", "/settings/webhook", { url: receiver.url })).status, 201);
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  clock.to("2026-06-01T00:10:00Z");
  const first = await tried(api, id, 1);
  assert.deepEqual([first.status, first.run_id, first.attempts, first.retry_at, first.error?.code], ["due", null, 1, "2026-06-01T00:10:05.000Z", "hook_failed"], JSON.stringify(first));
  assert.match(first.reason, /^hook_failed \(500\): the launch hook answered 500/);
  assert.equal((await api("GET", `/triggers/${id}`)).body.failures_in_a_row, 1, "a failed try counts toward the streak");

  let firing = first;
  for (const [i, cause] of [/^hook_failed \(timeout\): the launch hook did not answer in 0\.3 s/, /^hook_failed \(503\)/, /^hook_failed \(503\)/, /^hook_failed \(503\)/].entries()) {
    const at = Date.parse(firing.retry_at);
    assert.ok(await until(() => clock.timer !== null && clock.timer.at <= at), `the timer armed for its retry_at, ${firing.retry_at}`);
    clock.to(firing.retry_at);
    firing = await tried(api, id, i + 2);
    assert.match(firing.reason, cause, JSON.stringify(firing));
  }
  assert.deepEqual([firing.key, firing.status, firing.run_id, firing.error?.code], [first.key, "failed", null, "hook_failed"], "past the backoff table it fails");
  const off = (await api("GET", `/triggers/${id}`)).body;
  assert.deepEqual([off.enabled, off.failures_in_a_row, off.disabled?.reason], [false, 5, "auto_paused"], "the streak turned the trigger off");
  assert.deepEqual(posts(hook).map((got) => got.headers["webhook-id"]), Array(5).fill(first.key), "each try handed under the firing's webhook-id");
  const failed = await until(() => posts(receiver).map((got) => JSON.parse(got.body.toString("utf8"))).find((message) => message.type === "trigger.failed"));
  assert.ok(failed, "trigger.failed sent");
  assert.deepEqual([failed.data.firing_key, failed.data.error.code, failed.data.auto_paused], [first.key, "hook_failed", true]);
  assert.match(failed.data.error.message, /^hook_failed \(503\)/);
  assert.deepEqual(await runsOf(api, "nightly"), [], "no run started here");
});

test("a hook that answers another non-2xx (a 4xx, a redirect) fails the firing at once, hook_failed with its status: no retry, one failure in the streak", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const hook = await hookServer(t, (res, _sent, n) => (n === 1 ? answerJson(res, 400, { error: "no" }) : (res.writeHead(302, { location: "https://host.example/" }), res.end())));
  const { api } = await serve(t, { triggerClock: clock, launchHook: { url: hook.url, secret: mintSecret() } });
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  clock.to("2026-06-01T00:10:00Z");
  const [refused] = await firings(api, id, 1);
  assert.deepEqual([refused.status, refused.run_id, refused.error?.code, "retry_at" in refused], ["failed", null, "hook_failed", false], JSON.stringify(refused));
  assert.match(refused.reason, /^hook_failed \(400\): the launch hook answered 400/);
  clock.to("2026-06-01T00:20:00Z");
  const [moved] = await firings(api, id, 2);
  assert.deepEqual([moved.status, moved.error?.code], ["failed", "hook_failed"], JSON.stringify(moved));
  assert.match(moved.reason, /^hook_failed \(302\): the launch hook answered 302: a redirect is not followed/);
  assert.equal(posts(hook).length, 2, "one POST each, never tried again");
  const after = (await api("GET", `/triggers/${id}`)).body;
  assert.deepEqual([after.enabled, after.failures_in_a_row], [true, 2], "each a failure in the streak");
  assert.deepEqual(await runsOf(api, "nightly"), [], "no run started here");
});

test("a hook that is not reached is a failed try too: hook_failed (unreachable) with its code, due with retry_at", { timeout: 60_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  // A port nothing listens on: the hook's server, closed.
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${closed.address().port}/agentrun/firings`;
  await new Promise((resolve) => closed.close(resolve));
  const { api } = await serve(t, { triggerClock: clock, launchHook: { url, secret: mintSecret() } });
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 3600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  clock.to("2026-06-01T00:10:00Z");
  const firing = await tried(api, created.body.id, 1);
  assert.deepEqual([firing.status, firing.attempts, firing.error?.code], ["due", 1, "hook_failed"], JSON.stringify(firing));
  assert.match(firing.reason, /^hook_failed \(unreachable\): the launch hook was not reached \(ECONNREFUSED\)/);
});

test("the hook setting: off unless both are set, refused in words when half set or malformed, and a 10 s bound", () => {
  assert.equal(launchHookFrom({}), undefined);
  assert.equal(launchHookFrom({ url: "", secret: "" }), undefined);
  const secret = mintSecret();
  assert.deepEqual(launchHookFrom({ url: "https://host.example/hook", secret }), { url: "https://host.example/hook", secret });
  assert.throws(() => launchHookFrom({ url: "https://host.example/hook" }), /AGENTRUN_LAUNCH_HOOK_SECRET/);
  assert.throws(() => launchHookFrom({ secret }), /AGENTRUN_LAUNCH_HOOK_URL/);
  assert.throws(() => launchHookFrom({ url: "ftp://host.example/hook", secret }), /http/);
  const withUser = Object.assign(new URL("https://host.example/hook"), { username: "someone", password: "x" });
  assert.throws(() => launchHookFrom({ url: withUser.href, secret }), /user or password/);
  assert.throws(() => launchHookFrom({ url: "https://host.example/hook", secret: "not-a-whsec-secret" }), /whsec_/);
  assert.throws(() => launchHookFrom({ url: "https://host.example/hook", secret: "whsec_c2hvcnQ=" }), /24/);
  for (const bad of [{ url: "ftp://host.example/hook", secret }, { url: "https://host.example/hook", secret: `${secret}x`.replace("whsec_", "nope_") }]) {
    try {
      launchHookFrom(bad);
    } catch (error) {
      assert.ok(!error.message.includes(secret.slice(6)), "a refusal never says the secret");
    }
  }
  assert.equal(LAUNCH_HOOK_TIMEOUT_MS, 10_000);
});

test("the hook's URL is https off this machine: plain http only to 127.0.0.0/8, ::1 or localhost, else refused in words", () => {
  const secret = mintSecret();
  for (const url of ["https://host.example/hook", "https://10.0.0.5/hook", "http://127.0.0.1:8080/hook", "http://127.4.5.6/hook", "http://[::1]:9000/hook", "http://localhost:3000/hook", "http://LOCALHOST/hook"]) {
    assert.equal(launchHookFrom({ url, secret })?.url, url, url);
  }
  for (const url of ["http://host.example/hook", "http://10.0.0.5/hook", "http://128.0.0.1/hook", "http://[::2]/hook", "http://localhost.host.example/hook", "http://127.0.0.1.host.example/hook"]) {
    assert.throws(() => launchHookFrom({ url, secret }), (error) => /https/.test(error.message) && /127\.0\.0\.0\/8, ::1 or localhost/.test(error.message) && !error.message.includes(secret.slice(6)), url);
  }
});
