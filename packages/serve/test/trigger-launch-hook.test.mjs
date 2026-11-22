// The launch hook (trigger-launch-hook.ts): a server started with a hook URL and its signing secret hands each trigger
// firing that would start a run to the host instead, as a signed POST (Standard Webhooks, the firing's id its
// webhook-id), and starts no run of its own for it. The run the host starts through the API with `trigger_firing` is the
// firing's (started, counted by the overlap check); a 2xx with no such run records it sent; any other answer, or none
// within the bound, records it skipped with why. The hook's receiver here is a server on 127.0.0.1 that checks the
// signature as any receiver would (trigger-support.mjs hookServer).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { follow, scratch, serve, withEnv } from "./support.mjs";
import { fakeClock, firings, hookServer, made, portProbe, schedule, until } from "./trigger-support.mjs";

const { mintSecret, signatureOf, verify } = await import("../dist/standard-webhooks.js");
const { LAUNCH_HOOK_LATE_START_MS, LAUNCH_HOOK_TIMEOUT_MS, launchHookFrom } = await import("../dist/trigger-launch-hook.js");
const { uuidv7 } = await import("../dist/ids.js");
const { claimSecrets } = await import("../dist/runner/claim-secrets.js");
const { heldRedactor, secretRedactor } = await import("../dist/runner/redact.js");
const { readLaunchBody } = await import("../dist/run-launch.js");

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

// The counts above guard a paid run: a firing handed twice is a second run on the host's money. Each counts the
// install's POSTs alone; a probe a dev tool on the box sends to a new listener is no hand-off.
test("the host's hook counts the install's POSTs alone: a port probe's GET / before the firing and while it is handed is answered 404 and never counted", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const during = [];
  const hook = await hookServer(t, async (res) => {
    during.push(await portProbe(hook.url));
    answerJson(res, 200, {});
  });
  const before = await portProbe(hook.url);
  const { api } = await serve(t, { triggerClock: clock, runner: false, launchHook: { url: hook.url, secret: mintSecret() } });
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  clock.to("2026-06-01T00:10:00Z");
  const [firing] = await firings(api, created.body.id, 1);
  assert.deepEqual([firing.status, firing.run_id], ["sent", null], JSON.stringify(firing));
  assert.deepEqual(hook.got.map((one) => [one.method, one.headers["webhook-id"]]), [["POST", firing.key]], "the firing's one POST, and no probe");
  assert.deepEqual([before, during], [404, [404]], "each probe answered 404");
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

test("a sent firing whose host's run was written but never linked (a stop between the two) is started with it at the next server's start, and the overlap check counts it", { timeout: 180_000 }, async (t) => {
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
  const second = await serve(t, { data, triggerClock: clock, runner: false, launchHook: { url: hook.url, secret } });
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

test("a server without the launch hook refuses a run for a trigger firing", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, {});
  await made(api, "nightly");
  const refused = await api("POST", "/agents/nightly/runs", { input: { content: "Hi." }, max_cost_usd: 0.5, trigger_firing: { trigger_id: "trg_0123456789abcdef01234567", firing_id: `fir_${"0".repeat(32)}` } });
  assert.equal(refused.status, 422);
  assert.match(JSON.stringify(refused.body), /no launch hook/);
});

test("a hook that answers 500 skips the firing with the reason; one that does not answer within its bound skips it too", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const hook = await hookServer(t, (res, _sent, n) => (n === 1 ? answerJson(res, 500, { error: "down" }) : undefined));
  const { api } = await serve(t, { triggerClock: clock, launchHook: { url: hook.url, secret: mintSecret(), timeoutMs: 300 } });
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  clock.to("2026-06-01T00:10:00Z");
  const [refused] = await firings(api, created.body.id, 1);
  assert.deepEqual([refused.status, refused.run_id], ["skipped", null]);
  assert.match(refused.reason, /answered 500/);
  clock.to("2026-06-01T00:20:00Z");
  const [silent] = await firings(api, created.body.id, 2);
  assert.deepEqual([silent.status, silent.run_id], ["skipped", null]);
  assert.match(silent.reason, /did not answer in 0\.3 s/);
  assert.deepEqual(await runsOf(api, "nightly"), [], "no run started here for either");
  assert.equal((await api("GET", `/triggers/${created.body.id}`)).body.enabled, true, "a skip is no failure: the trigger stays on");
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
