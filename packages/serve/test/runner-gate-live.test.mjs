// A deny the server sets while a run is going reaches it at its next call, on the runner as in the old per-run process
// (Settings → Tools: "A permission applies at the next call, in runs already going too"). Through a real runner, adapter
// loop and pi adapter, the gate built at the claim as runner/adapter-run-spec.ts builds it. One turn calls a tool twice;
// the first call holds until the test has saved the server's settings (saveToolSettings, on the store the server writes):
//   - set to deny between the calls: the second call is refused in the gate's words ("on this server", nothing sent or
//     charged) and the tool is not run a second time;
//   - nothing changed: both calls run.
// And a store read that fails at a call fails closed: a deny the last good read held still refuses, and approvals "never"
// lifts no ask while the store does not read.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";
import { specFor } from "./runner-spec-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { saveToolSettings } = await import("../dist/tool-plane.js");
const TIMING = { leaseMs: 30_000, renewEveryMs: 150, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** One run whose turn calls web_fetch twice; the first call holds until `between` has run (on the server's store). */
async function twoCalls(t, between) {
  const opened = await stores({ runners: 1 });
  await saveToolSettings(opened.server, { web_fetch: { permission: "allow" } });
  await queue(opened.server, "run-1");
  const ran = { count: 0 };
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const tools = { web_fetch: { name: "web_fetch", replaySafe: false, ask: false, run: async () => { ran.count += 1; if (ran.count === 1) await held; return "the page"; } } };
  const script = [{ call: "web_fetch", args: { url: "https://example.com/a" } }, { call: "web_fetch", args: { url: "https://example.com/b" } }, { say: "finished" }];
  const requests = [];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, requests) });
  const runnerStore = opened.runners[0];
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-gate-live-"));
  // The gate as the dispatch builds it at the claim (adapterRunGate, the one the spec builder uses).
  const loop = createAdapterLoop(async (claim, run) => {
    const gate = await adapterRunGate(runnerStore, claim, { kind: "agentic", body: { approvals: "ask" } }, root);
    return { ...(await base(claim, run)), gate };
  }, { restartLimit: MAX_RESTARTS });
  const runner = startRunner({ store: runnerStore, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(() => ran.count === 1, "the first call started", 20_000);
  await between(opened.server);
  release();
  await until(async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === "ended" && row.runner === null;
  }, "the run ended", 20_000);
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part?.type === "tool_result"));
  const said = results.map((part) => (Array.isArray(part.content) ? part.content.map((c) => c.text ?? "").join("") : String(part.content ?? ""))).join("\n");
  return { ran: ran.count, said };
}

test("a deny the server sets between two calls of a live run's turn refuses the second call in the gate's words; the tool is not run again", async (t) => {
  const { ran, said } = await twoCalls(t, (server) => saveToolSettings(server, { web_fetch: { permission: "deny" } }));
  assert.equal(ran, 1, "the second call is not run: the server denied it meanwhile");
  assert.match(said, /on this server/, `the model reads the server's deny at its next call: ${said}`);
  assert.match(said, /nothing was sent and nothing was charged/, `and that nothing was sent: ${said}`);
});

test("control: nothing changed between the calls, both run", async (t) => {
  const { ran } = await twoCalls(t, async () => {});
  assert.equal(ran, 2, "both calls ran");
});

test("a store read that fails at a call fails closed: the last good read's deny still refuses, and never lifts no ask while the store does not read", async (t) => {
  const { spec, store } = await specFor(t, {
    body: { tools: ["web_search", "monid.run"], approvals: "never" },
    settings: { web_search: { permission: "deny" } },
  });
  const decision = async (tool) => {
    const given = await spec.gate({ callId: "c", tool, args: {} });
    return typeof given === "string" ? given : "deny";
  };
  assert.equal(await decision("monid.run"), "allow", "a clean read: never lifts the default ask");
  store.settings.get = async () => { throw new Error("the store is busy"); };
  assert.equal(await decision("web_search"), "deny", "a failed read keeps the last good read's deny");
  assert.equal(await decision("monid.run"), "ask", "a failed read: never lifts no ask (a deny may be behind it)");
});
