// The shadow audit (runner/audit.ts, learn/audit.ts): a run its promoted learned workflow serves first (answered alone or
// handed back) is drawn for an audit at 1/k, a seeded choice that is a function of the run's id alone (k is the agent
// definition's `learning.audit_every`, 10 by default). A drawn run starts a shadow run at its claim: the same agent on the
// same input with learning off, marked as the audit of that run (its launch's `audit`, its record's path `audit`), billed
// to the agent as learning cost. Once both ended, a later claim writes one row to audits.jsonl in the agent's git learning
// folder ({run, shadow_run, workflow, digest, source, agreed, served_cost, shadow_cost, at}, agreed by sameAnswer of the
// two answers). The hold rule reads those rows: when the last `hold_window` rows of the serving digest hold at least
// `hold_disagree` disagreements, the workflow stops serving (a hold, source `audit`) and the agent's next run asks ONE
// recompile with those rows as data; a second hold within `stop_window` served runs of the first stops it, asks no
// compile, and says so on the record.
//   (a) with k = 10, exactly the drawn served runs start a shadow, and the draw is a function of the run id;
//   (b) an audit row lands in audits.jsonl with both costs;
//   (c) the shadow's cost is the served run's learning cost in the agent's cost series, and the shadow is no row of it;
//   (d) 3 disagreements in 10 rows hold the workflow and ask exactly one recompile carrying those rows;
//   (e) a second hold inside stop_window asks no compile and writes the stop message;
//   (g) the definition's numbers stand in for the defaults: k 5, hold at 2 of 5.
// The agent's runs are real runs of the store on a pi run of the faux gateway; its promotion is S3a's record shape.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, readmeOf, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { promotionsOf } = await import("../dist/learn/promote.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { askedForCompile } = await import("../dist/learn/compile.js");
const { seedOf } = await import("../dist/learning.js");
const { readAudits, AUDITS_FILE } = await import("../dist/learn/audit.js");
const { agentCostOverStore } = await import("../dist/store-reads/learning.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** The agent's own answer to every question: what each audit scores the served answer against. */
const AGENT_SAYS = JSON.stringify({ answer: 42, sure: true });
const WRONG = { answer: 41, sure: true };

/** The audit's draw as the definition states it: drawn when the first 8 hex digits of sha256("audit:" + run id), read
 *  as a number, are a multiple of k. A function of the run id and k alone. */
const drawn = (runId, k) => Number.parseInt(createHash("sha256").update(`audit:${runId}`).digest("hex").slice(0, 8), 16) % k === 0;

const answerFlow = (how = "Answer the question; say whether you are sure.") => ({
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: how, out: "Answer", as: "answer", tier: "fast" },
    { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "answer.sure", value: false }, kind: "unsure", stage: "answer", summary: "not sure of {answer.answer}" },
  ] },
});
const REVISED = "Answer the question exactly; say whether you are sure.";
const FIRST = answerFlow();
const DIGEST = workflowDigest({ workflow: JSON.stringify(FIRST) });
const DIGEST_2 = workflowDigest({ workflow: JSON.stringify(answerFlow(REVISED)) });
/** A compile answer whose draft fails its dry run: no draft lands from the faux model, so a recompile ask stays the one. */
const BROKEN_DRAFT = `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"question":"What is six times seven?"}\n---\n${JSON.stringify({ ...FIRST, root: { node: "chain", steps: [{ ...FIRST.root.steps[0], as: "other" }] } })}\n\`\`\`\``;

const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => (part?.type === "text" ? part.text : "")).join(""));
const compileAskOf = (body) => {
  const last = (body?.messages ?? []).findLast((message) => message.role === "user");
  return askedForCompile(textOf(last)) ? textOf(last) : "";
};

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const FINAL = ["ended", "failed", "stopped"];

/** An agent of `learning` with `prior` runs of its own ("Question 0" …), the learned workflow `answer` landed and promoted
 *  by its check (S3a's record, at the landed commit), and a runner claiming every run from its stored launch. The
 *  workflow's node submits `submit(requestText)` ({answer: 42, sure: true} by default); the agent answers AGENT_SAYS; a
 *  compile ask is answered with BROKEN_DRAFT. */
async function world(t, { learning, prior = 0, submit } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-audit-ledger-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: submit ? submit(JSON.stringify(body)) : { answer: 42, sure: true } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : compileAskOf(body) ? BROKEN_DRAFT : AGENT_SAYS),
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Audited" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning } });
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const logs = [];
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const launchOf = (question, learningStart) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(learningStart ? { learning: learningStart } : {}) });
  for (let i = 0; i < prior; i++) {
    await server.runs.create({ id: `prior-${i}`, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(`Question ${i}`) });
    await ended(`prior-${i}`);
  }
  const seed = await landWorkflows(dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: FIRST }]);
  // Promoted by its check, as S3a's claim records it: it serves every fitting run first from here.
  await server.settings.put("learning.promotions.agent-1", { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", source: "check", reason: "checked: promoted", check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [] }, commit: seed }] });
  /** The shadow runs: those whose launch names the run they audit, whatever their state. */
  const shadows = async () => {
    const out = [];
    for (const row of await server.runs.list({ agentId: "agent-1" })) {
      const launch = readLaunchBody((await server.runs.launch(row.id)).body);
      if (launch?.audit) out.push({ row, launch });
    }
    return out;
  };
  const shadowOf = async (id) => (await shadows()).find(({ launch }) => launch.audit.of === id);
  const asks = new Map();
  /** Runs `id` on `question` at the learning folder's main now, as the server launches it; then, when it started a
   *  shadow, waits for that one to end too, so the next claim reads both ended. */
  const start = async (id, question) => {
    const before = gw.requests.length;
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(question, startAt((await seedOf(dir, "agent-1")).sha)) });
    const row = await ended(id);
    const shadow = await shadowOf(id);
    if (shadow) await ended(shadow.row.id);
    asks.set(id, gw.requests.slice(before).map((request) => compileAskOf(request.body)).filter(Boolean));
    return row;
  };
  const audits = async () => {
    const folder = learningWorkspace({ mode: "local", data: dir, agentId: "agent-1" });
    try {
      return await readAudits(folder.workspace);
    } finally {
      await folder.end();
    }
  };
  const replaysEnded = (count) => until(async () => {
    const all = [];
    for (const row of await server.runs.list({ agentId: "agent-1" })) if ((await server.runs.launch(row.id)).body?.replay) all.push(row);
    return all.length === count && all.every((row) => FINAL.includes(row.state) && row.runner === null) && all;
  }, `the ${count} replay runs ended`, 120_000);
  return { dir, server, gw, logs, start, asks, shadows, shadowOf, audits, replaysEnded, ended };
}

/** Lands `workflow` as the next revision of `answer` on the learning folder's main, as the recompile's merge lands it. */
async function landRevision(dir, workflow, runId) {
  const folder = learningWorkspace({ mode: "local", data: dir, agentId: "agent-1" });
  try {
    const merged = await learningCommit(folder.workspace, {
      kind: "merge", runId, reason: "revised answer", graded: {},
      files: [{ path: "workflows/answer/workflow.json", text: JSON.stringify(workflow) }, { path: "workflows/answer/README.md", text: readmeOf("answer", "Answers a question as a number") }],
    });
    assert.equal(merged.ok, true, JSON.stringify(merged));
  } finally {
    await folder.end();
  }
}

/** The fence of the recompile ask's audit rows alone. */
const fenceOf = (ask) => /----- begin (\w+): the disagreements -----\n([\s\S]*?)\n----- end \1 -----/.exec(ask)?.[2] ?? "";

test("(a) k = 10 by default: exactly the served runs whose id the draw picks start a shadow, each the audit of its run, learning off, path audit", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { learning: true });
  const ids = Array.from({ length: 14 }, (_, i) => `drawn-${i}`);
  const expected = ids.filter((id) => drawn(id, 10));
  // The ids are chosen so the draw picks some and leaves most: the test means something either way.
  assert.ok(expected.length > 0 && expected.length < ids.length / 2, JSON.stringify(expected));
  for (const id of ids) {
    const row = await w.start(id, `Question for ${id}`);
    assert.deepEqual([row.state, row.metrics?.path, row.metrics?.workflow_digest], ["ended", "workflow", DIGEST], `served first: ${JSON.stringify(row.metrics)}`);
  }
  const shadows = await w.shadows();
  assert.deepEqual(shadows.map(({ launch }) => launch.audit.of).sort(), [...expected].sort(), "a shadow for each drawn run, none other");
  for (const { row, launch } of shadows) {
    assert.deepEqual(launch.audit, { of: launch.audit.of, workflow: "answer", digest: DIGEST });
    assert.equal(launch.learning, undefined, "the shadow runs with learning off: no seed, no look-back");
    const served = readLaunchBody((await w.server.runs.launch(launch.audit.of)).body);
    assert.deepEqual(launch.input, served.input, "the same input");
    assert.deepEqual([row.state, row.metrics?.path, row.agentId, row.revisionId], ["ended", "audit", "agent-1", "rev-1"], JSON.stringify(row));
  }
});

test("(b, c) an audit row lands in audits.jsonl with both costs, and the shadow's cost is the served run's learning cost in the agent's cost series", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { learning: { audit_every: 1 } });
  const served = await w.start("served-1", "What is six times seven");
  assert.equal(served.metrics?.path, "workflow");
  const shadow = (await w.shadowOf("served-1")).row;
  assert.equal(shadow.state, "ended");
  // A later claim writes the row once both ended.
  await w.start("served-2", "What is seven times six");
  const rows = await w.audits();
  const row = rows.find((one) => one.run === "served-1");
  assert.ok(row, `${AUDITS_FILE}: ${JSON.stringify(rows)}`);
  const shadowRow = await w.server.runs.get(shadow.id);
  assert.deepEqual({ ...row, at: typeof row.at }, {
    run: "served-1", shadow_run: shadow.id, workflow: "answer", digest: DIGEST, source: "shadow", agreed: true,
    served_cost: served.costUsd, shadow_cost: shadowRow.costUsd, at: "string",
  });
  assert.ok(served.costUsd > 0 && shadowRow.costUsd > 0, `both runs are priced: ${served.costUsd}, ${shadowRow.costUsd}`);
  // The cost series the Learning tab reads: the served run carries its shadow's cost as learning, the shadow is no row.
  const cost = await agentCostOverStore(w.server, "agent-1");
  assert.equal(cost.runs.some((one) => one.run_id === shadow.id), false, "the shadow is no run of the series");
  const one = cost.runs.find((each) => each.run_id === "served-1");
  const usd = (value) => Math.round(value * 1e6) / 1e6;
  assert.deepEqual([one.path, one.cost_usd, one.learning_usd, one.total_usd], ["workflow", usd(served.costUsd), usd(shadowRow.costUsd), usd(served.costUsd + shadowRow.costUsd)], JSON.stringify(one));
});

/** The questions the workflow answers wrong (41, where the agent says 42): the first revision on `wrong`, the revision
 *  on `wrongLater`. */
const answers = ({ wrong = [], wrongLater = [] }) => (text) => {
  const asked = (list) => list.some((question) => text.includes(`${question}?`));
  return text.includes("exactly") ? (asked(wrongLater) ? WRONG : { answer: 42, sure: true }) : asked(wrong) ? WRONG : { answer: 42, sure: true };
};

test("(d, e) 3 disagreements in the last 10 rows hold the workflow and ask exactly one recompile with those rows; a second hold within stop_window stops it, asks no compile and says why", { timeout: 600_000 }, async (t) => {
  const wrong = ["Question 18", "Question 19", "Question 20"];
  const wrongLater = ["Question 31", "Question 32", "Question 33"];
  const w = await world(t, { learning: { compile_after: 5, audit_every: 1 }, prior: 5, submit: answers({ wrong, wrongLater }) });
  for (let i = 1; i <= 10; i++) {
    const row = await w.start(`served-${i}`, `Question ${10 + i}`);
    assert.deepEqual([row.metrics?.path, row.metrics?.workflow_digest], ["workflow", DIGEST], `served-${i}: ${JSON.stringify(row.metrics)}`);
    assert.deepEqual(w.asks.get(`served-${i}`), [], "serving, nothing compiles");
  }
  // The 11th claim writes served-10's row: 3 of the last 10 disagree. Held: the agent takes the run, and its end asks
  // the one recompile with those rows as data.
  const eleventh = await w.start("run-11", "Question 21");
  assert.equal(eleventh.metrics?.path, "agent", JSON.stringify(eleventh.metrics));
  const rows = (await w.audits()).filter((one) => one.digest === DIGEST);
  assert.equal(rows.length, 10, JSON.stringify(rows));
  assert.deepEqual(rows.filter((one) => one.agreed === false).map((one) => one.run).sort(), ["served-10", "served-8", "served-9"]);
  const held = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([held.digest, held.decided, held.source, held.audit.window, held.audit.disagree, held.audit.rows, held.audit.stopped], [DIGEST, "hold", "audit", 10, 3, 10, undefined], JSON.stringify(held));
  assert.deepEqual(held.audit.disagreements.map((one) => one.served).sort(), ["served-10", "served-8", "served-9"]);
  for (const one of held.audit.disagreements) {
    assert.equal(one.agent, AGENT_SAYS, "the agent's answer: the shadow's");
    assert.deepEqual(JSON.parse(one.draft), WRONG, "the served answer");
    assert.equal(one.run, (await w.shadowOf(one.served)).row.id, "the input's agent run: its shadow");
  }
  assert.equal(w.asks.get("run-11").length, 1, "exactly one recompile");
  const [ask] = w.asks.get("run-11");
  assert.ok(ask.startsWith("One more turn: revise your learned workflow `answer`"), ask.slice(0, 200));
  assert.match(ask, /disagreed with your own answer on 3 of its last 10 audited runs/);
  const fence = fenceOf(ask);
  assert.ok(fence, ask.slice(0, 3000));
  for (const question of wrong) assert.ok(fence.includes(`${question}?`), question);
  for (const part of [`The workflow's answer: ${JSON.stringify(WRONG)}`, `Your answer: ${AGENT_SAYS}`]) assert.ok(fence.includes(part), part);
  for (const agreed of ["Question 11?", "Question 17?"]) assert.ok(!fence.includes(agreed), `${agreed} agreed: not among them`);
  // Once per hold: the next run asks nothing more.
  await w.start("run-12", "Question 22");
  assert.deepEqual(w.asks.get("run-12"), []);

  // The recompile lands: its one check runs on the agent's last 5 inputs and the 3 disagreeing ones, then promotes it.
  await landRevision(w.dir, answerFlow(REVISED), "run-11");
  const check = await w.start("run-13", "Question 23");
  assert.equal(check.metrics?.path, "agent");
  await w.replaysEnded(8);
  const back = await w.start("served-30", "Question 30");
  assert.deepEqual([back.metrics?.path, back.metrics?.workflow_digest], ["workflow", DIGEST_2], JSON.stringify(back.metrics));
  const promoted = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([promoted.digest, promoted.decided, promoted.source, promoted.check.attempt, promoted.check.n], [DIGEST_2, "promote", "check", 2, 8], JSON.stringify(promoted.check));
  for (const one of held.audit.disagreements) assert.ok(promoted.check.of.includes(one.run), `the check ran on ${one.run}, a disagreeing input`);

  // It disagrees again, 3 times, within stop_window (100) served runs of the first hold: stopped, no compile, said.
  for (const [i, question] of wrongLater.entries()) await w.start(`served-${31 + i}`, question);
  const after = await w.start("run-40", "Question 40");
  assert.equal(after.metrics?.path, "agent", JSON.stringify(after.metrics));
  const stopped = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([stopped.digest, stopped.decided, stopped.source, stopped.audit.stopped, stopped.reason], [DIGEST_2, "hold", "audit", true, "stopped: the workflow disagreed with the agent twice"], JSON.stringify(stopped));
  assert.deepEqual(w.asks.get("run-40"), [], "no compile: it stopped");
  const later = await w.start("run-41", "Question 41");
  assert.equal(later.metrics?.path, "agent");
  assert.deepEqual(w.asks.get("run-41"), [], "nothing compiles again");
});

test("(g) the definition's numbers stand in: audit_every 5 draws at 1/5, and hold_window 5 with hold_disagree 2 holds on 2 disagreements", { timeout: 240_000 }, async (t) => {
  // Drawn at 1/5 but not at the default 1/10: their shadows come from the definition's k alone.
  const picked = Array.from({ length: 200 }, (_, i) => `g-${i}`).filter((id) => drawn(id, 5) && !drawn(id, 10)).slice(0, 2);
  const skipped = Array.from({ length: 200 }, (_, i) => `g-${i}`).find((id) => !drawn(id, 5));
  assert.equal(picked.length, 2);
  const w = await world(t, { learning: { audit_every: 5, hold_window: 5, hold_disagree: 2 }, submit: answers({ wrong: picked.map((id) => `Question for ${id}`) }) });
  for (const id of [skipped, ...picked]) assert.equal((await w.start(id, `Question for ${id}`)).metrics?.path, "workflow");
  assert.deepEqual((await w.shadows()).map(({ launch }) => launch.audit.of).sort(), [...picked].sort());
  const next = await w.start("g-next", "Question next");
  assert.equal(next.metrics?.path, "agent", "held on 2 of the last 5 rows");
  const held = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([held.decided, held.source, held.audit.window, held.audit.disagree, held.audit.rows], ["hold", "audit", 5, 2, 2], JSON.stringify(held));
});
