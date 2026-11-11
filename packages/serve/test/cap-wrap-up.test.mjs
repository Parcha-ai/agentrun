// The cap's wrap-up (tool-budget.ts wrappingUp): once a capped run's spend plus what its requests still out hold leaves
// too little to keep back one typical step and one final answer at its least (reserveFor), the run's tool gate refuses
// every call the model makes, in one fixed text, in every
// conversation of the run (a delegate's spawn of a child conversation, as a `subagent` spawn, included). Children in
// flight are not cut: their own next calls are refused and they answer, and the parent's final answer still lands under
// the cap. The figure is read from the run's booking records, so a claim moved to another runner holds the same line. A
// run with no cap is unchanged.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { closeOpenSessions, hostTools, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { sleep, STEADY_LEASE, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { suiteTools, MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { reserveFor, TOOL_BUDGET_TEXT, WRAP_UP_TEXT, wrappingUp } = await import("../dist/tool-budget.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

// The model as the cap prices it: output only, so a request's hold is its output limit at that price and its bound is 0.
// Each request asks for OUTPUT tokens and is held at HOLD; the provider bills each answer at BILLED (the adapter's price).
const OUTPUT = 4_096;
const priced = (holdUsd) => Object.freeze({ id: MODEL, api: "anthropic-messages", price: { input: 0, output: (holdUsd / OUTPUT) * 1e6 }, outputCeiling: OUTPUT });
/** The cap's least answer for a request held at `hold` (output only: ANSWER_TOKENS_LEAST of its OUTPUT), and the reserve
 *  a run with typical answers at `typical` keeps back (tool-budget.ts reserveFor), as the cases derive their lines. */
const LEAST_TOKENS = 1_024;
const reserveAt = (hold, typical) => reserveFor({ leastUsd: (hold * LEAST_TOKENS) / OUTPUT, step0Usd: hold, worstUsd: hold }, () => typical);
/** An origin billed as a provider bills: each answer at `billed`, never more than the output its request was limited to
 *  (its body's max_tokens, which the cap writes), in output tokens at the model's price, so the cap's books are real. */
const billedAt = (fetch, billed, hold, bills = []) => async (url, init) => {
  const limit = Number(JSON.parse(String(init.body)).max_tokens ?? OUTPUT);
  const tokens = Math.min(Math.round((billed / hold) * OUTPUT), limit);
  bills.push((tokens * hold) / OUTPUT);
  const sent = await fetch(url, init);
  const text = (await sent.text()).replace(/"usage":\{"output_tokens":\d+\}/g, `"usage":{"output_tokens":${tokens}}`);
  return new Response(text, { status: sent.status, headers: sent.headers });
};

/** Every tool result the provider got, in order, by the request that first carried it: its text and whether it is an error. */
function resultsIn(requests) {
  const seen = new Map();
  for (const body of requests) {
    for (const part of (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))) {
      if (part.type !== "tool_result" || seen.has(part.tool_use_id)) continue;
      const blocks = typeof part.content === "string" ? [{ type: "text", text: part.content }] : part.content ?? [];
      seen.set(part.tool_use_id, { text: blocks.filter((block) => block.type === "text").map((block) => block.text).join(""), isError: part.is_error === true });
    }
  }
  return [...seen.values()];
}
const texts = (requests) => resultsIn(requests).map((result) => result.text);

// A native tool that opens a conversation of its own, as a `subagent` does (owned by its call's task, on the session's
// model, with the session's read tool), sends it "child task <n>" and answers with its last words. Its calls run at once.
const CHILD = "child task";
const delegate = defineExtension({
  name: "test-delegate",
  tools: [
    defineTool({
      name: "delegate",
      description: "Hands a task to a conversation of its own.",
      parameters: { type: "object", properties: { n: { type: "number" } } },
      replay: "safe",
      executionMode: "parallel",
      execute: async (args, api, context) => {
        const parent = await api.agent(context);
        const child = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, created.id, { model: parent.model, tools: parent.tools.filter((tool) => tool.name === "read"), modelTools: null, instructions: "Follow the script." });
          return created.id;
        }, context);
        const handle = await api.conversation(child, context);
        const settled = await (await handle.submit({ type: "input", content: `${CHILD} ${args.n}`, requestId: `delegate:${String(api.taskId)}` }, context)).wait(context);
        const answer = settled.answer === undefined ? undefined : await api.commit((tx) => tx.entry(settled.answer), context);
        const said = answer?.model?.findLast((message) => message.role === "assistant")?.content?.map((part) => part.text ?? "").join("") ?? "";
        return { output: [{ type: "text", text: said }] };
      },
    }),
  ],
});
/** Which child a request is (its first message names it), or 0 for the root's. */
const childOf = (body) => Number(/child task (\d+)/.exec(JSON.stringify(body.messages?.[0] ?? {}))?.[1] ?? 0);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

/** A store with run-1 queued, a runner on the adapter loop under `capUsd` (undefined: no cap), the model held at `hold`
 *  and billed at `billed` a request, its root and children answered by `fetch`. `judged`: each request the cap judged. */
async function wrapRun(t, { capUsd, hold, billed, fetch, tools, onLedger, model, price }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-cap-wrap-up-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Wrap" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const judged = [];
  const loop = createAdapterLoop((_claim, run) => (onLedger?.(run.ledger), {
    adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" }, fetch, price: price ?? (() => billed), extensions: [delegate] }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
    input: "Follow the script.",
    runCap: { capUsd: () => capUsd, modelOf: () => model ?? priced(hold), judged: (request, answer) => void judged.push(answer) },
    hooks: quiet,
    gate: () => "allow",
  }), { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state !== "running" && now.state !== "queued" && now.runner === null && now;
  }, "the run settled", 30_000);
  return { row, judged };
}

// The root hands three children their tasks at once, then would hand a fourth, then answers. Child 1 would read six
// times; children 2 and 3 answer at once, but their first requests stay out (held) until child 1's first call is
// answered, so child 1 works while their reservations sit on the cap: what a parent's fan-out does to a small cap.
const ROOT = [{ calls: [{ call: "delegate", args: { n: 1 } }, { call: "delegate", args: { n: 2 } }, { call: "delegate", args: { n: 3 } }] }, { call: "delegate", args: { n: 4 } }, { say: "root answer from what the children found" }];
const CHILD_1 = [...Array.from({ length: 6 }, () => ({ call: "read" })), { say: "child 1 done" }];
const CHILD_N = (n) => [{ say: `child ${n} done` }];

/** Whether a request's newest tool result is the wrap-up's refusal: a model that reads it answers. */
const toldToWrapUp = (body) => resultsIn([body]).at(-1)?.text === WRAP_UP_TEXT;

/** The fan-out's origin: the root's and each child's scripts, children 2 and 3 held out until child 1's first call is
 *  answered. Child 1 answers as soon as it reads the wrap-up's refusal, as a model told to does. */
function fanOut() {
  const requests = { 0: [], 1: [], 2: [], 3: [], 4: [] };
  const origins = { 0: scriptedOrigin(ROOT, requests[0]), 1: scriptedOrigin(CHILD_1, requests[1]), 2: scriptedOrigin(CHILD_N(2), requests[2]), 3: scriptedOrigin(CHILD_N(3), requests[3]), 4: scriptedOrigin(CHILD_N(4), requests[4]) };
  const child1Wraps = scriptedOrigin(Array.from({ length: CHILD_1.length }, () => ({ say: "child 1 done" })), requests[1]);
  const out = { 2: deferred(), 3: deferred() };
  const release = deferred();
  const fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    const which = childOf(body);
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    if ((which === 2 || which === 3) && step === 0) {
      out[which].resolve();
      await release.promise;
    }
    // Child 1 starts once both reservations are out, and lets them go once it answers (its first request with no tool call).
    if (which === 1 && step === 0) await Promise.all([out[2].promise, out[3].promise]);
    if (which !== 1) return origins[which](url, init);
    // Child 1's next request, once its first call has been answered or refused: the reservations go.
    if (step > 0) release.resolve();
    return (toldToWrapUp(body) ? child1Wraps : origins[1])(url, init);
  };
  return { requests, fetch };
}

test("the rule: a capped run wraps up once its spend and holds leave too little to keep back a typical step and a final answer at its least; no cap, a figure unknown, or no reserve yet, never", () => {
  // A request priced at $0.04 for its step-0 answer and $0.01 at its least; its run's typical answer $0.03.
  const figures = { leastUsd: 0.01, step0Usd: 0.04, worstUsd: 0.06 };
  const reserve = reserveFor(figures, () => 0.03);
  assert.ok(Math.abs(reserve - 0.04) < 1e-12, `a typical step and the least answer: ${reserve}`);
  assert.equal(reserveFor(figures, (step0) => step0), 0.05, "before any answer is priced, the step-0 cost is the typical step");
  assert.equal(reserveFor(undefined, () => 0.03), undefined, "a request the cap cannot price keeps nothing back");
  assert.equal(wrappingUp(0.3, 0.26, reserve), false, "$0.26 + $0.04 fits $0.30: past 75%, still working");
  assert.equal(wrappingUp(0.3, 0.27, reserve), true, "$0.27 + $0.04 does not");
  assert.equal(wrappingUp(undefined, 1e6, reserve), false, "no cap");
  assert.equal(wrappingUp(1, null, reserve), false, "a spend no one knows: the cap refuses the next request for that");
  assert.equal(wrappingUp(1, 0.99, undefined), false, "no reserve yet: the cap stays the last line");
  assert.notEqual(WRAP_UP_TEXT, TOOL_BUDGET_TEXT);
});

test("children whose reservations push the run near its cap wrap up: every conversation that started answers, the root answers, no request is refused for the cap, and nothing is billed past it", async (t) => {
  // Cap $1, each request held at $0.30 and billed at $0.13 (never past the output the cap limited it to). What the run keeps
  // back is a typical step and the least answer (reserveAt). When child 1 first calls, the run has spent the root's first
  // request and its own, and children 2 and 3 are still out at their holds; when the root would spawn a fourth child,
  // every request so far is spent. Whether each is refused follows from the rule, not from picked figures.
  const CAP = 1;
  const HOLD = 0.3;
  const BILLED = 0.13;
  const reserve = reserveAt(HOLD, BILLED);
  const child1Refused = wrappingUp(CAP, 2 * BILLED + 2 * HOLD, reserve);
  const fourthRefused = wrappingUp(CAP, 6 * BILLED, reserve);
  const bills = [];
  const { requests, fetch } = fanOut();
  const { tools, ran } = suiteTools();
  const { row, judged } = await wrapRun(t, { capUsd: CAP, hold: HOLD, billed: BILLED, fetch: billedAt(fetch, BILLED, HOLD, bills), tools, price: (_model, usage) => (usage.output * HOLD) / OUTPUT });
  assert.deepEqual([row.state, row.summary], ["ended", null], `the run ended answered, never spend_cap_reached: ${JSON.stringify(row)}`);
  assert.equal(judged.filter((answer) => answer && "refuse" in answer).length, 0, "the cap refused no request");
  // Child 1, starting while children 2 and 3 hold their reservations: its read refused as the rule says, and it answered.
  assert.equal(child1Refused, true, "the rule refuses child 1's call: reservations, not spend, fill the cap");
  assert.equal(ran.read, 0, "no read ran");
  assert.deepEqual(resultsIn(requests[1]), [{ text: WRAP_UP_TEXT, isError: true }]);
  assert.equal(requests[1].length, 2, "child 1 answered on its next request");
  // Children 2 and 3, in flight all along, answered. A fourth child spawns, and answers, only if the rule leaves room.
  assert.equal(requests[2].length, 1);
  assert.equal(requests[3].length, 1);
  assert.equal(requests[4].length, fourthRefused ? 0 : 1, `the fourth spawn follows the rule (refused: ${fourthRefused})`);
  assert.deepEqual(texts(requests[0]), ["child 1 done", "child 2 done", "child 3 done", fourthRefused ? WRAP_UP_TEXT : "child 4 done"], "every child that started answered the root");
  assert.equal(requests[0].length, ROOT.length, "the root answered last");
  // Nothing billed past the cap: each request billed once, at no more than the output the cap let it have.
  const billed = bills.reduce((sum, usd) => sum + usd, 0);
  assert.ok(billed <= CAP + 1e-9, `billed $${billed.toFixed(4)} of a $${CAP} cap`);
});

test("a hold-only reservation still open (a browser session's reserve) counts toward the line, as the cap holds it", async (t) => {
  // Cap $1, each request held and billed at $0.01. The first call reserves most of the cap as a hold-only paid step (what
  // a browser session's reserve is), left open; the next call is refused though the run has spent $0.02.
  let ledger;
  const ran = { read: 0 };
  // The reserve is sized from the rule: once the run has spent its two requests, it leaves a hair less than what the run
  // keeps back (reserveAt), so the next call is refused and the answer still fits.
  const kept = reserveAt(0.01, 0.01);
  const reserveUsd = 1 - 2 * 0.01 - kept + 0.001;
  assert.equal(wrappingUp(1, 2 * 0.01 + reserveUsd, kept), true, "the reserve leaves too little to keep back");
  const tools = {
    reserve: { name: "reserve", replaySafe: false, run: async () => (await ledger.paid.admit({ id: "reserve-1", name: "a browser session", holdUsd: reserveUsd, basis: "its reserve", hold: true }), "reserved") },
    read: { name: "read", replaySafe: true, run: async () => (ran.read++, "read") },
  };
  const requests = [];
  const fetch = scriptedOrigin([{ call: "reserve" }, { call: "read" }, { say: "answered with the reserve still open" }], requests);
  const { row, judged } = await wrapRun(t, { capUsd: 1, hold: 0.01, billed: 0.01, fetch, tools, onLedger: (given) => void (ledger = given) });
  assert.deepEqual([row.state, row.summary], ["ended", null], JSON.stringify(row));
  assert.deepEqual(texts(requests), ["reserved", WRAP_UP_TEXT]);
  assert.equal(ran.read, 0);
  assert.equal(judged.filter((answer) => answer && "refuse" in answer).length, 0, "the cap refused no request");
});

test("a single-agent run under a $0.30 cap spends past 75% and still works: its tools stop only when it can no longer afford a typical step and a final answer, and it answers under the cap", async (t) => {
  // Each request held at $0.04 (its step-0 answer; $0.01 at its least) and billed at $0.03: it keeps back $0.03 + $0.01.
  // Eight reads run ($0.24 spent, past 75% of the cap, $0.28 with what it keeps back); the ninth comes at $0.27 and is
  // refused; the tenth request answers with $0.03 left.
  const CAP = 0.3;
  const BILLED = 0.03;
  const requests = [];
  const { tools, ran } = suiteTools();
  const fetch = scriptedOrigin([...Array.from({ length: 12 }, () => ({ call: "read" })), { say: "answered under the cap" }], requests);
  const fetchTold = scriptedOrigin(Array.from({ length: 4 }, () => ({ say: "answered under the cap" })), requests);
  const { row, judged } = await wrapRun(t, { capUsd: CAP, hold: 0.04, billed: BILLED, tools, fetch: (url, init) => (toldToWrapUp(JSON.parse(String(init.body))) ? fetchTold : fetch)(url, init) });
  assert.deepEqual([row.state, row.summary], ["ended", null], `the run ended answered: ${JSON.stringify(row)}`);
  assert.equal(ran.read, 8, "eight reads ran: past 75% of the cap ($0.24 of $0.30), the run still worked");
  assert.deepEqual(resultsIn(requests).filter((result) => result.text === WRAP_UP_TEXT), [{ text: WRAP_UP_TEXT, isError: true }], "one call refused, the ninth");
  assert.equal(judged.filter((answer) => answer && "refuse" in answer).length, 0, "the cap refused no request: the answer fit");
  assert.ok(requests.length * BILLED <= CAP + 1e-9, `billed $${(requests.length * BILLED).toFixed(2)} of a $${CAP} cap`);
});

test("a $1 run on Sonnet asking 64,000 output tokens a request still calls its tools: what it keeps back is a typical step and the least answer, never a whole worst-case request", async (t) => {
  // Sonnet's prices with a 64,000-token ceiling; pi asks 32,000 output tokens a request, so each is held at about $0.48, its
  // worst case. Keeping back a whole worst-case request (or that and a least answer) would refuse this run's calls from
  // about $0.52 spent. Each request is billed $0.06, so the run keeps back about $0.08: its ten reads ($0.60) all run.
  const sonnet = Object.freeze({ id: MODEL, api: "anthropic-messages", price: { input: 3, output: 15 }, outputCeiling: 64_000 });
  const requests = [];
  const { tools, ran } = suiteTools();
  const fetch = scriptedOrigin([...Array.from({ length: 10 }, () => ({ call: "read" })), { say: "answered after ten reads" }], requests);
  const { row, judged } = await wrapRun(t, { capUsd: 1, hold: 0, billed: 0.06, tools, fetch, model: sonnet });
  assert.deepEqual([row.state, row.summary], ["ended", null], JSON.stringify(row));
  assert.ok(judged[0] && judged[0].holdUsd > 0.4, `its requests are held at their large worst case: ${JSON.stringify(judged[0])}`);
  assert.equal(ran.read, 10, "every read ran");
  assert.equal(resultsIn(requests).filter((result) => result.text === WRAP_UP_TEXT).length, 0, "no call refused");
});

test("a run with no cap is unchanged: every child runs its whole script and every spawn is made", async (t) => {
  const { requests, fetch } = fanOut();
  const { tools, ran } = suiteTools();
  const { row } = await wrapRun(t, { capUsd: undefined, hold: 0.3, billed: 0.13, fetch, tools });
  assert.deepEqual([row.state, row.summary], ["ended", null], JSON.stringify(row));
  assert.equal(ran.read, 6, "child 1 read six times");
  assert.equal(resultsIn(Object.values(requests).flat()).filter((result) => result.text === WRAP_UP_TEXT).length, 0);
  assert.equal(requests[4].length, 1, "the fourth child was spawned");
  assert.deepEqual(texts(requests[0]), ["child 1 done", "child 2 done", "child 3 done", "child 4 done"]);
});

test("the wrap-up holds across a claim moved to another runner: it is read from the run's records, never kept in memory", async (t) => {
  // Cap $1, each request held and billed at $0.25: read and slow run ($0.25, $0.50 taken), the claim is lost while slow is
  // out, and on the next claim the third request's read is refused ($0.75 taken), and the answer is the fourth.
  const CAP = 1;
  const USD = 0.25;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-cap-wrap-up-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const runnerStores = [await openSqliteStore({ dataDir: dir, role: "runner" }), await openSqliteStore({ dataDir: dir, role: "runner" })];
  const runners = [];
  const { tools, ran, letSlowGo, slowStarted } = suiteTools();
  t.after(async () => {
    letSlowGo();
    for (const runner of runners) await runner.close().catch(() => {});
    for (const each of runnerStores) await each.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Wrap" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const requests = [];
  const script = [{ call: "read" }, { call: "slow" }, { call: "read" }, { say: "answered under the cap" }];
  const judged = [];
  const loop = createAdapterLoop((_claim, run) => ({
    adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests), price: () => USD }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
    input: "Follow the script.",
    runCap: { capUsd: () => CAP, modelOf: () => priced(USD), judged: (_request, answer) => void judged.push(answer) },
    hooks: quiet,
    gate: () => "allow",
  }), { restartLimit: MAX_RESTARTS });
  // The first runner on a short lease, lost while slow is out; the second takes the run once it lapses.
  runners.push(startRunner({ store: runnerStores[0], createLoop: loop, name: "runner-a", leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 }));
  await slowStarted;
  runners[0].kill();
  runners.push(startRunner({ store: runnerStores[1], createLoop: loop, name: "runner-b", ...TIMING }));
  await until(async () => (await server.runs.get("run-1")).runner === "runner-b", "the second runner took the run", 10_000);
  letSlowGo();
  let row;
  for (const deadline = Date.now() + 30_000; ; await sleep(20)) {
    row = await server.runs.get("run-1");
    if (row.state !== "running" && row.state !== "queued" && row.runner === null) break;
    assert.ok(Date.now() < deadline, `the run settled: ${JSON.stringify(row)}`);
  }
  assert.deepEqual([row.state, row.summary], ["ended", null], `the run ended answered: ${JSON.stringify(row)}`);
  assert.equal(ran.read, 1, "the read on the new claim was refused");
  assert.deepEqual(resultsIn(requests).at(-1), { text: WRAP_UP_TEXT, isError: true });
  assert.equal(judged.filter((answer) => answer && "refuse" in answer).length, 0, "the cap refused no request");
  assert.ok(requests.length * USD <= CAP, `billed $${requests.length * USD} of a $${CAP} cap`);
});
