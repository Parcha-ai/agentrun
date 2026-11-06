// What a trigger may send a run, through the API: never a message to a run with no spend cap (refused at create, at
// PATCH and, should the cap be gone, at the firing), and never an answer to a run that waits on a person (the firing is
// skipped, the run still waits). And the hook's own edges the review asked for: a create retried under its
// Idempotency-Key replays the trigger with no secret; a key too short signs nothing; the headers are judged before the
// body is read.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { hookRefusal } from "../dist/trigger-secrets.js";
import { follow, scratch, serve, withEnv } from "./support.mjs";
import { firings, made } from "./trigger-support.mjs";

const { Webhook } = createRequire(import.meta.url)("standardwebhooks");
const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
const messaging = (runId) => ({ name: "inbox", source: { kind: "webhook" }, target: { kind: "message_run", run_id: runId, input: { content: "A new event came in." } } });

async function post(baseUrl, triggerId, body, secret, id = `msg_${randomBytes(8).toString("hex")}`) {
  const at = Math.floor(Date.now() / 1000);
  const res = await fetch(`${baseUrl}/hooks/${triggerId}`, { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": new Webhook(secret).sign(id, new Date(at * 1000), body) }, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("a message_run target must be a capped run: refused at create and at PATCH on target.run_id, and a firing to a run whose cap is gone fails, sending nothing", { timeout: 180_000 }, async (t) => {
  withEnv(t, SEAL);
  const data = join(await scratch(t), "agents");
  const first = await serve(t, { data });
  await made(first.api, "chat");
  const uncapped = (await first.api("POST", "/agents/chat/runs", { input: { content: "Say hello." } })).body;
  const capped = (await first.api("POST", "/agents/chat/runs", { input: { content: "Say hello." }, max_cost_usd: 1 })).body;
  await follow(first.api, uncapped.run_id, ["completed"]);
  await follow(first.api, capped.run_id, ["completed"]);
  const refused = await first.api("POST", "/triggers", messaging(uncapped.run_id));
  assert.equal(refused.status, 422);
  assert.deepEqual(refused.body.error.fields.map((f) => [f.field, f.reason]), [["target.run_id", "not_allowed"]]);
  assert.match(refused.body.error.fields[0].message, /no spend cap/);
  const { id, secret } = (await first.api("POST", "/triggers", messaging(capped.run_id))).body;
  const patched = await first.api("PATCH", `/triggers/${id}`, { target: messaging(uncapped.run_id).target });
  assert.deepEqual([patched.status, patched.body.error.fields.map((f) => f.field)], [422, ["target.run_id"]]);
  await first.close();
  // The cap gone from the run's record (nothing removes one today): the firing is refused, never an uncapped turn.
  const file = join(data, "runs", capped.run_id, "serve.json");
  const meta = JSON.parse(await readFile(file, "utf8"));
  delete meta.max_cost_usd;
  await writeFile(file, JSON.stringify(meta));
  const second = await serve(t, { data });
  assert.equal((await post(second.baseUrl, id, "{}", secret)).status, 202);
  const [failed] = await firings(second.api, id, 1);
  assert.equal(failed.status, "failed", JSON.stringify(failed));
  assert.match(failed.error.message, /no spend cap/);
  const { rows } = await follow(second.api, capped.run_id, ["completed"]);
  assert.equal(rows.filter((row) => row.kind === "user_message").length, 1, "nothing sent");
});

test("a firing never answers a run that waits on a person: it is skipped with why, and the run still waits for its answer", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "asks", { tools: ["ask_person"] });
  const run = (await api("POST", "/agents/asks/runs", { input: { content: "Pick a region." }, max_cost_usd: 1 })).body;
  await follow(api, run.run_id, ["input_required"]);
  assert.equal((await api("GET", `/runs/${run.run_id}`)).body.pending?.kind, "question");
  const { id, secret } = (await api("POST", "/triggers", messaging(run.run_id))).body;
  assert.equal((await post(baseUrl, id, "eu", secret)).status, 202);
  const [skipped] = await firings(api, id, 1);
  assert.deepEqual([skipped.status, skipped.reason, skipped.run_id], ["skipped", "The run is waiting on a person.", null], JSON.stringify(skipped));
  const read = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.deepEqual([read.status, read.state, read.pending?.kind], ["input_required", "waiting", "question"], "still waiting, unanswered");
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
});

test("a webhook trigger's create retried under its Idempotency-Key replays the same trigger with no secret, saying it was shown once; another body under the key is 409", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, data } = await serve(t);
  await made(api, "triage");
  const body = { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "triage", input: { content: "Go." }, max_cost_usd: 0.5 } };
  const first = await api("POST", "/triggers", body, { "idempotency-key": "make-1" });
  assert.equal(first.status, 201);
  assert.match(first.body.secret, /^whsec_/);
  assert.equal(first.body.note, undefined);
  const again = await api("POST", "/triggers", body, { "idempotency-key": "make-1" });
  assert.deepEqual([again.status, again.headers.get("idempotent-replayed"), again.body.id, again.body.secret], [201, "true", first.body.id, undefined]);
  assert.match(again.body.note, /shown once.*\/secret/);
  assert.ok(!(await readFile(join(data, ".idempotency.json"), "utf8")).includes(first.body.secret.slice("whsec_".length)), "the idempotency record holds no secret");
  assert.equal((await api("GET", "/triggers")).body.triggers.length, 1, "one trigger");
  const other = await api("POST", "/triggers", { ...body, name: "other" }, { "idempotency-key": "make-1" });
  assert.deepEqual([other.status, other.body.error.code], [409, "idempotency_mismatch"]);
});

test("a key shorter than 24 bytes signs nothing, even with its own correct signature", () => {
  const body = Buffer.from("{}");
  const at = String(Math.floor(Date.now() / 1000));
  for (const key of [Buffer.alloc(0), randomBytes(16)]) {
    const secret = `whsec_${key.toString("base64")}`;
    const signature = `v1,${createHmac("sha256", key).update(`msg_x.${at}.`).update(body).digest("base64")}`;
    assert.ok(hookRefusal(secret, { "webhook-id": "msg_x", "webhook-timestamp": at, "webhook-signature": signature }, body, Date.now()), `a ${key.length}-byte key`);
  }
});

test("bad webhook headers are refused before the body is read: a body past 256 KiB with no signature is the hook's 401, not a 413", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  const { id } = (await api("POST", "/triggers", { source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "triage", input: { content: "Go." }, max_cost_usd: 0.5 } })).body;
  const res = await fetch(`${baseUrl}/hooks/${id}`, { method: "POST", headers: { "webhook-id": "msg_x" }, body: "x".repeat((256 << 10) + 1) }).catch((error) => ({ status: `reset: ${error.message}` }));
  assert.equal(res.status, 401);
});

test("a run that comes to wait on a person between the firing's check and its door's admission is never answered: the door refuses, the firing is skipped, the question stands", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const gate = join(await scratch(t), "gate");
  let api;
  // The seam before a message reaches the run's door: the run is let ask its question here, and the message goes on
  // only once the run waits on it.
  const beforeSubmit = async (runId, content) => {
    if (!content.startsWith("A new event came in.")) return;
    await writeFile(gate, "");
    // Its turn has ended on the question once the timeline holds the wait (the run's own status reads working while this
    // message is on its way).
    const waits = async () => (await api("GET", `/runs/${runId}/timeline`)).body.rows.some((row) => row.kind === "waiting");
    for (const end = Date.now() + 30_000; !(await waits()); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, "the run asks");
  };
  const server = await serve(t, { beforeSubmit });
  api = server.api;
  await made(api, "asks", { tools: ["ask_person"] });
  const run = (await api("POST", "/agents/asks/runs", { input: { content: `Pick a region once ${gate} exists.` }, max_cost_usd: 1 })).body;
  await follow(api, run.run_id, ["working"]);
  const { id, secret } = (await api("POST", "/triggers", messaging(run.run_id))).body;
  assert.equal((await post(server.baseUrl, id, "eu", secret)).status, 202);
  const [skipped] = await firings(api, id, 1);
  assert.deepEqual([skipped.status, skipped.reason], ["skipped", "The run is waiting on a person."], JSON.stringify(skipped));
  const read = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.deepEqual([read.status, read.state, read.pending?.kind], ["input_required", "waiting", "question"], "the question stands, unanswered");
  const { rows } = await follow(api, run.run_id, ["input_required"]);
  assert.equal(rows.filter((row) => row.kind === "user_message").length, 1, "no message reached it");
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
});

const GATE = { faux: new URL("./fixtures/faux-gate.mjs", import.meta.url).pathname, fauxWeb: new URL("./fixtures/faux-gate-web.mjs", import.meta.url).pathname, accounts: true, openSetup: true };

test("a run that comes to wait on a tool call's approval between the firing's check and its door's admission is never messaged: the door refuses, the firing is skipped, the approval stands, unanswered", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const gate = join(await scratch(t), "gate");
  let api;
  // The seam before a message reaches the run's door: the run is let call web_fetch (set to ask) here, and the message
  // goes on only once the call is parked for its approval.
  const beforeSubmit = async (runId, content) => {
    if (!content.startsWith("A new event came in.")) return;
    await writeFile(gate, "");
    const parked = async () => (await api("GET", `/runs/${runId}/timeline`)).body.rows.some((row) => row.kind === "tool_approval_requested");
    for (const end = Date.now() + 30_000; !(await parked()); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, "the call parks");
  };
  const server = await serve(t, { ...GATE, beforeSubmit });
  api = server.api;
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  await made(api, "fetcher", { tools: ["web_fetch"] });
  const run = (await api("POST", "/agents/fetcher/runs", { input: { content: `Fetch http://public.example/ once ${gate} exists.` }, max_cost_usd: 1 })).body;
  await follow(api, run.run_id, ["working"]);
  const { id, secret } = (await api("POST", "/triggers", messaging(run.run_id))).body;
  assert.equal((await post(server.baseUrl, id, "eu", secret)).status, 202);
  const [skipped] = await firings(api, id, 1);
  assert.deepEqual([skipped.status, skipped.reason], ["skipped", "The run is waiting on a person."], JSON.stringify(skipped));
  const read = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.deepEqual([read.status, read.state, read.pending?.kind, read.pending?.tool], ["input_required", "waiting", "approval", "web_fetch"], "the approval stands, unanswered");
  const { rows } = await follow(api, run.run_id, ["input_required"]);
  assert.equal(rows.filter((row) => row.kind === "user_message").length, 1, "no message reached it");
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
});

test("a firing never reaches a run paused at its spend cap (pending budget): it is skipped with the same reason, and the run still waits for its cap to be raised", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  // The tests' faux model priced on output only: a $0.05 cap cannot buy a request's least, so the run pauses at once.
  const { api, baseUrl } = await serve(t, { faux: new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname });
  await made(api, "capped");
  const run = (await api("POST", "/agents/capped/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
  await follow(api, run.run_id, ["input_required"]);
  assert.equal((await api("GET", `/runs/${run.run_id}`)).body.pending?.kind, "budget");
  const { id, secret } = (await api("POST", "/triggers", messaging(run.run_id))).body;
  assert.equal((await post(baseUrl, id, "{}", secret)).status, 202);
  const [skipped] = await firings(api, id, 1);
  assert.deepEqual([skipped.status, skipped.reason], ["skipped", "The run is waiting on a person."], JSON.stringify(skipped));
  const read = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.deepEqual([read.status, read.state, read.pending?.kind], ["input_required", "waiting", "budget"], "still paused at its cap");
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
});
