// A run's requests on free models stop at the server's limit of them (60, or AGENTRUN_FREE_MODEL_REQUESTS): the dollar
// cap cannot stop a free model, every request costing $0 (ChatGPT-plan requests don't count: cap-chatgpt-plan.test.mjs). A free model stuck on a failing tool (fixtures/faux-loop.mjs, the
// faux model at its $0 listing, calling a tool the run does not have) makes its 60th request and is refused its 61st: the
// run ends failed as the cap ends one, error spend_cap_reached, in the limit's words. One that needs 60 requests finishes.
// The same loop on a paid model is not stopped by the limit: dollars govern it. The capabilities report the limit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { follow, journalOf, serve, withEnv } from "./support.mjs";

const FREE_LOOP = new URL("./fixtures/faux-loop.mjs", import.meta.url).pathname;
const PAID_LOOP = new URL("./fixtures/faux-loop-priced.mjs", import.meta.url).pathname;
const ENV = "AGENTRUN_FREE_MODEL_REQUESTS";
const words = (n) => `Not sent: this run reached its ${n}-request limit for free models.`;

/** A server on `faux`, and a run of a new agent with `input`, followed to its end: its view and its model requests. */
async function loopServer(t, faux) {
  const { api, data } = await serve(t, { faux });
  let agents = 0;
  const run = async (input, body = {}) => {
    const id = `loop-${(agents += 1)}`;
    const made = await api("POST", "/agents", { definition: { id, version: 1, name: id, instructions: "Look it up.", skills: [], tools: [] } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: input }, ...body });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 120_000 });
    const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
    const requests = journalOf(data, started.body.run_id).filter((entry) => entry.kind === "runner.request").map((entry) => entry.data);
    return { view, requests };
  };
  return { api, run };
}

test("a free model looping on a failing tool is refused its 61st request: the run fails as at its cap, in the limit's words; 60 requests finish", { timeout: 300_000 }, async (t) => {
  withEnv(t, {}, [ENV]);
  const { api, run } = await loopServer(t, FREE_LOOP);
  const stopped = await run("Loop 60");
  assert.equal(stopped.view.status, "failed", JSON.stringify(stopped.view));
  assert.deepEqual(stopped.view.error && { code: stopped.view.error.code, message: stopped.view.error.message }, { code: "spend_cap_reached", message: words(60) });
  assert.equal(stopped.requests.length, 60, "60 requests left; the 61st was refused before it was sent");
  assert.ok(stopped.requests.every((request) => request.freeRequest === true), "each is counted toward the limit");

  const finished = await run("Loop 59");
  assert.equal(finished.view.status, "completed", JSON.stringify(finished.view.error));
  assert.equal(finished.requests.length, 60, "at its 60th request it still runs, and answers");
  assert.equal((await api("GET", "/capabilities")).body.limits.free_model_requests, 60, "the capabilities report the default");
});

test("a paid model in the same loop is not stopped by the limit", { timeout: 300_000 }, async (t) => {
  withEnv(t, {}, [ENV]);
  const { run } = await loopServer(t, PAID_LOOP);
  const done = await run("Loop 65", { max_cost_usd: 50 });
  assert.equal(done.view.status, "completed", JSON.stringify(done.view.error));
  assert.equal(done.requests.length, 66, "every request of the loop was sent");
  assert.ok(done.requests.every((request) => request.freeRequest === undefined), "none counted toward the limit");
});

test(`${ENV} moves the limit, and the capabilities say it`, { timeout: 120_000 }, async (t) => {
  withEnv(t, { [ENV]: "3" });
  const { api, run } = await loopServer(t, FREE_LOOP);
  const stopped = await run("Loop 5");
  assert.equal(stopped.view.status, "failed", JSON.stringify(stopped.view));
  assert.deepEqual(stopped.view.error && { code: stopped.view.error.code, message: stopped.view.error.message }, { code: "spend_cap_reached", message: words(3) });
  assert.equal(stopped.requests.length, 3);
  assert.equal((await api("GET", "/capabilities")).body.limits.free_model_requests, 3);
});

test(`${ENV} as no whole number above 0 refuses the server's start, naming it`, async (t) => {
  withEnv(t, {}, [ENV]);
  for (const bad of ["0", "-1", "1.5", "lots"]) {
    process.env[ENV] = bad;
    await assert.rejects(serve(t, { faux: FREE_LOOP }), new RegExp(`${ENV} is a whole number of requests above 0, not ${bad}`), bad);
  }
});
