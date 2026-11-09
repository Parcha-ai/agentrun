// The browser's money on the runner: bound with the claim's one-ledger booking on its ToolHost (host.paid), tools.ts hands
// it to browserSpend, so a browser call is held and settled on THAT booking and its session's release settles there too,
// before the run's release returns; the process's own spend (cap.ts paidCall, the old per-run process's) is never asked.
// An unpriced provider under the run's cap is refused before any session is made. The booking is the kernel cap's own
// (runCap over a memory session store, as paid-calls-run-ledger.test.mjs opens it), recorded as it is called; the
// browser runs on a pi-durable Harness with a faux model that opens a session (snapshot), on the faux browser.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import * as faux from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { scratch, withEnv } from "./support.mjs";

const { TOOLS, FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { hostLifecycle } = await import("../dist/runner/adapter-loop.js");
const { priceEnvOf } = await import("../dist/browser-cost.js");
const { useSpend } = await import("../dist/cap.js");
const kernelCap = await import("../../run-adapters/dist/kernel/cap/index.js");

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const T0 = Date.parse("2026-11-09T04:00:00Z");
/** Enough turns of the event loop that a release that does not wait for its settles has returned first. */
const YIELDS = 5_000;

/** The claim's one ledger (the kernel cap's paid calls under a `capUsd` cap), every admit and settle noted in `seen`. */
async function ledger(capUsd = 1) {
  const store = memorySessionStore();
  const tools = await kernelCap.runCap({ sessions: store, capUsd: () => capUsd, now: () => T0, modelOf: () => undefined }).tools(await store.open(kernelCap.TOOL_SESSION));
  const seen = [];
  // A settle is held back while the run's release has not returned (at most YIELDS turns of the event loop), so a release
  // that does not wait for its charges' settles is seen returning first.
  let released = false;
  const paid = {
    admit: async (request) => {
      seen.push({ op: "admit", id: request.id, name: request.name, holdUsd: request.holdUsd });
      return tools.admit(request);
    },
    settle: async (id, usd) => {
      for (let i = 0; i < YIELDS && !released; i += 1) await new Promise((resolve) => setImmediate(resolve));
      seen.push({ op: "settle", id, usd });
      return tools.settle(id, usd);
    },
  };
  return { paid, seen, spent: () => tools.spentUsd(), released: () => void ((released = true), seen.push({ op: "released" })) };
}

/** The process's own spend (the old per-run path's, cap.ts useSpend), noting every read and charge: a runner never uses it. */
function processSpend(t) {
  const asked = [];
  useSpend({ cap: 100, spent: () => (asked.push("spent"), 0), held: () => 0, add: (usd) => void asked.push(`add ${usd}`) });
  t.after(() => useSpend(undefined));
  return asked;
}

/** The browser bound as the runner binds it, with `paid` on its ToolHost, on a Harness; one turn that opens a session. */
async function browse(t, { paid, env = {} }) {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  writeFileSync(log, "");
  withEnv(t, { FAUX_BROWSER_LOG: log }, ["FAUX_BROWSER_LOG"]);
  const root = join(dir, "run");
  mkdirSync(join(root, "work"), { recursive: true });
  const lifecycle = hostLifecycle();
  const registry = createRegistry();
  const host = { where: { root, work: join(root, "work"), ref: { id: "run-1" } }, env: { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER, [TOOL_PLANE_ENV]: JSON.stringify({ browser: "browserbase" }), ...env }, install: (extension) => registry.install(extension), ...lifecycle.register, handoverInJournal: true, paid };
  const binding = await TOOLS.browser.bind(host);
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  const results = [];
  model.setResponses(Array.from({ length: 4 }, () => (context) => {
    const answered = context.messages.filter((m) => m.role === "toolResult");
    if (answered.length) return (results.push(answered.at(-1)), faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" }));
    return faux.fauxAssistantMessage([faux.fauxToolCall("snapshot", {})], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => undefined));
  const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, tools: binding.tools }, init: async (tx, id) => { for (const write of lifecycle.onConversation) await write(tx, Number(id)); } });
  for (const settle of lifecycle.beforeResume) await settle(harness);
  await (await conversation.submit({ type: "input", content: "Browse." }, ctx)).wait(ctx);
  const ops = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((line) => line.op);
  return { results, ops, release: async () => { for (const stop of lifecycle.beforeRelease) await stop(harness); } };
}

test("a priced browser call is held and settled on the claim's own booking, its session's release settles there before the run's release returns, and the process's own spend is never asked", { timeout: 120_000 }, async (t) => {
  const asked = processSpend(t);
  const booking = await ledger();
  const run = await browse(t, { paid: booking.paid });
  assert.equal(run.results.at(-1)?.isError, false, `the call ran: ${JSON.stringify(run.results.at(-1)?.content).slice(0, 200)}`);
  assert.ok(run.ops().includes("create"), "a session was made");
  const call = booking.seen.filter((step) => step.name === "this browser call");
  assert.equal(call.length, 1, `the call held once on the booking: ${JSON.stringify(booking.seen)}`);
  assert.ok(call[0].holdUsd > 0, "at a figure");
  assert.ok(booking.seen.some((step) => step.op === "settle" && step.id === call[0].id), "and settled there");
  await run.release();
  booking.released();
  const released = booking.seen.filter((step) => step.op === "admit" && step.name === "this browser session's time");
  assert.equal(released.length, 1, `the release is one more request on the booking: ${JSON.stringify(booking.seen)}`);
  const settledAt = booking.seen.findIndex((step) => step.op === "settle" && step.id === released[0].id);
  assert.ok(settledAt >= 0 && settledAt < booking.seen.findIndex((step) => step.op === "released"), `settled before the run's release returned: ${JSON.stringify(booking.seen)}`);
  assert.ok(booking.spent() > 0, "the booking counts the session's time");
  assert.ok(!asked.includes("spent"), `the process's own spend was never asked (no paidCall): ${JSON.stringify(asked)}`);
});

test("an unpriced provider under the run's cap is refused on the claim's booking before any session is made", { timeout: 120_000 }, async (t) => {
  const booking = await ledger(1);
  const run = await browse(t, { paid: booking.paid, env: { [priceEnvOf("browserbase")]: "unpriced" } });
  const answer = run.results.at(-1);
  assert.equal(answer?.isError, true, "the call is refused");
  assert.match(JSON.stringify(answer?.content), /spend_cap_reached|no price/i, JSON.stringify(answer?.content));
  assert.ok(!run.ops().includes("create"), `no session was made: ${run.ops().join(", ")}`);
  assert.ok(booking.seen.some((step) => step.op === "admit" && Number.isNaN(step.holdUsd)), "asked of the booking, at no figure");
  assert.equal(booking.spent(), 0, "nothing spent");
  await run.release();
});
