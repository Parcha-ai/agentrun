// A person's browser time on the runner's one ledger, and what a refusal at the cap does to the run (tools.ts hands
// browserSpend the run's ledger, host.ledger: its booking `paid` and its `pause`). The agent's own ask for a person
// (browser_request_handoff) refused at the cap pauses the run once, with the cap's figures, as main's paidCall pause
// does; the person's own take-over refused at the cap pauses nothing, its words alone going back to the viewer. The
// booking is the kernel cap's own (runCap over a memory session store) under a cap with room for a browser call and none
// for a person's held minutes; the browser runs on a pi-durable Harness on the faux browser, and the take-over goes
// through the run's own live viewer (pi-browser's, on its loopback port, as the live proxy reaches it).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import * as faux from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { connect } from "./fixtures/ws-client.mjs";
import { scratch, withEnv } from "./support.mjs";

const { TOOLS, FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { hostLifecycle } = await import("../dist/runner/adapter-loop.js");
const kernelCap = await import("../../run-adapters/dist/kernel/cap/index.js");

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const T0 = Date.parse("2026-11-09T04:00:00Z");
/** Room for one browser call's hold (about $0.018 on Browserbase at $0.12 an hour), none for a person's held minutes. */
const CAP_USD = 0.025;

/** The run's ledger as the adapter loop hands it: the kernel cap's paid calls under CAP_USD, and a pause that notes each
 *  refusal it is handed. */
async function runLedger() {
  const store = memorySessionStore();
  const paid = await kernelCap.runCap({ sessions: store, capUsd: () => CAP_USD, now: () => T0, modelOf: () => undefined }).tools(await store.open(kernelCap.TOOL_SESSION));
  const paused = [];
  return { ledger: { paid, pause: async (refusal) => void paused.push(refusal) }, paused };
}

/** The browser bound as the runner binds it, with the run's `ledger` on its ToolHost, on a Harness; one turn on `script`
 *  (the faux model's tool calls in order). `handed`: the live viewers the run handed over. */
async function browse(t, ledger, script) {
  const dir = await scratch(t);
  withEnv(t, { FAUX_BROWSER_LOG: join(dir, "browser.jsonl") }, ["FAUX_BROWSER_LOG"]);
  writeFileSync(join(dir, "browser.jsonl"), "");
  const root = join(dir, "run");
  mkdirSync(join(root, "work"), { recursive: true });
  const lifecycle = hostLifecycle();
  const registry = createRegistry();
  const handed = [];
  const liveViewers = { put: async (handover) => (handed.push(handover), true), drop: async () => {} };
  const host = { where: { root, work: join(root, "work"), ref: { id: "run-1" } }, env: { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER, [TOOL_PLANE_ENV]: JSON.stringify({ browser: "browserbase" }) }, install: (extension) => registry.install(extension), ...lifecycle.register, handoverInJournal: true, liveViewers, ledger };
  const binding = await TOOLS.browser.bind(host);
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  const results = [];
  model.setResponses(Array.from({ length: script.length + 2 }, () => (context) => {
    const answered = context.messages.filter((m) => m.role === "toolResult");
    if (answered.length) results.push(answered.at(-1));
    const next = script[answered.length];
    return next ? faux.fauxAssistantMessage([faux.fauxToolCall(next.tool, next.args ?? {})], { stopReason: "toolUse" }) : faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, tools: binding.tools }, init: async (tx, id) => { for (const write of lifecycle.onConversation) await write(tx, Number(id)); } });
  for (const settle of lifecycle.beforeResume) await settle(harness);
  await (await conversation.submit({ type: "input", content: "Browse." }, ctx)).wait(ctx);
  // The run lets its sessions go, then its Harness closes.
  t.after(async () => {
    for (const stop of lifecycle.beforeRelease) await stop(harness).catch(() => undefined);
    await harness.close(ctx).catch(() => undefined);
  });
  return { results, handed };
}

test("the agent's ask for a person refused at the run's cap pauses the run once, handed the cap's refusal and its figures", { timeout: 120_000 }, async (t) => {
  const { ledger, paused } = await runLedger();
  const run = await browse(t, ledger, [
    { tool: "snapshot" },
    { tool: "browser_request_handoff", args: { request_id: "8a6b2c1e-3f4d-4b5a-9c7e-1d2f3a4b5c6d", instruction: "Sign in for me.", completion_condition: "Signed in." } },
  ]);
  const asked = run.results.at(-1);
  assert.match(JSON.stringify(asked?.content ?? asked), /cap|spend/i, `the ask was refused at the cap: ${JSON.stringify(asked?.content ?? asked).slice(0, 300)}`);
  assert.equal(paused.length, 1, `the run is paused once: ${JSON.stringify(paused)}`);
  assert.match(String(paused[0].refuse), /spend_cap_reached|cap/i, "in the cap's words");
  assert.ok(paused[0].figures && typeof paused[0].figures === "object", `with the cap's figures: ${JSON.stringify(paused[0])}`);
});

test("the person's own take-over refused at the run's cap pauses nothing: its words go back to the viewer alone", { timeout: 120_000 }, async (t) => {
  const { ledger, paused } = await runLedger();
  const run = await browse(t, ledger, [{ tool: "snapshot" }]);
  const [viewer] = run.handed;
  assert.ok(viewer, "the session's live viewer was handed over");
  const own = `http://127.0.0.1:${viewer.port}`;
  const socket = await connect(`ws://127.0.0.1:${viewer.port}/v/${viewer.id}/ws`, { origin: own });
  assert.equal(socket.status, 101);
  t.after(() => socket.ws.destroy());
  socket.ws.sendJson({ type: "hello", token: viewer.token });
  assert.equal(JSON.parse((await socket.ws.next(60_000)).data).type, "ready");
  socket.ws.sendJson({ type: "take" });
  const { item } = await socket.ws.until((m) => m.type === "text" && /refused|denied|cap/i.test(m.data), 60_000);
  assert.ok(item, "the viewer is told the take-over was refused");
  assert.deepEqual(paused, [], "the run is not paused");
});
