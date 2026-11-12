// A person takes over a runner run's desktop through the spec builders the runner really uses (adapter-run-spec.ts for
// pi, cli-run-spec.ts for a CLI harness) and the one shared computerForClaim: the claim's hold on the desktop reaches the
// adapter loop (AdapterRunSpec.computer), so the desktop shows up live in the server's read and the take-over and the
// hand-back are applied. computer-takeover-store.test.mjs covers the hold's rules on a spec that sets the computer by
// hand; this one covers the wiring between them, which a hand-set spec never reaches.
//
// The desktop is --faux's (faux-computers.ts): nothing is rented. The model is held at its first request until the test
// lets it go, so the run is going while the person takes the desktop and hands it back. The routes are called as
// serve's dispatch calls them (computerRoute) on the server's store.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readBackOf } from "@parcha/agentrun-computer";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { computerRoute, computerViewOf } = await import("../dist/computer-routes.js");
const { computerHoldOf } = await import("../dist/computer-commands.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const DESKTOP = { kind: "desktop", provider: "faux-desktop" };
const OWNER = { ownerSession: true, token: false, accounts: true };
const FAUX = fauxComputers({ viewerBase: "http://serve.test:4777" });
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

/** A gate the model's first request waits on: `asked` once it arrived, `letGo()` lets it answer. */
function modelGate() {
  let arrived;
  const asked = new Promise((resolve) => (arrived = resolve));
  let letGo;
  const open = new Promise((resolve) => (letGo = resolve));
  return { asked, letGo, wait: async () => { arrived(); await open; } };
}

/** The claim's computer as the runner composes it under --faux: faux's registry, key table and launch. */
const FAUX_DEPS = {
  kinds: FAUX.kinds,
  keyTable: FAUX.keyTable,
  launch: FAUX.launch,
  providers: {},
  spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open" }),
  check: { readBackOf },
};

/** A store on a new data directory, an agent whose computer is the faux desktop, and run-1 launched with `launch`. */
async function storeWith(t, body, launch) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-desktop-takeover-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: DESKTOP, ...body } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  return { dir, server, store };
}

/** While the model's first request waits: the desktop is live in the server's read, the person takes it over and hands
 *  it back, and the Timeline says both; then the model answers and the run ends. */
async function takeOverAndHandBack(t, opened, gate, runner) {
  // A failed check still lets the model answer, so the runner's close does not wait on it.
  t.after(() => { gate.letGo(); return runner.close().catch(() => {}); });
  await gate.asked;
  const view = await computerViewOf(opened.server, RUN);
  assert.equal(view.state, "live", `the run's desktop is up in the server's read while the run goes: ${JSON.stringify(view)}`);
  const taken = await computerRoute("takeOverRunComputer", RUN, OWNER, opened.server);
  assert.ok(taken.hold === "pending" || taken.hold === "person", `the take-over is taken: ${JSON.stringify(taken)}`);
  await until(async () => (await computerHoldOf(opened.server, RUN)) === "person", "the person holds the desktop");
  await computerRoute("handBackRunComputer", RUN, OWNER, opened.server);
  await until(async () => (await computerHoldOf(opened.server, RUN)) === "agent", "the desktop is the agent's again");
  gate.letGo();
  const row = await until(async () => {
    const now = await opened.server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run is released");
  assert.equal(row.state, "ended", JSON.stringify(row));
  const said = (await runTimeline(opened.server, RUN, ctx)).map((one) => one.summary);
  const took = said.indexOf("You took over the desktop");
  const gave = said.indexOf("You handed the desktop back");
  assert.ok(took >= 0 && gave > took, `the Timeline says the take, then the hand-back:\n${said.join("\n")}`);
}

test("pi: a person takes over the run's desktop the spec builder claimed, and hands it back", { timeout: 120_000 }, async (t) => {
  const launch = { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  const opened = await storeWith(t, { tools: ["read"] }, launch);
  const gate = modelGate();
  const scripted = scriptedOrigin([{ say: "done" }]);
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: async (url, init) => { await gate.wait(); return scripted(url, init); } };
  const deps = { env: {}, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps: FAUX_DEPS };
  const runner = startRunner({
    store: opened.store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  await takeOverAndHandBack(t, opened, gate, runner);
});

test("a CLI harness: a person takes over the run's desktop the spec builder claimed, and hands it back", { timeout: 120_000 }, async (t) => {
  const launch = { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "opencode", model: { provider: "openai", modelId: "gpt-6.1-sol" } };
  const opened = await storeWith(t, { harness: "opencode", tools: ["read"] }, launch);
  const gate = modelGate();
  // The run's model gateway on loopback, answering OpenAI's Responses API once the gate lets its first request go.
  const gw = createServer(async (req, res) => {
    for await (const _ of req);
    if (req.method === "POST") await gate.wait();
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
  const deps = { env, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim, computerDeps: FAUX_DEPS };
  const runner = startRunner({
    store: opened.store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (name, given) => (name === "opencode" ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  await takeOverAndHandBack(t, opened, gate, runner);
});
