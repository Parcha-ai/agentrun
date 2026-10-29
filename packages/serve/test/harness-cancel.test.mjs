// A cancel holds on every harness: a run on codex or claude-agent whose cancel mark is down sends no model request,
// whatever starts its turn (a message, or a recovery the run's process starts itself), as pi's runs do (request-start.ts).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { modelPortFor, RUNNER_RECORDS } from "@parcha/agentrun-adapters";
import { fauxAdapter } from "@parcha/agentrun-adapters/testing";
import { timelineOf } from "@parcha/pi-durable-agent/timeline";
import { RUN_CANCELLED } from "../dist/files.js";
import { adapterRun } from "../dist/harness-app.js";
import { durableSessions } from "../dist/sessions.js";
import { agent, FAUX, follow, serve, withEnv } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

const runOf = (harness) => ({ harness, env: async () => ({ confinePrefix: () => ["/usr/bin/setpriv", "--no-new-privs", "--"] }) });

for (const harness of ["codex", "claude-agent"]) {
  test(`a cancelled run on ${harness} sends no model request: its turn ends on the refusal, with nothing sent or paid`, async () => {
    const adapter = fauxAdapter({ script: () => [{ say: "Hi.", usd: 0.001 }] });
    let cancelled = false;
    const app = adapterRun(async () => adapter, harness, { key: "run:1", label: "a", system: ["Answer."], context: "fresh" }, ctx, undefined, [], undefined, undefined, () => cancelled);
    const durable = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: {} }, ctx);
    const events = [];
    app.door.attach((e) => events.push(e.type));
    await app.onOpen(runOf(durable));
    // The cancel lands after the open, before the turn's first request leaves.
    cancelled = true;
    const door = { run: { harness: durable }, signal: new AbortController().signal, emit: (e) => events.push(e.type), adopt: () => {} };
    assert.deepEqual(await app.door.submit({ requestId: "m1", content: "hello", whenBusy: "followUp" }, door), { accepted: true });
    for (let i = 0; !events.includes("run_end") && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(events.includes("run_end"), `the turn ended: ${events.join(", ")}`);
    assert.equal(adapter.requests, 0, "no model request was sent");
  });
}

for (const harness of ["codex", "claude-agent"]) {
  test(`a cancel that lands after its check passed and before the request's record is written: on ${harness} the request is not sent, and nothing is booked`, async () => {
    const adapter = fauxAdapter({ script: () => [{ say: "Hi.", usd: 0.001 }] });
    let cancelled = false;
    // The cap is asked right after the cancel check passed: the cancel lands there, before the runner writes the record.
    const cap = { beforeRequest: () => void (cancelled = true) };
    const app = adapterRun(async () => adapter, harness, { key: "run:1", label: "a", system: ["Answer."], context: "fresh" }, ctx, undefined, [], undefined, cap, () => cancelled);
    const durable = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: {} }, ctx);
    const events = [];
    app.door.attach((e) => events.push(e.type));
    await app.onOpen(runOf(durable));
    const door = { run: { harness: durable }, signal: new AbortController().signal, emit: (e) => events.push(e.type), adopt: () => {} };
    assert.deepEqual(await app.door.submit({ requestId: "m1", content: "hello", whenBusy: "followUp" }, door), { accepted: true });
    for (let i = 0; !events.includes("run_end") && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(events.includes("run_end"), `the turn ended: ${events.join(", ")}`);
    assert.equal(adapter.requests, 0, "no model request was sent");
    const entries = [];
    const conversation = await durable.conversation(ROOT_CONVERSATION_ID, ctx);
    for (let cursor; ; ) {
      const page = await conversation.entries({ order: "ascending" }, 500, cursor, ctx);
      entries.push(...page.items);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    const assistant = entries.flatMap((e) => (e.model ?? []).filter((m) => m.role === "assistant"));
    assert.equal(assistant.filter((m) => m.stopReason !== "error").length, 0, "no request was booked");
    assert.match(assistant.map((m) => m.errorMessage ?? "").join(" "), /the run was cancelled/, "the turn ended on the cancel");
  });
}

for (const harness of ["codex", "claude-agent"]) {
  test(`the run's app on ${harness} reads the cancel serve writes: built on a cancelled run's directory, its turn sends nothing`, { timeout: 90_000 }, async (t) => {
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
    assert.equal((await api("POST", "/agents", agent("calc", { harness }))).status, 201);
    const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "hello" } });
    await follow(api, run.run_id, ["completed"]);
    // The run's directory holds its revision; cancelling it writes the mark there, which the app's guard reads.
    const root = join(data, "runs", run.run_id);
    await writeFile(join(root, RUN_CANCELLED), "");
    withEnv(t, { AGENTRUN_SERVE_FAUX: FAUX, AGENTRUN_SERVE_FAUX_HARNESS: FAUX_HARNESS });
    const { default: app } = await import("../dist/app.js");
    const options = await app({ ref: { id: run.run_id }, root, work: join(root, "work"), store: join(root, "store") });
    const durable = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: {} }, ctx);
    const events = [];
    options.door.attach((e) => events.push(e.type));
    await options.onOpen(runOf(durable));
    const door = { run: { harness: durable }, signal: new AbortController().signal, emit: (e) => events.push(e.type), adopt: () => {} };
    assert.deepEqual(await options.door.submit({ requestId: "m1", content: "hello again", whenBusy: "followUp" }, door), { accepted: true });
    for (let i = 0; !events.includes("run_end") && i < 300; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const entries = [];
    const conversation = await durable.conversation(ROOT_CONVERSATION_ID, ctx);
    for (let cursor; ; ) {
      const page = await conversation.entries({ order: "ascending" }, 500, cursor, ctx);
      entries.push(...page.items);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    const assistant = entries.flatMap((e) => (e.model ?? []).filter((m) => m.role === "assistant"));
    assert.deepEqual(assistant.filter((m) => m.stopReason !== "error").length, 0, "no request was booked");
    assert.match(assistant.map((m) => m.errorMessage ?? "").join(" "), /cancelled/, "the turn ended on the cancel");
  });
}

test("a request withdrawn as its record was written is no request when the run opens again: nothing is written for it, and the run has spent $0", async () => {
  const storage = new MemoryStorage();
  // The first process: the cancel lands while the request's record is written, and the runner withdraws the request.
  const first = await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx);
  const writer = await durableSessions(first, ctx).open("run:1");
  let stopped;
  const append = async (records) => {
    if (records.some((r) => r.kind === RUNNER_RECORDS.request)) stopped = new Error("the run was cancelled");
    return writer.append(records);
  };
  const booking = await modelPortFor(writer, { key: "run:1", append, stopped: () => stopped });
  await assert.rejects(booking.models.beforeRequest({ model: "m" }), /cancelled/);
  assert.deepEqual((await writer.read()).filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => r.data), [{ turn: 1, usd: 0, unsent: true }]);
  // The next process opens the run: the withdrawn request is not booked as one.
  const harness = await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx);
  const app = adapterRun(async () => fauxAdapter({ script: () => [] }), "codex", { key: "run:1", label: "a", system: ["Answer."], context: "fresh" }, ctx);
  app.door.attach(() => {});
  await app.onOpen(runOf(harness));
  const entries = [];
  const conversation = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
  for (let cursor; ; ) {
    const page = await conversation.entries({ order: "ascending" }, 500, cursor, ctx);
    entries.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  assert.equal(entries.flatMap((e) => (e.model ?? []).filter((m) => m.role === "assistant")).length, 0, "no answer written for a request that never left");
  const usage = timelineOf(entries, { settled: true }).findLast((r) => r.kind === "usage")?.usage;
  assert.equal(usage?.requests ?? 0, 0, "no request counted");
  assert.equal(usage?.usd ?? 0, 0, "and nothing spent");
});

test("a request that left and was booked at $0 (a free model) is still the run's request when it opens again: counted once, at $0", async () => {
  const storage = new MemoryStorage();
  const first = await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx);
  const writer = await durableSessions(first, ctx).open("run:1");
  const booking = await modelPortFor(writer, { key: "run:1" });
  const ticket = await booking.models.beforeRequest({ model: "m" });
  await booking.models.afterRequest({ input: 10, output: 5, cacheRead: 0, usd: 0 }, ticket);
  assert.deepEqual((await writer.read()).filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => r.data), [{ turn: 1, usd: 0 }]);
  const harness = await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx);
  const app = adapterRun(async () => fauxAdapter({ script: () => [] }), "codex", { key: "run:1", label: "a", system: ["Answer."], context: "fresh" }, ctx);
  app.door.attach(() => {});
  await app.onOpen(runOf(harness));
  const entries = [];
  const conversation = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
  for (let cursor; ; ) {
    const page = await conversation.entries({ order: "ascending" }, 500, cursor, ctx);
    entries.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  assert.deepEqual(timelineOf(entries, { settled: true }).findLast((r) => r.kind === "usage")?.usage, { usd: 0, requests: 1 }, "one request, at $0");
});
