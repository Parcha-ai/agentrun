// workflow-first through the runner's adapter loop (runner/workflow-first.ts): a pi run of an agent whose learned revision
// holds one active workflow that fits the run's input starts on that workflow, before any turn of the agent's model.
//   - answered: the model proxy records hold the workflow's node requests alone, each labelled learned_workflow; the
//     gateway never sees an agent request; the run's metrics say path "workflow", its learned revision and the
//     workflow; its cost is the booked node $; its learning reads nothing new at no cost.
//   - handed back (the workflow's escalate guard holds): the same run goes on to the agent, whose first input carries
//     the workflow's trace; the run ends on the agent's answer, path "handed_back", its cost the node's $ and the agent's;
//     it asks for no revision (one hand-back is one sample: a revision is asked only of a workflow its promotion holds),
//     and with no word from its owner it keeps nothing.
//   - workflow_first false, an input no workflow fits: the agent takes the run from its first turn, path "agent".
//   - learned_workflow set to ask: the run parks on the step before any node runs; approved, it runs.
//   - a stop while the step is asked: the claim that holds it ends the run stopped.
//   - the money rule: a workflow whose last 10 served runs cost more than the agent by hand, each side all-in (its own cost
//     and every learning round booked for it), stops running first and the agent takes the run, which asks for no
//     revision; under it, at a new digest, under 10 runs or with no by-hand baseline, it serves. A run whose all-in is
//     unknown (learning of unknown cost) is left out of the mean and counted, never read as 0.
// pi's model and the node's go through the session proxy to a loopback gateway; no sleeps, no port races. The same on a
// CLI harness (the faux one the harness table hands the runner): one loop serves every harness.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { checkedOf, landWorkflows, promoteChecked, startAt } from "./learned-workflow-seed-support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";
import { mergesOf, repoOf } from "./learn-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");
const { runTimeline, runEntries, runReflect } = await import("../dist/store-reads/journal.js");
const { said } = await import("../dist/learning-words.js");
const { agentCostOverStore, pastRunsOverStore } = await import("../dist/store-reads/learning.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { LEARNED_CLIP } = await import("../dist/learned-workflow.js");
const { COST_WINDOW, costLineOf, overLine, workflowCostsOf, fits, workflowDigest, workflowFirstOf, pathMetrics, servedOf, WORKFLOW_FIRST } = await import("../dist/runner/workflow-first.js");
const { resolveSchemaForWorkflow } = await import("@parcha/agentrun-dsl");
const { recordPromotion } = await import("../dist/learn/promote.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");
const { answerAsServed, answerJson, structuredAnswer } = await import("../dist/answer-json.js");
const { readSnapshot, textsAt } = await import("../dist/learn/folder.js");
const { askedForCompile } = await import("../dist/learn/compile.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const QUESTION = "What is six times seven";
const AGENT_SAYS = "The agent's own answer: 42.";

/** One extract node, then its guard: an `escalate` that hands the job back when the node is not sure. */
const answerFlow = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question; say whether you are sure.", out: "Answer", as: "answer" },
    { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "answer.sure", value: false }, kind: "unsure", stage: "answer", summary: "not sure of {answer.answer}" },
  ] },
};
const FLOWS = [{ name: "answer", description: "Answers a question as a number", workflow: answerFlow }];
/** The digest of FLOWS' workflow as its seed lays it (workflow.json, JSON.stringify of it). */
const DIGEST = workflowDigest({ workflow: JSON.stringify(answerFlow) });

const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
/** A request's text, every message's text blocks and the system prompt together. */
const textOf = (body) => [
  ...(Array.isArray(body?.system) ? body.system.map((block) => block?.text ?? "") : [String(body?.system ?? "")]),
  ...(body?.messages ?? []).flatMap((message) => (typeof message.content === "string" ? [message.content] : (message.content ?? []).map((block) => block?.text ?? (Array.isArray(block?.content) ? block.content.map((c) => c?.text ?? "").join("") : String(block?.content ?? ""))))),
].join("\n");
/** A node request: it offers the node's submit tool. Anything else is the agent's. */
const isNode = (request) => offers(request.body, "submit");

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A pi run of an agent that learned `answer`, on `input`; the node submits `{answer, sure}` (`sure` false hands back),
 *  or `submitted` when given; the agent, when asked, answers AGENT_SAYS. `toolSettings` on the revision; `approve`: answer the run's first ask ("stop":
 *  stop the run while it waits instead). `followUp`: once the run ends, a person's follow-up (a teacher's label on its
 *  answer) reopens it, and the run read is the follow-up's end; `first` is the row of the end before it. `maxCostUsd`:
 *  the run's cap; `settleOn`: the run states it is read at once its runner lets it go (a park for a raise is "parked").
 *  `crashInCall`: the first runner is lost while the workflow's node request is out (nothing more it writes lands), and a
 *  second runner takes the run. */
async function piRun(t, { input = { content: `${QUESTION}?`, question: QUESTION }, sure = true, learned = true, workflowFirst, toolSettings, approve = false, past = [], promotions, keptBefore: earlier = [], followUp, flows = FLOWS, saved = {}, answer, submitted, outputSchema, crashOnHandback = false, pastFromSecondClaim = false, agentCall, holdNode: givenHold, agentText, beforeRun, crashBeforeEnd, crashInCall = false, onCompileAsk, maxCostUsd, settleOn = ["ended", "failed", "stopped"] } = {}) {
  const holdNode = givenHold ?? (crashInCall ? async () => crash() : undefined);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-workflow-first-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  // `agentCall`: the agent's first answer is this tool call (its next, once a tool result is in, its text). `agentText`:
  // the agent's text for a request, by its body (undefined: AGENT_SAYS). `submitted` as a function: the record of the
  // n-th node submission (0 first), given that request's body.
  let submits = 0;
  const submit = (body) => (typeof submitted === "function" ? submitted(body, submits++) : submitted ?? { answer: answer ?? (sure ? 42 : 41), sure });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") ? (!hasResult(body) ? { name: "submit", input: { value: submit(body) } } : undefined) : agentCall && !hasResult(body) ? agentCall : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : (agentText?.(body) ?? AGENT_SAYS)),
  });
  let runner;
  let reader;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await reader?.close(ctx).catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], ...(learned ? { learning: true } : {}), ...(toolSettings ? { toolSettings } : {}), ...(outputSchema ? { outputSchema } : {}) } });
  const seed = learned ? await landWorkflows(dir, "agent-1", flows) : undefined;
  // `promotions`: the agent's promotion records before the run (learn/promote.ts), as its replays left them; none given,
  // each landed workflow as its check promoted it (no run of the agent's to check it on here, so it would stop unchecked).
  for (const record of promotions ?? (learned ? checkedOf(flows) : [])) await recordPromotion(server.settings, "agent-1", record, () => true);
  // `saved`: keys saved on the server after the learning landed (a value in a workflow that became a secret).
  for (const [name, value] of Object.entries(saved)) await putSealedKey(server, SEAL_KEY, name, value);
  // `beforeRun(dir)`: what changes on the agent's main after the run's seed was pinned, before the run starts.
  await beforeRun?.(dir);
  const launch = { input, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(learned ? { learning: startAt(seed) } : {}), ...(workflowFirst === false ? { workflowFirst: false } : {}), ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
  // `holdNode(held)`: the workflow's node request never answers (a workflow that blocks): it ends only when its request is
  // aborted, or when the test is over. `holdNode` is called once, as the first one is held, with `held` (`requests`: how
  // many node requests reached the upstream; `aborted`: how many of them were cut).
  const held = { requests: 0, aborted: 0, release: () => {} };
  const released = new Promise((resolve) => (held.release = resolve));
  t.after(() => held.release());
  // `onCompileAsk(dir)`: awaited as a compile turn's ask reaches the upstream, before it is answered (a change on main
  // after the compile read it).
  const asked = !onCompileAsk ? globalThis.fetch : async (url, init) => {
    let body;
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "");
    } catch {}
    if (body && !offers(body, "submit") && askedForCompile(lastOf(body)) !== false) await onCompileAsk(dir);
    return globalThis.fetch(url, init);
  };
  const upstream = !holdNode ? asked : async (url, init) => {
    const text = typeof init?.body === "string" ? init.body : url instanceof Request ? await url.clone().text() : "";
    let body;
    try {
      body = JSON.parse(text);
    } catch {}
    if (!offers(body, "submit")) return globalThis.fetch(url, init);
    held.requests += 1;
    if (held.requests === 1) void holdNode(held, server).catch((error) => (held.error = error));
    const signal = init?.signal ?? (url instanceof Request ? url.signal : undefined);
    return new Promise((_resolve, reject) => {
      const cut = () => {
        held.aborted += 1;
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal?.aborted) return cut();
      signal?.addEventListener("abort", cut, { once: true });
      void released.then(() => reject(new Error("the test is over")));
    });
  };
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: upstream };
  const logs = [];
  const crashingJournal = (journal, claim) => new Proxy(journal, { get: (target, key) => (key === "commit" ? async (...args) => {
    // `crashInCall`: the lost runner's writes never land.
    if (crashed && crashInCall && claim.runner === "runner-a") throw new Error("runner-a was lost");
    // `crashBeforeEnd`: the first runner is closed as its run's end is about to land, and that end never does (its commit
    // fails once the close has cut the claim, so the claim returns interrupted); `crashBeforeEnd(dir)` runs first, then a
    // second runner takes the run.
    if (!crashed && crashBeforeEnd && JSON.stringify(args[0]).includes('"agentrun.end"')) {
      await crashBeforeEnd(dir);
      crash();
      await new Promise((resolve) => setTimeout(resolve, 500));
      throw new Error("the runner died before its run's end landed");
    }
    const result = await target.commit(...args);
    if (!crashed && crashOnHandback && JSON.stringify(args[0]).includes("agentrun.workflow_first")) crash();
    return result;
  } : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  // `past`: earlier runs of the agent, newest first, as its store lists them (the money rule's read): laid before the
  // store's own rows, every other read the store's.
  // `pastFromSecondClaim`: the money rule reads them only once a first claim has built its spec (a claim after a crash).
  let claims = 0;
  const runsOf = { ...store.runs, list: async (filter) => [...(pastFromSecondClaim && claims < 1 ? [] : past), ...(await store.runs.list(filter))] };
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(store.runs) ?? {})) if (typeof store.runs[key] === "function" && key !== "list" && key !== "constructor") runsOf[key] = store.runs[key].bind(store.runs);
  // `keptBefore`: earlier runs' kept learning, newest first (learning_proposals), laid before the store's own the same way.
  const learningOf = {
    proposal: async (runId, round) => earlier.find((one) => one.runId === runId) ?? (await store.learning.proposal(runId, round)),
    proposals: async (agentId, options) => [...earlier.filter((one) => one.agentId === agentId), ...(await store.learning.proposals(agentId, options))],
    kept: async (agentId) => {
      const own = await store.learning.kept(agentId);
      return { ...own, proposals: [...earlier.filter((one) => one.agentId === agentId), ...own.proposals] };
    },
  };
  const depStore = past.length || earlier.length ? new Proxy(store, { get: (target, key) => (key === "runs" ? runsOf : key === "learning" ? new Proxy(target.learning, { get: (l, k) => (k in learningOf ? learningOf[k] : typeof l[k] === "function" ? l[k].bind(l) : l[k]) }) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) }) : store;
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store: depStore, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  // `approve: "stop-at-gate"`: the person's stop lands while the first claim is at the step's gate (the run's own gate,
  // asked before the ask is), so the claim that parks on the ask holds the stop. `claims`: the specs built, one per claim.
  const specOf = async (claim, run) => {
    const spec = await adapterRunSpecFromLaunch(launch, run, deps, claim);
    claims += 1;
    if (approve !== "stop-at-gate" || claims > 1) return spec;
    const gate = spec.gate;
    return { ...spec, gate: async (call) => {
      if (call.callId === "workflow-first") {
        await sendCommand(server, RUN, { kind: "stop" });
        await until(async () => (await server.runs.get(RUN)).state !== "running" || (await new Promise((resolve) => setTimeout(() => resolve(true), 300))), "the stop delivered", 5_000);
      }
      return gate ? gate(call) : undefined;
    } };
  };
  // `crashOnHandback`: the first runner is closed as the workflow's end reaches the record (its claim's signal aborts before
  // the handback goes to the agent, so that claim returns interrupted with the session still new); a second runner takes the
  // run, and the money rule (past runs, `pastFromSecondClaim`) now stops the workflow.
  let crashed = false;
  // The store the runners hold: its journals tell the crash when the workflow's end is committed.
  const runnerStore = crashOnHandback || crashBeforeEnd || crashInCall ? new Proxy(store, { get: (target, key) => (key === "journal" ? (claim) => crashingJournal(target.journal(claim), claim) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) }) : store;
  const crash = () => {
    crashed = true;
    void runner.close();
    runner = startRunner({ store: runnerStore, name: "runner-b", ...TIMING, createLoop: createAdapterLoop(specOf) });
  };
  runner = startRunner({ store: runnerStore, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const settled = (states) => until(async () => {
    const now = await server.runs.get(RUN);
    return states.includes(now.state) && now.runner === null && now;
  }, `the run ${states.join("/")}`);
  let parked;
  if (approve && approve !== "stop-at-gate") {
    parked = await settled(["parked", "ended", "failed", "stopped"]);
    const callId = await until(async () => {
      const row = await server.runs.get(RUN);
      const entries = (await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx)).entries;
      return entries.find((entry) => entry.kind === "agentrun.ask")?.data?.callId;
    }, "the step's ask", 10_000);
    parked = { ...parked, callId, requestsWhileParked: gw.requests.length };
    await sendCommand(server, RUN, approve === "stop" ? { kind: "stop" } : { kind: "approve", body: { approval: callId } });
  }
  let row = await settled(settleOn);
  const first = followUp === undefined ? undefined : row;
  if (first) {
    await server.runs.reopen(RUN, { kind: "steer", body: { text: followUp } });
    await server.flush?.();
    row = await until(async () => {
      const now = await server.runs.get(RUN);
      return (now.endedAt ?? 0) > (first.endedAt ?? 0) && ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
    }, "the follow-up's end");
  }
  reader = await Harness.open(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const sessions = journalSessions(reader, ctx, server);
  const all = [];
  for (const key of await sessions.keys()) for (const record of await sessions.read(key)) all.push(record);
  const requests = all.filter((record) => record.kind === "runner.request").map((record) => record.data);
  const turns = all.filter((record) => record.kind === "runner.turn").map((record) => record.data);
  const timeline = await runTimeline(server, RUN, ctx, { settled: true });
  const entries = await runEntries(server, RUN, ctx);
  const kept = await server.learning.proposal(RUN);
  const reflect = await runReflect(server, RUN, ctx);
  return { dir, row, first, requests, turns, timeline, entries, kept, reflect, gateway: gw, seed, parked, logs, claims, server, held };
}

test("workflow alone: the run answers on its learned workflow with no agent-model request, path workflow, its node $ its cost", async (t) => {
  const { row, requests, turns, timeline, entries, kept, reflect, gateway, seed } = await piRun(t);
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  // The model proxy records: the node's request alone, labelled learned_workflow; none of the agent's.
  assert.ok(requests.length >= 1, "the node made its request");
  assert.deepEqual(requests.filter((request) => request.host !== LEARNED_WORKFLOW_TOOL), [], `every request the proxy booked is the workflow's: ${JSON.stringify(requests)}`);
  assert.deepEqual(gateway.requests.filter((request) => !isNode(request)).map((request) => textOf(request.body).slice(0, 200)), [], "the gateway saw no agent request");
  // Its answer is the run's: the workflow's output, as the model's message.
  assert.ok(timeline.some((row) => ["assistant", "final_answer"].includes(row.kind) && /42/.test(row.text ?? "")), `the workflow's answer is the run's: ${JSON.stringify(timeline.map(({ kind, text }) => [kind, text]))}`);
  const { digest, ...served } = entries.findLast((entry) => entry.kind === WORKFLOW_FIRST)?.data ?? {};
  assert.deepEqual(served, { workflow: "answer", revision: seed, call: "workflow-first", outcome: "answered" });
  // The run record: the path, the revision, the workflow; the cost is what the session booked for the node.
  assert.equal(row.metrics?.path, "workflow", JSON.stringify(row.metrics));
  assert.equal(row.metrics?.learned_revision, seed);
  assert.equal(row.metrics?.workflow, "answer");
  assert.match(String(row.metrics?.workflow_digest), /^[0-9a-f]{16}$/);
  assert.equal(row.metrics.workflow_digest, digest, "the run record's digest is the served workflow's");
  const booked = turns.reduce((sum, turn) => sum + (typeof turn.usd === "number" ? turn.usd : 0), 0);
  assert.ok(booked > 0, `the node's request is priced: ${JSON.stringify(turns)}`);
  assert.ok(Math.abs((row.costUsd ?? 0) - booked) < 1e-9, `the run's cost is the node's booked $: ${row.costUsd} vs ${booked}`);
  // Its learning: no end-of-run turn, nothing new, at no cost (the clean-use count reads path "workflow").
  assert.equal(reflect, undefined, "no end-of-run turn was placed");
  assert.deepEqual({ state: kept?.proposal?.state, reason: kept?.proposal?.reason, detail: kept?.proposal?.detail, look_back_usd: kept?.proposal?.look_back_usd }, { state: "dropped", reason: "empty", detail: said.onlyWorkflow, look_back_usd: 0 }, JSON.stringify(kept?.proposal));
});

test("handed back: the guard holds, the same run goes on to the agent with the workflow's trace, and ends on the agent's answer", async (t) => {
  const { row, requests, timeline, entries, gateway, seed } = await piRun(t, { sure: false });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.deepEqual(entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"]);
  // The node ran first, then the agent: its first request carries the hand-back and the trace, then the job.
  const firstAgent = gateway.requests.findIndex((request) => !isNode(request));
  assert.ok(firstAgent > 0 && gateway.requests.slice(0, firstAgent).every(isNode), `the node's requests come first: ${gateway.requests.map(isNode)}`);
  const said = textOf(gateway.requests[firstAgent].body);
  assert.match(said, /Your learned workflow `answer` ran first on this job and handed it back to you/);
  assert.match(said, /handed the job back at its step "unsure": not sure of 41/);
  assert.match(said, /"sure":\s*false/);
  assert.match(said, new RegExp(QUESTION));
  // The agent finished it: its answer is the run's last word.
  const last = timeline.findLast((one) => ["assistant", "final_answer"].includes(one.kind));
  assert.equal(last?.text, AGENT_SAYS, JSON.stringify(timeline.map(({ kind, text }) => [kind, text])));
  // The run record: one run, path handed_back; its cost is the node's $ and the agent's together.
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  assert.equal(row.metrics?.learned_revision, seed);
  assert.equal(row.metrics?.workflow, "answer");
  assert.equal(row.metrics?.workflow_digest, DIGEST, "the digest is the workflow text's");
  assert.ok(requests.some((request) => request.host === LEARNED_WORKFLOW_TOOL) && requests.some((request) => request.host === undefined), `node and agent requests both booked: ${JSON.stringify(requests)}`);
  assert.ok((row.costUsd ?? 0) > 0, `the run's cost: ${row.costUsd}`);
});

// A workflow call a restart cut (its runner lost mid-call): the next claim ends the call interrupted and hands the job back,
// never running it again. The run's path is handed_back and the agent did its job, but the workflow handed nothing back
// itself: the summary counts it `cut`, never `back`. An escalate is the workflow's own hand-back: `back`.
test("a workflow call a restart cut is a hand-back the summary counts as `cut`, never `back`; an escalate is `back`", async (t) => {
  const cut = await piRun(t, { crashInCall: true });
  assert.equal(cut.row.state, "ended", `the run ended: ${JSON.stringify(cut.row)}`);
  // The lost runner wrote nothing past the call's start; the second runner's claim ended it.
  assert.equal(cut.claims, 2, "a second claim took the run");
  const end = cut.entries.find((entry) => entry.kind === "agentrun.call.end" && entry.data?.callId === "workflow-first");
  assert.equal(end?.data?.status, "interrupted", `the next claim ends the call interrupted: ${kindsOf(cut.entries)}`);
  assert.deepEqual(cut.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"]);
  assert.equal(cut.held.requests, 1, "the cut call never ran again");
  assert.deepEqual([cut.row.metrics?.path, cut.row.metrics?.workflow_cut], ["handed_back", true], JSON.stringify(cut.row.metrics));
  assert.deepEqual((await agentCostOverStore(cut.server, "agent-1")).summary.hand_backs, { ran: 1, back: 0, cut: 1 }, "cut by the restart, not handed back by the workflow");
  const escalated = await piRun(t, { sure: false });
  assert.deepEqual([escalated.row.metrics?.path, escalated.row.metrics?.workflow_cut], ["handed_back", undefined], JSON.stringify(escalated.row.metrics));
  assert.deepEqual((await agentCostOverStore(escalated.server, "agent-1")).summary.hand_backs, { ran: 1, back: 1, cut: 0 }, "the workflow's own escalate");
});

// The quote check is code (the DSL's quote_missing): an answer quoting text the run's page does not hold hands the job
// back to the agent, as any escalate does; the trace says how many quotes were checked and missed, never their text.
// The page is the run's own input here; on a compiled workflow it is what its call steps fetched.
const PAGE = "Acme Leather: hand-made wallets and belts, shipped worldwide. Our workshop has been in Lisbon since 1987.";
const citedFlow = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question", "page"], properties: { question: { type: "string" }, page: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "evidence"], properties: { answer: { type: "string" }, evidence: { type: "array", items: { type: "object", required: ["quote"], properties: { quote: { type: "string" } } } } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question from {page}, quoting it.", out: "Answer", as: "answer" },
    { node: "escalate", label: "quotes", when: { predicate: "quote_missing", path: "answer.evidence", field: "quote", pages: ["page"] }, kind: "quote_missing", stage: "answer", summary: "a quote of {answer.answer} is in no page" },
  ] },
};
const cited = (quote) => ({ input: { content: "Where is the workshop?", question: "Where is the workshop?", page: PAGE }, flows: [{ name: "answer", description: "Answers from a page, quoting it", workflow: citedFlow }], submitted: { answer: "Lisbon", evidence: [{ quote }] } });

test("a quote in no page: the workflow's quote_missing escalate hands the run back to the agent, whose answer ends it; a quote the page holds answers alone", async (t) => {
  const { row, entries, gateway, timeline } = await piRun(t, cited("Our workshop opened in Porto in 1990"));
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.deepEqual(entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"]);
  const firstAgent = gateway.requests.findIndex((request) => !isNode(request));
  assert.ok(firstAgent > 0, "the agent took the run after the node");
  assert.match(textOf(gateway.requests[firstAgent].body), /handed the job back at its step "quotes": a quote of Lisbon is in no page/);
  assert.equal(timeline.findLast((one) => ["assistant", "final_answer"].includes(one.kind))?.text, AGENT_SAYS);
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  const alone = await piRun(t, cited("has been in Lisbon since 1987"));
  assert.deepEqual(alone.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.equal(alone.row.metrics?.path, "workflow", JSON.stringify(alone.row.metrics));
});

// H5d's re-pick: a quote miss writes the answer once more (the same step, the draft in its state) before the escalate
// hands back. The answer step is the body of a loop of 2 until the same quote_missing check passes; the run's metrics
// keep each loop's exit (`loops`: its label, its passes, whether `until` held, and `repick` on the re-pick loop), so a
// re-pick is counted, and its request is the run's like any node's.
const QUOTES_MISSING = { predicate: "quote_missing", path: "answer.evidence", field: "quote", pages: ["page"] };
const repickFlow = { ...citedFlow, root: { node: "chain", steps: [
  { node: "loop", label: "repick", maxIters: 2, until: { predicate: "not", of: QUOTES_MISSING }, body: citedFlow.root.steps[0] },
  citedFlow.root.steps[1],
] } };
const MISSED = "Our workshop opened in Porto in 1990";
const FOUND = "has been in Lisbon since 1987";
/** The re-pick flow on the page: the n-th answer quotes `quotes[n]` (the last one past its end). */
const repicking = (...quotes) => ({ ...cited(quotes[0]), flows: [{ name: "answer", description: "Answers from a page, quoting it", workflow: repickFlow }], submitted: (_body, n) => ({ answer: "Lisbon", evidence: [{ quote: quotes[Math.min(n, quotes.length - 1)] }] }) });
const submits = (gateway) => gateway.requests.filter((request) => isNode(request) && !hasResult(request.body));

test("a quote miss re-picks once: the re-pick's found quote answers alone, one more node request, its $ in the run's cost and the loop's two passes in its metrics; a second miss hands back after exactly one re-pick; a quote found first runs no re-pick", async (t) => {
  const kept = await piRun(t, repicking(MISSED, FOUND));
  assert.equal(kept.row.state, "ended", JSON.stringify(kept.row));
  assert.deepEqual(kept.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.equal(kept.row.metrics?.path, "workflow", JSON.stringify(kept.row.metrics));
  const [draft, again, ...more] = submits(kept.gateway);
  assert.ok(draft && again && !more.length, `two answers, the draft and its re-pick: ${submits(kept.gateway).length}`);
  assert.ok(textOf(again.body).includes(MISSED) && !textOf(draft.body).includes(MISSED), "the re-pick reads the failed draft in its state");
  assert.deepEqual(kept.gateway.requests.filter((request) => !isNode(request)), [], "no agent request");
  assert.ok(kept.timeline.some((row) => ["assistant", "final_answer"].includes(row.kind) && (row.text ?? "").includes(FOUND)), "the re-pick's answer is the run's");
  assert.deepEqual(kept.row.metrics?.loops, [{ node: "repick", iterations: 2, met: true, repick: true, workflow: "answer" }]);
  const booked = kept.turns.reduce((sum, turn) => sum + (typeof turn.usd === "number" ? turn.usd : 0), 0);
  assert.ok(Math.abs((kept.row.costUsd ?? 0) - booked) < 1e-9 && kept.requests.filter((request) => request.host === LEARNED_WORKFLOW_TOOL).length === 2, `the run's cost is both node requests' booked $: ${kept.row.costUsd} vs ${booked}`);

  const back = await piRun(t, repicking(MISSED, "Our second workshop is in Faro"));
  assert.deepEqual(back.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"]);
  assert.equal(back.row.metrics?.path, "handed_back", JSON.stringify(back.row.metrics));
  const firstAgent = back.gateway.requests.findIndex((request) => !isNode(request));
  assert.equal(submits({ requests: back.gateway.requests.slice(0, firstAgent) }).length, 2, "the draft and one re-pick, never a third");
  assert.match(textOf(back.gateway.requests[firstAgent].body), /handed the job back at its step "quotes"/);
  assert.deepEqual(back.row.metrics?.loops, [{ node: "repick", iterations: 2, met: false, repick: true, workflow: "answer" }]);

  const first = await piRun(t, repicking(FOUND));
  assert.deepEqual(first.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.equal(submits(first.gateway).length, 1, "found first: no re-pick");
  assert.deepEqual(first.row.metrics?.loops, [{ node: "repick", iterations: 1, met: true, repick: true, workflow: "answer" }]);
});

// A composed workflow writing the answer re-picks in its child: the DSL labels the child's loop exit `cite/repick`
// (scopeDepsToChild), and that exit is the run's re-pick, read on the run (store-reads/learning.ts pathViewOf).
const composedRepickFlow = { ...citedFlow, root: { node: "chain", steps: [
  { node: "workflow", label: "cite", input: { question: "{question}", page: "{page}" }, out: "Answer", as: "answer", workflow: repickFlow },
] } };

test("a composed workflow's re-pick is the run's: its child's loop exit, labelled as the DSL labels it, reads found on the run", async (t) => {
  const run = await piRun(t, { ...repicking(MISSED, FOUND), flows: [{ name: "answer", description: "Answers from a page, quoting it", workflow: composedRepickFlow }] });
  assert.deepEqual(run.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"], JSON.stringify(run.row.metrics));
  assert.equal(submits(run.gateway).length, 2, "the draft and its re-pick");
  assert.deepEqual(run.row.metrics?.loops, [{ node: "cite/repick", iterations: 2, met: true, repick: true, workflow: "answer" }]);
  assert.equal((await viewOverStore(run.server, RUN, { origin: "", serverSecrets: () => [] }))?.workflow?.repick, "found");
});

// The compact re-pick (learn/compile.ts's worked example, compactStateProblems): a fast extract copies the facts from
// the page, and the answer step reads only those facts and its own draft through its state map, the draft as
// "{answer?}": null on the first pass (no missing_interpolation before any draft exists), the failed draft on the second.
// Neither answer request carries the page.
const ANSWER_FROM_FACTS = "Answer the question from the facts, quoting them; a draft that is not null failed the quote check.";
const compactRepickFlow = {
  ...citedFlow,
  schemas: { ...citedFlow.schemas, Facts: { type: "object", required: ["lines"], properties: { lines: { type: "array", items: { type: "string" } } } } },
  root: { node: "chain", steps: [
    { node: "extract", label: "facts", instructions: "Copy the page's lines about the workshop, exactly.", state: { page: "{page}" }, out: "Facts", as: "facts", tier: "fast" },
    { node: "loop", label: "repick", maxIters: 2, until: { predicate: "not", of: QUOTES_MISSING }, body: { node: "decide", label: "answer", instructions: ANSWER_FROM_FACTS, state: { question: "{question}", facts: "{facts}", draft: "{answer?}" }, out: "Answer", as: "answer" } },
    citedFlow.root.steps[1],
  ] },
};

test("the compact re-pick: the answer reads the fast extract's facts and its draft as {answer?}, null on the first pass and the failed draft on the second, and never the page", async (t) => {
  const quotes = [MISSED, FOUND];
  let answers = 0;
  const submitted = (body) => (textOf(body).includes(ANSWER_FROM_FACTS) ? { answer: "Lisbon", evidence: [{ quote: quotes[Math.min(answers++, 1)] }] } : { lines: [FOUND] });
  const run = await piRun(t, { ...cited(MISSED), flows: [{ name: "answer", description: "Answers from a page, quoting it", workflow: compactRepickFlow }], submitted });
  assert.equal(run.row.state, "ended", JSON.stringify(run.row));
  assert.deepEqual(run.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"], "the first pass ran: its absent draft read as null");
  assert.equal(run.row.metrics?.path, "workflow", JSON.stringify(run.row.metrics));
  assert.deepEqual(run.row.metrics?.loops, [{ node: "repick", iterations: 2, met: true, repick: true, workflow: "answer" }]);
  const [facts, ...rest] = submits(run.gateway);
  assert.ok(textOf(facts.body).includes("hand-made wallets"), "the fast extract reads the page");
  const [draft, again, ...more] = rest.filter((request) => textOf(request.body).includes(ANSWER_FROM_FACTS));
  assert.ok(draft && again && !more.length, `two answers, the draft and its re-pick: ${rest.length}`);
  assert.match(textOf(draft.body), /"draft":null/, "the first pass reads a null draft");
  assert.ok(!textOf(draft.body).includes(MISSED), "no draft yet on the first pass");
  assert.ok(textOf(again.body).includes(MISSED), "the re-pick reads its failed draft");
  for (const answer of [draft, again]) {
    assert.ok(textOf(answer.body).includes(FOUND), "it reads the facts");
    assert.ok(!textOf(answer.body).includes("hand-made wallets"), "never the page");
  }
  assert.deepEqual(run.gateway.requests.filter((request) => !isNode(request)), [], "no agent request");
});

// learning.repick (learn/repick.ts), the owner's: the compiled answer's re-pick loop rewritten so its second pass reads
// the run's fetched pages. Pass 1 is the answer step as compiled, reading its question and draft and never the page;
// pass 2, only after a quote miss, its clone reading the page too, told the page is untrusted data, offered no tool but
// its submit, its state cut to the owner's cap (the quote check after it still reads the whole page), each request held
// to the run's one cap at its worst case.
const repickPages = await import("../dist/learn/repick.js");
const { repickSiteOf } = await import("../dist/learn/check.js");
const ANSWER_FROM_QUESTION = "Answer the question, quoting the page; a draft that is not null failed the quote check.";
const questionRepickFlow = { ...citedFlow, root: { node: "chain", steps: [
  { node: "loop", label: "repick", maxIters: 2, until: { predicate: "not", of: QUOTES_MISSING }, body: { node: "decide", label: "answer", instructions: ANSWER_FROM_QUESTION, state: { question: "{question}", draft: "{answer?}" }, out: "Answer", as: "answer" } },
  citedFlow.root.steps[1],
] } };
/** The same flow composed, as composedRepickFlow composes repickFlow. */
const composedQuestionFlow = { ...composedRepickFlow, root: { node: "chain", steps: [{ ...composedRepickFlow.root.steps[0], workflow: questionRepickFlow }] } };
/** The flow as a compile commits it with learning.repick on, its clone capped at `maxChars`. */
const pagesFlow = (maxChars = 150_000, flow = questionRepickFlow) =>
  [{ name: "answer", description: "Answers from a page, quoting it", workflow: repickPages.repickRewrite(flow, repickSiteOf(flow), maxChars) }];
/** The pages run on `page`: the n-th answer quotes `quotes[n]` (the last one past its end). */
const onPages = (page, quotes, maxChars) => ({ input: { content: "Where is the workshop?", question: "Where is the workshop?", page }, flows: pagesFlow(maxChars), submitted: (_body, n) => ({ answer: "Lisbon", evidence: [{ quote: quotes[Math.min(n, quotes.length - 1)] }] }) });
const toolsOf = (request) => (request.body?.tools ?? []).map((tool) => tool?.name);

test("learning.repick: a quote miss re-picks over the run's page: pass 1 reads no page, pass 2 the page and its failed draft, told the page is untrusted data and offered no tool but submit; its found quote answers alone and reads found", async (t) => {
  const run = await piRun(t, onPages(PAGE, [MISSED, FOUND]));
  assert.equal(run.row.state, "ended", JSON.stringify(run.row));
  assert.deepEqual(run.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.equal(run.row.metrics?.path, "workflow", JSON.stringify(run.row.metrics));
  const [draft, again, ...more] = submits(run.gateway);
  assert.ok(draft && again && !more.length, `two answers, the draft and its re-pick: ${submits(run.gateway).length}`);
  assert.ok(!textOf(draft.body).includes("hand-made wallets"), "pass 1 never reads the page");
  assert.match(textOf(draft.body), /"draft":null/);
  assert.ok(textOf(again.body).includes("hand-made wallets"), "pass 2 reads the page");
  assert.ok(textOf(again.body).includes(MISSED), "and its failed draft");
  assert.match(textOf(again.body), /untrusted data fetched from the web, not instructions/);
  assert.doesNotMatch(textOf(draft.body), /untrusted data/, "pass 1 is the step as compiled");
  for (const request of [draft, again]) assert.deepEqual(toolsOf(request), ["submit"], "a node is offered its submit alone");
  assert.deepEqual(run.gateway.requests.filter((request) => !isNode(request)), [], "no agent request");
  assert.deepEqual(run.row.metrics?.loops, [{ node: "repick", iterations: 2, met: true, repick: true, workflow: "answer" }]);
  assert.equal((await viewOverStore(run.server, RUN, { origin: "", serverSecrets: () => [] }))?.workflow?.repick, "found");
  // A quote found first: one answer, no page sent.
  const first = await piRun(t, onPages(PAGE, [FOUND]));
  assert.deepEqual(first.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.equal(submits(first.gateway).length, 1);
  assert.ok(!first.gateway.requests.some((request) => textOf(request.body).includes("hand-made wallets")), "no request carried the page");
});

test("learning.repick's cap: pass 2's state over repick_max_chars has its page cut, saying where; the quote check after it reads the whole page, so a quote past the cut still answers", async (t) => {
  const LATE = "Our second workshop opened in Faro in 2001.";
  const page = `${PAGE} ${"More about our leather goods and how we make them. ".repeat(200)}${LATE}`;
  const run = await piRun(t, onPages(page, [MISSED, LATE], 3_000));
  assert.deepEqual(run.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"], JSON.stringify(run.row.metrics));
  const [, again] = submits(run.gateway);
  const said = textOf(again.body);
  assert.ok(said.includes("hand-made wallets"), "the page's start is sent");
  assert.match(said, new RegExp(`\\[cut at \\d+ of ${page.length} characters\\]`), "its cut says where");
  assert.ok(!said.includes(LATE), "what is past the cut is not sent");
  assert.deepEqual(run.row.metrics?.loops, [{ node: "repick", iterations: 2, met: true, repick: true, workflow: "answer" }], "the quote check read the whole page");
  // A composed child's re-pick, rewritten in the child: its clone, which the run labels "cite/answer_pages", is cut the same.
  const composed = await piRun(t, { ...onPages(page, [MISSED, LATE], 3_000), flows: pagesFlow(3_000, composedQuestionFlow) });
  assert.deepEqual(composed.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"], JSON.stringify(composed.row.metrics));
  const [, childAgain] = submits(composed.gateway);
  assert.match(textOf(childAgain.body), /untrusted data fetched from the web, not instructions/);
  assert.match(textOf(childAgain.body), new RegExp(`\\[cut at \\d+ of ${page.length} characters\\]`), "the child's clone is cut at the owner's cap");
  assert.ok(!textOf(childAgain.body).includes(LATE));
  assert.deepEqual(composed.row.metrics?.loops, [{ node: "cite/repick", iterations: 2, met: true, repick: true, workflow: "answer" }]);
  // A cap its state cannot fit with every string cut: pass 2 is refused unsent, never sent past the owner's cap.
  const tiny = await piRun(t, onPages(page, [MISSED, LATE], 10));
  assert.notDeepEqual(tiny.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.ok(!tiny.gateway.requests.some((request) => /untrusted data fetched from the web/.test(textOf(request.body))), "pass 2 reached no request");
});

test("learning.repick's marker key is the host's: an input holding repick_next is refused before any node runs", async (t) => {
  const { input, ...rest } = onPages(PAGE, [MISSED, FOUND]);
  const run = await piRun(t, { ...rest, input: { ...input, repick_next: { taken: "pages" } } });
  assert.notDeepEqual(run.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.ok(!run.gateway.requests.some((request) => /untrusted data fetched from the web/.test(textOf(request.body))), "the input picked no pass");
  assert.ok(!run.gateway.requests.some((request) => isNode(request) && textOf(request.body).includes("hand-made wallets")), "no node read the page");
});

// f4: the run's one cap holds each node request at its worst case (its whole input uncached, one token a byte, and its
// output clamped to fit: run-adapters kernel/cap/rule.ts), pass 2's as any. A cap pass 1 fits and pass 2's page does not
// refuses pass 2 unsent and parks the run for a raise, its spend within the cap; a cap it fits sends it.
test("learning.repick under the run's cap: pass 2's page request is held at its worst case: refused unsent when it does not fit, the run parked within its cap; sent when it fits", async (t) => {
  const page = `${PAGE} ${"More about our leather goods and how we make them. ".repeat(2_000)}`;
  const CAP = 0.1;
  const parked = await piRun(t, { ...onPages(page, [MISSED, FOUND]), maxCostUsd: CAP, settleOn: ["parked", "ended", "failed", "stopped"] });
  assert.equal(parked.row.state, "parked", JSON.stringify(parked.row));
  assert.equal(submits(parked.gateway).length, 1, "pass 1 went; pass 2 was refused unsent");
  assert.ok(!parked.gateway.requests.some((request) => textOf(request.body).includes("More about our leather goods")), "the page reached no request");
  assert.ok((parked.row.costUsd ?? 0) <= CAP, `within its cap: ${parked.row.costUsd}`);
  const sent = await piRun(t, { ...onPages(page, [MISSED, FOUND]), maxCostUsd: 2 });
  assert.equal(sent.row.state, "ended", JSON.stringify(sent.row));
  assert.equal(submits(sent.gateway).length, 2, "pass 2 went");
  assert.ok(textOf(submits(sent.gateway)[1].body).includes("More about our leather goods"));
  assert.ok((sent.row.costUsd ?? 0) <= 2, `within its cap: ${sent.row.costUsd}`);
});

/** A request's last message, trimmed: an end-of-run turn's is its prompt. */
const lastOf = (body) => textOf({ messages: (body?.messages ?? []).slice(-1) }).trim();
/** The agent's requests that are a compile turn's (a new workflow or a revision), by their last message. */
const compileAsked = (gateway) => gateway.requests.filter((request) => !isNode(request) && askedForCompile(lastOf(request.body)) !== false);

// Fable review 11-16 §1: one hand-back is one sample. The run asks no compile (the workflow's revision is asked only of a
// hold), and, with no word from its owner, nothing more: the agent's job is all it pays for.
test("handed back: the run asks no compile; its learning is dropped with nothing new, at $0 asked", async (t) => {
  const { row, gateway, kept } = await piRun(t, { sure: false });
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  assert.deepEqual(compileAsked(gateway).map((request) => lastOf(request.body).slice(0, 120)), [], "no compile turn: a hand-back asks no revision");
  assert.deepEqual({ state: kept?.proposal?.state, reason: kept?.proposal?.reason, detail: kept?.proposal?.detail, look_back_usd: kept?.proposal?.look_back_usd, turn: kept?.turn }, { state: "dropped", reason: "empty", detail: said.empty, look_back_usd: 0, turn: null }, JSON.stringify(kept));
});

// #2648 review (Paid revisions cannot merge): the compile turn revises a workflow from main's text as it reads it, so
// that read is the revised workflow's conflict base, not the seed the run started from. A run started at S with `answer`;
// main then changed `answer` (another run's revision); `answer` is held, so the agent takes the run and its compile turn
// revises main's text: the run's own commit merges the revision. A change to `answer` on main after the compile read is
// still a conflict, never written over.
const MAINS_INSTRUCTIONS = "Answer the question as a whole number; say whether you are sure.";
const REVISED_INSTRUCTIONS = "Answer the question as a whole number, checking the product twice; say whether you are sure.";
const answerWith = (instructions) => ({ ...answerFlow, root: { ...answerFlow.root, steps: [{ ...answerFlow.root.steps[0], instructions }, answerFlow.root.steps[1]] } });
/** Merges `answer` with `instructions` on agent-1's main under `data`, as another run's revision lands. */
async function answerOnMain(data, instructions, runId) {
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const merged = await learningCommit(folder.workspace, { runId, reason: "revised", files: [{ path: "workflows/answer/workflow.json", text: JSON.stringify(answerWith(instructions)) }] });
    assert.equal(merged.ok, true, JSON.stringify(merged));
    return merged.main;
  } finally {
    await folder.end();
  }
}
/** Agent-1's main under `data` now, and `paths`' texts on it. */
async function mainOf(data, paths) {
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const main = (await readSnapshot(folder.workspace)).main;
    return { main, texts: await textsAt(folder.workspace, main, paths) };
  } finally {
    await folder.end();
  }
}
const revisedBlock = `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number\nexample: {"question":"What is six times seven?"}\n---\n${JSON.stringify(answerWith(REVISED_INSTRUCTIONS))}\n\`\`\`\``;
/** `answer`'s hold at the digest of `flow` (its replay held it): the only thing that asks for its revision. */
const holdAt = (flow) => ({ workflow: "answer", digest: workflowDigest({ workflow: JSON.stringify(flow) }), at: new Date().toISOString(), decided: "hold", reason: "20 graded runs it served were right 70.0% of the time" });

test("a held workflow's compile revises main's text of it, changed since the run's seed: the revision merges; a change on main after that read is still a conflict (#2648 review)", { timeout: 120_000 }, async (t) => {
  const json = "workflows/answer/workflow.json";
  for (const raced of [false, true]) {
    let changed;
    let racer;
    const { dir, seed, kept, gateway } = await piRun(t, {
      // The seed's revision and main's are both held: the agent takes the run, and main's is the one revised.
      promotions: [holdAt(answerFlow), holdAt(answerWith(MAINS_INSTRUCTIONS))],
      beforeRun: async (data) => (changed = await answerOnMain(data, MAINS_INSTRUCTIONS, "run-other")),
      // `raced`: another change to `answer` lands on main after the compile read it, before its answer is checked.
      ...(raced ? { onCompileAsk: async (data) => (racer ??= await answerOnMain(data, "Answer the question; say whether you are sure, then stop.", "run-racer")) } : {}),
      agentText: (body) => (/^One more turn: revise your learned workflow `answer`\./m.test(textOf({ messages: (body?.messages ?? []).slice(-1) })) ? revisedBlock : undefined),
    });
    assert.notEqual(changed, seed, "main moved past the run's seed");
    const ask = gateway.requests.find((request) => !isNode(request) && /One more turn: revise your learned workflow `answer`/.test(textOf(request.body)));
    assert.ok(ask, "the compile turn asked for the revision");
    assert.ok(textOf(ask.body).includes(MAINS_INSTRUCTIONS), "it revises main's text, not the seed's");
    const now = await mainOf(dir, [json]);
    if (raced) {
      assert.deepEqual([kept?.proposal?.state, kept?.proposal?.reason], ["dropped", "checker"], `a change after the compile read is refused: ${JSON.stringify(kept?.proposal)}`);
      assert.ok((kept.proposal.problems ?? []).some((problem) => problem.path === json), JSON.stringify(kept.proposal.problems));
      assert.equal(now.main, racer, "main keeps the racing change");
    } else {
      assert.equal(kept?.proposal?.state, "merged", `the revision of main's text merges: ${JSON.stringify(kept?.proposal)}`);
      assert.deepEqual(kept.proposal.workflows, [{ file: json, name: "answer" }]);
      assert.equal(kept.proposal.merged, now.main, "the run's own commit is main");
      assert.ok(now.texts[json].includes(REVISED_INSTRUCTIONS), now.texts[json]);
    }
  }
});

// #2648 review (Restart overwrites newer workflow changes): the commit of main the compile turn read its workflow at is
// kept with its ask, so a restart that replays the saved answer reads that commit, never main again. A run of held
// `answer` revises it at main A, commits it, and dies before its end lands; another run's revision of `answer` lands
// (main B); the next claim replays the saved answer and never writes it over B: the run's one merge stays its only one.
// B's revision is held too, so the claim after the crash, reading main B, still asks the revision (only a hold asks one).
test("a restart after the compile answer is saved replays it against the main it was asked at: a change to the workflow since conflicts, never overwritten (#2648 review)", { timeout: 120_000 }, async (t) => {
  const OTHERS = "Answer the question as a whole number, then say whether you are sure.";
  let moved;
  const { dir, seed, kept, gateway, claims, row } = await piRun(t, {
    promotions: [holdAt(answerFlow), holdAt(answerWith(OTHERS))],
    crashBeforeEnd: async (data) => (moved = await answerOnMain(data, OTHERS, "run-other")),
    agentText: (body) => (/^One more turn: revise your learned workflow `answer`\./m.test(textOf({ messages: (body?.messages ?? []).slice(-1) })) ? revisedBlock : undefined),
  });
  // A claim after the crash ended the run. How many claims the restart took races its timing (3, not 2, in a merge-queue
  // run), so only "past the first" is asserted; the asks below pin that the saved compile answer was replayed, not re-asked.
  assert.ok(claims >= 2, `a claim after the crash ended the run: ${claims} claims`);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(moved && moved !== seed, "main moved past the compile read before the restart");
  const asks = gateway.requests.filter((request) => !isNode(request) && /One more turn: revise your learned workflow `answer`/.test(textOf({ messages: (request.body?.messages ?? []).slice(-1) })));
  assert.equal(asks.length, 1, "the restart replays the saved compile answer, never asks it again");
  assert.ok(!textOf(asks[0].body).includes(OTHERS), "it was asked of main's text before the other run's change");
  assert.ok(kept?.proposal, "the run's learning was kept");
  const json = "workflows/answer/workflow.json";
  const now = await mainOf(dir, [json]);
  assert.equal(now.main, moved, `main keeps the other run's change: ${JSON.stringify(kept.proposal)}`);
  assert.ok(now.texts[json].includes(OTHERS), "the other run's text is main's, never overwritten");
  assert.equal(mergesOf(repoOf(dir, "agent-1"), RUN).length, 1, "the run merged once, before its crash; the restart merged nothing more");
});

test("a learned workflow named as only a workflow may be (sort_invoice): held, the end-of-run turn still asks for its revision", async (t) => {
  // And through a run: held, its end-of-run turn is placed and asks for it by that name.
  const { gateway, kept } = await piRun(t, { flows: [{ ...FLOWS[0], name: "sort_invoice" }], promotions: [{ ...holdAt(answerFlow), workflow: "sort_invoice" }] });
  const ask = gateway.requests.find((request) => !isNode(request) && /One more turn: revise your learned workflow `sort_invoice`\./.test(textOf(request.body)));
  assert.ok(ask, `the compile turn asked about \`sort_invoice\`: ${gateway.requests.map((request) => textOf(request.body).slice(-300)).join("\n---\n")}`);
  assert.ok(kept?.proposal, "the run's learning was kept");
});

// A teacher's label sent after the run (a follow-up) is the owner's word learning keeps: on a run its learned workflow
// served and on one it handed back, the follow-up's end is a round of its own (learning_proposals keyed by run and
// round), kept beside the first round's, never dropped as a repeat of it: the label is one line of corrections.md,
// committed by the run, with no turn asked for it. A run the workflow answered alone, then the agent answered a
// follow-up on, did not finish on the workflow alone: handed_back.
const LABEL = "Label: the reference answer is 42; keep the workflow's answer as it is.";
const roundsOf = async (server) => [await server.learning.proposal(RUN, 1), await server.learning.proposal(RUN, 2)];
/** Round 2 kept the label as its correction, committed by the run, with no turn asked and nothing spent asking. */
async function labelKept(dir, two) {
  assert.equal(two?.round, 2, `the label's round is kept: ${JSON.stringify(two)}`);
  assert.deepEqual([two.turn, two.proposal?.state, two.proposal?.corrections, two.proposal?.look_back_usd], [null, "merged", 1, 0], JSON.stringify(two));
  const { main, texts } = await mainOf(dir, ["corrections.md"]);
  assert.equal(two.proposal.merged, main, "the run's own commit is main");
  assert.ok(texts["corrections.md"].includes(LABEL), texts["corrections.md"]);
}

test("follow-up on a workflow-served run: the label is kept as round 2's correction, beside round 1's drop, and the path turns handed_back", async (t) => {
  const { dir, row, first, gateway, server } = await piRun(t, { followUp: LABEL });
  assert.equal(first.metrics?.path, "workflow", JSON.stringify(first.metrics));
  assert.equal(row.state, "ended", JSON.stringify(row));
  const [one, two] = await roundsOf(server);
  assert.deepEqual([one?.round, one?.proposal?.state, one?.proposal?.reason, one?.turn], [1, "dropped", "empty", null], `round 1 stands: ${JSON.stringify(one)}`);
  await labelKept(dir, two);
  // The agent's first turn is the follow-up's: the job, what the workflow answered, then the label it is a word on.
  const firstAgent = gateway.requests.find((request) => !isNode(request));
  assert.match(textOf(firstAgent.body), new RegExp(`${QUESTION}[\\s\\S]*Your learned workflow \`answer\` ran first on this job and answered it\\. Its answer:[\\s\\S]*42[\\s\\S]*${LABEL.slice(0, 20)}`), textOf(firstAgent.body));
  assert.equal(row.metrics?.path, "handed_back", `the agent answered the follow-up: ${JSON.stringify(row.metrics)}`);
  assert.equal(row.metrics?.workflow, "answer");
});

test("follow-up on a handed-back run: round 1, no feedback, keeps nothing; the label is kept as round 2's correction beside it", async (t) => {
  const { dir, row, first, server } = await piRun(t, { sure: false, followUp: LABEL });
  assert.equal(first.metrics?.path, "handed_back", JSON.stringify(first.metrics));
  assert.equal(row.state, "ended", JSON.stringify(row));
  const [one, two] = await roundsOf(server);
  assert.equal(one?.round, 1);
  assert.deepEqual([one.turn, one.proposal?.state, one.proposal?.detail, one.proposal?.look_back_usd], [null, "dropped", said.empty, 0], `round 1 kept nothing: ${JSON.stringify(one)}`);
  await labelKept(dir, two);
  assert.equal(row.metrics?.path, "handed_back");
});

test("workflow_first false: the agent takes the run from its first turn, path agent", async (t) => {
  const { row, entries, gateway, logs } = await piRun(t, { workflowFirst: false });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(entries.some((entry) => entry.kind === WORKFLOW_FIRST), false);
  assert.equal(isNode(gateway.requests[0]), false, "the first request is the agent's");
  assert.equal(row.metrics?.path, "agent");
  assert.equal(row.metrics?.workflow, undefined);
  assert.ok(logs.some((line) => /workflow_first: false/.test(line)), JSON.stringify(logs));
});

// S1: an agent run of a workflow job (learning: true) keeps only its owner's feedback: with none, no request of its own
// and $0 asked; a follow-up after it is feedback, kept as that round's correction with no request either.
test("an agent run of a workflow job with no feedback asks nothing and spends $0; a follow-up is kept as its round's correction, still asking nothing", async (t) => {
  const quiet = await piRun(t, { workflowFirst: false });
  assert.equal(quiet.row.metrics?.path, "agent", JSON.stringify(quiet.row.metrics));
  assert.deepEqual(compileAsked(quiet.gateway), [], "no compile due");
  assert.deepEqual([quiet.kept?.turn, quiet.kept?.proposal?.state, quiet.kept?.proposal?.detail, quiet.kept?.proposal?.look_back_usd], [null, "dropped", said.empty, 0], JSON.stringify(quiet.kept));

  const heard = await piRun(t, { workflowFirst: false, followUp: LABEL });
  const [one, two] = await roundsOf(heard.server);
  assert.deepEqual([one?.turn, one?.proposal?.look_back_usd], [null, 0], `round 1, before the follow-up, asked nothing: ${JSON.stringify(one)}`);
  assert.deepEqual(compileAsked(heard.gateway), [], "no compile due on the follow-up's round either");
  await labelKept(heard.dir, two);
});

test("an input no learned workflow fits: the agent takes the run, path agent, with nothing logged", async (t) => {
  const { row, entries, gateway, logs } = await piRun(t, { input: { content: `${QUESTION}?` } });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(entries.some((entry) => entry.kind === WORKFLOW_FIRST), false);
  assert.equal(isNode(gateway.requests[0]), false, "the first request is the agent's");
  assert.equal(row.metrics?.path, "agent");
  assert.deepEqual(logs.filter((line) => line.startsWith("workflow-first:")), [], "none fitting is the common case: no line");
});

test("learned_workflow set to ask: the step parks before any node runs; approved, the workflow answers alone", async (t) => {
  const { row, parked, gateway, requests } = await piRun(t, { toolSettings: { [LEARNED_WORKFLOW_TOOL]: { permission: "ask" } }, approve: true });
  assert.equal(parked.state, "parked", `the run parked on the ask: ${JSON.stringify(parked)}`);
  assert.equal(parked.callId, "workflow-first", "the ask is the step's call");
  assert.equal(parked.requestsWhileParked, 0, "no model request before the approval");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.metrics?.path, "workflow", JSON.stringify(row.metrics));
  assert.ok(gateway.requests.every(isNode), "approved, it ran the workflow alone");
  assert.ok(requests.every((request) => request.host === LEARNED_WORKFLOW_TOOL));
});

test("learned_workflow set to ask: a stop while the step waits ends the run stopped, the workflow never run", async (t) => {
  const { row, parked, gateway } = await piRun(t, { toolSettings: { [LEARNED_WORKFLOW_TOOL]: { permission: "ask" } }, approve: "stop" });
  assert.equal(parked.state, "parked", `the run parked on the ask: ${JSON.stringify(parked)}`);
  assert.equal(row.state, "stopped", `the stop is taken, not parked again: ${JSON.stringify(row)}`);
  assert.equal(gateway.requests.length, 0, "no model request: the workflow never ran, the agent never asked");
});

test("learned_workflow set to ask: a stop that lands while the step is asked is taken by that claim, never parked on", async (t) => {
  const { row, gateway, claims } = await piRun(t, { toolSettings: { [LEARNED_WORKFLOW_TOOL]: { permission: "ask" } }, approve: "stop-at-gate" });
  assert.equal(row.state, "stopped", `the run ends stopped: ${JSON.stringify(row)}`);
  assert.equal(claims, 1, "the claim that held the stop took it; the run was never given back parked with its stop untaken");
  assert.equal(gateway.requests.length, 0, "the workflow never ran, the agent never asked");
});

/** Waits until the runner has handed the rows written so far on (commandPollMs is 30 ms): a row it holds back stays held. */
const handedOn = () => new Promise((resolve) => setTimeout(resolve, 300));
/** The command rows of the run, by kind. */
const rowsOf = async (server) => Object.fromEntries((await server.commands(RUN, 0)).map((one) => [one.kind, one]));

/** The run's journal kinds with their call ids and states, for a failure's message. */
const kindsOf = (entries) => JSON.stringify(entries.map(({ kind, data }) => [kind, data?.callId ?? data?.state, data?.status]));

test("a message while the workflow runs first never holds a later stop: the workflow is cut and the run ends stopped, then the message is its next turn", async (t) => {
  const MESSAGE = "Also show your work.";
  const { row, gateway, held, entries, server } = await piRun(t, {
    holdNode: async (_held, server) => {
      await sendCommand(server, RUN, { kind: "steer", body: { text: MESSAGE } });
      await handedOn();
      await sendCommand(server, RUN, { kind: "stop" });
    },
  });
  assert.equal(held.error, undefined, String(held.error?.stack ?? held.error));
  // The stop reached the running workflow: its call ends interrupted and the run's first end is the stop's.
  const callEnd = entries.find((entry) => entry.kind === "agentrun.call.end" && entry.data?.callId === "workflow-first");
  assert.equal(callEnd?.data?.status, "interrupted", `the workflow's call ends interrupted: ${kindsOf(entries)}`);
  const firstEnd = entries.find((entry) => entry.kind === "agentrun.end");
  assert.equal(firstEnd?.data?.state, "stopped", `the run's first end is the person's stop: ${kindsOf(entries)}`);
  assert.equal(held.requests, 1, "the workflow spent nothing more after its stop: its one node request, no other");
  assert.ok(!entries.some((entry) => entry.kind === WORKFLOW_FIRST), "the workflow never answered nor handed back");
  // A message waiting at a person's stop is the run's next turn (store run-patch.ts refuseLeftovers, as main's stop leaves a
  // message submitted before it to run): the agent takes the job with it, the cut workflow never run again.
  const rows = await rowsOf(server);
  assert.ok(rows.stop.takenAt !== null && rows.stop.refused === null, `the stop is taken by the stop's end: ${JSON.stringify(rows.stop)}`);
  assert.ok(rows.steer.takenAt !== null && rows.steer.refused === null, `the message is taken by its turn: ${JSON.stringify(rows.steer)}`);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(gateway.requests.length > 0 && gateway.requests.every((request) => !isNode(request)), "the agent's requests alone after the stop");
  assert.match(textOf(gateway.requests[0].body), new RegExp(`${QUESTION}[\\s\\S]*${MESSAGE}`), "the agent's first input: the job, then the message");
});

test("a message while the workflow runs first never holds a later cancel: the workflow is cut, the run ends cancelled, nothing more spent", async (t) => {
  const { row, gateway, held, entries, server } = await piRun(t, {
    holdNode: async (_held, server) => {
      await sendCommand(server, RUN, { kind: "steer", body: { text: "Also show your work." } });
      await handedOn();
      await sendCommand(server, RUN, { kind: "cancel" });
    },
  });
  assert.equal(held.error, undefined, String(held.error?.stack ?? held.error));
  assert.deepEqual({ state: row.state, outcome: row.outcome }, { state: "stopped", outcome: "cancelled" }, JSON.stringify(row));
  const callEnd = entries.find((entry) => entry.kind === "agentrun.call.end" && entry.data?.callId === "workflow-first");
  assert.equal(callEnd?.data?.status, "interrupted", `the workflow's call ends interrupted: ${kindsOf(entries)}`);
  assert.equal(held.requests, 1, "nothing more spent: the workflow's one node request, no other");
  assert.equal(gateway.requests.length, 0, "the agent never asked");
  const rows = await rowsOf(server);
  assert.ok(rows.cancel.takenAt !== null && rows.cancel.refused === null, `the cancel is taken by the run's end: ${JSON.stringify(rows.cancel)}`);
  assert.ok(rows.steer.refused, `a cancel refuses the message waiting at it: ${JSON.stringify(rows.steer)}`);
});

test("a message while the workflow runs first never holds a later raise or browser hand-back: each reaches the run while it runs", async (t) => {
  let whileRunning;
  const { row, held } = await piRun(t, {
    holdNode: async (theHeld, server) => {
      await sendCommand(server, RUN, { kind: "steer", body: { text: "Also show your work." } });
      await handedOn();
      await sendCommand(server, RUN, { kind: "raise", body: { capUsd: 5 } });
      await sendCommand(server, RUN, { kind: "browser_hand_back", body: { ask: "no-such-ask", outcome: "done" } });
      // Each answered (this run has no cap and no hand-over: both refused in words) while the workflow still runs.
      whileRunning = await until(async () => {
        const rows = await rowsOf(server);
        return rows.raise?.refused && rows.browser_hand_back?.refused && rows;
      }, "the raise and the hand-back answered", 5_000).catch((error) => ({ error: error.message }));
      whileRunning = { ...whileRunning, aborted: theHeld.aborted, state: (await server.runs.get(RUN)).state };
      await sendCommand(server, RUN, { kind: "cancel" });
    },
  });
  assert.equal(held.error, undefined, String(held.error?.stack ?? held.error));
  assert.equal(whileRunning?.error, undefined, `the raise and the hand-back reached the run behind the message: ${JSON.stringify(whileRunning)}`);
  assert.deepEqual({ state: whileRunning.state, aborted: whileRunning.aborted }, { state: "running", aborted: 0 }, "answered while the workflow still ran");
  assert.match(whileRunning.raise.refused, /no cap to raise/);
  assert.equal(held.requests, 1);
  assert.deepEqual({ state: row.state, outcome: row.outcome }, { state: "stopped", outcome: "cancelled" }, JSON.stringify(row));
});

/** Earlier runs of the agent, newest first, as the store lists them: `served` runs of FLOWS' workflow at `digest` (path
 *  handed_back), each at `servedUsd`, then `byHand` runs on the agent's path, each at `byHandUsd`. */
const pastRuns = ({ served = COST_WINDOW, servedUsd = 0.5, byHand = 3, byHandUsd = 0.2, digest = DIGEST } = {}) => {
  const at = Date.UTC(2026, 10, 12);
  const row = (i, metrics, costUsd) => ({ id: `past-${i}`, agentId: "agent-1", revisionId: "rev-1", state: "ended", startedAt: at - i * 60_000, endedAt: at - i * 60_000 + 1_000, costUsd, costAtMostUsd: null, metrics, importedFrom: null, archivedAt: null, disk: null, epoch: 1, runner: null });
  return [
    ...Array.from({ length: served }, (_, i) => row(i, { path: "handed_back", workflow: "answer", workflow_digest: digest, learned_revision: "s" }, servedUsd)),
    ...Array.from({ length: byHand }, (_, i) => row(served + i, { path: "agent", learned_revision: "s" }, byHandUsd)),
  ];
};

test("money rule: a workflow whose last 10 served runs cost more than the agent by hand stops running first, and the run asks no compile", async (t) => {
  const { row, gateway, entries, logs } = await piRun(t, { past: pastRuns({ servedUsd: 0.5, byHandUsd: 0.2 }) });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.metrics?.path, "agent", `the agent took the run: ${JSON.stringify(row.metrics)}`);
  assert.equal(gateway.requests.filter(isNode).length, 0, "the workflow never ran");
  const revise = entries.findLast((entry) => entry.kind === WORKFLOW_FIRST)?.data;
  assert.deepEqual(revise, { workflow: "answer", digest: DIGEST, revision: revise?.revision, outcome: "needs_revision", served_usd: 0.5, by_hand_usd: 0.2, runs: COST_WINDOW }, "the run's journal keeps why, with the two numbers");
  assert.ok(logs.some((line) => /answer cost \$0\.5 a run over its last 10 served runs, at or over \$0\.2 by hand/.test(line)), JSON.stringify(logs));
  // The stop is a stop: it asks no compile (Fable review 11-16 §5 step 1).
  assert.deepEqual(compileAsked(gateway).map((request) => lastOf(request.body).slice(0, 120)), [], "the money rule's stop asks no compile");
});

// A workflow its replay held (runner/promotion.ts): the agent takes the run, and its end-of-run compile turn asks for the
// workflow's revision with the replay's numbers; a hold of another digest (an older revision) asks for none.
test("held by its check: the agent takes the run, and the compile turn asks for a revision with the check's numbers; an older revision's hold asks nothing", async (t) => {
  const at = new Date().toISOString();
  const check = { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 20, agreed: 13, alone: 20, of: [], cost_usd: 0.4, outcomes: { answered: 20, handed_back: 0, failed: 0, skipped_write: 0 } };
  const held = { workflow: "answer", digest: DIGEST, at, decided: "hold", reason: "checked on 20 of the agent's inputs: held", check };
  const { row, gateway, logs } = await piRun(t, { promotions: [held] });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.metrics?.path, "agent", `the agent took the run: ${JSON.stringify(row.metrics)}`);
  assert.equal(gateway.requests.filter(isNode).length, 0, "the held workflow never ran");
  assert.ok(logs.some((line) => /answer at [0-9a-f]{16} is held/.test(line)), JSON.stringify(logs));
  const ask = gateway.requests.find((request) => /One more turn: revise your learned workflow `answer`\.\nYour learned workflow `answer` does not run first: checked on 20 inputs of your last 20 completed runs, it answered 20 alone/.test(textOf(request.body)));
  assert.ok(ask, `the compile turn asked for a revision with the replay's numbers: ${gateway.requests.map((request) => textOf(request.body)).filter((text) => text.includes("One more turn")).map((text) => text.slice(text.lastIndexOf("One more turn"), text.lastIndexOf("One more turn") + 600)).join("\n---\n")}`);
  assert.match(textOf(ask.body), /`answer` as it is now:/);
  assert.doesNotMatch(textOf(ask.body), /answer `No change\.`/);
  // Exactly one revise: the hold's own compile turn.
  assert.equal(compileAsked(gateway).filter((request) => askedForCompile(lastOf(request.body)) === true).length, 1, "the hold asks one revise");
  // A hold of an older revision: main's is a new digest, decided on its own (here its check promoted it), and nothing
  // asks for a revision.
  const older = await piRun(t, { promotions: [{ ...held, digest: "fedcba9876543210" }, ...checkedOf(FLOWS)] });
  assert.equal(older.row.metrics?.path, "workflow", JSON.stringify(older.row.metrics));
  assert.ok(!older.gateway.requests.some((request) => /One more turn: revise your learned workflow/.test(textOf(request.body))), "an older revision's hold asks nothing");
});

// #2641 review (class C): once per hold. A run since the hold that compiled the held workflow asked already, whatever
// came of it (its draft failed its checks, or its commit was refused), however many runs ago; one before the hold did not.
test("held: a compile of it since the hold, past the last 4 runs, asks no revision again; one from before the hold does", async (t) => {
  const at = new Date().toISOString();
  const check = { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 20, agreed: 13, alone: 20, of: [], cost_usd: 0.4, outcomes: { answered: 20, handed_back: 0, failed: 0, skipped_write: 0 } };
  const held = { workflow: "answer", digest: DIGEST, at, decided: "hold", reason: "checked on 20 of the agent's inputs: held", check };
  const past = pastRuns({ served: 0, byHand: 6 });
  const compiledAt = (createdAt) => [{ runId: "past-5", agentId: "agent-1", turn: null, createdAt, proposal: { state: "dropped", reason: "checker", detail: "d", compiled: { workflow: "answer", attempts: [{ ok: false, errors: ["workflow: no root"] }] }, draft_errors: ["workflow: no root"] } }];
  const asksRevision = (gateway) => gateway.requests.some((request) => /One more turn: revise your learned workflow `answer`/.test(textOf(request.body)));
  const since = await piRun(t, { promotions: [held], past, keptBefore: compiledAt(Date.parse(at) + 1) });
  assert.equal(since.row.metrics?.path, "agent", JSON.stringify(since.row.metrics));
  assert.ok(!asksRevision(since.gateway), "asked once already, 6 runs ago: never again for this hold");
  const before = await piRun(t, { promotions: [held], past, keptBefore: compiledAt(Date.parse(at) - 60_000) });
  assert.ok(asksRevision(before.gateway), "a compile before the hold was not this hold's ask");
});

// #3390 review: a connected agent's hold on give-backs spends no recompile, so its revise whose draft failed its checks
// at the held attempt (recordDraftFailed: not stopped) is asked once more. The failed compile's own kept learning lands
// after its record (the run ends after its compile turn) and is not the once-more ask; another run's compile since is.
// Its revise comes at a first compile's cadence: the hold is older than the agent's last 19 runs by hand, so the ending
// run is the 20th since it (compile_after).
test("held on give-backs: a revise whose draft failed at the held attempt is asked once more, once", async (t) => {
  const at = Date.UTC(2026, 10, 12) - 60 * 60_000;
  // A failed draft's record is keyed by the run that compiled it (recordDraftFailed).
  const { draftFailedDigest } = await import("../dist/runner/learning-end.js");
  const bar = { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 0, agreed: 0, alone: 0, of: [] };
  const held = { workflow: "answer", digest: DIGEST, at: new Date(at).toISOString(), decided: "hold", via: "sdk", reason: "the connected agent gave back 5 reserved native turns in a row", check: { ...bar, released: 5 } };
  const failed = { workflow: "answer", digest: draftFailedDigest("past-5"), at: new Date(at + 1_000).toISOString(), decided: "hold", reason: "its draft failed its checks: workflow: no root. It is not promoted; the next due run compiles it once more", check: bar };
  // Completed runs by hand, as the store lists them (outcome null: compile_after counts them, learn/compile.ts agentRun).
  const byHand = (n) => pastRuns({ served: 0, byHand: n }).map((row) => ({ ...row, outcome: null }));
  const past = byHand(19);
  const compiledBy = (runId, createdAt) => ({ runId, agentId: "agent-1", turn: null, createdAt, proposal: { state: "dropped", reason: "checker", detail: "d", compiled: { workflow: "answer", attempts: [{ ok: false, errors: ["workflow: no root"] }] }, draft_errors: ["workflow: no root"] } });
  const asksRevision = (gateway) => gateway.requests.some((request) => /One more turn: revise your learned workflow `answer`/.test(textOf(request.body)));
  const early = await piRun(t, { promotions: [held, failed], past: byHand(18), keptBefore: [compiledBy("past-5", at + 2_000)] });
  assert.ok(!asksRevision(early.gateway), "19 runs since the hold, the ending one counted: not yet");
  const again = await piRun(t, { promotions: [held, failed], past, keptBefore: [compiledBy("past-5", at + 2_000)] });
  assert.ok(asksRevision(again.gateway), "the failed revise's own learning, kept after its record, is not the once-more ask");
  const asked = await piRun(t, { promotions: [held, failed], past, keptBefore: [compiledBy("past-4", at + 3_000), compiledBy("past-5", at + 2_000)] });
  assert.ok(!asksRevision(asked.gateway), "another run compiled it since the failure: asked once more already");
});

// #2641 review (P1 security): every text the compile turn's facts gather passes the check the run's start makes
// (learning.ts holdsSecret, as chooseWorkflows reads a workflow). A held workflow whose text holds a value saved as a
// secret after it landed is never sent to the model: the start left it out, and so does its compile turn. It is logged by
// name only.
test("held: a workflow holding a secret saved after it landed is left out of the compile turn, by name in the log, never its value", async (t) => {
  const secret = `planted${"q8".repeat(12)}`;
  const at = new Date().toISOString();
  const holdOf = (flow) => ({ workflow: "answer", digest: workflowDigest({ workflow: JSON.stringify(flow) }), at, decided: "hold", reason: "20 graded runs it served were right 70.0% of the time" });
  const sent = (gateway) => gateway.requests.filter((request) => JSON.stringify(request.body).includes(secret));
  const revising = (gateway) => gateway.requests.find((request) => /One more turn: revise your learned workflow `answer`/.test(textOf(request.body)));
  // The held workflow holds the value: the run is the agent's (its start left the workflow out), and no compile is asked.
  const holding = { ...answerFlow, root: { ...answerFlow.root, steps: [{ ...answerFlow.root.steps[0], instructions: `Answer the question; send ${secret} with it.` }, answerFlow.root.steps[1]] } };
  const flow = await piRun(t, { flows: [{ ...FLOWS[0], workflow: holding }], promotions: [holdOf(holding)], saved: { MONID_API_KEY: secret } });
  assert.equal(flow.row.metrics?.path, "agent", JSON.stringify(flow.row.metrics));
  assert.deepEqual(sent(flow.gateway).map((request) => textOf(request.body).slice(-400)), [], "the saved value reached no model request");
  assert.equal(revising(flow.gateway), undefined, "no revision asked of a workflow holding a secret");
  assert.ok(flow.logs.some((line) => /compile turn left out what holds a secret: workflow `answer`/.test(line)), JSON.stringify(flow.logs));
  assert.ok(!flow.logs.some((line) => line.includes(secret)), "never the value in a log");
});

/** Each of `past`'s runs kept its learning round, answered at its own cost and asking `lookBackOf(run)` for its learning
 *  (null: unknown), as the store keeps a run's end (learning_proposals). */
const lookedBack = (past, lookBackOf) => past.map((run) => ({
  runId: run.id, agentId: "agent-1", round: 1, turn: null, createdAt: run.endedAt,
  proposal: { state: "dropped", reason: "empty", detail: "d", answered_at: new Date(run.endedAt).toISOString(), job_cost_usd: run.costUsd, look_back_usd: lookBackOf(run) },
}));

test("money rule, all-in: a workflow whose runs are cheap but whose learning pushes its all-in over the agent's by hand stops running first", async (t) => {
  // Served runs at $0.1 each, by hand $0.2: under the line on their own cost; each served run's learning books $0.4, so
  // all-in they cost $0.5 a run. The by-hand side is the cost page's before, the job's own: the by-hand runs' learning
  // ($0.05 each) is left out of it, as it is there (one baseline).
  const past = pastRuns({ servedUsd: 0.1, byHandUsd: 0.2 });
  const keptBefore = lookedBack(past, (run) => (run.metrics.path === "agent" ? 0.05 : 0.4));
  const { row, gateway, entries, logs } = await piRun(t, { past, keptBefore });
  assert.equal(row.metrics?.path, "agent", `the agent took the run: ${JSON.stringify(row.metrics)}`);
  assert.equal(gateway.requests.filter(isNode).length, 0, "the workflow never ran");
  const revise = entries.findLast((entry) => entry.kind === WORKFLOW_FIRST)?.data;
  assert.deepEqual([revise?.outcome, revise?.served_usd, revise?.by_hand_usd, revise?.runs], ["needs_revision", 0.5, 0.2, COST_WINDOW], "served all-in, by hand the cost page's before");
  assert.ok(logs.some((line) => /answer cost \$0\.5 a run over its last 10 served runs, at or over \$0\.2 by hand \(served all-in, by hand the job's own/.test(line)), JSON.stringify(logs));
});

test("money rule, all-in: a served run whose learning's cost is unknown is left out of the mean and counted, never read as 0", async (t) => {
  // 11 served runs, the newest at $5 with learning of unknown cost, the 10 older at $0.1: read as 0 its learning would
  // put it in the window ($0.59 a run, over the by-hand $0.2); left out, the 10 known are the window, under, and it serves.
  const [newest, ...older] = pastRuns({ served: COST_WINDOW + 1, servedUsd: 0.1, byHandUsd: 0.2 });
  const unknownNewest = (past) => lookedBack(past.slice(0, 1), () => null);
  const { row: under } = await piRun(t, { past: [{ ...newest, costUsd: 5 }, ...older], keptBefore: unknownNewest([{ ...newest, costUsd: 5 }]) });
  assert.equal(under.metrics?.path, "workflow", JSON.stringify(under.metrics));
  // Only 10 served, the newest unknown: 9 known, under COST_WINDOW, so it serves though the 9 cost $0.5 a run.
  const fewPast = pastRuns({ servedUsd: 0.5, byHandUsd: 0.2 });
  const { row: few } = await piRun(t, { past: fewPast, keptBefore: unknownNewest(fewPast) });
  assert.equal(few.metrics?.path, "workflow", `an unknown run is never one of the window: ${JSON.stringify(few.metrics)}`);
});

test("money rule: under the by-hand cost, a new digest, fewer than 10 served runs, or no by-hand baseline: the workflow serves", async (t) => {
  for (const [why, past] of [
    ["under the by-hand cost", pastRuns({ servedUsd: 0.1, byHandUsd: 0.2 })],
    ["a new revision of it (another digest's runs)", pastRuns({ servedUsd: 0.5, byHandUsd: 0.2, digest: "fedcba9876543210" })],
    ["9 served runs", pastRuns({ served: COST_WINDOW - 1, servedUsd: 0.5, byHandUsd: 0.2 })],
    ["no by-hand baseline", pastRuns({ servedUsd: 0.5, byHand: 0 })],
  ]) {
    await t.test(why, async (t) => {
      const { row, logs } = await piRun(t, { past });
      assert.equal(row.metrics?.path, "workflow", `${why}: ${JSON.stringify(row.metrics)}`);
      if (why === "no by-hand baseline") assert.ok(logs.some((line) => /no by-hand cost to hold answer to/.test(line)), JSON.stringify(logs));
    });
  }
});

test("costLineOf: the newest 10 served runs at the digest against the by-hand side as given (the cost page's before: one baseline)", () => {
  const at = Date.UTC(2026, 10, 12);
  const run = (i, metrics, allInUsd) => ({ metrics, allInUsd, startedAt: at - i * 60_000 });
  const served = (i, usd, extra = {}) => run(i, { path: i % 2 ? "workflow" : "handed_back", workflow: "answer", workflow_digest: "d", ...extra }, usd);
  const BY_HAND = { runs: 2, mean_usd: 0.2 };
  /** The money rule's read: the runs, the by-hand side as the cost page's summary gives it, and the by-hand runs it left out. */
  const pastOf = (runs, by_hand = BY_HAND, by_hand_unknown = 1) => ({ runs, by_hand, by_hand_unknown });
  // A by-hand run's all-in is never read here: the by-hand side is the cost page's, its mean over the job's own $.
  const rows = [...Array.from({ length: 12 }, (_, i) => served(i, i < 10 ? 0.3 : 9)), run(12, { path: "agent" }, 5), run(13, { path: "agent" }, 5), run(14, { path: "agent" }, null)];
  assert.deepEqual(costLineOf(pastOf(rows), "answer", "d"), { served: { runs: 10, mean_usd: 0.3 }, by_hand: BY_HAND, unknown_runs: 1 }, "the newest 10 served; by hand as given, its unknown run counted");
  // An unknown served run is left out and counted while the window fills; one past a full window is not read at all.
  assert.deepEqual(costLineOf(pastOf([served(0, null), ...rows.slice(1)]), "answer", "d").served, { runs: 10, mean_usd: 1.17 }, "the newest unknown: the window reaches one run further back");
  assert.equal(costLineOf(pastOf([served(0, null), ...rows.slice(1)]), "answer", "d").unknown_runs, 2);
  assert.equal(costLineOf(pastOf([...rows.slice(0, 10), served(10, null), ...rows.slice(11)]), "answer", "d").unknown_runs, 1, "past the full window: not counted");
  assert.deepEqual(costLineOf(pastOf(rows), "answer", "e").served, { runs: 0, mean_usd: null }, "another digest: none served");
  assert.equal(costLineOf(pastOf(rows.slice(0, 12), null, 0), "answer", "d").by_hand, null, "no baseline: none, never $0");
  assert.equal(overLine(costLineOf(pastOf(Array.from({ length: 10 }, (_, i) => served(i, 9)), null, 0), "answer", "d")), false, "no baseline: never over the line");
  assert.equal(servedOf([{ kind: WORKFLOW_FIRST, data: { workflow: "answer", digest: "d", outcome: "needs_revision" } }]), undefined, "a revision ask served nothing");
  // What the agent's cost per run shows its owner: each workflow at its newest digest, over the line or not.
  const ONE = { runs: 1, mean_usd: 0.2 };
  const over = [...Array.from({ length: 10 }, (_, i) => served(i, 0.5)), run(10, { path: "agent" }, 0.2), served(11, 0.1, { workflow_digest: "old" })];
  assert.deepEqual(workflowCostsOf(pastOf(over, ONE, 0)), [{ workflow: "answer", digest: "d", state: "needs_revision", served: { runs: 10, mean_usd: 0.5 }, by_hand: ONE, unknown_cost_runs: 0 }]);
  assert.deepEqual(workflowCostsOf(pastOf([run(0, { path: "workflow", workflow: "answer", workflow_digest: "new" }, null), ...over], ONE, 0)), [{ workflow: "answer", digest: "new", state: "serving", served: null, by_hand: ONE, unknown_cost_runs: 1 }], "a new digest starts from zero; its unknown run counted");
  assert.equal(workflowCostsOf(pastOf([...Array.from({ length: 10 }, (_, i) => served(i, 0.1)), run(10, { path: "agent" }, 0.2)], ONE, 0))[0].state, "serving", "under the line");
});

// A workflow whose one output field is a string (answerFlow's output is a record of a number and a flag, so JSON): the tool hands back
// that string as it is, whatever the node submits, as long as a test likes.
const textFlow = {
  ...answerFlow,
  schemas: { ...answerFlow.schemas, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question in words.", out: "Answer", as: "answer" }] },
};
const TEXT_FLOWS = [{ name: "answer", description: "Answers a question in words", workflow: textFlow }];

test("a workflow's answer the tool cut goes back to the agent: no agent turn could recover its ending, so the run never ends on it", async (t) => {
  const { row, entries, gateway, timeline } = await piRun(t, { flows: TEXT_FLOWS, answer: "a long answer. ".repeat(Math.ceil((LEARNED_CLIP + 5_000) / 15)) });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"]);
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  const firstAgent = gateway.requests.find((request) => !isNode(request));
  assert.match(textOf(firstAgent.body), /Your learned workflow `answer` ran first on this job and handed it back to you/);
  assert.equal(timeline.findLast((one) => ["assistant", "final_answer"].includes(one.kind))?.text, AGENT_SAYS, "the agent's answer is the run's last word");
});

test("a workflow's answer under the cut is the run's own answer", async (t) => {
  const { row, entries, gateway } = await piRun(t, { flows: TEXT_FLOWS, answer: "a long answer. ".repeat(Math.floor((LEARNED_CLIP - 1_000) / 15)) });
  assert.equal(row.metrics?.path, "workflow", JSON.stringify(row.metrics));
  assert.deepEqual(entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.equal(gateway.requests.filter((request) => !isNode(request)).length, 0);
});

/** The run's final answer, as the timeline shows it. */
const finalOf = (timeline) => timeline.findLast((one) => ["assistant", "final_answer"].includes(one.kind))?.text ?? "";

test("an agent with an output schema: a one-field workflow's bare code is served as the schema's object, its result.output meets the schema", async (t) => {
  const outputSchema = { type: "object", required: ["mcc"], properties: { mcc: { type: "string" } } };
  const code = await piRun(t, { flows: TEXT_FLOWS, answer: "5462", outputSchema });
  assert.equal(code.row.metrics?.path, "workflow", JSON.stringify(code.row.metrics));
  const said = finalOf(code.timeline);
  assert.match(said, /^```json\n[\s\S]*\n```$/, `the answer is one fenced json block: ${said}`);
  assert.deepEqual(structuredAnswer(said, outputSchema), { value: { mcc: "5462" } }, "the code is the schema's field as a string, never a JSON number");
});

test("an agent with an output schema: a one-field workflow's text (not JSON) is served as the schema's object", async (t) => {
  const outputSchema = { type: "object", required: ["category"], properties: { category: { type: "string" } } };
  const words = await piRun(t, { flows: TEXT_FLOWS, answer: "Grocery stores", outputSchema });
  assert.equal(words.row.metrics?.path, "workflow", JSON.stringify(words.row.metrics));
  assert.deepEqual(words.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.deepEqual(structuredAnswer(finalOf(words.timeline), outputSchema), { value: { category: "Grocery stores" } });
});

test("an agent with an output schema: a workflow's object output is served as it is, fenced; without a schema it is left as the workflow gave it", async (t) => {
  const outputSchema = { type: "object", properties: { answer: { type: "number" } } };
  const json = await piRun(t, { outputSchema });
  assert.equal(json.row.metrics?.path, "workflow", JSON.stringify(json.row.metrics));
  assert.deepEqual(structuredAnswer(finalOf(json.timeline), outputSchema), { value: { answer: 42, sure: true } });
  const bare = await piRun(t);
  assert.doesNotMatch(finalOf(bare.timeline), /```/);
});

test("an agent with an output schema: an output that cannot be shaped to it goes back to the agent, the reason in its handback", async (t) => {
  const outputSchema = { type: "object", required: ["answer"], properties: { answer: { type: "number" } } };
  const words = await piRun(t, { flows: TEXT_FLOWS, answer: "forty-two", outputSchema });
  assert.equal(words.row.metrics?.path, "handed_back", JSON.stringify(words.row.metrics));
  assert.deepEqual(words.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"]);
  const handed = words.timeline.find((one) => /handed it back to you/.test(one.text ?? ""));
  assert.ok(handed, "the agent's first input is the handback");
  assert.match(handed.text, /forty-two/, "the workflow's own answer is in it");
  assert.match(handed.text, /does not meet the agent's output schema: \/answer/, `the reason is in it: ${handed.text}`);
});

test("a claim that dies after a handback the agent never got: the next claim sends the same handback, why and all (schema, cut)", async (t) => {
  const outputSchema = { type: "object", required: ["answer"], properties: { answer: { type: "number" } } };
  // The second claim either serves the workflow again (recovering its end) or finds the money rule now stops it (the
  // recovered step then knows the agent's schema from the stop alone): the same handback either way.
  const stopped = { past: pastRuns({ servedUsd: 0.5, byHandUsd: 0.2, digest: workflowDigest({ workflow: JSON.stringify(textFlow) }) }), pastFromSecondClaim: true };
  for (const [label, extra] of [["serving", {}], ["money rule stops it", stopped]]) {
    const words = await piRun(t, { flows: TEXT_FLOWS, answer: "forty-two", outputSchema, crashOnHandback: true, ...extra });
    assert.equal(words.row.state, "ended", `${label}: ${JSON.stringify(words.row)}`);
    assert.ok(words.claims >= 2, `${label}: a second claim took the run: ${words.claims}`);
    assert.deepEqual(words.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"], label);
    const firstAgent = words.gateway.requests.find((request) => !isNode(request));
    assert.match(textOf(firstAgent.body), /forty-two/, `${label}: the workflow's own answer is in it`);
    assert.match(textOf(firstAgent.body), /does not meet the agent's output schema: \/answer/, `${label}: the reason survives the crash: ${textOf(firstAgent.body)}`);
  }
});

test("answerAsServed: one answer as served for serving, replay and grading; what it serves reads back as the value it shaped", () => {
  const mcc = { type: "object", required: ["mcc"], properties: { mcc: { type: "string" } } };
  const cases = [
    ["5462", mcc, { mcc: "5462" }],
    ["Grocery stores", mcc, { mcc: "Grocery stores" }],
    ['{"mcc":"5462"}', mcc, { mcc: "5462" }],
    ["7", { type: "object", required: ["n"], properties: { n: { type: "number" }, why: { type: "string" } } }, { n: 7 }],
    ['Done.\n```json\n{"mcc":"5999"}\n```', mcc, { mcc: "5999" }],
  ];
  for (const [output, schema, value] of cases) {
    const served = answerAsServed(output, schema);
    assert.deepEqual(served.value, value, `${output}: ${JSON.stringify(served)}`);
    assert.deepEqual(structuredAnswer(served.text, schema), { value }, `${output}: the grade path (result.output) reads what serving shaped`);
  }
  // A replay of a one-field workflow agrees with its graded answer: the replay's answer is the served one, read as a value.
  const replayed = answerAsServed("5462", mcc);
  assert.deepEqual(answerJson(replayed.text), { value: { mcc: "5462" } });
  assert.match(answerAsServed("forty-two", { type: "object", required: ["n"], properties: { n: { type: "number" } } }).why ?? "", /^its answer does not meet the agent's output schema: \/n /);
  assert.deepEqual(answerAsServed("5462", undefined), { text: "5462", value: "5462" }, "no schema: as the workflow gave it");
  // An object output that fails the schema goes back to the agent, said against the object: never its own text in a field.
  const wrongType = answerAsServed('{"answer":42,"sure":true}', { type: "object", required: ["answer"], properties: { answer: { type: "string" } } });
  assert.equal(wrongType.text, undefined, `a mismatched object is not served: ${JSON.stringify(wrongType)}`);
  assert.match(wrongType.why ?? "", /^its answer does not meet the agent's output schema: \/answer /);
  // An array output is no object: as text, it fills the one field.
  assert.deepEqual(answerAsServed('["a"]', mcc).value, { mcc: '["a"]' });
});

test("a claim that dies after the workflow handed the job back: the next claim sends the handback even when the money rule now stops the workflow", async (t) => {
  const { row, gateway, entries, claims } = await piRun(t, { sure: false, crashOnHandback: true, past: pastRuns({ servedUsd: 0.5, byHandUsd: 0.2 }), pastFromSecondClaim: true });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"], "one step on the record: the money rule's stop added none");
  assert.equal(gateway.requests.filter(isNode).length > 0, true, "the workflow ran once, on the first claim");
  const firstAgent = gateway.requests.find((request) => !isNode(request));
  assert.match(textOf(firstAgent.body), /Your learned workflow `answer` ran first on this job and handed it back to you/, "the agent's first input is the handback, not the bare job");
});

test("the cost page and the launch's money rule read one history: every run since the reset, the cost page's before as the by-hand side", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-workflow-first-cost-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const at = Date.UTC(2026, 10, 12);
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(`run-${i}`);
    await store.runs.create({ id: `run-${i}`, agentId: "agent-1", revisionId: "rev-1" });
  }
  await store.flush?.();
  const db = new DatabaseSync(join(dir, "store.sqlite"), { timeout: 5_000 });
  try {
    // run-0 the newest; the three older ones are served runs of one digest, the newest of them at 0.9, the oldest two at 0.1.
    ids.forEach((id, i) => db.prepare("UPDATE runs SET state = 'ended', started_at = ?, ended_at = ?, cost_usd = ?, metrics = ? WHERE id = ?").run(at - i * 60_000, at - i * 60_000 + 1_000, i === 0 ? 0.9 : 0.1, JSON.stringify({ path: "handed_back", workflow: "answer", workflow_digest: DIGEST, learned_revision: "s" }), id));
  } finally {
    db.close();
  }
  const { workflows, summary } = await agentCostOverStore(store, "agent-1");
  const past = await pastRunsOverStore(store, "agent-1");
  assert.deepEqual(workflowCostsOf(past), workflows, "the launch's money rule reads what the cost page shows");
  assert.deepEqual([workflows[0]?.served, past.by_hand, summary.before], [{ runs: 4, mean_usd: 0.3 }, null, null], `all four served runs; no run by hand, no baseline: ${JSON.stringify(workflows)}`);
});

test("workflowFirstOf: one fitting workflow serves; none, two, a workflow run, no learning start, or workflow_first false do not", async () => {
  const flow = (name, required) => ({ name, description: "", workflow: JSON.stringify({ ...answerFlow, name, schemas: { ...answerFlow.schemas, In: { type: "object", required, properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])) } } }) });
  const launch = { input: { content: "c", question: "q" }, learning: { seed: "abc" } };
  const logs = [];
  const log = (line) => logs.push(line);
  const { serve: one } = await workflowFirstOf("agentic", [flow("answer", ["question"])], launch, log);
  assert.deepEqual({ ...one, digest: typeof one.digest }, { name: "answer", digest: "string", input: launch.input, revision: "abc" });
  assert.deepEqual(await workflowFirstOf("agentic", [flow("answer", ["question"]), flow("other", ["content"])], launch, log), {}, "two fit: the agent's");
  assert.ok(logs.some((line) => /2 of 2 learned workflows fit/.test(line)), JSON.stringify(logs));
  assert.deepEqual(await workflowFirstOf("agentic", [flow("answer", ["missing"])], launch, log), {}, "none fit");
  assert.deepEqual(await workflowFirstOf("agentic", [flow("answer", [])], launch, log), {}, "no required field: never fits");
  assert.deepEqual(await workflowFirstOf("workflow", [flow("answer", ["question"])], launch, log), {}, "a workflow run is not agentic");
  assert.deepEqual(await workflowFirstOf("agentic", [flow("answer", ["question"])], { ...launch, learning: undefined }, log), {}, "no learning start");
  assert.deepEqual(await workflowFirstOf("agentic", [flow("answer", ["question"])], { ...launch, workflowFirst: false }, log), {}, "forced to the agent");
  assert.equal(fits({ name: "x", description: "", workflow: "not json" }, launch.input, resolveSchemaForWorkflow), false);
  // The run record carries the path only for a run that learns, as the run-end classifier gives it.
  assert.deepEqual(pathMetrics({ input: {} }, { path: "workflow", workflow: "answer" }), {});
  assert.deepEqual(pathMetrics({ input: {}, learning: { seed: "abc" } }, undefined), { path: "agent", learned_revision: "abc" });
  assert.deepEqual(pathMetrics({ input: {}, learning: { seed: "abc" } }, { path: "handed_back", workflow: "answer", digest: "d" }), { path: "handed_back", learned_revision: "abc", workflow: "answer", workflow_digest: "d" });
  assert.deepEqual(pathMetrics({ input: {}, learning: { seed: "abc" } }, { path: "workflow", workflow: "answer" }), { path: "workflow", learned_revision: "abc", workflow: "answer" }, "the agent called it itself: no digest");
  // What the step did, from its entry alone.
  assert.equal(servedOf([]), undefined);
  assert.deepEqual(servedOf([{ kind: WORKFLOW_FIRST, data: { workflow: "answer", digest: "d", outcome: "handed_back" } }]), { outcome: "handed_back", workflow: "answer", digest: "d" });
});

test("workflowFirstOf: past runs it can't read stop nothing, and it says so: the run is served unchecked and the log names why", async () => {
  const flow = { name: "answer", description: "", workflow: JSON.stringify({ ...answerFlow, name: "answer", schemas: { ...answerFlow.schemas, In: { type: "object", required: ["question"], properties: { question: { type: "string" } } } } }) };
  const launch = { input: { question: "q" }, learning: { seed: "abc" } };
  const logs = [];
  const { serve } = await workflowFirstOf("agentic", [flow], launch, (line) => logs.push(line), () => Promise.reject(new Error("the store is gone")));
  assert.equal(serve?.name, "answer", "it serves");
  assert.ok(logs.some((line) => /money rule could not read/.test(line) && line.includes("the store is gone") && line.includes("unchecked")), JSON.stringify(logs));
});

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const HARNESS = "codex";

/** The same run on a CLI harness (the faux codex, through the runner's dispatch): the agent, when it gets a turn, says
 *  its thinking (faux-harness.mjs "Say your thinking."). */
async function cliRun(t, { sure = true } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-workflow-first-cli-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: ({ body }) => {
    const offered = (body?.tools ?? []).some((tool) => tool?.name === "submit");
    const answered = (body?.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) || (body?.input ?? []).some((item) => item?.type === "function_call_output");
    return offered && !answered ? { name: "submit", input: { value: { answer: sure ? 42 : 41, sure } } } : undefined;
  } });
  let runner;
  let reader;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await reader?.close(ctx).catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Say your thinking.", harness: HARNESS, tools: ["read"], learning: true } });
  const seed = await landWorkflows(dir, "agent-1", FLOWS);
  await promoteChecked(server.settings, "agent-1", FLOWS);
  const launch = { input: { content: `${QUESTION}?`, question: QUESTION }, title: "t", place: { mode: "runner" }, harness: HARNESS, model: { provider: "openai", modelId: "gpt-6.1-terra" }, learning: startAt(seed) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const env = { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-6.1-terra", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5", AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === HARNESS ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  reader = await Harness.open(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const sessions = journalSessions(reader, ctx, server);
  const all = [];
  for (const key of await sessions.keys()) for (const record of await sessions.read(key)) all.push(record);
  const requests = all.filter((record) => record.kind === "runner.request").map((record) => record.data);
  const turns = all.filter((record) => record.kind === "runner.turn").map((record) => record.data);
  const timeline = await runTimeline(server, RUN, ctx, { settled: true });
  return { row, requests, turns, timeline, seed };
}

test("CLI: the workflow answers alone, no harness request, path workflow, its node $ the run's cost", async (t) => {
  const { row, requests, turns, timeline, seed } = await cliRun(t);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(requests.length >= 1 && requests.every((request) => request.host === LEARNED_WORKFLOW_TOOL), `only the node's requests: ${JSON.stringify(requests)}`);
  assert.deepEqual({ path: row.metrics?.path, learned_revision: row.metrics?.learned_revision, workflow: row.metrics?.workflow }, { path: "workflow", learned_revision: seed, workflow: "answer" });
  const booked = turns.reduce((sum, turn) => sum + (typeof turn.usd === "number" ? turn.usd : 0), 0);
  assert.ok(booked > 0 && Math.abs((row.costUsd ?? 0) - booked) < 1e-9, `the run's cost is the node's booked $: ${row.costUsd} vs ${booked}`);
  assert.ok(timeline.some((one) => ["assistant", "final_answer"].includes(one.kind) && /42/.test(one.text ?? "")), JSON.stringify(timeline.map(({ kind, text }) => [kind, text])));
});

test("CLI: handed back, the harness takes the same run with the trace and ends it, path handed_back", async (t) => {
  const { row, requests, timeline } = await cliRun(t, { sure: false });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  assert.ok(requests.some((request) => request.host === LEARNED_WORKFLOW_TOOL) && requests.some((request) => request.host === undefined), `node and harness requests both booked: ${JSON.stringify(requests)}`);
  const handed = timeline.find((one) => /handed it back to you/.test(one.text ?? ""));
  assert.ok(handed, `the harness's input carries the hand-back: ${JSON.stringify(timeline.map(({ kind, text }) => [kind, text?.slice(0, 80)]))}`);
  assert.match(handed.text, /handed the job back at its step "unsure": not sure of 41/);
  assert.match(timeline.findLast((one) => ["assistant", "final_answer"].includes(one.kind))?.text ?? "", /^Thinking /);
});
