// pi through the adapter loop: what each answer's booking read gives pi (adapter-loop bookedCost, which pi's
// afterResponse puts on the answer), when the session's proxy books requests no answer of their own follows:
// - a first request the provider fails before any output reached pi (a 429, an overload, a server error, a dropped
//   connection, a stream cut mid-answer): pi-ai retries it inside the attempt (the loop's MODEL_STREAM), so one answer
//   reads the failed request's booking summed with its retry's: nothing booked for an error answer, unknown for a request
//   booked at its hold; the answers after it read their own figures;
// - more consecutive 429s than pi's own default of three retries: pi-ai retries each attempt after the wait the provider's
//   retry-after asks for (the session's proxy passes it on), pi retries the attempt (the loop's MODEL_RETRY), and the run
//   completes: each failed attempt's answer reads nothing booked, and the price is booked once;
// - side requests through the session's model port (one marked side, as a client's summary on another model; one under a
//   host label, as a learned workflow's model node): each books with no answer of its own and is not any answer's, so the
//   next answer reads its own figure alone, and the answers after it read their own, never unknown for the rest of the
//   session. The side requests stay on the run's ledger.
// The origin is a script (no network).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop, MODEL_RETRY } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
// The run ends itself; nothing here waits on the lease.
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
// Binary-exact figures, so a sum compares equal.
const PRICE = 0.25;
const SIDE = 0.125;
const HOSTED = 0.0625;
after(closeOpenSessions);

const errorBody = (status, type, message, headers = {}) => new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers: { "content-type": "application/json", ...headers } });
/** A 429 as a provider at capacity sends it, asking to be retried after `retryAfter` (its retry-after-ms, or retry-after). */
const busy = (retryAfter) => () => errorBody(429, "rate_limit_error", "429 Too Many Requests: fleet capacity exhausted", retryAfter);
const FAILS = {
  "a 429": () => errorBody(429, "rate_limit_error", "429 Too Many Requests: rate limited"),
  "an overload (529)": () => errorBody(529, "overloaded_error", "Overloaded"),
  "a server error (500)": () => errorBody(500, "api_error", "Internal server error"),
  "a dropped connection": () => {
    throw new TypeError("fetch failed");
  },
  "a stream cut mid-answer": () => {
    const start = { type: "message_start", message: { id: "msg_cut", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } };
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`));
        controller.error(new TypeError("terminated"));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  },
};

/** One run of `script` through pi on the adapter loop, every answered request priced PRICE: `fail` fails the first
 *  `fails` requests as FAILS names it, or as the function it is; `retry` the loop's retry policy (default MODEL_RETRY);
 *  `tools` the host's tools, each run given the session's model port. Returns the requests that reached the provider (and
 *  when each did), what each answer's booking read gave pi (at the seam where the loop hands it over), the figures the
 *  run's ledger booked (its runner.turn records), and the run's row. */
async function run(t, script, { fail, fails = 1, retry, tools = {}, beforeBooked } = {}) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-retry-booking-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Booking" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const origin = scriptedOrigin(script);
  const failing = typeof fail === "function" ? fail : FAILS[fail];
  let failed = fail === undefined ? fails : 0;
  let requests = 0;
  const at = [];
  const fetch = async (url, init) => {
    requests += 1;
    at.push(Date.now());
    if (failed < fails) {
      failed += 1;
      return failing();
    }
    return origin(url, init);
  };
  const costs = [];
  let models;
  let booked = [];
  const host = Object.fromEntries(Object.entries(tools).map(([name, run]) => [name, { name, replaySafe: true, ask: false, run: () => run(models) }]));
  const base = piAdapterSpec({ script, tools: host, hooks: quiet }, { fetch, price: () => PRICE });
  const spec = async (claim, given) => {
    const session = await base(claim, given);
    const open = session.adapter.open;
    const adapter = {
      ...session.adapter,
      open: (sessionSpec, io) => {
        models = io.models;
        const bookedCost = async () => {
          if (beforeBooked) await beforeBooked(costs.length, models);
          const usd = await io.bookedCost();
          costs.push(usd);
          // The ledger as this answer read it; the last answer's read is the run's whole ledger.
          booked = (await io.writer.read()).filter((record) => record.kind === "runner.turn").map((record) => record.data.usd);
          return usd;
        };
        return open(sessionSpec, { ...io, bookedCost });
      },
    };
    return { ...session, adapter };
  };
  runner = startRunner({ store, createLoop: createAdapterLoop(spec, { restartLimit: MAX_RESTARTS, ...(retry ? { retry } : {}) }), name: "runner-a", ...TIMING });
  const deadline = Date.now() + 20_000;
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (row.state !== "running" && row.state !== "queued" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}: ${JSON.stringify(costs)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { requests, at, costs, booked, row };
}

/** pi's retry policy at a short delay: MODEL_RETRY's attempts, 10ms apart. */
const FAST = { ...MODEL_RETRY, baseDelayMs: 10, maxAgentDelayMs: 10 };
/** What an answer reads for a request the provider failed before any output and pi-ai's retry of it: an error answer
 *  books nothing, so the retry's price; a request that left and got no answer is booked at its hold, which is no price. */
const RETRIED = { "a 429": PRICE, "an overload (529)": PRICE, "a server error (500)": PRICE, "a dropped connection": null, "a stream cut mid-answer": null };

for (const fail of Object.keys(FAILS)) {
  test(`pi through the adapter: after ${fail} pi-ai retried inside the attempt, its one answer reads the failed request's booking with its retry's, and the answer after it its own`, async (t) => {
    const { requests, costs, row } = await run(t, [{ call: "read" }, { say: "done" }], { fail, tools: { read: async () => "read" } });
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.equal(requests, 3, "the failed request, its retry and the second request reached the provider");
    assert.deepEqual(costs, [RETRIED[fail], PRICE], `one answer for the failed request and its retry, then the next answer: ${JSON.stringify(costs)}`);
  });
}

test("pi through the adapter: twelve consecutive 429s (four attempts of three, past pi's default three retries) are waited out: pi-ai retries each attempt twice, pi the attempt, and the run completes with each failed attempt's answer at $0 and the price booked once", async (t) => {
  const { requests, costs, booked, row } = await run(t, [{ say: "done" }], { fail: busy({ "retry-after-ms": "10" }), fails: 12, retry: FAST });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(requests, 13, "twelve 429s, then the answer");
  assert.deepEqual(costs, [0, 0, 0, 0, PRICE], `four attempts of three 429s each read nothing booked; the fifth, the answer, its price: ${JSON.stringify(costs)}`);
  assert.deepEqual(booked.filter((usd) => usd !== 0), [PRICE], `the price is booked once, every 429 at $0: ${JSON.stringify(booked)}`);
});

test("pi through the adapter: on the loop's own retry policy (MODEL_RETRY), four consecutive 429s, which ended a run on pi's default, are waited out", async (t) => {
  const { requests, costs, row } = await run(t, [{ say: "done" }], { fail: busy({ "retry-after-ms": "10" }), fails: 4 });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(requests, 5, "four 429s, then the answer");
  assert.deepEqual(costs, [0, PRICE], JSON.stringify(costs));
});

test("pi through the adapter: a 429's retry-after, passed on by the session's proxy, is how long pi-ai waits to retry it", async (t) => {
  const { requests, at, costs, row } = await run(t, [{ say: "done" }], { fail: busy({ "retry-after": "1" }) });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(requests, 2, "the 429, then its retry");
  assert.deepEqual(costs, [PRICE], "one answer: the retry was inside the attempt");
  // pi-ai's own first backoff is at most 500ms; the provider asked for a second.
  assert.ok(at[1] - at[0] >= 950, `the retry waited the second the provider asked for: ${at[1] - at[0]}ms`);
});

test("pi through the adapter: side requests between two answers (one marked side, one under a host label) are no answer's: the next answer reads its own price alone, and the answers after it read their own", async (t) => {
  // Requests admitted and booked through the session's model port with no answer of their own.
  const look = async (models) => {
    const side = await models.beforeRequest({ model: "side-model", side: true });
    await models.afterRequest({ input: 10, output: 5, usd: SIDE }, side);
    const hosted = await models.beforeRequest({ model: "side-model", host: "learned_workflow" });
    await models.afterRequest({ input: 10, output: 5, usd: HOSTED }, hosted);
    return "looked";
  };
  const { requests, costs, booked } = await run(t, [{ call: "look" }, { call: "read" }, { say: "done" }], { tools: { look, read: async () => "read" } });
  assert.equal(requests, 3, "three answered requests reached the provider");
  assert.deepEqual(costs, [PRICE, PRICE, PRICE], "each answer reads its own price: never unknown, never a side request's");
  assert.deepEqual(booked, [PRICE, SIDE, HOSTED, PRICE, PRICE], "the side requests stay on the run's ledger");
});

test("pi through the adapter: a side request booked after the turn's answer, last on the ledger when the answer's booking reads, is no answer's: the answer reads its own price, never the side request's", async (t) => {
  // The host's own request beside pi's (a learned workflow's model node), admitted while pi answered and booked only as
  // pi idles on its next answer, so its runner.turn lands after that answer's own and is the last turn on the ledger.
  // Reading the last turn alone would book the side figure as the answer's cost; the answer reads only its own.
  let ticket;
  const arm = async (models) => {
    ticket = await models.beforeRequest({ model: "side-model", side: true });
    return "armed";
  };
  // Book the armed side request as the second answer ("done") hands its booking over, once its own turn is on the ledger.
  const beforeBooked = async (answer, models) => {
    if (answer === 1 && ticket) {
      await models.afterRequest({ input: 10, output: 5, usd: SIDE }, ticket);
      ticket = undefined;
    }
  };
  const { costs, booked } = await run(t, [{ call: "arm" }, { say: "done" }], { tools: { arm }, beforeBooked });
  assert.deepEqual(costs, [PRICE, PRICE], "each answer reads its own price; the second never reads the side request booked last");
  assert.deepEqual(booked, [PRICE, PRICE, SIDE], "the side request stays on the run's ledger, last");
});
