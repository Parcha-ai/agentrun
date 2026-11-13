// A person's stop of a held run (computer-held.ts) ends its agent, not the hold: the run keeps its computer, the owner's
// calls still answered, until the owner releases it (the run then ends stopped) or a cancel ends it at once.
//
// The run is a CLI harness (opencode's stand-in) built by the spec builder the runner really uses (cli-run-spec.ts) on
// --faux's desktop (faux-computers.ts): nothing is rented. The model is held at its first request, so the agent is
// working when the stop comes. The routes are called as serve's dispatch calls them (heldRoute) on the server's store.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readBackOf } from "@parcha/agentrun-computer";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { heldField, heldRoute } = await import("../dist/computer-held-routes.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const FAUX = fauxComputers({ viewerBase: "http://serve.test:4777" });
const FAUX_DEPS = { kinds: FAUX.kinds, keyTable: FAUX.keyTable, launch: FAUX.launch, providers: {}, spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open" }), check: { readBackOf } };
const FAST = { pollMs: 20, takeMs: 20_000, context: ctx };
after(closeOpenSessions);

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A held opencode run on the faux desktop, its runner started. `launchDesktop` stands in for the faux desktop's launch. */
async function heldRun(t, launchDesktop = FAUX.launch) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "computer-held-stop-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: { kind: "desktop", provider: "faux-desktop" }, harness: "opencode", tools: ["read"] } });
  const launch = { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "opencode", model: { provider: "openai", modelId: "gpt-6.1-sol" }, hold: { minutes: 1 } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });

  let arrived;
  const asked = new Promise((resolve) => (arrived = resolve));
  let letGo;
  const open = new Promise((resolve) => (letGo = resolve));
  // The run's model gateway on loopback: its first request waits until the test's end.
  const gw = createServer(async (req, res) => {
    for await (const _ of req);
    if (req.method === "POST") {
      arrived();
      await open;
    }
    const events = [
      { type: "response.output_text.delta", item_id: "m_0", output_index: 0, content_index: 0, delta: "Done." },
      { type: "response.completed", response: { id: "resp_0", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => gw.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gw.close(resolve)));
  const env = { AGENT_MODEL_BASE_URL: `http://127.0.0.1:${gw.address().port}`, AGENT_MODEL_API_KEY: "not-a-secret", [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }), PATH: process.env.PATH };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim, computerDeps: { ...FAUX_DEPS, launch: launchDesktop } };
  const runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "opencode" ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => { letGo(); return runner.close().catch(() => {}); });

  const held = async () => (await heldField(server, RUN, FAST))?.state;
  const route = (name, body = {}) => heldRoute(name, RUN, body, server, FAST);
  return { server, held, route, asked };
}

/** A held opencode run on the faux desktop, started by its owner, its agent working (the model's first request held). */
async function heldAndWorking(t) {
  const { server, held, route, asked } = await heldRun(t);
  await until(async () => (await held()) === "waiting", "the desktop is up and held");
  assert.deepEqual(await route("startRun"), { held: { state: "started" } });
  await asked;
  return { server, held, route };
}

const finalRow = (server) => until(async () => {
  const now = await server.runs.get(RUN);
  return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
}, "the run is final and released");

test("a CLI harness: a person's stop of a held run ends its agent and keeps the computer, the owner's calls answered, until the release; the run then ends stopped", { timeout: 120_000 }, async (t) => {
  const { server, held, route } = await heldAndWorking(t);
  await sendCommand(server, RUN, { kind: "stop" });
  await until(async () => (await held()) === "ended", "the hold keeps the computer after the stop");
  assert.equal((await server.runs.get(RUN)).state, "running", "the run waits for the release");
  const said = (await runTimeline(server, RUN, ctx)).map((one) => one.summary).filter(Boolean);
  assert.ok(said.some((one) => /^The agent was stopped\. The run keeps its computer/.test(one)), `the Timeline says the stop kept the computer: ${JSON.stringify(said)}`);

  const answer = await route("callRunComputer", { method: "hello" });
  assert.equal(answer.ok, true, `the owner's call reaches the kept computer: ${JSON.stringify(answer)}`);

  assert.deepEqual(await route("releaseRunComputer"), { held: { state: "released" } });
  const row = await finalRow(server);
  assert.deepEqual([row.state, row.outcome], ["stopped", "stopped"], JSON.stringify(row));
  const stop = (await server.commands(RUN, 0)).find((one) => one.kind === "stop");
  assert.ok(stop.takenAt !== null && stop.refused === null, `the stop's row is taken by the end: ${JSON.stringify(stop)}`);
});

test("a CLI harness: a stop that comes while a held run's computer is still coming up ends the run stopped and lets the computer go, never waiting for a release", { timeout: 120_000 }, async (t) => {
  let launching;
  const entered = new Promise((resolve) => (launching = resolve));
  let up;
  const comeUp = new Promise((resolve) => (up = resolve));
  const { server } = await heldRun(t, async (entry, spec) => {
    launching();
    await comeUp;
    return FAUX.launch(entry, spec);
  });
  t.after(() => up());
  await entered;
  await sendCommand(server, RUN, { kind: "stop" });
  // The runner hands the stop on before the computer is up: its hold has not started, so the stop keeps nothing.
  await new Promise((resolve) => setTimeout(resolve, 500));
  up();
  // Well inside the hold's minute: a stop that kept the computer would wait for a release no row could bring.
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run ends at once", 20_000);
  assert.deepEqual([row.state, row.outcome], ["stopped", "stopped"], JSON.stringify(row));
  const stop = (await server.commands(RUN, 0)).find((one) => one.kind === "stop");
  assert.ok(stop.takenAt !== null && stop.refused === null, `the stop's row is taken by the end: ${JSON.stringify(stop)}`);
});

test("a CLI harness: a cancel after a stop that kept the held computer ends the run at once, cancelled, and lets the computer go", { timeout: 120_000 }, async (t) => {
  const { server, held } = await heldAndWorking(t);
  await sendCommand(server, RUN, { kind: "stop" });
  await until(async () => (await held()) === "ended", "the hold keeps the computer after the stop");
  await sendCommand(server, RUN, { kind: "cancel" });
  const row = await finalRow(server);
  assert.deepEqual([row.state, row.outcome], ["stopped", "cancelled"], JSON.stringify(row));
  assert.equal(await held(), "released");
  const rows = await server.commands(RUN, 0);
  for (const kind of ["stop", "cancel"]) {
    const one = rows.find((each) => each.kind === kind);
    assert.ok(one.takenAt !== null && one.refused === null, `the ${kind}'s row is taken by the end: ${JSON.stringify(one)}`);
  }
});
