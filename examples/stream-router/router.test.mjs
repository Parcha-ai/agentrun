// Offline check of the Stream router on a faux AgentRun server, with Jev scripted by faux-jev.mjs (it routes by the
// note's words; live routing is Jev's judgment). The stream trigger (signature "stream") starts the stream-router
// workflow for each signed note; Jev routes it to none, Arun, research or code; a none note ends with no model request.
// The last test pins what the design needs that AgentRun does not do yet (README.md, "Gaps").
//
// From the repo root, after `npm run build`:  node --test examples/stream-router/router.test.mjs
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { agent, flowAgent, serve, withEnv } from "../../packages/serve/test/support.mjs";

const WORKFLOW = JSON.parse(readFileSync(new URL("./router.workflow.json", import.meta.url), "utf8"));
// The faux model submits {answer: 42} for every model node: here alone, the reply's answer takes any value.
WORKFLOW.schemas.Reply.properties.answer = {};
const FAUX_JEV = new URL("./faux-jev.mjs", import.meta.url).pathname;
const SECRET = `swh_${randomBytes(32).toString("base64url")}`;
/** Stream's signature, as its "Set up Stream Webhook" article gives it. */
const sign = (body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
const note = (text) => JSON.stringify({ interaction_id: crypto.randomUUID().toUpperCase(), text });
async function post(baseUrl, id, body) {
  const res = await fetch(`${baseUrl}/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-stream-signature": sign(body) }, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, done, what) {
  for (let i = 0; i < 600; i++) {
    const value = await read();
    if (done(value)) return value;
    await pause(50);
  }
  throw new Error(`${what} never came`);
}
const ENDED = ["completed", "failed", "escalated", "stopped", "cancelled", "input_required"];

test("the Stream router: notes sent together each start the router; Jev routes each to none, Arun, research or code; a none note runs no model", { timeout: 180_000 }, async (t) => {
  withEnv(t, { TYPESAFE_API_KEY: "faux-key-for-the-scripted-jev" });
  const { api, baseUrl } = await serve(t, { fauxJev: FAUX_JEV });
  const made = await api("POST", "/agents", flowAgent("stream-router", WORKFLOW, { max_cost_usd: 1 }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // accept makes each note its own run while another note's run is active; without it a note that comes meanwhile is
  // skipped. max_active_runs bounds them.
  const trigger = await api("POST", "/triggers", { name: "ring", source: { kind: "webhook", signature: "stream", accept: [{ event: "interaction" }] }, target: { kind: "start_run", agent_id: "stream-router", input: { content: "A voice note arrived from the Stream ring." }, max_cost_usd: 1 }, max_active_runs: 5 });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  assert.equal((await api("POST", `/triggers/${trigger.body.id}/secret`, { secret: SECRET })).status, 200);

  const cases = [
    ["Arun, follow up with Dana about the Q4 slides before Friday.", "arun"],
    ["Look into which vector databases support hybrid search and compare their pricing.", "research"],
    ["There's a bug in the login form on the agentrun repo: the error overlaps the button.", "code"],
    ["Add oat milk and apples to my grocery list.", "none"],
  ];
  const posted = await Promise.all(cases.map(([text]) => post(baseUrl, trigger.body.id, note(text))));
  for (const answer of posted) assert.equal(answer.status, 202, JSON.stringify(answer.body));
  for (const [i, [text, want]] of cases.entries()) {
    const firing = await until(async () => (await api("GET", `/triggers/${trigger.body.id}/firings`)).body.firings.find((f) => f.key === posted[i].body.key), (f) => f && f.status !== "due", "the firing");
    assert.equal(firing.status, "started", `${text}: ${JSON.stringify(firing)}`);
    const run = await until(async () => (await api("GET", `/runs/${firing.run_id}`)).body, (r) => ENDED.includes(r.status), "the run's end");
    assert.equal(run.status, "completed", `${text}: ${JSON.stringify(run.error ?? run.pending)}`);
    assert.deepEqual([run.result.output.taken, run.result.output.unsure], [want, false], text);
    const rows = (await api("GET", `/runs/${firing.run_id}/timeline?limit=500`)).body.rows;
    const decisions = rows.filter((r) => r.kind === "decision").length;
    const requests = rows.findLast((r) => r.kind === "usage")?.usage?.requests ?? 0;
    assert.equal(decisions, 1, `${text}: one Jev decision`);
    assert.equal(requests - decisions, want === "none" ? 0 : 1, `${text}: ${want === "none" ? "no model request" : "its specialist's one model request"}`);
  }
});

test("gaps, as AgentRun behaves today: a prefix rule has no word boundary, no rule drops a blank note, and a paused trigger refuses where the design wants a shadow mode", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("arun", { max_cost_usd: 1 }))).status, 201);
  const make = async (name, accept) => {
    const made = await api("POST", "/triggers", { name, source: { kind: "webhook", signature: "stream", accept }, target: { kind: "start_run", agent_id: "arun", input: { content: "A note." }, max_cost_usd: 1 } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await api("POST", `/triggers/${made.body.id}/secret`, { secret: SECRET })).status, 200);
    return made.body.id;
  };
  const wake = await make("arun", [{ event: "interaction", where: [{ pointer: "/text", prefix: "Arun" }] }]);
  const open = await make("all", [{ event: "interaction" }]);
  const found = {
    // The design's matcher wants whitespace or punctuation after the name: "Arundel" is not "Arun".
    prefix_without_boundary: (await post(baseUrl, wake, note("Arundel castle photos for the album."))).status,
    // The design drops blank text before anything else.
    blank_text: (await post(baseUrl, open, note("   "))).status,
  };
  // The design's shadow mode logs a match and wakes no one; a paused trigger refuses the note as a bad signature is.
  assert.equal((await api("PATCH", `/triggers/${wake}`, { enabled: false })).status, 200);
  found.paused_trigger = (await post(baseUrl, wake, note("Arun, this is shadow mode."))).status;
  assert.deepEqual(found, { prefix_without_boundary: 202, blank_text: 202, paused_trigger: 401 });
});
