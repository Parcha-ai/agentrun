// A harness run (claude-agent, codex: the faux harness stands for both, through serve's one adapter path) on a store slow
// to write: each root write waits (ROOT_WRITE_DELAY_ENV, a test seam), so the writes fall behind the session's events.
// Each request's answer is still its own entry, with its own text and its own cost, after its own start mark: the run
// counts its requests once each, at their known cost. And the run's cap, which reads the session's booking, never counts
// a request as $0: the follow-up's request that the spend leaves no room for is refused, its pending naming that spend.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, runDir, serve, withEnv } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;

/** The root's entries of run `runId`, in order; `all`: every conversation's (the session's records too), in the one order
 *  the store committed them. */
function rootOf(data, runId, all = false) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare(`SELECT id, record FROM entries ${all ? "" : "WHERE conversation_id = 1 "}ORDER BY id`).all().map((r) => ({ id: r.id, ...JSON.parse(r.record) }));
  } finally {
    db.close();
  }
}
const contentOf = (entry) => (entry.model?.[0]?.content ?? []).map((b) => (b.type === "text" ? b.text : `call:${b.name}`)).join("|");

for (const on of ["claude-agent", "codex"]) {
  test(`${on}: on a store slow to write, each request's answer is its own entry, with its own text and cost, after its own start mark`, async (t) => {
    withEnv(t, { AGENTRUN_SERVE_TEST_ROOT_WRITE_DELAY_MS: "300" });
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
    assert.equal((await api("POST", "/agents", agent("slow-root", { harness: on, instructions: "Write on a slow store.", tools: ["read", "write", "edit"] }))).status, 201);
    const started = await api("POST", "/agents/slow-root/runs", { input: { content: "Write alpha to a.md." } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 30_000 });
    assert.equal(last.status, "completed", JSON.stringify(rows.at(-1)));
    const usage = rows.findLast((r) => r.kind === "usage")?.usage;
    assert.deepEqual([usage?.requests, usage?.usd], [2, 0.003], `two requests at their known cost: ${JSON.stringify(usage)}`);
    assert.equal((await api("GET", `/runs/${runId}`)).body.cost?.usd, 0.003, "the run's cost is known");
    const root = rootOf(data, runId);
    const answers = root.filter((e) => e.kind === "pi.assistant").map((e) => [contentOf(e), e.model[0].usage?.cost?.total ?? null]);
    assert.deepEqual(answers, [["Writing a.md.|call:write", 0.001], ["Wrote it.", 0.002]], `each request's own text and cost: ${JSON.stringify(answers)}`);
    // The order at the boundary, as the store committed it: request 1's answer, then request 2's start mark (committed and
    // synced, the runner awaiting both), and only then request 2 leaves (the faux harness records it as it is sent).
    const log = rootOf(data, runId, true);
    const idOf = (match, what) => { const at = log.find(match); assert.ok(at, `${what}: ${JSON.stringify(log.map((e) => e.kind))}`); return at.id; };
    const answer1 = idOf((e) => e.kind === "pi.assistant" && contentOf(e).startsWith("Writing a.md."), "request 1's answer");
    const mark2 = idOf((e) => e.kind === "agentrun.request_started" && e.data?.request === 2, "request 2's mark");
    const sent2 = idOf((e) => e.kind === "faux.request" && e.data?.index === 1, "request 2 sent");
    assert.ok(answer1 < mark2 && mark2 < sent2, `answer(1) ${answer1} < mark(2) ${mark2} < sent(2) ${sent2}`);
    // Each request's start mark is on the root before its answer.
    const at = (match) => root.findIndex(match);
    for (const [n, text] of [[1, "Writing a.md."], [2, "Wrote it."]]) {
      const mark = at((e) => e.kind === "agentrun.request_started" && e.data?.request === n);
      const answer = at((e) => e.kind === "pi.assistant" && contentOf(e).startsWith(text));
      assert.ok(mark >= 0 && mark < answer, `request ${n}'s mark (${mark}) before its answer (${answer}): ${JSON.stringify(root.map((e) => e.kind))}`);
    }
  });
}

for (const on of ["claude-agent", "codex"]) {
  test(`${on}: on a store slow to write, a request paid only after the next one answered keeps its own text and its own cost`, async (t) => {
    withEnv(t, { AGENTRUN_SERVE_TEST_ROOT_WRITE_DELAY_MS: "300" });
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
    const paid = join(data, "..", `paid-${on}`);
    assert.equal((await api("POST", "/agents", agent("paid-late", { harness: on, instructions: `Write on a slow store, paid once ${paid} exists.`, tools: ["read", "write", "edit"] }))).status, 201);
    const started = await api("POST", "/agents/paid-late/runs", { input: { content: "Write alpha to a.md." } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    // The first request's cost comes in once the second has gone and answered, before the turn's end stops waiting for it.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await writeFile(paid, "");
    const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 30_000 });
    assert.equal(last.status, "completed", JSON.stringify(rows.at(-1)));
    const answers = rootOf(data, runId).filter((e) => e.kind === "pi.assistant" && contentOf(e)).map((e) => [contentOf(e), e.model[0].usage?.cost?.total ?? null]);
    const late = rootOf(data, runId).filter((e) => e.kind === "agentrun.request_cost_late" || e.kind === "adapter.request_cost_late").map((e) => e.data?.usd);
    assert.deepEqual(answers.map(([text]) => text), ["Writing a.md.|call:write", "Wrote it."], `each request's own text: ${JSON.stringify(answers)}`);
    assert.equal(answers[1][1], 0.002, `the second answer carries the second request's cost: ${JSON.stringify(answers)}`);
    assert.ok(answers[0][1] === 0.001 || late.includes(0.001), `the first answer's cost is the first request's, on it or as its late cost: ${JSON.stringify({ answers, late })}`);
    const usage = rows.findLast((r) => r.kind === "usage")?.usage;
    assert.deepEqual([usage?.requests, usage?.usd], [2, 0.003], `two requests at their known cost: ${JSON.stringify(usage)}`);
  });
}

for (const on of ["claude-agent", "codex"]) {
  test(`${on}: on a store slow to write, a request whose cost is unknown stays unknown on its own answer and in the run's cost, never $0, and the next request keeps its own`, async (t) => {
    withEnv(t, { AGENTRUN_SERVE_TEST_ROOT_WRITE_DELAY_MS: "300" });
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
    assert.equal((await api("POST", "/agents", agent("unpriced", { harness: on, instructions: "Write unpriced on a slow store.", tools: ["read", "write", "edit"] }))).status, 201);
    const runId = (await api("POST", "/agents/unpriced/runs", { input: { content: "Write alpha to a.md." } })).body.run_id;
    const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 30_000 });
    assert.equal(last.status, "completed", JSON.stringify(rows.at(-1)));
    const answers = rootOf(data, runId).filter((e) => e.kind === "pi.assistant").map((e) => [contentOf(e), e.model[0].usage?.cost?.total ?? null]);
    assert.deepEqual(answers.map(([text]) => text), ["Writing a.md.|call:write", "Wrote it."], JSON.stringify(answers));
    assert.equal(answers[1][1], 0.002, `the second answer keeps its own cost: ${JSON.stringify(answers)}`);
    assert.notEqual(answers[0][1], 0, `the first answer's unknown cost is never $0: ${JSON.stringify(answers)}`);
    const usage = rows.findLast((r) => r.kind === "usage")?.usage;
    assert.deepEqual([usage?.requests, usage?.usd], [2, null], `two requests, the total unknown: ${JSON.stringify(usage)}`);
    assert.equal((await api("GET", `/runs/${runId}`)).body.cost?.usd ?? null, null, "the run's cost is unknown, not $0.002");
  });
}

test("claude-agent: on a store slow to write, the cap counts a request of unknown cost at what it held it at, never $0: the next request is refused for want of room", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_TEST_ROOT_WRITE_DELAY_MS: "300" });
  const { api } = await serve(t, { faux: OUTPUT_PRICED, fauxHarness: FAUX_HARNESS });
  assert.equal((await api("POST", "/agents", agent("unpriced-cap", { harness: "claude-agent", instructions: "Pay unpriced on a slow store.", tools: ["read", "write", "edit"] }))).status, 201);
  const runId = (await api("POST", "/agents/unpriced-cap/runs", { input: { content: "Write alpha to a.md." }, max_cost_usd: 1 })).body.run_id;
  const { last } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 30_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  // The first request's provider gave no cost: the cap counts it at the bound it admitted it at (the whole room it had),
  // so the second request, which would fit beside $0, is refused, and the pause names that spend.
  assert.deepEqual([last.status, view.pending?.kind], ["input_required", "budget"], JSON.stringify(view.pending ?? view));
  assert.ok(view.pending.spent_usd === null || view.pending.spent_usd >= 0.9, `the unknown request counts at its hold, never $0: ${JSON.stringify(view.pending)}`);
  assert.equal(view.cost?.usd ?? null, null, "the run's own cost stays unknown");
});

test("claude-agent: on a store slow to write, the cap counts what each request cost, never $0: a follow-up whose request the spend leaves no room for is refused, naming that spend", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_TEST_ROOT_WRITE_DELAY_MS: "300" });
  const { api } = await serve(t, { faux: OUTPUT_PRICED, fauxHarness: FAUX_HARNESS });
  assert.equal((await api("POST", "/agents", agent("slow-cap", { harness: "claude-agent", instructions: "Pay on a slow store.", tools: ["read", "write", "edit"] }))).status, 201);
  // The output-priced model's least request costs $0.1024: the cap admits it at $0.001 spent, never at $0.003.
  const started = await api("POST", "/agents/slow-cap/runs", { input: { content: "Write alpha to a.md." }, max_cost_usd: 0.1044 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 30_000 });
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "And more." })).status, 202);
  const { last } = await follow(api, runId, ["input_required", "completed", "failed"], { deadlineMs: 30_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([last.status, view.pending?.kind, view.pending?.spent_usd], ["input_required", "budget", 0.003], JSON.stringify(view.pending ?? view));
});

for (const [on, capped] of [["claude-agent", false], ["codex", false], ["claude-agent", true], ["codex", true]]) {
  test(`${on}${capped ? ", capped" : ""}: on a store slow to write, a side call admitted and answered while a request still streams leaves each its own text and cost`, async (t) => {
    withEnv(t, { AGENTRUN_SERVE_TEST_ROOT_WRITE_DELAY_MS: "300" });
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
    assert.equal((await api("POST", "/agents", agent("overlap", { harness: on, instructions: "Write beside a side call on a slow store.", tools: ["read", "write", "edit"] }))).status, 201);
    // Capped, every request is admitted through the cap's check and held at its bound while in flight.
    const runId = (await api("POST", "/agents/overlap/runs", { input: { content: "Write alpha to a.md." }, ...(capped ? { max_cost_usd: 5 } : {}) })).body.run_id;
    const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 30_000 });
    assert.equal(last.status, "completed", JSON.stringify(rows.at(-1)));
    const root = rootOf(data, runId);
    const answers = root.filter((e) => e.kind === "pi.assistant" && contentOf(e)).map((e) => [contentOf(e), e.model[0].usage?.cost?.total ?? null]);
    console.log(JSON.stringify({ answers, usage: rows.findLast((r) => r.kind === "usage")?.usage, kinds: root.map((e) => `${e.kind}${e.data?.request ? `#${e.data.request}` : ""}${e.kind === "pi.assistant" ? `:${e.model[0].usage?.cost?.total}` : ""}`) }));
    assert.deepEqual(answers, [["Writing a.md.|call:write", 0.001], ["Wrote it.", 0.002]], `each request's own text and cost: ${JSON.stringify(answers)}`);
    const usage = rows.findLast((r) => r.kind === "usage")?.usage;
    assert.equal(usage?.usd, 0.0035, `every request's cost, the side call's too, known: ${JSON.stringify(usage)}`);
  });
}
