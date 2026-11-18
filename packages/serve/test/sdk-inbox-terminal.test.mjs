import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve } from "./support.mjs";
import { SdkRuns } from "../dist/sdk/runs.js";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { runEntries } from "../dist/store-reads/journal.js";

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const proxy = (target, overrides) => new Proxy(target, { get(object, name) {
  if (Object.hasOwn(overrides, name)) return overrides[name];
  const value = Reflect.get(object, name, object);
  return typeof value === "function" ? value.bind(object) : value;
} });
const completion = { status: "completed", answer: "The application finished its paid task.", usage: { input_tokens: 12, output_tokens: 7, cost_usd: 0.025 } };
const batch = { sequence: 1, events: [{ type: "tool", id: "one", name: "lookup", status: "completed", output: "done" }] };

async function fixture(t, runtime, learning = false) {
  const server = await serve(t, { runner: false }), { api, store } = server;
  const definition = { id: "sdk-inbox", name: "SDK inbox", instructions: "Use application policy.", sdk: { runtime }, learning, tools: [] };
  assert.equal((await api("POST", "/agents", { definition })).status, 201);
  const started = await api("POST", "/agents/sdk-inbox/sdk-runs", { runtime, input: "A paid application task.", instructions: "Keep the whole application policy." }, { "Idempotency-Key": "inbox" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = started.body.run_id, key = `sdk-run:${id}`, launch = (await store.runs.launch(id)).body;
  let routes = 0;
  const loop = (observed = store, journal, signal = new AbortController().signal) => createSdkLoop(launch, { store: observed, data: server.data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => {
    routes++; assert.fail("This control must not dispatch reflection or grading");
  })({ journal: claim => journal?.(claim) ?? store.journal(claim), flush: () => store.flush(), signal });
  const sdk = observed => new SdkRuns(observed ?? store, server.data, "fake-test-key");
  return { ...server, id, key, launch, loop, sdk, routes: () => routes };
}

async function failedUnknown(f, learning = true) {
  const row = await f.store.runs.get(f.id);
  assert.equal(row.state, "failed"); assert.equal(row.costUsd, null); assert.equal(row.metrics, null);
  const entries = await runEntries(f.store, f.id, BACKGROUND_CONTEXT);
  assert.equal(entries.filter(e => e.kind === "agentrun.end").length, 1);
  assert.ok(!entries.some(e => e.kind === "agentrun.sdk.completion" || e.kind === "agentrun.sdk.reflecting" || e.kind === "runner.request"));
  const proposal = await f.store.learning.proposal(f.id);
  if (learning) { assert.equal(proposal?.turn, null); assert.equal(proposal?.proposal.state, "dropped"); assert.equal(proposal?.proposal.reason, "crashed"); }
  else assert.equal(proposal, undefined);
  assert.equal(f.routes(), 0);
}

for (const runtime of ["claude-agent-sdk", "codex-sdk"]) {
  for (const winner of ["completion", "expiry", "expiry-event"]) {
    test(`${runtime} SDK ${winner} wins the durable inbox race`, { timeout: 30_000 }, async t => {
      const f = await fixture(t, runtime), { store, id, key } = f;
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const inbox = await store.settings.get(key);
      await store.settings.put(key, { ...inbox, expires_at: Date.now() + 1_000 });
      const writing = gate(), write = gate(), reading = gate(), read = gate();
      t.after(() => { write.resolve(); read.resolve(); });
      let firstWrite = true, reads = 0;
      const writer = proxy(store, { settings: proxy(store.settings, { replaceIf: async (...args) => {
        if (firstWrite) { firstWrite = false; writing.resolve(); await write.promise; }
        return store.settings.replaceIf(...args);
      } }) });
      const request = (winner === "expiry-event" ? f.sdk(writer).events(id, batch) : f.sdk(writer).complete(id, completion)).then(value => ({ value }), error => ({ error }));
      await writing.promise; // API has validated and read the old inbox, but has not committed its CAS.
      t.mock.timers.tick(2_000);
      const claim = await store.claim(id, "race", { leaseMs: 60_000 }); assert.ok(claim);
      const reader = proxy(store, { settings: proxy(store.settings, { get: async wanted => {
        const value = await store.settings.get(wanted);
        if (wanted === key && ++reads === 2 && winner === "completion") { reading.resolve(); await read.promise; }
        return value;
      } }) });
      const running = f.loop(reader).start(claim);
      if (winner === "completion") {
        await reading.promise; write.resolve();
        assert.deepEqual(await request, { value: { accepted: true } }); read.resolve();
        assert.equal((await running).state, "ended", "accepted completion wins over a stale expired read");
        const row = await store.runs.get(id); assert.equal(row.costUsd, 0.025); assert.equal(row.metrics.input, 12); assert.equal(row.metrics.output, 7);
        const entries = await runEntries(store, id, BACKGROUND_CONTEXT);
        assert.equal(entries.filter(e => e.kind === "agentrun.sdk.completion").length, 1);
        assert.ok(entries.some(e => e.kind === "agentrun.message" && e.data.text === completion.answer));
        assert.deepEqual(await f.sdk().complete(id, completion), { accepted: true }, "identical completion retry survives terminal state");
        await assert.rejects(f.sdk().complete(id, { ...completion, answer: "changed" }), error => error.code === "idempotency_mismatch");
      } else {
        assert.equal((await running).state, "failed"); write.resolve();
        const result = await request; assert.equal(result.error?.code, "not_continuable", "a request admitted before expiry cannot write after durable closure");
        await failedUnknown(f, false);
        const saved = await store.settings.get(key); assert.equal(saved.completion, undefined); assert.equal(saved.batches.length, 0);
      }
    });
  }
  for (const phase of ["source", "inbox", "journal"]) {
    test(`${runtime} SDK initial ${phase} read failure records unknown cost and an unasked learning drop`, async t => {
      const f = await fixture(t, runtime, true), claim = await f.store.claim(f.id, "early", { leaseMs: 60_000 });
      let failed = false;
      const fail = () => { if (!failed) { failed = true; throw new Error(`Synthetic initial ${phase} read failed.`); } };
      const observed = proxy(f.store, {
        runs: proxy(f.store.runs, { get: async id => { if (phase === "source") fail(); return f.store.runs.get(id); } }),
        settings: proxy(f.store.settings, { get: async key => { if (phase === "inbox") fail(); return f.store.settings.get(key); } }),
      });
      const journal = claim => proxy(f.store.journal(claim), { scanConversations: async (...args) => { if (phase === "journal") fail(); return f.store.journal(claim).scanConversations(...args); } });
      assert.equal((await f.loop(observed, journal).start(claim)).state, "failed");
      assert.equal(failed, true); await failedUnknown(f);
      await assert.rejects(f.sdk().complete(f.id, completion), error => error.code === "not_continuable");
    });
  }
}

for (const boundary of ["close", "end", "claim-lost", "shutdown"]) {
  test(`SDK unavailable ${boundary} leaves an interrupted claim for recovery`, async t => {
    const f = await fixture(t, "codex-sdk", true), { store, key, id } = f;
    const inbox = await store.settings.get(key);
    if (boundary !== "claim-lost") await store.settings.put(key, { ...inbox, expires_at: Date.now() - 1 });
    const claim = await store.claim(id, "old", { leaseMs: 60_000 }); let reached = false;
    if (boundary === "claim-lost") { await store.release(claim); assert.ok(await store.claim(id, "new", { leaseMs: 60_000 })); }
    const observed = proxy(store, { settings: proxy(store.settings, { replaceIf: async (...args) => {
      if (boundary === "close") { reached = true; throw new Error("Synthetic unavailable CAS."); }
      return store.settings.replaceIf(...args);
    } }) });
    const journal = claim => { const real = store.journal(claim); let commits = 0; return proxy(real, { commit: async (...args) => {
      if (boundary === "end" && ++commits === 2) { reached = true; throw new Error("Synthetic unavailable terminal commit."); }
      return real.commit(...args);
    } }); };
    const signal = new AbortController(); if (boundary === "shutdown") signal.abort();
    assert.equal((await f.loop(observed, journal, signal.signal).start(claim)).state, "interrupted");
    if (boundary === "close" || boundary === "end") assert.equal(reached, true);
    assert.equal((await store.runs.get(id)).state, "running");
    assert.equal(await store.learning.proposal(id), undefined);
    assert.ok(!(await runEntries(store, id, BACKGROUND_CONTEXT)).some(e => e.kind === "agentrun.end"));
    if (boundary !== "end") assert.equal((await store.settings.get(key)).closed, undefined, "unavailable or stale writers do not poison the inbox");
    else {
      await store.release(claim); const next = await store.claim(id, "reclaim", { leaseMs: 60_000 });
      assert.equal((await f.loop().start(next)).state, "failed", "a durable close survives a lost terminal commit"); await failedUnknown(f);
    }
    if (boundary === "claim-lost") assert.deepEqual(await f.sdk().complete(id, completion), { accepted: true }, "the healthy new claim's inbox remains writable");
  });
}

test("SDK completion already accepted survives an initial read error and is consumed by a new claim", async t => {
  const f = await fixture(t, "codex-sdk"), { store, id } = f;
  assert.deepEqual(await f.sdk().events(id, batch), { accepted: true });
  assert.deepEqual(await f.sdk().complete(id, completion), { accepted: true });
  const claim = await store.claim(id, "read-error", { leaseMs: 60_000 });
  const observed = proxy(store, { runs: proxy(store.runs, { get: async () => { throw new Error("Synthetic unavailable initial run read."); } }) });
  assert.equal((await f.loop(observed).start(claim)).state, "interrupted");
  assert.equal((await store.runs.get(id)).state, "running"); assert.equal(await store.learning.proposal(id), undefined);
  await store.release(claim); const next = await store.claim(id, "recovery", { leaseMs: 60_000 });
  assert.equal((await f.loop().start(next)).state, "ended"); assert.equal((await store.runs.get(id)).costUsd, 0.025);
  assert.deepEqual(await f.sdk().events(id, batch), { accepted: true });
  await assert.rejects(f.sdk().events(id, { ...batch, events: [] }), error => error.code === "idempotency_mismatch");
  assert.deepEqual(await f.sdk().complete(id, completion), { accepted: true });
  assert.equal((await runEntries(store, id, BACKGROUND_CONTEXT)).filter(e => e.kind === "agentrun.sdk.completion").length, 1);
});

test("SDK durable error closure rejects a completion whose API write was already in flight", async t => {
  const f = await fixture(t, "codex-sdk", true), { store, id } = f;
  const writing = gate(), write = gate(); t.after(() => write.resolve()); let first = true;
  const writer = proxy(store, { settings: proxy(store.settings, { replaceIf: async (...args) => {
    if (first) { first = false; writing.resolve(); await write.promise; }
    return store.settings.replaceIf(...args);
  } }) });
  const request = f.sdk(writer).complete(id, completion).then(value => ({ value }), error => ({ error }));
  await writing.promise;
  const claim = await store.claim(id, "early-error", { leaseMs: 60_000 });
  const reader = proxy(store, { runs: proxy(store.runs, { get: async () => { throw new Error("Synthetic initial source read failed."); } }) });
  assert.equal((await f.loop(reader).start(claim)).state, "failed"); write.resolve();
  assert.equal((await request).error?.code, "not_continuable"); await failedUnknown(f);
});

test("SDK failed completed-end commit preserves accepted answer and usage for reclaim", async t => {
  const f = await fixture(t, "codex-sdk"), { store, id } = f;
  await f.sdk().complete(id, completion); const claim = await store.claim(id, "ending", { leaseMs: 60_000 });
  let refused = false;
  const journal = claim => { const real = store.journal(claim); return proxy(real, { commit: async (...args) => {
    if (!refused && args[0].flat().some(write => write.type === "entry" && write.value.kind === "agentrun.end")) {
      refused = true; throw new Error("Synthetic unavailable completed-end commit.");
    }
    return real.commit(...args);
  } }); };
  assert.equal((await f.loop(store, journal).start(claim)).state, "interrupted"); assert.equal(refused, true);
  assert.equal((await store.runs.get(id)).state, "running");
  await store.release(claim); const next = await store.claim(id, "ending-again", { leaseMs: 60_000 });
  assert.equal((await f.loop().start(next)).state, "ended");
  const row = await store.runs.get(id); assert.equal(row.costUsd, 0.025); assert.equal(row.metrics.input, 12);
  const entries = await runEntries(store, id, BACKGROUND_CONTEXT);
  assert.equal(entries.filter(e => e.kind === "agentrun.sdk.completion").length, 1);
  assert.equal(entries.filter(e => e.kind === "agentrun.end").length, 1); assert.equal(f.routes(), 0);
});
