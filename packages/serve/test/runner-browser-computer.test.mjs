// An agent whose computer is a browser, run on the runner end to end: the claim starts the browser through its provider
// (computer-for-claim.ts providerLaunch, no launch of the server's own), and the run's browser tool (tools.ts, pi-browser's
// durable extension on pi's native route) drives that one session with the raw-CDP driver over the CDP URL the provider's
// connect hands over. Browserbase, Kernel and the local Chrome take this one path. The provider here is a stand-in in the
// computer module's shape whose connect hands over a signed-looking URL of pi-browser's fake page (fixtures/fake-ax-page);
// the model is a scripted origin. A CLI harness refuses a browser computer at its claim, in words, before anything is made.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { readBackOf } from "@parcha/agentrun-computer";
import { fakeAxPage } from "../../pi-browser/test/fixtures/fake-ax-page.mjs";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
/** Test keys, no real ones, saved sealed as Settings → Computers saves them. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const BROWSER_COMPUTER = { kind: "browser", provider: "browserbase" };
const PI_LAUNCH = { input: { content: "Browse." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
/** The query a vendor signs its CDP URL with: a secret that must reach no request to the model. */
const SIGNED = "signingKey=SECRET-signed-url-token";
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

/** A browser provider in the computer module's shape: each connect hands over `url` as its CDP target (as Browserbase's,
 *  Kernel's and the local Chrome's do) and dials nothing itself. */
function browserProvider(url, record) {
  return {
    id: "browserbase",
    version: "0",
    capabilities: () => ({ lifetime: "vendor", maxLifetimeMs: 3_600_000, network: ["open"], groups: ["cdp"] }),
    check: () => [],
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      record.created.push(spec.labels);
      return { ok: true, value: { id: "bb-1", name: "bb-1" } };
    },
    async connect() {
      record.connects += 1;
      return { ok: true, value: { client: { close() {} }, hello: { version: "0", kind: "browser", groups: ["cdp"] }, cdp: { url }, close: async () => {} } };
    },
    attach: async () => ({ ok: false, error: { code: "unsupported", message: "nothing is mounted in this computer" } }),
    async release(ref, how) {
      record.released.push([ref.id, how]);
      return { ok: true, value: undefined };
    },
  };
}

/** The claim's computer as the runner composes it, on the stand-in provider: the module's registry, no deps.launch. */
const computerDepsOver = (url, record) => ({
  kinds: KINDS,
  providers: { browserbase: () => browserProvider(url, record) },
  spec: () => ({ image: "browser", lifetimeMs: 600_000, network: "open" }),
  check: { readBackOf },
});

/** A store on a new data directory with Browserbase's keys saved, an agent of `body`, and run-1 launched with `launch`. */
async function storeWith(t, body, launch) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-browser-computer-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries(BROWSERBASE)) await putSealedKey(server, SEAL_KEY, name, value);
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Browse.", ...body } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  return { dir, server, store };
}

test("pi: an agent whose computer is a Browserbase browser runs: its snapshot and its click reach the browser the claim started, over the URL the provider's connect handed over", { timeout: 120_000 }, async (t) => {
  const page = await fakeAxPage();
  t.after(() => page.close());
  const record = { created: [], released: [], connects: 0 };
  const opened = await storeWith(t, { tools: ["read"], computer: BROWSER_COMPUTER }, PI_LAUNCH);
  const requests = [];
  const script = [{ call: "snapshot" }, { call: "run", args: { actions: [{ op: "click", id: "0-11" }] } }, { say: "done" }];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests) };
  const deps = { env: {}, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps: computerDepsOver(`${page.url}?${SIGNED}`, record) };
  const runner = startRunner({
    store: opened.store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const row = await until(async () => {
    const now = await opened.server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run is released");

  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(record.created.length, 1, "the claim started one browser");
  assert.equal(record.created[0]["agentrun.run"], RUN, "under the run's labels");
  const offered = (requests[0]?.tools ?? []).map((tool) => tool.name);
  for (const name of ["snapshot", "run"]) assert.equal(offered.filter((one) => one === name).length, 1, `${name} is offered once, with no grant of the browser: ${JSON.stringify(offered)}`);
  const methods = page.calls.map((call) => call.method);
  assert.ok(methods.includes("Accessibility.getFullAXTree"), `the snapshot read the page's tree: ${JSON.stringify(methods)}`);
  const mouse = page.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type);
  assert.deepEqual(mouse, ["mouseMoved", "mousePressed", "mouseReleased"], "the click reached the page");
  const told = JSON.stringify(requests.at(-1)?.messages ?? []);
  assert.match(told, /\[0-11\] button \\"Add\\"/, "the model read the snapshot's ids");
  assert.match(told, /\[ok\] click \[0-11\] button \\"Add\\"/, "and the click's line");
  assert.ok(!JSON.stringify(requests).includes("SECRET-signed-url-token"), "the signed URL reaches no request to the model");
  await until(() => record.released.length > 0, "the claim releases its browser");
  assert.deepEqual(record.released, [["bb-1", "delete"]], "the claim released its browser at the run's end, once");
});

test("a CLI harness refuses a browser computer at its claim, in words, before anything is made", { timeout: 60_000 }, async (t) => {
  const record = { created: [], released: [], connects: 0 };
  const opened = await storeWith(t, { harness: "opencode", tools: ["read"], computer: BROWSER_COMPUTER }, { ...PI_LAUNCH, harness: "opencode", model: { provider: "openai", modelId: "gpt-5" } });
  const [claim] = await opened.store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  const harness = await Harness.open(opened.store.journal(claim), { models: () => undefined, registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => {}));
  const run = { harness, registry, setModels: () => {} };
  const deps = { env: { OPENAI_API_KEY: "not-a-secret-openai" }, data: opened.dir, journal: (c) => opened.store.journal(c), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim, computerDeps: computerDepsOver("ws://127.0.0.1:9/devtools/browser/none", record) };
  const error = await cliRunSpecFromLaunch(await opened.store.runs.launch(RUN).then((row) => row.body), run, deps, claim).then(() => undefined, (thrown) => thrown);
  assert.ok(error, "refused");
  assert.equal(error.code, "computer_unavailable");
  assert.match(error.message, /This agent's computer is a browser, which only the pi harness drives here: pick pi for this agent, or another kind of computer in Settings → Computers\./);
  assert.deepEqual(record.created, [], "nothing was made");
});
