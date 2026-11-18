// The shadow audit (runner/audit.ts, learn/audit.ts): a run its promoted learned workflow answered alone (path `workflow`;
// never one it handed back) is drawn for an audit at 1/k, a seeded choice that is a function of the run's id alone (k is the agent
// definition's `learning.audit_every`, 10 by default). A drawn run starts a shadow run at its end: the same agent on the
// same input with learning off, marked as the audit of that run (its launch's `audit`, its record's path `audit`), billed
// to the agent as learning cost, capped at what the served run's cap left (none left: no shadow, a `skipped` row). A
// shadow never waits on a person: one that would (a raise of that cap, an approval its owner's setting asks) ends at once,
// a `parked` row, no verdict. Once both ended, a later claim writes one row to audits.jsonl in the agent's git learning
// folder ({run, shadow_run, workflow, digest, source, agreed, served_cost, shadow_cost, turn, at}, agreed by sameAnswer of
// the shadow's answer and the served run's answer `turn` names, the one it gave when the audit began). The hold rule reads those rows: when the last `hold_window` rows of the serving digest hold at least
// `hold_disagree` disagreements, the workflow stops serving (a hold carrying `audit`) and the agent's next run asks ONE
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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
const { agentCostOverStore, allInOf, shadowSpendOf } = await import("../dist/store-reads/learning.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");

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
/** A compile turn's first ask (askedForCompile true), never an attempt the checks sent back ("again": the same compile
 *  turn's retries, which BROKEN_DRAFT always draws). */
const compileAskOf = (body) => {
  const last = (body?.messages ?? []).findLast((message) => message.role === "user");
  return askedForCompile(textOf(last)) === true ? textOf(last) : "";
};
/** Any compile message, a first ask or a retry: what the faux model answers with BROKEN_DRAFT. */
const anyCompileAsk = (body) => {
  const last = (body?.messages ?? []).findLast((message) => message.role === "user");
  return askedForCompile(textOf(last)) !== false;
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
 *  first compile ask is answered with BROKEN_DRAFT, and a revision ask is refused. `says(body)`: the agent's answer to a
 *  request instead (undefined: AGENT_SAYS); `call(body)`: a tool call the agent makes instead of answering; `tools` and
 *  `toolSettings`: the agent's (none by default); `outputSchema`: its definition's output_schema (none by default). */
async function world(t, { learning, prior = 0, submit, paused = false, env = {}, priced, says, call, tools = [], toolSettings, outputSchema } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-audit-ledger-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: submit ? submit(JSON.stringify(body)) : { answer: 42, sure: true } } } : call?.(body)),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : anyCompileAsk(body) ? BROKEN_DRAFT : (says?.(body) ?? AGENT_SAYS)),
    // A revision ask is refused, as learn-promote-once's landsRevision: a test lands any revision itself, and a recompile
    // whose drafts failed would be recorded as its stop (runner/learning-end.ts recordDraftFailed, S3b).
    refuse: ({ body }) => (compileAskOf(body).startsWith("One more turn: revise") ? { message: "the test lands any revision itself" } : undefined),
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  // No tool that can write (learn/audit.ts auditWriterOf): an agent the audit may run a second time.
  await server.agents.create({ id: "agent-1", name: "Audited" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools, learning, ...(toolSettings ? { toolSettings } : {}), ...(outputSchema ? { outputSchema } : {}) } });
  // `priced`: what each request costs, in order (the route's price is the booking's figure), else its tokens at the price.
  const price = (model, usage) => (priced ? priced(model, usage) : ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6);
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const logs = [];
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  /** The runner, started once (`paused`: only when the test resumes it, and one run at a time, so the runs made before are
   *  claimed one by one, oldest first, and each shadow is made in the order of its served run). */
  const resume = () => {
    runner ??= startRunner({ store, name: "runner-a", ...TIMING, ...(paused ? { loops: 1 } : {}), createLoop: createAdapterLoop(specOf) });
  };
  if (!paused) resume();
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const launchOf = (question, learningStart, extra = {}) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(learningStart ? { learning: learningStart } : {}), ...extra });
  for (let i = 0; i < prior; i++) {
    await server.runs.create({ id: `prior-${i}`, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(`Question ${i}`) });
    await ended(`prior-${i}`);
  }
  const seed = await landWorkflows(dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: FIRST }]);
  // Promoted by its check, as S3a's claim records it: it serves every fitting run first from here.
  await server.settings.put("learning.promotions.agent-1", { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [] }, commit: seed }] });
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
  /** Makes run `id` on `question` (its launch with `extra` too) at the learning folder's main now, as the server does. */
  const create = async (id, question, extra) => server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(question, startAt((await seedOf(dir, "agent-1")).sha), extra) });
  const start = async (id, question, extra) => {
    const before = gw.requests.length;
    await create(id, question, extra);
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
  return { dir, server, store, gw, logs, create, start, resume, asks, shadows, shadowOf, audits, replaysEnded, ended };
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
  // Counted for the promotion that served it: its promote record's `at`.
  const promotedAt = (await promotionsOf(w.server.settings, "agent-1"))[0].at;
  // `turn`: the served run's answer row the audit compared, its newest when the audit began.
  const answerRow = (await runTimeline(w.server, "served-1", BACKGROUND_CONTEXT, { settled: true })).findLast((one) => one.kind === "final_answer");
  assert.ok(answerRow?.id, "the served run has an answer row");
  assert.deepEqual({ ...row, at: typeof row.at }, {
    run: "served-1", shadow_run: shadow.id, workflow: "answer", digest: DIGEST, promoted_at: promotedAt, source: "shadow", agreed: true,
    served_cost: served.costUsd, shadow_cost: shadowRow.costUsd, turn: answerRow.id, at: "string",
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
  assert.deepEqual([held.digest, held.decided, held.audit.window, held.audit.disagree, held.audit.rows, held.audit.stopped], [DIGEST, "hold", 10, 3, 10, undefined], JSON.stringify(held));
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
  assert.deepEqual([promoted.digest, promoted.decided, promoted.check.attempt, promoted.check.n], [DIGEST_2, "promote", 2, 8], JSON.stringify(promoted.check));
  for (const one of held.audit.disagreements) assert.ok(promoted.check.of.includes(one.run), `the check ran on ${one.run}, a disagreeing input`);

  // It disagrees again, 3 times, within stop_window (100) served runs of the first hold: stopped, no compile, said.
  for (const [i, question] of wrongLater.entries()) await w.start(`served-${31 + i}`, question);
  const after = await w.start("run-40", "Question 40");
  assert.equal(after.metrics?.path, "agent", JSON.stringify(after.metrics));
  const stopped = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([stopped.digest, stopped.decided, stopped.audit.stopped, stopped.reason], [DIGEST_2, "hold", true, "stopped: the workflow disagreed with the agent twice"], JSON.stringify(stopped));
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
  assert.deepEqual([held.decided, held.audit.window, held.audit.disagree, held.audit.rows], ["hold", 5, 2, 2], JSON.stringify(held));
});

test("(r2) three shadows that end between two claims are written oldest first: hold_window 2 holds on the 2 newest", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { learning: { audit_every: 1, hold_window: 2, hold_disagree: 2 }, paused: true, submit: answers({ wrong: ["Batch 2", "Batch 3"] }) });
  // Made before the runner starts: a claim takes the oldest run first, so the three served runs are claimed before any of
  // their shadows is, and none of their claims settles a row. The next claim settles all three at once.
  for (const i of [1, 2, 3]) await w.create(`batch-${i}`, `Batch ${i}`);
  w.resume();
  for (const i of [1, 2, 3]) {
    assert.equal((await w.ended(`batch-${i}`)).metrics?.path, "workflow", `batch-${i} served`);
    await w.ended((await until(() => w.shadowOf(`batch-${i}`), `batch-${i}'s shadow`)).row.id);
  }
  assert.deepEqual(await w.audits(), [], "no claim settled a row yet");
  const next = await w.start("batch-next", "Batch next");
  assert.deepEqual((await w.audits()).map((row) => row.run), ["batch-1", "batch-2", "batch-3"], "the batch is appended oldest first");
  assert.equal(next.metrics?.path, "agent", "held: the 2 newest rows disagree");
  const held = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([held.decided, held.audit.rows], ["hold", 2], JSON.stringify(held));
  assert.deepEqual(held.audit.disagreements.map((one) => one.served).sort(), ["batch-2", "batch-3"]);
});

test("(r2) the hold is the ledger's: rows committed with 3 disagreements whose hold write failed hold the workflow at the next claim, which adds no row", { timeout: 300_000 }, async (t) => {
  const ids = Array.from({ length: 400 }, (_, i) => `c-${i}`);
  const wrong = ids.filter((id) => drawn(id, 5)).slice(0, 3);
  const quiet = ids.filter((id) => !drawn(id, 5)).slice(0, 2);
  const w = await world(t, { learning: { audit_every: 5 }, submit: answers({ wrong: wrong.map((id) => `Question for ${id}`) }) });
  // While `failing`, the hold's write to the promotion records fails: a crash between the ledger's commit and that write.
  let failing = false;
  for (const method of ["replaceIf", "putIfAbsent"]) {
    const real = w.store.settings[method].bind(w.store.settings);
    w.store.settings[method] = async (...args) => {
      if (failing && JSON.stringify(args).includes('"audit":{"window"')) throw new Error("the settings write failed");
      return real(...args);
    };
  }
  for (const id of wrong) assert.equal((await w.start(id, `Question for ${id}`)).metrics?.path, "workflow", `${id} served`);
  failing = true;
  // This claim commits the third disagreeing row; the hold it makes is never written.
  const lost = await w.start(quiet[0], `Question for ${quiet[0]}`);
  failing = false;
  assert.equal(lost.metrics?.path, "workflow", "still served: its hold was lost");
  const rows = await w.audits();
  assert.deepEqual(rows.filter((row) => row.agreed === false).map((row) => row.run).sort(), [...wrong].sort(), "the ledger holds the 3 disagreements");
  assert.equal((await promotionsOf(w.server.settings, "agent-1")).at(-1).decided, "promote", "no hold was recorded");
  // The next claim adds no row (quiet[0] was not drawn), and holds from the ledger alone.
  const next = await w.start(quiet[1], `Question for ${quiet[1]}`);
  assert.equal((await w.audits()).length, rows.length, "this claim added no row");
  assert.equal(next.metrics?.path, "agent", `held from the ledger: ${JSON.stringify(next.metrics)}`);
  const held = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([held.decided, held.audit.disagreements.length], ["hold", 3], JSON.stringify(held));
});

test("(r2) a run a trigger started (GitHub's) is never audited: drawn by its id, it starts no shadow, and is counted not auditable; a run over the API beside it is audited", { timeout: 240_000 }, async (t) => {
  const { notAuditableOf } = await import("../dist/runner/audit.js");
  const w = await world(t, { learning: { audit_every: 1 } });
  const trigger = { id: "trigger-gh", firing_key: "delivery-1" };
  const row = await w.start("gh-1", "What is six times seven", { trigger, inputOrigin: { kind: "trigger", trigger_id: trigger.id, source: "github", owner: false } });
  assert.deepEqual([row.state, row.metrics?.path, row.metrics?.not_auditable], ["ended", "workflow", true], JSON.stringify(row.metrics));
  assert.ok(drawn("gh-1", 1), "drawn at 1 in 1");
  assert.equal(await w.shadowOf("gh-1"), undefined, "no shadow: a triggered run is not auditable");
  const api = await w.start("api-1", "What is seven times six");
  assert.equal(api.metrics?.not_auditable, undefined);
  assert.ok(await w.shadowOf("api-1"), "a run over the API is audited");
  assert.equal(await notAuditableOf(w.server, "agent-1", "answer", DIGEST, { stop_window: 100 }), 1, "the read counts the triggered run");
});

// Review on #3061 r3 (PRRT_kwDOUmdVMs64P8Kc): a hold's disagreement texts are redacted whole, then cut (learn/secrets.ts
// excerptShown, the one rule a check's use too): cut first, a secret straddling CHECK_TEXT_MAX left its prefix, which no
// later redactor (the promotions read, the recompile prompt) matches.
test("(r3) a secret straddling char 1,200 of an audited input leaves no 8 characters of it in the ledger, the hold, the promotions read or the recompile prompt", { timeout: 300_000 }, async (t) => {
  const { CHECK_TEXT_MAX, promotionsShown } = await import("../dist/learn/promote.js");
  const { secretsShown } = await import("../dist/learning.js");
  const { readLearning } = await import("../dist/learn/folder.js");
  const secret = ["Zq81Trb", "N4wX7cV", "2mKp09L", "dHy5aEg", "3UfJxQ"].join("");
  // The input as the hold reads it is the launch's input in JSON: {"content":"<question>?","question":...}; the secret
  // starts 10 characters before the cut.
  const head = '{"content":"';
  const question = `Leaky ${"filler ".repeat(200)}`.slice(0, CHECK_TEXT_MAX - 10 - head.length) + secret + " and more words after it";
  const w = await world(t, { learning: { compile_after: 5, audit_every: 1, hold_window: 1, hold_disagree: 1 }, prior: 5, env: { AUDIT_TEST_TOKEN: secret }, submit: (text) => (text.includes("Leaky") ? WRONG : { answer: 42, sure: true }) });
  const served = await w.start("leak-1", question);
  assert.equal(served.metrics?.path, "workflow", JSON.stringify(served.metrics));
  const at = JSON.stringify(readLaunchBody((await w.server.runs.launch("leak-1")).body).input).indexOf(secret);
  assert.ok(at < CHECK_TEXT_MAX && at + secret.length > CHECK_TEXT_MAX, `the secret straddles the cut: at ${at}`);
  const next = await w.start("leak-next", "Question 99");
  assert.equal(next.metrics?.path, "agent", `held on the one disagreement: ${JSON.stringify(next.metrics)}`);
  const held = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([held.decided, held.audit.disagreements.length], ["hold", 1], JSON.stringify(held));
  assert.ok(held.audit.disagreements[0].input.includes("Leaky"), "the hold quotes the input");
  const [ask] = w.asks.get("leak-next");
  assert.ok(fenceOf(ask ?? "").includes("Leaky"), `the recompile ask quotes it: ${(ask ?? "").slice(0, 300)}`);
  const folder = learningWorkspace({ mode: "local", data: w.dir, agentId: "agent-1" });
  let ledger;
  try {
    ledger = await readLearning(folder.workspace, async (read) => (read.snapshot?.audits ? read.body(AUDITS_FILE, read.snapshot.audits.oid) : ""));
  } finally {
    await folder.end();
  }
  assert.ok(ledger.includes("leak-1"), ledger);
  const leaks = (text) => Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).filter((part) => text.includes(part));
  assert.deepEqual(leaks(ledger), [], "the ledger");
  assert.deepEqual(leaks(JSON.stringify(held)), [], "the hold record");
  assert.deepEqual(leaks(JSON.stringify(promotionsShown(await promotionsOf(w.server.settings, "agent-1"), secretsShown([secret])))), [], "the promotions read");
  assert.deepEqual(leaks(ask), [], "the recompile prompt");
});

// Review on #3061 r3 (PRRT_kwDOUmdVMs64P8Kg): the hold rule counts only the rows of the runs the digest's current
// promotion served (each row keeps the promotion it was drawn under), so an owner's replay that promotes a held digest
// again is never held, or stopped, by the rows it was held on.
test("(r3) an audit hold, then the owner's replay promotes it again: the next claim, with no new served runs, neither holds nor stops it", { timeout: 300_000 }, async (t) => {
  const { recordPromotion } = await import("../dist/learn/promote.js");
  const picked = Array.from({ length: 200 }, (_, i) => `o-${i}`).filter((id) => drawn(id, 5)).slice(0, 2);
  const quiet = Array.from({ length: 200 }, (_, i) => `o-${i}`).filter((id) => !drawn(id, 5)).slice(0, 2);
  const w = await world(t, { learning: { audit_every: 5, hold_window: 5, hold_disagree: 2 }, submit: answers({ wrong: picked.map((id) => `Question for ${id}`) }) });
  for (const id of picked) assert.equal((await w.start(id, `Question for ${id}`)).metrics?.path, "workflow");
  assert.equal((await w.start(quiet[0], `Question for ${quiet[0]}`)).metrics?.path, "agent", "held on its 2 disagreements");
  const records = await promotionsOf(w.server.settings, "agent-1");
  const held = records.at(-1);
  assert.deepEqual([held.decided, held.audit.stopped], ["hold", undefined], JSON.stringify(held));
  // The owner's replay of the held digest passes: the record runner/promotion.ts decideCheck writes (a check's promote).
  const promoted = { workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked on 5 of the agent's inputs: promoted", check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [], cost_usd: 0, outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 } }, commit: records[0].commit };
  assert.equal((await recordPromotion(w.server.settings, "agent-1", promoted, (was) => was?.at === held.at)).won, true);
  const next = await w.start(quiet[1], `Question for ${quiet[1]}`);
  assert.deepEqual([next.metrics?.path, next.metrics?.workflow_digest], ["workflow", DIGEST], `served again: ${JSON.stringify(next.metrics)}\n${w.logs.filter((line) => line.includes("workflow-first")).join("\n")}`);
  const after = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([after.decided, after.check?.n, after.audit], ["promote", 5, undefined], `no hold, no stop: ${JSON.stringify(after)}`);
});

// Review on #3061 r3 (PRRT_kwDOUmdVMs64P8Kj): an audit is found by the `started` row startAudit writes, never by a window
// of the agent's newest runs: a shadow that ends after 1,300 newer runs started still settles.
test("(r3) a shadow that ends after 1,300 newer runs of the agent started still settles into the ledger and holds", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { audit_every: 1, hold_window: 1, hold_disagree: 1 }, submit: (text) => (text.includes("Late question") ? WRONG : { answer: 42, sure: true }) });
  assert.equal((await w.start("late-1", "Late question")).metrics?.path, "workflow");
  assert.equal((await w.shadowOf("late-1")).row.state, "ended");
  // 1,300 runs of the agent started after it (imported: ended, never claimed), each newer than the shadow.
  const from = Date.now() + 1_000;
  for (let i = 0; i < 1_300; i++) {
    await w.server.importRun({ id: `newer-${i}`, agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "pi", session: `s-${i}` }, launch: { body: { input: { content: "hi" }, title: "t", place: { mode: "runner" } } }, startedAt: from + i, transcript: [] });
  }
  const next = await w.start("late-next", "Question next");
  const rows = await w.audits();
  assert.deepEqual(rows.map((row) => [row.run, row.agreed]), [["late-1", false]], JSON.stringify(rows));
  assert.equal(next.metrics?.path, "agent", `held on it: ${JSON.stringify(next.metrics)}`);
  const held = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([held.decided, held.audit.disagreements.map((one) => one.served)], ["hold", ["late-1"]], JSON.stringify(held));
});

/** A store of `served` runs the learned workflow `answer` served at `digest` and a shadow of each (newest first, as the
 *  store lists them), for runner/audit.ts startAudit alone: the agent's revision holds `learning`; `made` the runs created. */
function servedStore(served, learning, digest) {
  const rows = [];
  for (let i = 0; i < served; i++) {
    rows.push({ id: `s-${i}`, agentId: "agent-1", state: "ended", runner: null, archivedAt: null, importedFrom: null, outcome: "completed", startedAt: 2 * i, metrics: { path: "workflow", workflow: "answer", workflow_digest: digest } });
    rows.push({ id: `audit.s-${i}`, agentId: "agent-1", state: "ended", runner: null, archivedAt: null, importedFrom: null, outcome: "completed", startedAt: 2 * i + 1, metrics: { path: "audit" } });
  }
  rows.reverse();
  const made = [];
  const launches = new Map();
  const store = {
    settings: { get: async () => undefined },
    agents: { revision: async () => ({ id: "rev-1", body: { instructions: "Answer.", tools: [], learning }, mcpPin: null }) },
    runs: {
      list: async ({ state, archived, limit } = {}) => rows.filter((row) => (state === undefined || row.state === state) && (archived === undefined || (row.archivedAt !== null) === archived)).slice(0, limit ?? rows.length),
      get: async (id) => rows.find((row) => row.id === id),
      launch: async () => ({ body: {} }),
      create: async (row, launch) => {
        made.push(row.id);
        launches.set(row.id, launch?.body);
      },
    },
  };
  return { store, made, rows, launches };
}

test("(r2) the served count reads past the shadows: audit_every 1 over 1,100 served runs and their 1,100 shadows counts 1,100, so the rate switches to audit_every_later past audit_later_after", async (t) => {
  const { startAudit } = await import("../dist/runner/audit.js");
  const { lastRunsOf } = await import("../dist/learn/compile.js");
  const learning = { audit_every: 1, audit_every_later: 1000, audit_later_after: 1000 };
  const runId = Array.from({ length: 1000 }, (_, i) => `next-${i}`).find((id) => !drawn(id, 1000));
  const launch = { input: { content: "Next?" }, title: "Next", place: { mode: "runner" }, learning: startAt("0".repeat(40)) };
  const serve = { name: "answer", digest: DIGEST };
  // A drawn run's started line is written to the agent's learning folder before its shadow is made.
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-audit-count-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const claimOf = async (served) => {
    const { store, made } = servedStore(served, learning, DIGEST);
    await startAudit({ store, agentId: "agent-1", revisionId: "rev-1", context: {}, folder: () => learningWorkspace({ mode: "local", data: dir, agentId: "agent-1" }), shown: async () => ({ text: (text) => text }), log: () => {}, runId, launch }, serve);
    return { store, made };
  };
  // 900 served: under audit_later_after, every served run is drawn (1 in 1).
  assert.deepEqual((await claimOf(900)).made, [`audit.${runId}`]);
  // 1,100 served among 2,200 runs: all 1,100 are counted, so the rate is 1 in 1,000 and this id is not drawn.
  const { store, made } = await claimOf(1_100);
  assert.deepEqual(made, [], "past audit_later_after: 1 in 1,000, not drawn");
  const servedAt = (row) => row.metrics?.path === "workflow" && row.metrics.workflow_digest === DIGEST;
  assert.equal((await lastRunsOf(store, "agent-1", 2_000, servedAt)).length, 1_100, "the served count's read");
});

// Review on #3061 r4 (PRRT_kwDOUmdVMs64QkBm): the shadow's cap is what its served run's cap left, read at the served
// run's end, so the two never spend past it; less than a run's smallest cap left starts no shadow.
test("(r4) a shadow's cap is the served run's cap less what it spent: served cap $1.00, spent $0.30, the shadow's cap is $0.70", { timeout: 240_000 }, async (t) => {
  // Every request is booked at $0.30: the served run's workflow takes one (its node's call).
  const w = await world(t, { learning: { audit_every: 1 }, priced: () => 0.3 });
  const served = await w.start("capped-1", "What is six times seven", { max_cost_usd: 1 });
  assert.deepEqual([served.state, served.metrics?.path, served.costUsd], ["ended", "workflow", 0.3], JSON.stringify(served));
  const shadow = await w.shadowOf("capped-1");
  assert.ok(shadow, "drawn at 1 in 1: a shadow");
  assert.equal(readLaunchBody((await w.server.runs.launch(shadow.row.id)).body).maxCostUsd, 0.7, "the shadow's cap: $1.00 less the $0.30 spent");
  assert.equal(shadow.row.state, "ended", "its answer given within its cap");
  assert.ok(shadow.row.costUsd <= 0.7, `within its cap: ${shadow.row.costUsd}`);
});

test("(r4) a shadow that stops on its cap is `parked`: no verdict, never counted toward the hold (hold_window 1, hold_disagree 1), where an uncapped disagreement holds", { timeout: 300_000 }, async (t) => {
  // The workflow answers these wrong; the agent (and so each shadow) answers 42. Every request is booked at $0.30, and
  // admitted only when the cap holds its least first: its input and the least answer (1,024 output tokens at $15/M,
  // over $0.015) at the model's price.
  const w = await world(t, { learning: { audit_every: 1, hold_window: 1, hold_disagree: 1 }, priced: () => 0.3, submit: (text) => (text.includes("Wrong question") ? WRONG : { answer: 42, sure: true }) });
  // Its cap leaves $0.011 after the $0.30 it spent: a shadow is started (over a run's smallest cap, $0.01), and its first
  // request is refused at that cap.
  const served = await w.start("tight-1", "Wrong question one", { max_cost_usd: 0.311 });
  assert.deepEqual([served.state, served.metrics?.path, served.costUsd], ["ended", "workflow", 0.3], JSON.stringify(served));
  const shadow = (await w.shadowOf("tight-1")).row;
  const { AUDIT_PARKED } = await import("../dist/runner/audit.js");
  assert.equal(readLaunchBody((await w.server.runs.launch(shadow.id)).body).maxCostUsd, 0.011);
  assert.equal(shadow.state, "failed", `never parked for a raise: ${JSON.stringify(shadow)}`);
  assert.equal(shadow.summary, `${AUDIT_PARKED}: it would wait on a raise of its cap`);
  const next = await w.start("tight-next", "Question 99");
  assert.equal(next.metrics?.path, "workflow", `not held: ${JSON.stringify(next.metrics)}`);
  const row = (await w.audits()).find((one) => one.run === "tight-1");
  assert.deepEqual([row?.agreed, row?.parked, row?.shadow_run], [null, true, shadow.id], JSON.stringify(row));
  assert.equal((await promotionsOf(w.server.settings, "agent-1")).at(-1).decided, "promote", "a parked shadow neither holds nor counts");
  // The same disagreement with room for its shadow holds at once: the parked one was not counted, not merely agreed.
  await w.start("wide-1", "Wrong question two");
  const after = await w.start("wide-next", "Question 98");
  assert.equal(after.metrics?.path, "agent", `held on the uncapped disagreement: ${JSON.stringify(after.metrics)}`);
  const held = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([held.decided, held.audit.disagreements.map((one) => one.served)], ["hold", ["wide-1"]], JSON.stringify(held));
});

// learning.agree_on: the audit compares the served answer and its shadow's on the fields that say the decision, as the
// check does. The agent (so each shadow) answers as a real model does, prose then a fenced json block with a rationale
// the workflow's answer never repeats: no disagreement on agree_on (or the output schema's enum and boolean fields), a
// declared field that differs still holds.
const SHADOW_SAYS = `Six sevens.\n\n\`\`\`json\n${JSON.stringify({ answer: 42, sure: true, why: "six times seven is forty-two" })}\n\`\`\``;
for (const [named, extra, compared] of [
  ["learning.agree_on", { learning: { audit_every: 1, hold_window: 1, hold_disagree: 1, agree_on: ["answer", "sure"] } }, "on answer and sure"],
  ["the output schema's enum and boolean fields", { learning: { audit_every: 1, hold_window: 1, hold_disagree: 1 }, outputSchema: { type: "object", properties: { answer: { enum: [41, 42] }, sure: { type: "boolean" }, why: { type: "string" } } } }, "on the schema's fields"],
]) {
  test(`(agree_on) a served answer that differs from its shadow's only in its rationale is no disagreement, compared ${compared} (${named}); a declared field that differs holds`, { timeout: 300_000 }, async (t) => {
    const w = await world(t, { ...extra, says: () => SHADOW_SAYS, submit: (text) => (text.includes("Wrong question") ? WRONG : { answer: 42, sure: true }) });
    const served = await w.start("same-1", "What is six times seven");
    assert.equal(served.metrics?.path, "workflow", JSON.stringify(served.metrics));
    const next = await w.start("same-next", "What is seven times six");
    assert.equal(next.metrics?.path, "workflow", `not held: ${JSON.stringify(next.metrics)}`);
    const row = (await w.audits()).find((one) => one.run === "same-1");
    assert.equal(row?.agreed, true, JSON.stringify(row));
    assert.equal((await promotionsOf(w.server.settings, "agent-1")).at(-1).decided, "promote");
    await w.start("wrong-1", "Wrong question one");
    const after = await w.start("wrong-next", "Question 98");
    assert.equal(after.metrics?.path, "agent", `held on the declared field: ${JSON.stringify(after.metrics)}`);
    assert.equal((await w.audits()).find((one) => one.run === "wrong-1")?.agreed, false);
  });
}

// Review on #3061 r4 (PRRT_kwDOUmdVMs64SUUv): a shadow never waits on a person. Its agent only reads (web_fetch, a
// built-in the readOnlyHint rule reads as a read: learn/replay-calls.ts READ_TOOLS), and its owner set web_fetch to ask:
// the shadow's call is asked at the gate (never let through) and the shadow ends there at once, `parked`, the ask
// withdrawn in that end, so nothing waits on anyone, and the served run's all-in is known (its batch row closes).
test("(r5) an all-read agent whose owner set web_fetch to ask: the shadow ends parked at the ask, no approval pending anywhere, the served run's all-in known", { timeout: 300_000 }, async (t) => {
  const fetches = [];
  const w = await world(t, {
    learning: { audit_every: 1, hold_window: 1, hold_disagree: 1 },
    tools: ["web_fetch"],
    toolSettings: { web_fetch: { permission: "ask" } },
    // The agent's turn fetches a page first; the workflow's node only submits.
    call: (body) => (offers(body, "web_fetch") && !hasResult(body) && !anyCompileAsk(body) ? (fetches.push(1), { name: "web_fetch", input: { url: "http://audit.test/page" } }) : undefined),
  });
  const served = await w.start("asked-1", "What is six times seven");
  assert.deepEqual([served.state, served.metrics?.path], ["ended", "workflow"], JSON.stringify(served));
  const shadow = (await w.shadowOf("asked-1")).row;
  const { AUDIT_PARKED } = await import("../dist/runner/audit.js");
  assert.ok(fetches.length > 0, "the shadow called web_fetch");
  assert.deepEqual([shadow.state, shadow.summary], ["failed", `${AUDIT_PARKED}: it would wait on a person's approval of a tool call`], JSON.stringify(shadow));
  // Nothing waits on anyone: neither run reads input_required, and no approval is pending on either.
  for (const id of [shadow.id, "asked-1"]) {
    const view = await viewOverStore(w.server, id, { origin: "https://run.test", serverSecrets: () => [] });
    assert.deepEqual([view.status === "input_required", view.pending ?? null], [false, null], `${id}: ${JSON.stringify({ status: view.status, pending: view.pending })}`);
  }
  const rows = await runTimeline(w.server, shadow.id, BACKGROUND_CONTEXT, { settled: true });
  assert.ok(!rows.some((row) => /^Ran: web_fetch/.test(row.summary ?? "")), `the gate let nothing through: ${JSON.stringify(rows.map((row) => row.summary))}`);
  // The served run's all-in is known (the shadow's cost booked), so a batch's row on it closes (server.ts batch figures).
  assert.equal(typeof shadow.costUsd, "number", `the shadow's cost is booked: ${shadow.costUsd}`);
  assert.deepEqual(await shadowSpendOf(w.server, "asked-1"), { open: false, usd: shadow.costUsd });
  const allIn = await allInOf(w.server, await w.server.runs.get("asked-1"));
  assert.equal(typeof allIn.total_usd, "number", JSON.stringify(allIn));
  // Settled at the next claim: `parked`, no verdict, never counted (hold_disagree 1 would hold on one disagreement).
  const next = await w.start("asked-next", "Question 99");
  const row = (await w.audits()).find((one) => one.run === "asked-1");
  assert.deepEqual([row?.agreed, row?.parked, row?.shadow_run], [null, true, shadow.id], JSON.stringify(row));
  assert.equal(next.metrics?.path, "workflow", `not held: ${JSON.stringify(next.metrics)}`);
});

// Review on #3061 r4 (PRRT_kwDOUmdVMs64SUU0): an audit compares the shadow with the served run's answer when the audit
// began (its started line's `turn`), read from the run by that row's id: a follow-up's answer since is never the one
// compared, for the verdict or the hold's disagreement.
const lastUserText = (body) => textOf((body?.messages ?? []).findLast((message) => message.role === "user"));
test("(r5) the workflow answers 41, the owner follows up and the run answers 42, the shadow answers 42: a disagreement on 41", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { audit_every: 1, hold_window: 1, hold_disagree: 1 }, submit: (text) => (text.includes("Followed question") ? WRONG : { answer: 42, sure: true }) });
  const served = await w.start("follow-1", "Followed question");
  assert.equal(served.metrics?.path, "workflow", JSON.stringify(served.metrics));
  assert.equal((await w.shadowOf("follow-1")).row.state, "ended");
  const first = (await runTimeline(w.server, "follow-1", BACKGROUND_CONTEXT, { settled: true })).findLast((one) => one.kind === "final_answer");
  assert.deepEqual(JSON.parse(first.text), WRONG, `the workflow's answer: ${first.text}`);
  await w.server.runs.reopen("follow-1", { kind: "steer", body: { text: "Check that again." } });
  await w.ended("follow-1");
  const newest = (await runTimeline(w.server, "follow-1", BACKGROUND_CONTEXT, { settled: true })).findLast((one) => one.kind === "final_answer");
  assert.equal(newest.text, AGENT_SAYS, `the follow-up's answer is 42 now: ${newest.text}`);
  assert.notEqual(newest.id, first.id);
  const next = await w.start("follow-next", "Question 99");
  const row = (await w.audits()).find((one) => one.run === "follow-1");
  assert.deepEqual([row?.agreed, row?.turn], [false, first.id], `the audited answer is 41's: ${JSON.stringify(row)}`);
  assert.equal(next.metrics?.path, "agent", `held on the disagreement: ${JSON.stringify(next.metrics)}`);
  const held = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.deepEqual([held.decided, held.audit.disagreements.length], ["hold", 1], JSON.stringify(held));
  assert.deepEqual(JSON.parse(held.audit.disagreements[0].draft), WRONG, "the hold's disagreement shows 41, the answer audited");
  assert.equal(held.audit.disagreements[0].agent, AGENT_SAYS);
});

test("(r5) a follow-up asks something else and the run answers it: no false disagreement, the audit agrees on the answer it began with", { timeout: 300_000 }, async (t) => {
  const OTHER = JSON.stringify({ answer: 7, sure: true });
  const w = await world(t, { learning: { audit_every: 1, hold_window: 1, hold_disagree: 1 }, says: (body) => (lastUserText(body).includes("Something else") ? OTHER : undefined) });
  const served = await w.start("other-1", "What is six times seven");
  assert.equal(served.metrics?.path, "workflow", JSON.stringify(served.metrics));
  assert.equal((await w.shadowOf("other-1")).row.state, "ended");
  const first = (await runTimeline(w.server, "other-1", BACKGROUND_CONTEXT, { settled: true })).findLast((one) => one.kind === "final_answer");
  await w.server.runs.reopen("other-1", { kind: "steer", body: { text: "Something else: what is one plus six?" } });
  await w.ended("other-1");
  const newest = (await runTimeline(w.server, "other-1", BACKGROUND_CONTEXT, { settled: true })).findLast((one) => one.kind === "final_answer");
  assert.equal(newest.text, OTHER, `the follow-up's own answer: ${newest.text}`);
  const next = await w.start("other-next", "Question 99");
  const row = (await w.audits()).find((one) => one.run === "other-1");
  assert.deepEqual([row?.agreed, row?.turn], [true, first.id], JSON.stringify(row));
  assert.equal(next.metrics?.path, "workflow", `not held: ${JSON.stringify(next.metrics)}`);
});

test("(r4) a drawn run whose cap leaves under a run's smallest cap (or a spend not known) starts no shadow: its row says skipped \"no allowance\", no verdict", async (t) => {
  const { startAudit } = await import("../dist/runner/audit.js");
  const learning = { audit_every: 1 };
  const serve = { name: "answer", digest: DIGEST };
  const launch = { input: { content: "Next?" }, title: "Next", place: { mode: "runner" }, maxCostUsd: 1, learning: startAt("0".repeat(40)) };
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-audit-room-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = () => learningWorkspace({ mode: "local", data: dir, agentId: "agent-1" });
  const endOf = async (runId, room) => {
    const { store, made, launches } = servedStore(3, learning, DIGEST);
    await startAudit({ store, agentId: "agent-1", revisionId: "rev-1", context: {}, folder, shown: async () => ({ text: (text) => text }), log: () => {}, runId, launch, room: async () => room }, serve);
    return { made, launches };
  };
  const fits = await endOf("room-fits", 0.7);
  assert.deepEqual(fits.made, ["audit.room-fits"]);
  assert.equal(fits.launches.get("audit.room-fits").max_cost_usd, 0.7, "the room it was given, never the served launch's $1.00");
  for (const [runId, room] of [["room-short", 0.005], ["room-unknown", null]]) assert.deepEqual((await endOf(runId, room)).made, [], `${runId}: no shadow`);
  const f = folder();
  let rows;
  try {
    rows = await readAudits(f.workspace);
  } finally {
    await f.end();
  }
  assert.deepEqual(rows.map((row) => [row.run, row.shadow_run, row.agreed, row.skipped]), [["room-short", null, null, "no allowance"], ["room-unknown", null, null, "no allowance"]], JSON.stringify(rows));
  // Its end again (a follow-up's): the row stands, no second row and no shadow.
  assert.deepEqual((await endOf("room-short", 0.5)).made, [], "once per run");
  const again = folder();
  try {
    assert.equal((await readAudits(again.workspace)).filter((row) => row.run === "room-short").length, 1);
  } finally {
    await again.end();
  }
});

// Review on #3061 r4 (PRRT_kwDOUmdVMs64QkBr): A8's rule, null while unknown, never $0.
test("(r4) a served run's all-in is unknown while its shadow is queued or running, never $0; once the shadow ended it is served + shadow", async () => {
  const { allInOf, shadowSpendOf } = await import("../dist/store-reads/learning.js");
  const served = { id: "served-1", costUsd: 0.2 };
  const storeWith = (shadow) => ({ learning: { proposal: async () => undefined }, runs: { get: async (id) => (id === "audit.served-1" ? shadow : undefined) } });
  for (const state of ["queued", "running"]) {
    const store = storeWith({ id: "audit.served-1", state, costUsd: 0.1 });
    assert.deepEqual(await allInOf(store, served), { cost_usd: 0.2, learning_usd: null, total_usd: null }, `${state}: unknown, not the served part`);
    assert.deepEqual(await shadowSpendOf(store, "served-1"), { open: true, usd: null });
  }
  assert.deepEqual(await allInOf(storeWith({ id: "audit.served-1", state: "ended", costUsd: 0.25 }), served), { cost_usd: 0.2, learning_usd: 0.25, total_usd: 0.45 });
  assert.deepEqual(await allInOf(storeWith(undefined), served), { cost_usd: 0.2, learning_usd: 0, total_usd: 0.2 }, "never drawn: nothing beside it");
});
