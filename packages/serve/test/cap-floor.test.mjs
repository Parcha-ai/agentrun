// A cap too small for one request is refused when the run is created, with the figures, and the agent says its floor
// before a run. A run's first request (one the cap refused at step 0 too) records its floor on its start mark, priced in
// the run's process by the cap's own path: the least (its input and least output, the figure the cap refuses it below)
// and the typical (its input and WRAP_UP_STEP0_ANSWER_TOKENS of output). The agent read serves the newest measured floor
// of its input-free part (`cap_floor`), and a create whose cap is under the least that run would need, its own input
// counted, is refused (422 below_least) with both figures. Nothing measured yet: no floor, and the create goes as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

/** Priced on both sides, input $10 and output $100 a million: a first request's least moves with its input. */
const FLOOR_PRICED = new URL("./fixtures/faux-floor-priced.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const near = (a, b, within, what) => assert.ok(Math.abs(a - b) <= within, `${what}: ${a} vs ${b}`);

// Under the faux harness claude-agent and codex run one path (harness-app.ts's guard, capBefore), so codex stands for both.
for (const harness of ["pi", "codex"]) {
  test(`${harness}: a run paused at step 0 teaches the agent its floor, and a cap below the least is then refused at create with both figures`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { faux: FLOOR_PRICED, ...(harness === "pi" ? {} : { fauxHarness: FAUX_HARNESS }) });
    const id = `floor-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, harness === "pi" ? {} : { harness }))).status, 201);
    // Nothing measured yet: no floor, and a small cap is created as before (and pauses before doing anything).
    assert.equal((await api("GET", `/agents/${id}`)).body.cap_floor, undefined, "no floor before any run");
    const input = { content: "Write one.md" };
    const first = await api("POST", `/agents/${id}/runs`, { input, max_cost_usd: 0.02 });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    await follow(api, first.body.run_id, SETTLED);
    const { pending } = (await api("GET", `/runs/${first.body.run_id}`)).body;
    assert.equal(pending?.kind, "budget", JSON.stringify(pending));
    // The agent's floor: measured by that refused request, its input-free part, so below what that request needed.
    const floor = (await api("GET", `/agents/${id}`)).body.cap_floor;
    assert.ok(floor, "the paused run's refused request measured the floor");
    assert.equal(typeof floor.model, "string");
    assert.ok(Number.isFinite(Date.parse(floor.measured_at)), JSON.stringify(floor));
    assert.ok(floor.least_usd > 0.1024 - 1e-6 && floor.least_usd < pending.needs_usd, JSON.stringify({ floor, pending }));
    assert.ok(floor.typical_usd > floor.least_usd, JSON.stringify(floor));
    // A second run with the same input and cap: refused at create, its least the very figure the pause needed.
    const refused = await api("POST", `/agents/${id}/runs`, { input, max_cost_usd: 0.02 });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    const { error } = refused.body;
    assert.equal(error.code, "input_invalid");
    assert.deepEqual(error.fields.map((f) => [f.field, f.reason]), [["max_cost_usd", "below_least"]], JSON.stringify(error));
    near(error.details.least_usd, pending.needs_usd, 1e-6, "the create's least is the pause's needs");
    assert.equal(error.details.least_cap_usd, Math.ceil(error.details.least_usd * 100 - 1e-9) / 100, JSON.stringify(error.details));
    assert.equal(error.details.model, floor.model);
    assert.ok(error.details.typical_usd > error.details.least_usd, JSON.stringify(error.details));
    // In words: the model, the cap asked, and both figures.
    for (const said of [floor.model, "$0.02", `$${error.details.least_cap_usd.toFixed(2)}`]) assert.ok(error.message.includes(said), `${said} in: ${error.message}`);
    // A cap between the least and the typical is created: the clamp and the wrap-up take it from there, as before.
    const between = (error.details.least_usd + error.details.typical_usd) / 2;
    const mid = await api("POST", `/agents/${id}/runs`, { input, max_cost_usd: between });
    assert.equal(mid.status, 202, JSON.stringify(mid.body));
    await follow(api, mid.body.run_id, SETTLED);
  });
}

test("pi: the create's least counts the run's own input: a longer input needs its bytes more, at the model's input price", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FLOOR_PRICED });
  assert.equal((await api("POST", "/agents", agent("floor-input"))).status, 201);
  const first = await api("POST", "/agents/floor-input/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.02 });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, SETTLED);
  const { pending } = (await api("GET", `/runs/${first.body.run_id}`)).body;
  assert.equal(pending?.kind, "budget", JSON.stringify(pending));
  // 1,001 more plain bytes in the message (a space and 1,000 x's): $0.01001 more at $10 a million.
  const longer = await api("POST", "/agents/floor-input/runs", { input: { content: `Write one.md ${"x".repeat(1000)}` }, max_cost_usd: 0.02 });
  assert.equal(longer.status, 422, JSON.stringify(longer.body));
  near(longer.body.error.details.least_usd - pending.needs_usd, 1001 * 10 / 1e6, 2e-6, "the input's bytes at $10 a million");
});

test("pi: a completed run measures the floor as a paused one does, and a cap above the least is never refused", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FLOOR_PRICED });
  assert.equal((await api("POST", "/agents", agent("floor-done"))).status, 201);
  const first = await api("POST", "/agents/floor-done/runs", { input: { content: "Write one.md" } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, SETTLED);
  const floor = (await api("GET", "/agents/floor-done")).body.cap_floor;
  assert.ok(floor && floor.least_usd > 0.1024 - 1e-6, JSON.stringify(floor));
  assert.deepEqual(floor.by_effort?.[floor.effort], { least_usd: floor.least_usd, typical_usd: floor.typical_usd }, JSON.stringify(floor));
  const above = await api("POST", "/agents/floor-done/runs", { input: { content: "Write one.md" }, max_cost_usd: 5 });
  assert.equal(above.status, 202, JSON.stringify(above.body));
});

test("pi: a floor is its revision's: a new revision has none until its own first run, which is never refused", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FLOOR_PRICED });
  assert.equal((await api("POST", "/agents", agent("floor-rev"))).status, 201);
  const first = await api("POST", "/agents/floor-rev/runs", { input: { content: "Write one.md" } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, SETTLED);
  assert.ok((await api("GET", "/agents/floor-rev")).body.cap_floor, "the first revision's run measured it");
  // New instructions: another first request, so the old floor is not this revision's.
  assert.equal((await api("PUT", "/agents/floor-rev/definition", { definition: { ...agent("floor-rev").definition, instructions: "Answer in one line." } })).status, 200);
  assert.equal((await api("GET", "/agents/floor-rev")).body.cap_floor, undefined, "no floor on the new revision yet");
  const small = await api("POST", "/agents/floor-rev/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.02 });
  assert.equal(small.status, 202, `the new revision's first run is never refused: ${JSON.stringify(small.body)}`);
});
