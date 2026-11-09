// The browser binding's own wiring of a runner-path run's sign-in save (tools.ts, the browser's onSession): each bound run's
// session that saved, released when the run lets it go (beforeRelease), fills ITS agent's sign-in verified_at under ITS
// claim, and the release waits for that before it returns, so the run's end commit (which ends the claim) never races it.
// Two runs bound on one runner process, each on a pi-durable Harness of its own (MemoryStorage), driven by a faux model
// that opens a session (snapshot), through the faux browser (fixtures/faux-browser.mjs). The binding's lifecycle is
// collected with the adapter loop's hostLifecycle(), as the runner's ToolHost registers it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import * as faux from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { storeOn } from "./store-helpers.mjs";
import { withEnv } from "./support.mjs";

const { saveSignIn, signInViews } = await import("../dist/sign-ins-store.js");
const { TOOLS, FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { hostLifecycle } = await import("../dist/runner/adapter-loop.js");

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
/** A test seal key, no real one. */
const KEY = randomBytes(32);
const LEASE = 10 * 60_000;
/** Enough turns of the event loop that a release that does not wait for the save's verify has returned first. */
const YIELDS = 5_000;
const yieldTurns = async (n) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** One runner's store: agents a (a Browserbase context) and b (a Kernel profile), a run of each claimed by the one runner. */
async function runner(t) {
  const s = await storeOn(t);
  const log = join(s.dir, "browser.jsonl");
  writeFileSync(log, "");
  withEnv(t, { FAUX_BROWSER_LOG: log }, ["FAUX_BROWSER_LOG"]);
  const claims = {};
  for (const [agent, provider] of [["a", "browserbase"], ["b", "kernel"]]) {
    await s.store.agents.create({ id: `agent-${agent}`, name: agent }, { id: `rev-${agent}`, kind: "agentic", body: { instructions: "Browse.", tools: ["browser"] } });
    await saveSignIn(s.store, KEY, { agentId: `agent-${agent}`, provider, pointer: `${provider}-${randomBytes(12).toString("hex")}` });
    await s.store.runs.create({ id: `run-${agent}`, agentId: `agent-${agent}`, revisionId: `rev-${agent}` });
    claims[`run-${agent}`] = await s.store.claim(`run-${agent}`, "runner-1", { leaseMs: LEASE });
  }
  return { ...s, claims };
}

/** Run `run` bound on `vendor` as the runner binds it: the browser tool on a ToolHost carrying the run's store, claim and
 *  seal key, its lifecycle collected by hostLifecycle(); its Harness opened, a turn that opens a session, and `events`
 *  noting when the store's verify ran and when the release returned. */
async function bound(t, r, run, vendor, events) {
  const root = join(r.dir, "runs", run);
  mkdirSync(join(root, "work"), { recursive: true });
  const lifecycle = hostLifecycle();
  const registry = createRegistry();
  // The store as the host sees it: its verify noted, and held back while the release has not returned (at most YIELDS
  // turns), so a release that does not wait for it is seen returning first.
  let released = false;
  const signIns = Object.create(r.store.signIns);
  signIns.verify = async (...args) => {
    for (let i = 0; i < YIELDS && !released; i += 1) await yieldTurns(1);
    events.push(`${run}: verified`);
    return r.store.signIns.verify(...args);
  };
  const store = { liveViewers: r.store.liveViewers, runs: r.store.runs, signIns };
  const env = { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER, [TOOL_PLANE_ENV]: JSON.stringify({ browser: vendor }) };
  const host = { where: { root, work: join(root, "work"), ref: { id: run } }, env, install: (extension) => registry.install(extension), ...lifecycle.register, handoverInJournal: true, store, claim: r.claims[run], sealKey: KEY };
  const binding = await TOOLS.browser.bind(host);
  assert.deepEqual([lifecycle.onConversation.length, lifecycle.beforeResume.length, lifecycle.beforeRelease.length], [1, 1, 1], "the browser registers one of each");
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 4 }, () => (context) => {
    if (context.messages.some((m) => m.role === "toolResult")) return faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
    return faux.fauxAssistantMessage([faux.fauxToolCall("snapshot", {})], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => undefined));
  const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, tools: binding.tools }, init: async (tx, id) => { for (const write of lifecycle.onConversation) await write(tx, Number(id)); } });
  for (const settle of lifecycle.beforeResume) await settle(harness);
  await (await conversation.submit({ type: "input", content: "Browse." }, ctx)).wait(ctx);
  return {
    /** The run lets its sessions go (the loop's beforeRelease), then writes its end at once, as the loop does. */
    end: async () => {
      for (const stop of lifecycle.beforeRelease) await stop(harness);
      released = true;
      events.push(`${run}: released`);
      await r.store.runs.update(r.claims[run], { state: "ended" });
    },
  };
}

const verifiedAt = async (store, agentId) => (await signInViews(store, KEY, agentId))[0]?.verified_at;

test("each bound run's last save, at the release that lets its sessions go, fills its own agent's verified_at under its own claim, and the release waits for it before the run's end commit", { timeout: 120_000 }, async (t) => {
  const r = await runner(t);
  const events = [];
  const a = await bound(t, r, "run-a", "browserbase", events);
  const b = await bound(t, r, "run-b", "kernel", events);
  assert.equal(await verifiedAt(r.store, "agent-a"), null, "nothing saved yet");
  assert.equal(await verifiedAt(r.store, "agent-b"), null);
  await a.end();
  assert.deepEqual(events, ["run-a: verified", "run-a: released"], "run-a's release waited for its verify");
  assert.match(String(await verifiedAt(r.store, "agent-a")), /^\d{4}-\d\d-\d\dT/, "agent a verified, by run-a's save");
  assert.equal(await verifiedAt(r.store, "agent-b"), null, "agent b's is untouched by run-a's release");
  await b.end();
  assert.deepEqual(events, ["run-a: verified", "run-a: released", "run-b: verified", "run-b: released"]);
  assert.match(String(await verifiedAt(r.store, "agent-b")), /^\d{4}-\d\d-\d\dT/, "agent b verified, by run-b's own claim and sign-in");
});
