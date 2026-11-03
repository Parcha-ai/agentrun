// One grader decides whether a run's checked notes join main: a bounded call on the agent's own model, read fail-closed.
// The injection screen runs only with an independent judge (Jev). What the grade spends is kept on the run's learning
// and, with how its learning ended, in the learning ledger, which /v2/usage's `learning` meter reads; a call cut off at
// its bound costs what nobody knows, never $0. A server that goes mid-grade grades the run once at its next start, and a
// run is merged once, never twice. GET /v2/stats counts how the runs that tried to learn fared, from the ledger and the
// runs the server holds, never a run's files.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { CANARY } from "./fixtures/faux-jev.mjs";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, LEARN, learner, ledgerOf, made, mergesOf, repoOf, savedOf, settled, sleep, started } from "./learn-support.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const PLAN = [["check-units.md", note("Check units", "Convert every amount to one unit before comparing")]];
const callsIn = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

test("the grader's verdict decides: a drop, a merge that keeps no note and an answer that is no verdict are dropped as grader, with the verdict kept; a model that fails is grade_failed", { timeout: 150_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  const cases = [
    ["Grade: drop.", "grader", { merge: false, reason: "A note is about the one case it came from.", items: [{ file: "check-units.md", keep: false, question: "General", why: "It is about one case." }] }],
    ["Grade: sly.", "grader", { merge: false, reason: "the grader said merge, but did not keep every item", items: [{ file: "check-units.md", keep: false, question: "General", why: "It is about one case." }] }],
    ["Grade: garbage.", "grader", { merge: false, reason: "the grader's verdict could not be read", items: [] }],
    ["Grade: fail.", "grade_failed", undefined],
  ];
  for (const [rule, reason, verdict] of cases) {
    const id = rule.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "");
    await made(api, learner(id, { instructions: rule, plan: PLAN }));
    const runId = await started(api, id);
    const { view, rows } = await ended(api, runId);
    assert.equal(view.result.final_answer, "Job answer.");
    settled(view, rows, "dropped", reason);
    const { learning } = await savedOf(data, runId);
    assert.deepEqual(learning.verdict, verdict, rule);
    assert.equal(git(repoOf(data, id), ["rev-list", "--count", "main"]), "1", `${rule}: nothing merged`);
    // Asked once, whatever it answered; its cost kept, unknown when the call failed.
    assert.equal(learning.cost_usd.grade === null, reason === "grade_failed", JSON.stringify(learning.cost_usd));
  }
  assert.equal(callsIn(calls).filter((call) => call.kind === "grade").length, cases.length, "one grader call a run");
});

test("with no independent judge there is no injection screen: Jev is never asked, the grader alone decides, and the run merges", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  withEnv(t, { AGENTRUN_TEST_FAUX_JEV_CALLS: join(dir, "jev.jsonl"), AGENTRUN_TEST_FAUX_CALLS: join(dir, "calls.jsonl") }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_TEST_FAUX_GRADE_HOLD"]);
  const { api } = await serve(t, { learning: "on", faux: LEARN, fauxJev: FAUX_JEV });
  await made(api, learner("unscreened", { plan: PLAN }));
  const { view, rows } = await ended(api, await started(api, "unscreened"));
  settled(view, rows, "merged");
  assert.deepEqual(callsIn(join(dir, "jev.jsonl")), [], "Jev was never asked");
  assert.equal(callsIn(join(dir, "calls.jsonl")).length, 1, "the grader was");
});

test("with Jev here, the screen runs first: a note it scores at or over the threshold drops the run as screen, the grader never asked, and Jev's cost is the grade's; a Jev that cannot judge drops it as screen_down", { timeout: 150_000 }, async (t) => {
  const dir = await scratch(t);
  const jev = join(dir, "jev.jsonl");
  const calls = join(dir, "calls.jsonl");
  withEnv(t, { TYPESAFE_API_KEY: CANARY, AGENTRUN_TEST_FAUX_JEV_CALLS: jev, AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_JEV_STATUS", "AGENTRUN_TEST_FAUX_JEV_NO_USAGE", "AGENTRUN_TEST_FAUX_GRADE_HOLD"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN, fauxJev: FAUX_JEV });
  await made(api, learner("screened", { plan: PLAN }));
  // The faux Jev scores every yes-or-no question 0.92: over the threshold.
  const runId = await started(api, "screened");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "screen");
  assert.ok(callsIn(jev).length >= 1 && callsIn(jev).every((call) => call.authorized && call.pid === process.pid), "the server asked Jev, with its key");
  assert.deepEqual(callsIn(calls), [], "the grader was never asked");
  const { learning } = await savedOf(data, runId);
  assert.equal(learning.verdict, undefined);
  assert.ok(learning.cost_usd.grade > 0 && learning.tokens.grade.input === 120 * callsIn(jev).length, JSON.stringify(learning));
  process.env.AGENTRUN_TEST_FAUX_JEV_STATUS = "503";
  const down = await ended(api, await started(api, "screened"));
  settled(down.view, down.rows, "dropped", "screen_down");
  assert.deepEqual(callsIn(calls), [], "still never the grader");
});

// A Jev key a person saved on the server (the settings API) screens the notes as one in the server's environment does.
test("a Jev key saved through the settings API, none in the environment, screens the notes: a note it scores over the threshold drops the run as screen, Jev asked on the saved key and the grader never", { timeout: 150_000 }, async (t) => {
  const dir = await scratch(t);
  const jev = join(dir, "jev.jsonl");
  const calls = join(dir, "calls.jsonl");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_JEV_CALLS: jev, AGENTRUN_TEST_FAUX_CALLS: calls }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_TEST_FAUX_JEV_STATUS", "AGENTRUN_TEST_FAUX_JEV_NO_USAGE", "AGENTRUN_TEST_FAUX_GRADE_HOLD"]);
  const { api } = await serve(t, { learning: "on", faux: LEARN, fauxJev: FAUX_JEV });
  assert.equal((await api("PUT", "/settings/tool-keys/typesafe", { values: { TYPESAFE_API_KEY: CANARY } })).status, 204);
  await made(api, learner("screened", { plan: PLAN }));
  const runId = await started(api, "screened");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "screen");
  assert.ok(callsIn(jev).length >= 1 && callsIn(jev).every((call) => call.authorized && call.pid === process.pid), "the server asked Jev, on the saved key");
  assert.deepEqual(callsIn(calls), [], "the grader was never asked");
});

test("a server that goes mid-grade grades the run once at its next start; a run whose kept verdict is merged again is the merge already on main, never a second", { timeout: 180_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls, AGENTRUN_TEST_FAUX_GRADE_HOLD: "1" }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const first = await serve(t, { learning: "on", faux: LEARN });
  const { data } = first;
  await made(first.api, learner("held", { plan: PLAN }));
  const runId = await started(first.api, "held");
  for (let i = 0; callsIn(calls).length === 0; i++) {
    assert.ok(i < 1200, "the grader is asked");
    await sleep(50);
  }
  assert.equal((await first.api("GET", `/runs/${runId}`)).body.learning.state, "proposed");
  await first.close();
  const saved = JSON.parse(readFileSync(join(data, "runs", runId, "serve.json"), "utf8"));
  assert.deepEqual([saved.learning.state, saved.learning.verdict], ["proposed", undefined], "nothing was decided");
  // The next start grades it, once.
  delete process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD;
  const second = await serve(t, { learning: "on", faux: LEARN, data });
  const { view, rows } = await ended(second.api, runId);
  settled(view, rows, "merged");
  assert.equal(callsIn(calls).length, 2, "one grader call per server");
  const repo = repoOf(data, "held");
  const main = git(repo, ["rev-parse", "main"]);
  assert.equal(mergesOf(repo, runId).length, 1);
  await second.close();
  // A server that went after the verdict was kept and before the merge was saved: the run reads proposed, verdict kept.
  const merged = JSON.parse(readFileSync(join(data, "runs", runId, "serve.json"), "utf8"));
  writeFileSync(join(data, "runs", runId, "serve.json"), JSON.stringify({ ...merged, learning: { ...merged.learning, state: "proposed", merged: undefined } }));
  const third = await serve(t, { learning: "on", faux: LEARN, data });
  const again = await ended(third.api, runId);
  settled(again.view, again.rows, "merged");
  assert.equal((await savedOf(data, runId)).learning.merged, main, "the merge already on main");
  assert.equal(git(repo, ["rev-parse", "main"]), main, "main did not move");
  assert.equal(mergesOf(repo, runId).length, 1, "merged once");
  assert.equal(callsIn(calls).length, 2, "the kept verdict was not asked again");
});

// A run whose learning waits to be checked or graded is opened again for a follow-up, and its server goes while the
// follow-up runs. The next server reads the run as running, so its start passes the learning over: the run's own end,
// once the follow-up finishes, is where it is checked and graded, with no later restart.
for (const at of ["proposed", "reflecting"]) {
  test(`a run opened again for a follow-up while its learning is ${at}, its server gone while the follow-up runs: the next server finishes the follow-up, then ${at === "proposed" ? "grades" : "checks and grades"} what the run proposed, and it merges, with no restart after`, { timeout: 180_000 }, async (t) => {
    const gate = join(await scratch(t), "answer");
    const calls = join(await scratch(t), "calls.jsonl");
    writeFileSync(gate, "");
    withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls, AGENTRUN_TEST_FAUX_GRADE_HOLD: "1" }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
    const first = await serve(t, { learning: "on", faux: LEARN });
    const { data } = first;
    await made(first.api, learner("reopened", { plan: PLAN, instructions: `Answer once ${gate} exists.` }));
    const runId = await started(first.api, "reopened");
    for (let i = 0; callsIn(calls).length === 0; i++) {
      assert.ok(i < 1200, "the grader is asked");
      await sleep(50);
    }
    assert.equal((await first.api("GET", `/runs/${runId}`)).body.learning.state, "proposed");
    // The follow-up's answer holds until the gate is back, so the server goes while it runs, mid-grade.
    rmSync(gate);
    const sent = await first.api("POST", `/runs/${runId}/messages`, { content: "One more thing." });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    for (let i = 0; (await first.api("GET", `/runs/${runId}`)).body.status !== "working"; i++) {
      assert.ok(i < 1200, "the follow-up runs");
      await sleep(50);
    }
    await first.close();
    const saved = JSON.parse(readFileSync(join(data, "runs", runId, "serve.json"), "utf8"));
    assert.deepEqual([saved.learning.state, saved.learning.verdict], ["proposed", undefined], "nothing was decided");
    if (at === "reflecting") {
      // A server that went after the run settled and before its check: what the turn wrote is set aside, not yet checked.
      writeFileSync(join(data, "runs", runId, "serve.json"), JSON.stringify({ ...saved, learning: { ...saved.learning, state: "reflecting", reason: null, detail: "The end-of-run turn ended; what it wrote waits to be checked." } }));
      rmSync(join(data, "runs", runId, "learning-proposal.json"));
      assert.ok(existsSync(join(data, "runs", runId, "learning-turn", "check-units.md")), "the turn's copy is set aside");
    }
    // The next server: the follow-up answers, the run ends, and its learning goes on from where it was.
    delete process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD;
    writeFileSync(gate, "");
    const second = await serve(t, { learning: "on", faux: LEARN, data });
    const { view, rows } = await ended(second.api, runId);
    assert.equal(view.status, "completed");
    settled(view, rows, "merged");
    assert.equal(callsIn(calls).length, 2, "one grader call per server");
    const repo = repoOf(data, "reopened");
    assert.equal((await savedOf(data, runId)).learning.merged, git(repo, ["rev-parse", "main"]));
    assert.equal(mergesOf(repo, runId).length, 1, "merged once");
    assert.deepEqual(git(repo, ["ls-tree", "--name-only", "main"]).split("\n"), ["MEMORY.md", "check-units.md"]);
    await second.close();
  });
}

test("a grader that never answers is cut off at its bound: the run's learning is grade_failed, and what the grade spent is unknown (null), never $0, on the run, in the ledger and on /v2/usage", { timeout: 120_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_GRADE_HOLD: "never", AGENTRUN_TEST_FAUX_CALLS: calls }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN, gradeTimeoutMs: 1_500 });
  await made(api, learner("stuck", { plan: PLAN }));
  const runId = await started(api, "stuck");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "grade_failed");
  assert.equal(callsIn(calls).length, 1, "the grader was asked, and never answered");
  const { learning } = await savedOf(data, runId);
  assert.deepEqual([learning.cost_usd, learning.tokens], [{ grade: null }, { grade: null }]);
  assert.deepEqual(ledgerOf(data).map(({ run, state, reason, cost, tokens }) => [run, state, reason, cost, tokens]), [[runId, "dropped", "grade_failed", null, null]]);
  const line = (await api("GET", "/usage?group_by=meter")).body.lines.find((entry) => entry.meter === "learning");
  assert.deepEqual([line.usd, line.unpriced_runs], [0, 1], "unpriced, never $0");
});

// GET /v2/usage on one server with both kinds of spend outside a run's tokens: a run whose paid tool charged (monid's
// `tools`, from S2) and a run whose grade spent (the learning ledger's `learning`). Each groups the same way, and the
// total is every line once.
test("GET /v2/usage books a run's tool charge as tools and a grade as learning, beside the runs' tokens: by meter, agent and day the lines sum to the same total", { timeout: 180_000 }, async (t) => {
  const saved = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_MONID_CALLS: join(await scratch(t), "monid.jsonl"), AGENTRUN_TEST_FAUX_MONID_KEY: saved }, ["MONID_API_KEY", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN, fauxHarness: FAUX_HARNESS, fauxMonid: FAUX_MONID });
  // A learning run on pi, graded and merged: its grade's cost is the learning ledger's.
  await made(api, learner("learner", { plan: PLAN }));
  const learnt = await started(api, "learner");
  const learning = await ended(api, learnt);
  settled(learning.view, learning.rows, "merged");
  const grade = (await savedOf(data, learnt)).learning.cost_usd.grade;
  assert.ok(grade > 0, "the grade cost something");
  // A run on claude-agent whose monid call charged $0.003, on a key saved through the settings API.
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: saved } })).status, 204);
  await made(api, agent("enrich", { harness: "claude-agent", instructions: "Run monid's /person/enrich on Ada.", tools: ["monid.discover", "monid.inspect", "monid.run"] }));
  const enriched = await started(api, "enrich", "hi");
  await follow(api, enriched, ["completed"], { deadlineMs: 55_000 });
  const cost = async (runId) => (await api("GET", `/runs/${runId}`)).body.cost.usd;
  const [learnerRun, enrichRun] = [await cost(learnt), await cost(enriched)];
  assert.equal(enrichRun, 0.005, "two requests and monid's charge");
  const round = (v) => Math.round(v * 1e6) / 1e6;
  const usage = async (group) => (await api("GET", `/usage?group_by=${group}`)).body;
  const sum = (body) => round(body.lines.reduce((total, line) => total + line.usd, 0));
  const byMeter = await usage("meter");
  assert.deepEqual(Object.fromEntries(byMeter.lines.map((line) => [line.meter, line.usd])), { tokens: round(learnerRun + 0.002), tools: 0.003, learning: round(grade) });
  assert.equal(byMeter.total_usd, round(learnerRun + enrichRun + grade), "every run's cost, and the grade, once");
  assert.equal(sum(byMeter), byMeter.total_usd, "the lines sum to the total");
  const byAgent = await usage("agent");
  assert.deepEqual(Object.fromEntries(byAgent.lines.map((line) => [line.group, line.usd])), { learner: round(learnerRun + grade), enrich: enrichRun });
  assert.equal(byAgent.total_usd, byMeter.total_usd);
  const byDay = await usage("day");
  assert.equal(byDay.lines.length, 1, "one day");
  assert.equal(byDay.lines[0].usd, byMeter.total_usd);
  assert.equal(byDay.total_usd, byMeter.total_usd);
  for (const body of [byMeter, byAgent, byDay]) assert.equal(body.unpriced_runs, 0);
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.features.usage.meters, ["tokens", "tools", "learning"]);
});

test("GET /v2/usage books each grade under the meter learning, by agent and by day; GET /v2/stats counts the runs that tried to learn, over its filters, from the ledger, and a restarted server counts the same with runs/ unreadable", { timeout: 180_000 }, async (t) => {
  withEnv(t, {}, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS"]);
  const first = await serve(t, { learning: "on", faux: LEARN });
  const { api, data } = first;
  await made(api, learner("counted", { plan: PLAN, once: true }));
  await made(api, agent("mute", { learning: true }));
  await made(api, agent("plain", { tools: ["write"] }));
  const merged = await ended(api, await started(api, "counted"));
  const empty = await ended(api, await started(api, "counted"));
  const mute = await ended(api, await started(api, "mute"));
  await ended(api, await started(api, "plain"));
  assert.deepEqual([merged.view.learning.state, empty.view.learning.reason, mute.view.learning.reason], ["merged", "empty", "no_write_tool"]);
  const grade = (await savedOf(data, merged.view.run_id)).learning.cost_usd.grade;
  assert.ok(grade > 0);
  for (const { view } of [empty, mute]) await savedOf(data, view.run_id);
  const byMeter = (await api("GET", "/usage?group_by=meter")).body;
  const line = byMeter.lines.find((entry) => entry.meter === "learning");
  assert.equal(line.usd, Math.round(grade * 1e6) / 1e6);
  assert.ok(byMeter.lines.find((entry) => entry.meter === "tokens").usd > 0, "the runs' own cost stays under tokens");
  assert.ok((await api("GET", "/usage?group_by=agent")).body.lines.find((entry) => entry.group === "counted").usd >= line.usd);

  const want = { runs: 3, merged: 1, dropped: { empty: 1, no_write_tool: 1 }, in_progress: 0 };
  assert.deepEqual((await api("GET", "/stats")).body.learning, want);
  assert.deepEqual((await api("GET", "/stats?agent=mute")).body.learning, { runs: 1, merged: 0, dropped: { no_write_tool: 1 }, in_progress: 0 });
  assert.deepEqual((await api("GET", `/stats?from=${new Date(Date.now() + 60_000).toISOString()}`)).body.learning, { runs: 0, merged: 0, dropped: {}, in_progress: 0 });
  // One ledger line per run that tried to learn, once its end was saved: the grade's spend on the merged one, none on the
  // others, which were never graded.
  const lines = ledgerOf(data).map(({ run, agent, state, reason, at, cost, tokens }) => ({ run, agent, state, reason, at: typeof at, cost, tokens }));
  const zero = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
  const saved = await savedOf(data, merged.view.run_id);
  assert.deepEqual(lines.sort((a, b) => a.run.localeCompare(b.run)), [
    { run: merged.view.run_id, agent: "counted", state: "merged", reason: null, at: "string", cost: grade, tokens: saved.learning.tokens.grade },
    { run: empty.view.run_id, agent: "counted", state: "dropped", reason: "empty", at: "string", cost: 0, tokens: zero },
    { run: mute.view.run_id, agent: "mute", state: "dropped", reason: "no_write_tool", at: "string", cost: 0, tokens: zero },
  ].sort((a, b) => a.run.localeCompare(b.run)));
  await first.close();
  const again = await serve(t, { learning: "on", faux: LEARN, data });
  // The restarted server holds none of these runs: it counts them from the ledger alone, and never opens runs/.
  const runs = join(data, "runs");
  chmodSync(runs, 0o000);
  try {
    assert.deepEqual((await again.api("GET", "/stats")).body.learning, want, "read back from the ledger");
    assert.deepEqual((await again.api("GET", "/stats?agent=mute")).body.learning, { runs: 1, merged: 0, dropped: { no_write_tool: 1 }, in_progress: 0 });
  } finally {
    chmodSync(runs, 0o700);
  }
  assert.equal((await again.api("GET", "/usage?group_by=meter")).body.lines.find((entry) => entry.meter === "learning").usd, line.usd, "counted once");
  assert.equal(ledgerOf(data).length, 3, "the restart wrote no line again");
});
