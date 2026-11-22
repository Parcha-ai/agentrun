// The launch hook (trigger-launch-hook.ts): a server started with a hook URL and its signing secret hands each trigger
// firing that would start a run to the host instead, as a signed POST (Standard Webhooks, the firing's id its
// webhook-id), and starts no run of its own for it. The run the host starts through the API with `trigger_firing` is the
// firing's (started, counted by the overlap check); a 2xx with no such run records it sent; any other answer, or none
// within the bound, records it skipped with why. The hook's receiver here is a server on 127.0.0.1 that checks the
// signature as any receiver would.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { follow, serve } from "./support.mjs";
import { fakeClock, firings, made, schedule } from "./trigger-support.mjs";

const { mintSecret, verify } = await import("../dist/standard-webhooks.js");
const { LAUNCH_HOOK_TIMEOUT_MS, launchHookFrom } = await import("../dist/trigger-launch-hook.js");

/** A host's hook on 127.0.0.1: each request kept (its headers and body), answered by `answer`. */
async function hookServer(t, answer) {
  const got = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    got.push({ method: req.method, headers: req.headers, body });
    await answer(res, JSON.parse(body.toString("utf8")), got.length);
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
  assert.equal(starts[0]?.status, 202, JSON.stringify(starts[0]?.body));
  const runId = starts[0].body.run_id;
  assert.deepEqual([first.status, first.run_id], ["started", runId], JSON.stringify(first));
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual(run.trigger, { id: created.body.id, firing_key: first.key }, "the run is the trigger's, as one started here");
  const ref = { trigger_id: created.body.id, firing_id: first.key };
  const again = await api("POST", "/agents/nightly/runs", { input: { content: "Again." }, max_cost_usd: 0.5, trigger_firing: ref });
  assert.deepEqual([again.status, again.body.run_id, again.headers.get("idempotent-replayed")], [202, runId, "true"], "a second start for the firing answers its run");
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
