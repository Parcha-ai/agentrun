// A server note (the replaced computer's, the spend cap's wrap-up, the free-model limit's wrap-up) counts as told only
// once a request carrying it is answered by the model. pi through the runner's adapter loop and the session's model
// proxy, its upstream scripted (Anthropic's for Sonnet 5.5, OpenRouter's for a free model):
// - the request that carries the note fails (an upstream 429): pi's retry carries it, the run's timeline shows it once,
//   and no later request carries it;
// - the request that carries it is admitted, then the runner stops before the answer (a server's stop mid-request): the
//   note is not told (no row), and the resumed claim's first request carries it, once;
// - a request that is answered tells it once, as before.
//
// The desktop is --faux's (faux-computers.ts): nothing is rented. pi's retry runs 1 ms apart here, so the retry goes
// out as soon as pi has the 429: the note is given back before the client hears the failure.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const DESKTOP = { kind: "desktop", provider: "faux-desktop" };
const FAUX = fauxComputers();
after(closeOpenSessions);

/** pi's retry with its attempts 1 ms apart, and no retry inside an attempt (support.mjs FAST_MODEL_RETRY). */
const FAST_RETRY = { retry: { enabled: true, maxRetries: 8, baseDelayMs: 1, maxAgentDelayMs: 1 }, stream: { maxRetries: 0 } };

/** Each note of a kind in a request's body (the regex stops at the reminder's closing tag). */
const COMPUTER_NOTES = /AgentRun server note: your computer was replaced[^<]*/g;
const WRAP_UP_NOTES = /AgentRun server note: (?:About \$|This run's budget)[^<]*/g;
const FREE_NOTES = /AgentRun server note: \d+ free-model requests? left[^<]*/g;
/** Their rows on the run's timeline, the server's. */
const COMPUTER_ROW = /^AgentRun: Your computer was replaced/;
const WRAP_UP_ROW = /^AgentRun: (?:About \$|This run's budget)/;
const FREE_ROW = /^AgentRun: \d+ free-model requests? left/;

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const FAUX_DEPS = {
  kinds: FAUX.kinds,
  keyTable: FAUX.keyTable,
  launch: FAUX.launch,
  providers: {},
  spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open" }),
  check: { readBackOf },
};

/** The shared computerForClaim, its computer marked as one that replaced an earlier claim's. */
const replacedClaim = async (claim, store, deps) => ({ ...(await computerForClaim(claim, store, deps)), replaced: { kind: "desktop", folderKept: false } });

const bodyOf = async (input, init) => JSON.parse(input instanceof Request ? await input.clone().text() : String(init?.body ?? "{}"));

/** OpenRouter's chat completions for a free model, scripted as scriptedOrigin is: a read of a.txt, then "done". */
const freeOrigin = (bodies) => async (input, init) => {
  const body = await bodyOf(input, init);
  bodies.push(body);
  const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
  const chunk = (fields) => `data: ${JSON.stringify({ id: `gen-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: body.model, ...fields })}\n\n`;
  const call = { index: 0, id: `call_${step}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } };
  const said = step === 0
    ? chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
    : chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  const usage = chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
  return new Response(`${said}${usage}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
};

/** An upstream in front of `answering`: its first `fails` requests get a 429 (a rate limit); with `hang`, every request
 *  is held unanswered until its client is cut (`asked` resolves at the first). Every body in `bodies`. */
const upstream = ({ fails = 0, hang = false, asked }, answering, bodies) => {
  let seen = 0;
  return async (input, init = {}) => {
    seen += 1;
    if (!hang && seen > fails) return answering(input, init);
    bodies.push(await bodyOf(input, init));
    if (!hang) return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited upstream." } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } });
    asked?.();
    const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    return await new Promise((_resolve, reject) => {
      const cut = () => reject(Object.assign(new Error("the server stopped"), { name: "AbortError" }));
      if (signal?.aborted) cut();
      signal?.addEventListener("abort", cut, { once: true });
    });
  };
};

const ROUTES = {
  // Sonnet 5.5's route and price, its upstream a scripted Anthropic origin: nothing leaves loopback.
  sonnet: {
    model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    route: async (fetch) => {
      const priced = await routeOf("anthropic/claude-sonnet-5-5", { ANTHROPIC_API_KEY: "fake-test-key" });
      return { ...priced, provider: { ...priced.provider, origin: "https://route.invalid" }, fetch };
    },
    answering: (bodies) => scriptedOrigin([{ call: "read", args: { path: "a.txt" } }, { say: "done" }], bodies),
  },
  // OpenRouter's ling-3.2-flash:free at its $0 listing, its fetch the scripted origin.
  free: {
    model: { provider: "openrouter", modelId: "inclusionai/ling-3.2-flash:free" },
    route: (fetch) => routeOf("openrouter/inclusionai/ling-3.2-flash:free", { OPENROUTER_API_KEY: "fake-test-key" }, "default", undefined, fetch),
    answering: freeOrigin,
  },
};

/** A run on `on`'s route, its computer replaced (`replaced`), under `maxCostUsd`, the runner's env `env`: a read, then
 *  an answer. `start(name, upstreamOptions)` starts a runner whose upstream is `upstream(upstreamOptions)`. */
async function opened(t, { on = "sonnet", replaced = false, maxCostUsd, env = {} }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-note-told-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const { model, route, answering } = ROUTES[on];
  const launch = { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "pi", model, ...(maxCostUsd === undefined ? {} : { max_cost_usd: maxCostUsd }) };
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: DESKTOP, tools: ["read"] } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const start = async (name, options, bodies) => {
    const fetch = upstream(options, answering(bodies), bodies);
    const theRoute = await route(fetch);
    const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => theRoute, computerForClaim: replaced ? replacedClaim : computerForClaim, computerDeps: FAUX_DEPS };
    const runner = startRunner({
      store, name, ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
      createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (harness, given) => (harness === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim), FAST_RETRY) : undefined) }),
    });
    t.after(() => runner.close().catch(() => {}));
    return runner;
  };
  const summaries = async () => (await runTimeline(server, RUN, ctx)).map((one) => one.summary).filter((summary) => typeof summary === "string");
  const settled = (states = ["ended", "failed", "stopped", "parked"]) => until(async () => {
    const now = await server.runs.get(RUN);
    return states.includes(now.state) && now.runner === null && now;
  }, `the run is released ${states.join(" or ")}`);
  const raise = (capUsd) => sendCommand(server, RUN, { kind: "raise", body: { capUsd } });
  const leaves = (state) => until(async () => (await server.runs.get(RUN)).state !== state, `the run leaves ${state}`);
  const ended = async () => {
    const row = await settled();
    const said = await summaries();
    assert.equal(row.state, "ended", `${JSON.stringify(row)}\n${JSON.stringify(said)}`);
    assert.ok(!said.some((summary) => summary.includes("AgentRun server note")), `no row is labelled twice: ${JSON.stringify(said)}`);
    return said;
  };
  return { start, summaries, settled, raise, leaves, ended };
}

const count = (bodies, notes) => bodies.map((body) => (JSON.stringify(body).match(notes) ?? []).length);

// The replaced computer's note on a resumed claim; the cap's wrap-up, due at step 0 under $0.10 (the first request's
// input and a 4,096-token answer at Sonnet 5.5's price is over a third of it); the free limit's, due at once under a
// limit of 3 requests (FREE_WRAP_UP_MARGIN: 3 left, the first request included).
const NOTES = [
  { note: "the replaced computer's note", run: { replaced: true }, notes: COMPUTER_NOTES, row: COMPUTER_ROW },
  { note: "the cap's wrap-up", run: { maxCostUsd: 0.1 }, notes: WRAP_UP_NOTES, row: WRAP_UP_ROW, raiseTo: 0.2 },
  { note: "the free limit's wrap-up", run: { on: "free", env: { AGENTRUN_FREE_MODEL_REQUESTS: "3" } }, notes: FREE_NOTES, row: FREE_ROW },
];

for (const { note, run, notes, row, raiseTo } of NOTES) {
  const rows = (said) => said.filter((summary) => row.test(summary)).length;

  test(`pi, ${note}: the request carrying it gets a 429, pi's retry carries it, one row, and no later request carries it`, { timeout: 120_000 }, async (t) => {
    const theRun = await opened(t, run);
    const bodies = [];
    await theRun.start("runner-a", { fails: 1 }, bodies);
    const said = await theRun.ended();
    assert.equal(bodies.length, 3, "the failed request, its retry (a read), then the answer");
    assert.deepEqual(count(bodies, notes), [1, 1, 0], "the retry carries the note the failed request gave back; the request after the answer does not");
    assert.equal(rows(said), 1, `one row: ${JSON.stringify(said)}`);
  });

  test(`pi, ${note}: the request carrying it is admitted, then the runner stops before its answer: no row, and the resumed claim's first request carries it, once`, { timeout: 120_000 }, async (t) => {
    const theRun = await opened(t, run);
    const before = [];
    let asked;
    const inFlight = new Promise((resolve) => (asked = resolve));
    const first = await theRun.start("runner-a", { hang: true, asked }, before);
    await inFlight;
    // The request is admitted (the proxy sent it upstream) and unanswered: the note is not told yet.
    assert.equal(rows(await theRun.summaries()), 0, "no row while the request is out");
    await first.close();
    assert.deepEqual(count(before, notes), [1], "the first claim's request carried it");
    assert.equal(rows(await theRun.summaries()), 0, `the stop told nothing: ${JSON.stringify(await theRun.summaries())}`);
    const resumed = [];
    await theRun.start("runner-b", {}, resumed);
    if (raiseTo !== undefined) {
      // The stopped request is booked at its hold, the whole of what the cap had left: the resume parks for a raise
      // before it sends anything, and the raise resumes it.
      assert.equal((await theRun.settled(["parked"])).state, "parked");
      assert.deepEqual(resumed, [], "the parked claim sent nothing");
      await theRun.raise(raiseTo);
      await theRun.leaves("parked");
    }
    const said = await theRun.ended();
    assert.deepEqual(count(resumed, notes), [1, ...resumed.slice(1).map(() => 0)], "the resume's first request carries it once; no later one");
    assert.equal(rows(said), 1, `one row: ${JSON.stringify(said)}`);
  });

  test(`pi, ${note}: the request carrying it is answered: told once, one row, and no later request carries it`, { timeout: 120_000 }, async (t) => {
    const theRun = await opened(t, run);
    const bodies = [];
    await theRun.start("runner-a", {}, bodies);
    const said = await theRun.ended();
    assert.equal(bodies.length, 2, "a read, then the answer");
    assert.deepEqual(count(bodies, notes), [1, 0], "the first request carries it, the next does not");
    assert.equal(rows(said), 1, `one row: ${JSON.stringify(said)}`);
  });
}
