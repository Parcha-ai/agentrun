// A server note (the replaced computer's, the spend cap's wrap-up) counts as told only once a request carrying it is
// answered by the model. pi through the runner's adapter loop and the session's model proxy, its upstream a scripted
// Anthropic origin: when the request that carries the note fails (an upstream 429), pi's retry carries it, the run's
// timeline shows it once, and no later request carries it; a request that is answered tells it once, as before.
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
/** Their rows on the run's timeline, the server's. */
const COMPUTER_ROW = /^AgentRun: Your computer was replaced/;
const WRAP_UP_ROW = /^AgentRun: (?:About \$|This run's budget)/;

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

/** An upstream whose first `fails` requests get Anthropic's 429 (a rate limit), then `scripted`'s answers; every body
 *  sent to it in `bodies`, the failed ones included. */
const failingFirst = (fails, scripted, bodies) => {
  let seen = 0;
  return async (url, init = {}) => {
    if (++seen > fails) return scripted(url, init);
    bodies.push(JSON.parse(String(init.body ?? "{}")));
    return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited upstream." } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } });
  };
};

/** A pi run on Sonnet 5.5's price, its first `fails` requests failing with a 429: a read, then an answer. `replaced`: its
 *  computer replaced an earlier claim's. `maxCostUsd`: its cap. Its requests' bodies, and its timeline's summaries. */
async function piRun(t, { fails, replaced = false, maxCostUsd }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-note-told-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const launch = { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, ...(maxCostUsd === undefined ? {} : { max_cost_usd: maxCostUsd }) };
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: DESKTOP, tools: ["read"] } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const bodies = [];
  const scripted = scriptedOrigin([{ call: "read", args: { path: "a.txt" } }, { say: "done" }], bodies);
  // Sonnet 5.5's route and price, its upstream the scripted origin: nothing leaves loopback.
  const priced = await routeOf("anthropic/claude-sonnet-5-5", { ANTHROPIC_API_KEY: "fake-test-key" });
  const route = { ...priced, provider: { ...priced.provider, origin: "https://route.invalid" }, fetch: failingFirst(fails, scripted, bodies) };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: replaced ? replacedClaim : computerForClaim, computerDeps: FAUX_DEPS };
  const runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim), FAST_RETRY) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run is released");
  const said = (await runTimeline(server, RUN, ctx)).map((one) => one.summary).filter((summary) => typeof summary === "string");
  assert.equal(row.state, "ended", `${JSON.stringify(row)}\n${JSON.stringify(said)}`);
  assert.ok(!said.some((summary) => summary.includes("AgentRun server note")), `no row is labelled twice: ${JSON.stringify(said)}`);
  return { bodies, said };
}

const count = (bodies, notes) => bodies.map((body) => (JSON.stringify(body).match(notes) ?? []).length);

// The replaced computer's note on a resumed claim, and the cap's wrap-up, due at step 0 under $0.10 (the first request's
// input and a 4,096-token answer at Sonnet 5.5's price is over a third of it).
const NOTES = [
  { note: "the replaced computer's note", run: { replaced: true }, notes: COMPUTER_NOTES, row: COMPUTER_ROW },
  { note: "the cap's wrap-up", run: { maxCostUsd: 0.1 }, notes: WRAP_UP_NOTES, row: WRAP_UP_ROW },
];

for (const { note, run, notes, row } of NOTES) {
  test(`pi, ${note}: the request carrying it gets a 429, pi's retry carries it, one row, and no later request carries it`, { timeout: 120_000 }, async (t) => {
    const { bodies, said } = await piRun(t, { fails: 1, ...run });
    assert.equal(bodies.length, 3, "the failed request, its retry (a read), then the answer");
    assert.deepEqual(count(bodies, notes), [1, 1, 0], "the retry carries the note the failed request gave back; the request after the answer does not");
    assert.equal(said.filter((summary) => row.test(summary)).length, 1, `one row: ${JSON.stringify(said)}`);
  });

  test(`pi, ${note}: the request carrying it is answered: told once, one row, and no later request carries it`, { timeout: 120_000 }, async (t) => {
    const { bodies, said } = await piRun(t, { fails: 0, ...run });
    assert.equal(bodies.length, 2, "a read, then the answer");
    assert.deepEqual(count(bodies, notes), [1, 0], "the first request carries it, the next does not");
    assert.equal(said.filter((summary) => row.test(summary)).length, 1, `one row: ${JSON.stringify(said)}`);
  });
}
