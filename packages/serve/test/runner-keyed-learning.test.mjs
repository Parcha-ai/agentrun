// A run's learning work on its own model key (model_key), through the runner: a server that holds no gateway key of its
// own runs a keyed run's learned-workflow check and its shadow audit on that run's key, each child on a copy sealed for
// it alone and erased at its end, out of what the run's cap leaves at its end; and the run's view says where that work
// stands (`learning_work`), what its caller revokes the key on. Proven here:
//   - a keyed run whose learned workflow is new gets its check: one replay run per input, started at the run's end, every
//     model request of each carrying the run's key (the gateway records it), never another;
//   - a keyed run its promoted workflow served gets its shadow audit, on the run's key;
//   - while the children run the run reads `running`, listing them; once they end, `ended` at the last one's end;
//   - each child's copy opens for that child alone, and is erased by the write that ends it; a purge leaves no byte of it;
//   - what the replays spent on the run's key is the run's own learning (cost.learning_usd, its part check_usd), as its
//     shadow's is;
//   - a purge of the run while its replays run cancels them and erases their copies before it answers: no child left
//     running, no copy in the store's bytes, nothing spent after it;
//   - a cap that leaves too little drops the check (`no_budget`): no replay, nothing reserved, the run reads `ended`; and
//     its shadow too, under a run's smallest cap: no shadow, the drop named `no_budget`, the run reads `ended`;
//   - `deadline_at` is set while the run reads running (each child's start + LEARNING_CHILD_MS, the latest) and null once
//     it ended; a child still at work at its deadline is cancelled by its runner (on the runner's injected clock), as a
//     person's cancel is: it ends, nothing more reaches the gateway, and the run reads ended;
//   - the key is in no log line, and nowhere in the store's bytes in the clear.
// The agent's runs are real runs of the store on a pi run of the faux gateway, its route reading the run's model env.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, putPromotions, startAt } from "./learned-workflow-seed-support.mjs";
import { storeBytes } from "./support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { promotionsOf } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { seedOf } = await import("../dist/learning.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { openRunLaunch, sealRunLaunch } = await import("../dist/store/seal.js");
const { agentCostOverStore, runAllInOverStore } = await import("../dist/store-reads/learning.js");
const { purgeRun } = await import("../dist/agent-delete.js");
const { LEARNING_CHILD_MS, RUN_CAP_MIN_USD, learningChildrenOf } = await import("../dist/learning-work.js");

const SEAL_KEY = Buffer.alloc(32, 9);
const MODEL = "claude-sonnet-5-5";
const RUN_KEY = `not-a-secret-${"keyed-learning"}-5e1a07`;
const PI = `not-a-secret-${"pi"}`;
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const AGENT_SAYS = JSON.stringify({ answer: 42, sure: true });
const FINAL = ["ended", "failed", "stopped"];

const answerFlow = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question; say whether you are sure.", out: "Answer", as: "answer", tier: "fast" },
    { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "answer.sure", value: false }, kind: "unsure", stage: "answer", summary: "not sure of {answer.answer}" },
  ] },
};
const FLOWS = [{ name: "answer", description: "Answers a question as a number", workflow: answerFlow }];
const DIGEST = workflowDigest({ workflow: JSON.stringify(answerFlow) });

const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
/** The credential a request carried, whichever header its wire puts it in. */
const keyOf = (request) => request.headers["x-api-key"] ?? request.headers.authorization?.replace(/^Bearer /, "");

const until = async (done, what, ms = 90_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A front for the gateway that holds every request whose body `held` matches until `release()`, so a test reads the
 *  run's view while its children are in flight. */
async function holdingFront(t, origin, held) {
  const waiting = new Set();
  const open = new Set();
  let released = false;
  const forward = async (req, res, body) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !["host", "content-length", "connection"].includes(key)));
    const answer = await fetch(`${origin}${req.url}`, { method: req.method, headers, ...(body.length ? { body } : {}) });
    res.writeHead(answer.status, Object.fromEntries([...answer.headers].filter(([key]) => !["content-length", "content-encoding", "transfer-encoding", "connection"].includes(key))));
    if (answer.body) Readable.fromWeb(answer.body).pipe(res);
    else res.end();
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (!released && held(body.toString("utf8"))) {
      const go = () => (waiting.delete(go), open.delete(res), forward(req, res, body).catch(() => res.destroy()));
      waiting.add(go);
      open.add(res);
      return;
    }
    await forward(req, res, body).catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const res of open) res.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, waiting, release: () => ((released = true), [...waiting].forEach((go) => go())) };
}

/** An agent of `learning` with `prior` earlier runs of its own, on no key (the server's path), and `answer` landed in its
 *  learning (`promoted`: as its check's record promotes it, so it serves first). The runner's env names the
 *  gateway and holds no key of its own; its route reads the key the claim's model env holds. `hold`: requests whose body
 *  it matches wait until `front.release()`. `learningClock`: the runner's clock for its learning children's deadlines.
 *  `usage`: what the gateway says each request used. `pollMs`: the runner's poll, when not TIMING's. `lease`: the
 *  runner's lease timings, when not TIMING's. `call`: the gateway's tool call, when not the right submit. `restart(clock)` kills the runner (a crash: it writes nothing more, its
 *  claims lapse at their lease) and starts another on the same store, `clock` its learning clock. */
async function world(t, { learning = true, prior = 0, promoted = false, hold, learningClock, usage, pollMs, lease, call } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-keyed-learning-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: call ?? (({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: 42, sure: true } } } : undefined)),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : AGENT_SAYS),
    ...(usage ? { usage } : {}),
  });
  const front = hold ? await holdingFront(t, gw.url, hold) : undefined;
  const origin = front?.url ?? gw.url;
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Keyed" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: [], learning } });
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  // The route reads the gateway key the claim's model env holds at each request: the run's own (a getter over its sealed
  // key, claim-secrets.ts claimModelEnv) on a keyed claim, none on the server's path (the test's stand-in then).
  const routeOf = async (_model, env) => ({ model: MODEL, provider: { api: "anthropic-messages", origin, credential: () => env.AGENT_MODEL_API_KEY ?? PI }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch });
  const logs = [];
  const deps = { env: { AGENT_MODEL_BASE_URL: origin }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  const startOne = (name, clock) => startRunner({ store, name, ...TIMING, ...lease, ...(pollMs ? { pollMs } : {}), ...(clock ? { learningClock: clock } : {}), createLoop: createAdapterLoop(specOf) });
  runner = startOne("runner-a", learningClock);
  const restart = (clock) => {
    runner.kill();
    runner = startOne("runner-b", clock);
  };
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const launchOf = (question, extra = {}) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...extra });
  for (let i = 0; i < prior; i++) {
    await server.runs.create({ id: `prior-${i}`, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(`Question ${i}`) });
    await ended(`prior-${i}`);
  }
  const seed = await landWorkflows(dir, "agent-1", FLOWS);
  if (promoted) await putPromotions(server, "agent-1", [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [] }, commit: seed }]);
  /** Makes run `id` on `question`, handed the run key RUN_KEY bound to the gateway's origin and capped at `capUsd`, at the
   *  agent's newest learning save now, as the server's start makes it. */
  const keyed = async (id, question, capUsd) => server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, {
    body: launchOf(question, { learning: startAt((await seedOf(dir, server, "agent-1")).sha), ...(capUsd !== undefined ? { max_cost_usd: capUsd } : {}) }),
    sealed: sealRunLaunch(SEAL_KEY, id, { model: { key: RUN_KEY, origin: new URL(origin).origin } }),
  });
  const children = async (field) => {
    const out = [];
    for (const row of await server.runs.list({ agentId: "agent-1" })) if (readLaunchBody((await server.runs.launch(row.id)).body)?.[field]) out.push(row);
    return out;
  };
  const view = async (id) => viewOverStore(server, id, { origin: "", serverSecrets: () => [], sealKey: SEAL_KEY });
  return { dir, server, gw, front, logs, ended, keyed, children, view, restart };
}

/** The key nowhere in the clear: no log line, none of the store's bytes. */
async function assertNowhere(w) {
  assert.equal(w.logs.join("\n").includes(RUN_KEY), false, "the key is in no log line");
  await w.server.flush();
  assert.equal(storeBytes(w.dir).includes(Buffer.from(RUN_KEY)), false, "the key is in none of the store's bytes in the clear");
}

test("a keyed run's new workflow is checked at its end on the run's own key: each replay holds a copy sealed for it alone, every request of it carries the run's key, the run reads running then ended, and each copy is erased at its end and gone after purge", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { prior: 6, hold: (body) => body.includes('"name":"submit"') });
  await w.keyed("run-1", "What is six times seven", 5);
  const parent = await w.ended("run-1");
  assert.equal(parent.state, "ended", JSON.stringify(parent));
  assert.equal((await w.server.runs.launch("run-1")).sealed, null, "the run's own key erased at its turn's end");
  assert.ok(w.logs.some((line) => line.includes(`answer at ${DIGEST} is new: it is checked at this run's end, on this run's own key`)), w.logs.join("\n"));
  // The replays started at the run's end, each held at its first node request: the run reads running, listing them.
  const replays = await until(async () => {
    const rows = await w.children("replay");
    return rows.length === 6 && w.front.waiting.size === 6 && rows;
  }, "six replay runs, each at its node's request");
  const ids = replays.map((row) => row.id);
  const running = (await w.view("run-1")).learning_work;
  assert.deepEqual([running.state, [...running.runs].sort(), running.ended_at], ["running", [...ids].sort(), null], JSON.stringify(running));
  // Its deadline: the last replay's start + LEARNING_CHILD_MS, so between the run's start and now, that bound on.
  const deadline = Date.parse(running.deadline_at) - LEARNING_CHILD_MS;
  assert.ok(deadline >= parent.startedAt && deadline <= Date.now(), `deadline_at is a replay's start + LEARNING_CHILD_MS: ${JSON.stringify(running)}`);
  for (const id of ids) {
    const sealed = (await w.server.runs.launch(id)).sealed;
    assert.deepEqual(openRunLaunch(SEAL_KEY, id, sealed)?.model, { key: RUN_KEY, origin: new URL(w.front.url).origin }, "the run's key, bound to the gateway's origin, sealed for the replay");
    assert.equal(openRunLaunch(SEAL_KEY, "run-1", sealed), undefined, "and for no other run");
    const launch = readLaunchBody((await w.server.runs.launch(id)).body);
    assert.ok(launch.maxCostUsd > 0 && launch.maxCostUsd <= 5 / 6, `each capped at its share of what the run's cap left: ${launch.maxCostUsd}`);
  }
  // While its replays run, what they will cost the run is not known: the agent's cost read (the cost route's) says so as
  // the run's own read does, never a settled $0 check.
  const open = (await agentCostOverStore(w.server, "agent-1")).runs.find((run) => run.run_id === "run-1");
  assert.deepEqual([open?.check_usd, open?.learning_usd, open?.total_usd], [null, null, null], `the agent's ledger reads run-1's check unknown: ${JSON.stringify(open)}`);
  const openAllIn = await runAllInOverStore(w.server, "run-1");
  assert.deepEqual([openAllIn.check_usd, openAllIn.learning_usd, openAllIn.all_in_usd], [null, null, null], JSON.stringify(openAllIn));
  w.front.release();
  for (const id of ids) {
    const row = await w.ended(id);
    assert.deepEqual([row.state, row.metrics?.path], ["ended", "replay"], JSON.stringify(row));
    assert.equal((await w.server.runs.launch(id)).sealed, null, `replay ${id}'s copy erased by the write that ends it`);
  }
  // Every node request (the replays' alone: the agent's runs ask none) carried the run's key, and only it.
  const nodes = w.gw.requests.filter((request) => offers(request.body, "submit"));
  assert.ok(nodes.length >= 6, `each replay asked its node: ${nodes.length}`);
  assert.deepEqual([...new Set(nodes.map(keyOf))], [RUN_KEY], "the replays ran on the run's own key");
  const done = (await w.view("run-1")).learning_work;
  const lastEnd = Math.max(...(await Promise.all(ids.map((id) => w.server.runs.get(id)))).map((row) => row.endedAt));
  assert.deepEqual(done, { state: "ended", runs: [], ended_at: new Date(lastEnd).toISOString(), deadline_at: null }, "ended at the last child's end, its deadline gone");
  assert.equal((await promotionsOf(w.server.learning, "agent-1")).at(-1).decided, "replaying", "the check's record: decided at a later claim");
  // What the replays spent on the run's key is the run's own learning, as its shadow's would be: its cost.learning_usd
  // carries it (its part check_usd), and its all-in with it.
  const spent = (await Promise.all(ids.map((id) => w.server.runs.get(id)))).map((row) => row.costUsd);
  assert.ok(spent.every((usd) => typeof usd === "number" && usd > 0), `each replay's cost is booked: ${spent}`);
  const micro = (usd) => Math.round(usd * 1e6);
  const cost = await runAllInOverStore(w.server, "run-1");
  const near = (a, b) => Math.abs(a - b) <= ids.length;
  assert.ok(near(micro(cost.check_usd ?? 0), spent.reduce((sum, usd) => sum + micro(usd), 0)), `the run's check_usd is its replays' cost (${spent}): ${JSON.stringify(cost)}`);
  assert.ok(micro(cost.learning_usd) >= micro(cost.check_usd), `in its learning_usd: ${JSON.stringify(cost)}`);
  assert.ok(near(micro(cost.all_in_usd), micro(cost.usd) + micro(cost.learning_usd)), `and its all-in: ${JSON.stringify(cost)}`);
  const settled = (await agentCostOverStore(w.server, "agent-1")).runs.find((run) => run.run_id === "run-1");
  assert.equal(settled?.check_usd, cost.check_usd, `once every replay ended the agent's ledger reads the run's check as its own read does: ${JSON.stringify(settled)}`);
  // A purge leaves nothing of the copies: the children's and the run's launches gone, no byte of the key kept.
  const KEPT = { meters: null, spend: { usd: 0, basis: "list" }, learning: null };
  for (const id of [...ids, "run-1"]) await w.server.runs.purge(id, KEPT);
  for (const id of [...ids, "run-1"]) assert.equal((await w.server.runs.launch(id).catch(() => undefined))?.sealed ?? null, null, `${id}: no sealed bytes after purge`);
  await assertNowhere(w);
});

test("a purge of a keyed run while its check's replays run cancels them and erases their copies before it answers: no child left running, no copy in the store's bytes, nothing spent after it", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { prior: 6, hold: (body) => body.includes('"name":"submit"') });
  await w.keyed("run-1", "What is six times seven", 5);
  await w.ended("run-1");
  const replays = await until(async () => {
    const rows = await w.children("replay");
    return rows.length === 6 && w.front.waiting.size === 6 && rows;
  }, "six replay runs, each at its node's request");
  const ids = replays.map((row) => row.id);
  assert.equal((await w.view("run-1")).learning_work.state, "running");
  // The purge as DELETE /v2/runs/{run_id} runs it (agent-delete.ts purgeRun) over the store, the run's things outside its
  // rows aside. The replays are made from the runs they replay, not from it: they never make it refuse.
  const KEPT = { meters: null, spend: { usd: 0, basis: "list" }, learning: null };
  const host = { store: w.server, madeFrom: (id) => w.server.runs.madeFrom(id), forgetCopies: async () => {}, forgetRun: async () => {}, kept: async () => KEPT, turnOver: async () => false, waitMs: 60_000, pollMs: 20 };
  await purgeRun(host, "run-1");
  assert.notEqual((await w.server.runs.get("run-1")).purgedAt, null, "the run is purged");
  // Read the moment it answers, never waited for: each replay ended and let go, its copy gone, the key nowhere.
  for (const id of ids) {
    const row = await w.server.runs.get(id);
    assert.ok(FINAL.includes(row.state) && row.runner === null, `replay ${id} is not running once the purge answers: ${JSON.stringify([row.state, row.runner])}`);
    assert.equal((await w.server.runs.launch(id)).sealed, null, `replay ${id}'s copy of the run's key is erased`);
  }
  await assertNowhere(w);
  // Nothing spent after it: no model request reaches the gateway, and no replay's booked cost moves.
  const asked = w.gw.requests.length;
  const booked = await Promise.all(ids.map(async (id) => (await w.server.runs.get(id)).costUsd));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(w.gw.requests.length, asked, "no model request after the purge");
  assert.deepEqual(await Promise.all(ids.map(async (id) => (await w.server.runs.get(id)).costUsd)), booked, "no spend booked after the purge");
});

test("a learning child still at work at its deadline (its start + LEARNING_CHILD_MS, on the runner's clock) is cancelled by its runner as a person's cancel is: it ends cancelled, nothing more reaches the gateway, its spend booked once, and the run reads ended", { timeout: 240_000 }, async (t) => {
  // The runner's clock for learning deadlines, injected: real time until the test moves it past every replay's deadline.
  let ahead = 0;
  const w = await world(t, { prior: 6, hold: (body) => body.includes('"name":"submit"'), learningClock: () => Date.now() + ahead });
  await w.keyed("run-1", "What is six times seven", 5);
  await w.ended("run-1");
  const replays = await until(async () => {
    const rows = await w.children("replay");
    return rows.length === 6 && w.front.waiting.size === 6 && rows;
  }, "six replay runs, each held at its node's request");
  const ids = replays.map((row) => row.id);
  const running = (await w.view("run-1")).learning_work;
  assert.equal(running.state, "running");
  assert.ok(Date.parse(running.deadline_at) > Date.now(), `deadline_at set, ahead: ${JSON.stringify(running)}`);
  for (const id of ids) {
    const { state } = await w.server.runs.get(id);
    assert.ok(state === "running" || state === "queued", `${id} still at work before its deadline: ${state}`);
  }
  const nodes = () => w.gw.requests.filter((request) => offers(request.body, "submit")).length;
  assert.equal(nodes(), 0, "every node request held at the front: none reached the gateway");
  // Past every replay's deadline on the runner's clock: each is cancelled, the held request never sent on.
  ahead = LEARNING_CHILD_MS + 60_000;
  for (const id of ids) {
    const row = await w.ended(id);
    assert.deepEqual([row.state, row.outcome], ["stopped", "cancelled"], `replay ${id} cancelled at its deadline: ${JSON.stringify([row.state, row.outcome, row.summary])}`);
    assert.equal((await w.server.runs.launch(id)).sealed, null, `replay ${id}'s copy erased by the write that ends it`);
  }
  const booked = await Promise.all(ids.map(async (id) => (await w.server.runs.get(id)).costUsd));
  const work = (await w.view("run-1")).learning_work;
  assert.deepEqual([work.state, work.runs, work.deadline_at], ["ended", [], null], JSON.stringify(work));
  assert.equal(nodes(), 0, "no node request of a cancelled replay reached the gateway");
  assert.deepEqual(await Promise.all(ids.map(async (id) => (await w.server.runs.get(id)).costUsd)), booked, "each replay's spend booked once, at its end");
  await assertNowhere(w);
});

test("a learning child claimed already past its deadline (queued past it, on the runner's clock) never starts: no loop, no model request, it ends cancelled at spend 0, and the run reads ended", { timeout: 240_000 }, async (t) => {
  // The runner's clock past every child's deadline from the start: each replay is claimed after the bound its run's caller
  // was promised, so none may spend.
  // A slow poll: a sweep of held children (runner.ts endOverdue) comes seconds after a claim, so only a check made before
  // the loop starts keeps a child past its deadline from asking the model.
  const w = await world(t, { prior: 6, learningClock: () => Date.now() + LEARNING_CHILD_MS + 60_000, pollMs: 3_000 });
  await w.keyed("run-1", "What is six times seven", 5);
  await w.ended("run-1");
  const replays = await until(async () => {
    const rows = await w.children("replay");
    return rows.length === 6 && rows;
  }, "six replay runs made");
  // A replay's node asks the model with the workflow's submit tool; the run's own agent turn never offers it.
  const nodes = () => w.gw.requests.filter((request) => offers(request.body, "submit")).length;
  for (const { id } of replays) {
    const row = await w.ended(id);
    assert.deepEqual([row.state, row.outcome], ["stopped", "cancelled"], `replay ${id} cancelled unstarted: ${JSON.stringify([row.state, row.outcome, row.summary])}`);
    assert.equal(row.costUsd ?? 0, 0, `replay ${id} spent nothing: ${row.costUsd}`);
    assert.equal((await w.server.runs.launch(id)).sealed, null, `replay ${id}'s copy erased by the write that ends it`);
  }
  assert.equal(nodes(), 0, "no request of a replay past its deadline reached the gateway");
  const work = await until(async () => {
    const one = (await w.view("run-1")).learning_work;
    return one.state !== "running" && one;
  }, "the run's learning work settles");
  assert.deepEqual([work.state, work.runs, work.deadline_at], ["ended", [], null], JSON.stringify(work));
  await assertNowhere(w);
});

test("a replay that booked spend and lost its runner, claimed again past its deadline, ends cancelled with what it booked: its cost and its check on the run's key stay the run's learning", { timeout: 240_000 }, async (t) => {
  // Each replay's node: its first request answered (a submit its schema refuses) and booked, its second (after that
  // refusal, the tool's result) held at the front, so each has spent when its runner dies. The agent's own runs are
  // answered right at once (no tool result yet).
  const refused = ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: "not a number", sure: true } } } : undefined);
  const w = await world(t, { prior: 6, call: refused, hold: (body) => body.includes('"name":"submit"') && body.includes('"tool_result"'), lease: { leaseMs: 8_000, renewEveryMs: 500, stopMarginMs: 2_000 } });
  await w.keyed("run-1", "What is six times seven", 5);
  await w.ended("run-1");
  const replays = await until(async () => {
    const rows = await w.children("replay");
    return rows.length === 6 && w.front.waiting.size === 6 && rows;
  }, "six replay runs, each held at its node's second request");
  const ids = replays.map((row) => row.id);
  // The runner dies with every replay at work; the next starts past each replay's deadline on its learning clock.
  w.restart(() => Date.now() + LEARNING_CHILD_MS + 60_000);
  for (const id of ids) {
    const row = await w.ended(id);
    assert.deepEqual([row.state, row.outcome], ["stopped", "cancelled"], `replay ${id} cancelled at its claim past its deadline: ${JSON.stringify([row.state, row.outcome, row.summary])}`);
  }
  const spent = (await Promise.all(ids.map((id) => w.server.runs.get(id)))).map((row) => row.costUsd);
  assert.ok(spent.every((usd) => typeof usd === "number" && usd > 0), `each replay ends with what it booked before its runner died: ${spent}`);
  const micro = (usd) => Math.round(usd * 1e6);
  const near = (a, b) => Math.abs(a - b) <= ids.length;
  const total = spent.reduce((sum, usd) => sum + micro(usd), 0);
  const work = await until(async () => {
    const one = (await w.view("run-1")).learning_work;
    return one.state !== "running" && one;
  }, "the run's learning work settles");
  assert.equal(work.state, "ended", JSON.stringify(work));
  const cost = await runAllInOverStore(w.server, "run-1");
  assert.ok(near(micro(cost.check_usd ?? 0), total), `the run's check_usd is what its replays booked (${spent}): ${JSON.stringify(cost)}`);
  const agent = (await agentCostOverStore(w.server, "agent-1")).runs.find((run) => run.run_id === "run-1");
  assert.ok(near(micro(agent?.check_usd ?? 0), total), `and the agent's ledger reads it so: ${JSON.stringify(agent)}`);
  await assertNowhere(w);
});

test("a keyed run its promoted workflow served gets its shadow audit on the run's own key: the shadow's copy sealed for it alone, erased at its end; the run reads ended once it ends", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { learning: { audit_every: 1 }, promoted: true, hold: (body) => !body.includes('"name":"submit"') });
  const before = w.gw.requests.length;
  await w.keyed("served-1", "What is six times seven", 5);
  const served = await w.ended("served-1");
  assert.deepEqual([served.state, served.metrics?.path], ["ended", "workflow"], JSON.stringify(served.metrics));
  const [shadow] = await until(async () => {
    const rows = await w.children("audit");
    return rows.length === 1 && w.front.waiting.size >= 1 && rows;
  }, "the shadow, at its first request");
  const sealed = (await w.server.runs.launch(shadow.id)).sealed;
  assert.equal(openRunLaunch(SEAL_KEY, shadow.id, sealed)?.model?.key, RUN_KEY, "the shadow's copy of the run's key");
  assert.equal(openRunLaunch(SEAL_KEY, "served-1", sealed), undefined, "sealed for the shadow alone");
  const going = (await w.view("served-1")).learning_work;
  assert.deepEqual([going.state, going.runs, going.ended_at], ["running", [shadow.id], null], JSON.stringify(going));
  assert.ok(Date.parse(going.deadline_at) - LEARNING_CHILD_MS >= served.startedAt, `the shadow's start + LEARNING_CHILD_MS: ${JSON.stringify(going)}`);
  w.front.release();
  const ended = await w.ended(shadow.id);
  assert.deepEqual([ended.state, ended.metrics?.path], ["ended", "audit"], JSON.stringify(ended));
  assert.equal((await w.server.runs.launch(shadow.id)).sealed, null, "the shadow's copy erased at its end");
  const asked = w.gw.requests.slice(before);
  assert.ok(asked.some((request) => !offers(request.body, "submit")), "the shadow asked the agent");
  assert.deepEqual([...new Set(asked.map(keyOf))], [RUN_KEY], "the served run and its shadow both ran on the run's own key");
  assert.deepEqual((await w.view("served-1")).learning_work, { state: "ended", runs: [], ended_at: new Date(ended.endedAt).toISOString(), deadline_at: null });
  await assertNowhere(w);
});

test("a keyed run whose cap leaves too little for its check drops it (no_budget): no replay, nothing reserved, the run reads ended", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { prior: 6 });
  await w.keyed("tight-1", "What is six times seven", 0.03);
  await w.ended("tight-1");
  const work = await until(async () => {
    const one = (await w.view("tight-1")).learning_work;
    return one.state !== "running" && one;
  }, "the run's learning work settles");
  assert.equal(work.state, "ended", JSON.stringify(work));
  assert.deepEqual(work.runs, []);
  assert.ok(Date.parse(work.ended_at) > 0, JSON.stringify(work));
  assert.ok(w.logs.some((line) => /answer at \w+ is not checked: what this run's cap leaves is too little for 6 replay runs on its own key, or not known \(no_budget\)/.test(line)), w.logs.join("\n"));
  assert.deepEqual(await w.children("replay"), [], "no replay run made");
  assert.deepEqual((await promotionsOf(w.server.learning, "agent-1")).filter((one) => one.digest === DIGEST), [], "nothing reserved: a later claim checks it");
  await assertNowhere(w);
});

test("a keyed run its promoted workflow served, whose cap leaves under a run's smallest cap, starts no shadow: it drops it (no_budget), nothing reaches the gateway for it, and the run reads ended", { timeout: 240_000 }, async (t) => {
  // Each request $0.039 (8000 in at $3/M, 1000 out at $15/M): a served run's step needs $0.04 of room before it, so its
  // end can leave under RUN_CAP_MIN_USD only when what it spends is near what it held.
  const w = await world(t, { learning: { audit_every: 1 }, promoted: true, usage: { input: 8_000, output: 1_000 } });
  // What a served run costs on this gateway: one served at a roomy cap, with its shadow.
  await w.keyed("served-0", "What is six times seven", 5);
  const roomy = await w.ended("served-0");
  assert.equal(roomy.metrics?.path, "workflow", JSON.stringify(roomy.metrics));
  await until(async () => {
    const rows = await w.children("audit");
    return rows.length === 1 && FINAL.includes((await w.server.runs.get(rows[0].id))?.state);
  }, "the roomy run's shadow ended");
  assert.ok(roomy.costUsd > 0, JSON.stringify(roomy.costUsd));
  // The same run capped so that what its cap leaves at its end is under RUN_CAP_MIN_USD ($0.01).
  const capUsd = Math.round((roomy.costUsd + RUN_CAP_MIN_USD / 2) * 1e6) / 1e6;
  const before = w.gw.requests.length;
  await w.keyed("tight-1", "What is six times seven", capUsd);
  const served = await w.ended("tight-1");
  assert.deepEqual([served.state, served.metrics?.path], ["ended", "workflow"], JSON.stringify([served.state, served.metrics]));
  const work = await until(async () => {
    const one = (await w.view("tight-1")).learning_work;
    return one.state !== "running" && one;
  }, "the run's learning work settles");
  assert.equal(work.state, "ended", `a shadow dropped for want of budget ends the run's learning work: ${JSON.stringify(work)}`);
  assert.deepEqual([work.runs, work.deadline_at], [[], null], JSON.stringify(work));
  assert.ok(Date.parse(work.ended_at) > 0, JSON.stringify(work));
  const [dropped, ...more] = await learningChildrenOf(w.server.settings, "tight-1");
  assert.deepEqual([dropped?.run, dropped?.kind, dropped?.keyed, dropped?.dropped, more.length], [null, "shadow", true, "no_budget", 0], JSON.stringify([dropped, ...more]));
  assert.deepEqual((await w.children("audit")).map((row) => row.id), ["audit.served-0"], "no shadow of the tight run was made");
  assert.ok(w.logs.some((line) => /no shadow: its cap leaves \$[\d.]+, under a run's smallest cap \(no allowance\)/.test(line)), w.logs.join("\n"));
  const asked = w.gw.requests.slice(before);
  assert.equal(asked.length, Math.round(served.costUsd / 0.039), `each request the gateway saw is one the served run paid for, none a shadow's: ${served.costUsd}`);
  assert.deepEqual([...new Set(asked.map(keyOf))], [RUN_KEY], "only the run's own requests, on its own key");
  await assertNowhere(w);
});

test("an unkeyed run on a keyless server starts no learning work on any key: its check is skipped in words, and it reads none", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { prior: 6 });
  await w.server.runs.create({ id: "plain-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Plain?", question: "Plain" }, title: "Plain", place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, learning: startAt((await seedOf(w.dir, w.server, "agent-1")).sha) } });
  await w.ended("plain-1");
  assert.ok(w.logs.some((line) => /replay check is skipped: it is tied to no run's model key, and this server holds none of its own/.test(line)), w.logs.join("\n"));
  assert.deepEqual(await w.children("replay"), []);
  const work = await until(async () => {
    const one = (await w.view("plain-1")).learning_work;
    return one.state !== "running" && one;
  }, "the run's learning settles");
  assert.notEqual(work.state, "running");
  assert.deepEqual(work.runs, []);
});
