// The browser on the runner, on pi's native route (costsofar-4: PiAdapterOptions.extensions): a pi run whose revision
// names the browser, with the run's one-ledger booking on its ToolHost (host.ledger.paid), carries pi-browser's durable
// extension on its root agent, so its nine tools are pi's own tool tasks (a taskId, a memo, conversations they own) and
// its release tasks run under pi's recovery in the claim's Harness. The model is offered each of the nine exactly once
// (no HostTool beside it, no second install). With no booking, the extension is not installed and nothing is offered; a
// CLI root gets no browser from the runner at all. The release that lets a run's sessions go (tools.ts beforeRelease,
// through the spec's lifecycle) waits for its browser.release task with the Harness open and scheduling, so that task
// completes BEFORE the seal: at the run's end, and at a park. Through the runner, its dispatch and the spec builder, on
// the faux browser and a scripted model origin.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const cliSpec = await import("../dist/runner/cli-run-spec.js");
const { FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { saveSignIn, signInViews } = await import("../dist/sign-ins-store.js");

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 9);
const RUN = "run-1";
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
/** Test keys, no real ones, saved sealed in the store as the settings API saves them. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const NINE = ["snapshot", "run", "screenshot", "browser_read", "browser_release", "browser_relaunch", "browser_request_handoff", "browser_downloads", "browser_upload"];
const PI_LAUNCH = { input: { content: "Browse." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, plane: { browser: "browserbase" } };
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
/** The tool names a request offered the model. */
const offered = (body) => (body?.tools ?? []).map((tool) => tool.name);

/** A store on a new data directory with the browser's keys saved, an agent of `body`, and run-1 launched with `launch`. */
async function storeWith(t, body, launch, settings, before) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-browser-native-"));
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
  if (settings) await server.settings.put("tool-settings", settings);
  if (before) await before(server);
  await server.flush?.();
  return { dir, server, store };
}

/** run-1 run by a runner whose pi loop is the spec builder's (with `run` reshaped by `runAs`) on a scripted origin; until
 *  it is released `ended` (its end) or `parked`. Its row, the requests the model was sent, and its journal's records. */
async function piRun(t, { body, script, settings, before, during, until: want = ["ended", "failed", "stopped"], runAs = (run) => run }) {
  const opened = await storeWith(t, body, PI_LAUNCH, settings, before);
  const requests = [];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests) };
  const deps = { env: { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER }, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  const runner = startRunner({
    store: opened.store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, runAs(run), deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const seen = during ? await during(opened) : undefined;
  const row = await until(async () => {
    const now = await opened.server.runs.get(RUN);
    return want.includes(now.state) && now.runner === null && now;
  }, `the run is released ${want.join("|")}`);
  const records = await journalRecords(opened.server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  return { row, requests, records, seen, opened };
}

/** The browser.release tasks the journal holds. */
const releaseTasks = (records) => records.tasks.filter((task) => task.kind === "browser.release");
/** A task that ran to its end and completed (its record's terminal state). */
const completed = (task) => task.state?.status === "terminal" && task.state.outcome?.status === "completed";

test("a pi root with the run's booking and the browser granted carries pi-browser's durable extension: the model is offered each of its nine tools exactly once", { timeout: 120_000 }, async (t) => {
  const r = await piRun(t, { body: { tools: ["read", "browser"] }, script: [{ say: "done" }] });
  assert.equal(r.row.state, "ended", JSON.stringify(r.row));
  assert.ok(r.requests.length >= 1);
  for (const [i, body] of r.requests.entries()) {
    for (const name of NINE) assert.equal(offered(body).filter((offeredName) => offeredName === name).length, 1, `request ${i} offers ${name} exactly once: ${JSON.stringify(offered(body))}`);
  }
});

test("a pi root without the run's booking (host.ledger.paid) installs no browser extension: none of its tools is offered", { timeout: 120_000 }, async (t) => {
  const r = await piRun(t, { body: { tools: ["read", "browser"] }, script: [{ say: "done" }], runAs: (run) => ({ ...run, ledger: { ...run.ledger, paid: undefined } }) });
  assert.equal(r.row.state, "ended", JSON.stringify(r.row));
  for (const body of r.requests) assert.deepEqual(offered(body).filter((name) => NINE.includes(name)), [], JSON.stringify(offered(body)));
});

test("a revision that names no browser gets none of its tools on a pi root", { timeout: 120_000 }, async (t) => {
  const r = await piRun(t, { body: { tools: ["read"] }, script: [{ say: "done" }] });
  for (const body of r.requests) assert.deepEqual(offered(body).filter((name) => NINE.includes(name)), []);
});

test("a CLI root gets no browser tool from the runner, whatever its revision names", { timeout: 120_000 }, async (t) => {
  const opened = await storeWith(t, { harness: "opencode", tools: ["read", "browser"] }, { ...PI_LAUNCH, harness: "opencode", model: { provider: "openai", modelId: "gpt-5" } });
  const [claim] = await opened.store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  const harness = await Harness.open(opened.store.journal(claim), { models: () => undefined, registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => {}));
  const run = { harness, registry, setModels: () => {} };
  const deps = { env: { OPENAI_API_KEY: `not-a-secret-${"openai"}` }, data: opened.dir, journal: (c) => opened.store.journal(c), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  const spec = await cliSpec.cliRunSpecFromLaunch(await opened.store.runs.launch(RUN).then((row) => row.body), run, deps, claim);
  assert.deepEqual(spec.session.tools.map((tool) => tool.name).filter((name) => NINE.includes(name)), [], "no browser tool");
});

test("the drain at the run's end: the release that lets its sessions go waits for the browser.release task, which completes before the end is sealed", { timeout: 120_000 }, async (t) => {
  const r = await piRun(t, { body: { tools: ["browser"] }, script: [{ call: "snapshot" }, { say: "done" }] });
  assert.equal(r.row.state, "ended", JSON.stringify(r.row));
  const released = releaseTasks(r.records);
  assert.ok(released.length >= 1, `the session's release task is in the journal: ${JSON.stringify(r.records.tasks.map((task) => task.kind))}`);
  assert.ok(released.every(completed), `each completed before the seal: ${JSON.stringify(released.map((task) => task.state))}`);
});

test("the drain at a park: the release that lets the run's sessions go waits for the browser.release task, which completes before the park is sealed", { timeout: 120_000 }, async (t) => {
  // read is set to ask in the server's tool settings: the run parks on it, its browser session open from the snapshot.
  const r = await piRun(t, { body: { tools: ["read", "browser"] }, settings: { read: { permission: "ask" } }, script: [{ call: "snapshot" }, { call: "read", args: { path: "notes.txt" } }, { say: "done" }], until: ["parked", "ended", "failed"] });
  assert.equal(r.row.state, "parked", JSON.stringify(r.row));
  const released = releaseTasks(r.records);
  assert.ok(released.length >= 1, `the session's release task is in the journal: ${JSON.stringify(r.records.tasks.map((task) => task.kind))}`);
  assert.ok(released.every(completed), `each completed before the seal: ${JSON.stringify(released.map((task) => task.state))}`);
});

test("end to end on the runner: a run handed its agent's saved sign-in opens its session on the profile to save, hands its viewer over through the store, saves on release (verified_at), and books its time on the run's ledger", { timeout: 120_000 }, async (t) => {
  const log = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-browser-log-")), "browser.jsonl");
  writeFileSync(log, "");
  const before = process.env.FAUX_BROWSER_LOG;
  process.env.FAUX_BROWSER_LOG = log;
  t.after(() => (before === undefined ? delete process.env.FAUX_BROWSER_LOG : (process.env.FAUX_BROWSER_LOG = before)));
  const pointer = `ctx-saved-${Date.now().toString(16)}`;
  const r = await piRun(t, {
    body: { tools: ["browser"] },
    // A turn that opens a session, then a read of it, so the session stays open while the viewer is looked for.
    script: [{ call: "snapshot" }, { call: "browser_read" }, { say: "done" }],
    before: (server) => saveSignIn(server, SEAL_KEY, { agentId: "agent-1", provider: "browserbase", pointer }),
    // While the run holds its session: the run's viewer, handed over through the store under its claim.
    during: (opened) => until(async () => (await opened.server.liveViewers.of(RUN)).length > 0 || (await opened.server.runs.get(RUN)).state !== "running", "the viewer or the end"),
  });
  assert.equal(r.row.state, "ended", JSON.stringify(r.row));
  const ops = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(ops.filter((op) => op.op === "sign-in").map(({ ref, save, ref_in_env }) => ({ ref, save, ref_in_env })), [{ ref: pointer, save: true, ref_in_env: false }], "handed the saved sign-in, to save");
  assert.deepEqual(ops.filter((op) => op.op === "profile").map(({ name, save }) => ({ name, save })), [{ name: "default", save: true }], "its session opened on the profile, saving");
  assert.equal(r.seen, true, "its viewer was handed over through the store while it ran");
  assert.deepEqual(await r.opened.server.liveViewers.of(RUN), [], "and gone with the run");
  assert.ok((await signInViews(r.opened.server, SEAL_KEY, "agent-1"))[0]?.verified_at, "its release saved: the sign-in verified");
  // Its money on the run's one ledger (the paid tools' session): the browser call held and settled there, and its
  // session's release one more request there.
  const paid = r.records.entries.filter((entry) => entry.kind === "runner.request").map((entry) => entry.data?.model);
  assert.ok(paid.includes("paid:this browser call"), `the browser call booked on the run's ledger: ${JSON.stringify(paid)}`);
  assert.ok(paid.includes("paid:this browser session's time"), `its release booked there too: ${JSON.stringify(paid)}`);
});
