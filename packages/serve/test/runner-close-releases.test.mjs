// A runner's graceful close lets go of what a run holds, and books it, before close() resolves: the run's tool hosts'
// beforeRelease runs while the run's journal still takes their writes, so a browser session's release is charged on the
// run's ledger (its final charge on the root) and a priced computer's last stretch is booked, each once. Nothing is let
// go after close() has resolved, and no tool host's beforeRelease fails for a loop already stopped. On pi (the browser
// tool, on the faux browser) and on a CLI harness (claude-agent's faux harness, on a priced faux desktop), each through
// the real loop: startRunner over createDispatchLoop and the adapter or CLI spec, on a real store. The release is
// bounded: a provider's cleanup bound and a margin (releaseBoundMs). A release under the cleanup bound is awaited; a tool
// host that never lets go holds close() only to the bound, what the release booked before it stands, and the run's root
// says the release was cut.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { readBackOf } from "@parcha/agentrun-computer";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
after(closeOpenSessions);

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 5);
const RUN = "run-1";
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
/** Test keys, no real ones. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const TIMING = { leaseMs: 30_000, renewEveryMs: 5_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** A provider's cleanup bound for the tests of a release's bound, short: the release's bound is it and RELEASE_MARGIN_MS. */
const CLEANUP_MS = 1_500;
/** How long after close() a late release would still land: longer than any the loop's teardown takes. */
const AFTER_CLOSE_MS = 3_500;
/** A priced model request, for the tests that read the run's model spend: each one at this. */
const PRICE = 0.01;
/** $0.01 a vCPU-second and $0.001 a GiB-second on faux-desktop. */
const PRICES = { AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_FAUX_DESKTOP: "0.01", AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_FAUX_DESKTOP: "0.001" };

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Every console.warn from here on, kept for the test, and still said. */
function warnings(t) {
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => {
    said.push(args.map(String).join(" "));
    warn(...args);
  };
  t.after(() => (console.warn = warn));
  return said;
}

/** The lines the process writes to stderr while the test runs (the browser's count says a lost charge there). */
function stderrLines(t) {
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    said.push(...String(chunk).split("\n").filter(Boolean));
    return write.call(this, chunk, ...rest);
  };
  t.after(() => (process.stderr.write = write));
  return said;
}
/** The lines of `said` that call a browser charge uncounted. */
const uncountedOf = (said) => said.filter((line) => line.includes("browser_spend_uncounted"));

/** A new data directory with a server and a runner store on it, closed and removed after the test. */
async function stores(t, prefix) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, server, store };
}

/** The run's journal records as they stand, read as the server reads them. */
async function recordsOf(server) {
  const row = await server.runs.get(RUN);
  return journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
}

/** A model origin that answers `script` in turn, and holds every request after it until the request is aborted: the
 *  run's turn is in flight when the test closes its runner. */
function holdingOrigin(script, requests) {
  const scripted = scriptedOrigin(script, requests);
  return async (url, init = {}) => {
    const step = (JSON.parse(String(init.body ?? "{}")).messages ?? []).filter((message) => message.role === "assistant").length;
    if (step < script.length) return scripted(url, init);
    requests.push(JSON.parse(String(init.body ?? "{}")));
    return new Promise((_resolve, reject) => {
      const stop = () => reject(init.signal?.reason ?? new Error("aborted"));
      if (init.signal?.aborted) stop();
      init.signal?.addEventListener("abort", stop, { once: true });
    });
  };
}

/** The computer's time on the run's ledger: each hold and each booking (a runner.request of tool compute), and each
 *  request's settle (its runner.turn). */
const compute = (records) => {
  const requests = records.entries.filter((entry) => entry.kind === "runner.request" && entry.data?.tool === "compute");
  const settled = new Set(records.entries.filter((entry) => entry.kind === "runner.turn").map((entry) => `${entry.conversationId}:${entry.data.turn}`));
  return { holds: requests.filter((entry) => entry.data.hold === true).length, booked: requests.filter((entry) => entry.data.hold !== true).length, open: requests.filter((entry) => !settled.has(`${entry.conversationId}:${entry.data.turn}`)).map((entry) => entry.data) };
};
/** The cuts of the run's release on its root (KINDS.releaseCut). */
const cutsOf = (records) => records.entries.filter((entry) => entry.kind === "agentrun.release.cut").map((entry) => entry.data);
/** The model of a run whose own conversation hands the browser to a subagent, whose child opens a session with its
 *  snapshot and then holds its next request, as holdingOrigin does. */
function subagentOrigin(requests) {
  const root = holdingOrigin([{ call: "subagent", args: { prompt: "Browse.", tools: ["browser"] } }], requests);
  const child = holdingOrigin([{ call: "snapshot" }], requests);
  return (url, init = {}) => (String(init.body ?? "").includes("You are a subagent.") ? child : root)(url, init);
}

/** A pi run with the browser (the faux browser, as Browserbase) whose turn is in flight after its snapshot opened a
 *  session, under runner-a of `runnerOptions`; `launch` adds to the run's launch, `env` to the process's for the test.
 *  `origin` is its model (the run's own conversation's snapshot, by default), `tools` its agent's, and `ready` how many
 *  requests have been asked once the snapshot's session is open. `again(name)` starts another runner (runner-b), of the
 *  same options, on the same store. `journalOf(claim, journal)` is the journal a runner reads and writes for a claim (the
 *  store's, by default), and `loopOf(name, createLoop)` makes the loops of the runner `name`. `price` prices each model
 *  request (free, by default); `opened: false` is a run that may have ended by the time its requests are asked, its
 *  session already let go. */
async function piRun(t, prefix, { runnerOptions = {}, launch = {}, env = {}, origin = (requests) => holdingOrigin([{ call: "snapshot" }], requests), tools = ["browser"], ready = 2, journalOf = (_claim, journal) => journal, loopOf = (_name, createLoop) => createLoop, price = () => 0, opened = true } = {}) {
  const { dir, server, store } = await stores(t, prefix);
  for (const [name, value] of Object.entries(BROWSERBASE)) await putSealedKey(server, SEAL_KEY, name, value);
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Browse.", tools } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Browse." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, plane: { browser: "browserbase" }, ...launch } });
  await server.flush?.();
  // The vendor's sessions (FAUX_BROWSER_STATE: each live one) and its every call (FAUX_BROWSER_LOG: its releases).
  const state = join(dir, "faux-browser-state.json");
  const log = join(dir, "faux-browser.log");
  const set = { FAUX_BROWSER_STATE: state, FAUX_BROWSER_LOG: log, ...env };
  const before = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
  Object.assign(process.env, set);
  t.after(() => {
    for (const [name, value] of Object.entries(before)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  const requests = [];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: origin(requests), price, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 100 };
  const deps = { env: { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  const start = (name) => {
    // The runner's store, whose journals are journalOf's.
    const journaled = new Proxy(store, {
      get(target, key) {
        if (key === "journal") return (claim) => journalOf(claim, target.journal(claim));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runner = startRunner({
      store: journaled, name, ...TIMING, ...runnerOptions,
      createLoop: loopOf(name, createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (harness, given) => (harness === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) })),
    });
    t.after(() => runner.close().catch(() => {}));
    return runner;
  };
  const runner = start("runner-a");
  // The snapshot opened a session, and the turn's next request is in flight.
  await until(() => requests.length >= ready, "the request after the snapshot is in flight");
  const live = () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : []);
  if (opened) assert.equal(live().length, 1, "the snapshot opened one session");
  const releases = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.op === "release") : []);
  return { dir, server, store, runner, live, releases, requests, again: (name = "runner-b") => start(name) };
}

/** The browser's charges the run's root records (BROWSER_CHARGED), in order. */
const chargesOf = (records) => records.entries.filter((entry) => entry.kind === "agentrun.browser_charged").map((entry) => entry.data);
/** The browser's holds on the run's ledger (each runner.request of tool browser held, not booked) not yet settled. */
const browserHolds = (records) => {
  const settled = new Set(records.entries.filter((entry) => entry.kind === "runner.turn").map((entry) => `${entry.conversationId}:${entry.data.turn}`));
  return records.entries.filter((entry) => entry.kind === "runner.request" && entry.data?.tool === "browser" && entry.data.hold === true && !settled.has(`${entry.conversationId}:${entry.data.turn}`)).map((entry) => entry.data);
};

test("pi: a runner's graceful close releases the run's browser session once and books its release before close() resolves, with no beforeRelease refused", { timeout: 120_000 }, async (t) => {
  const said = warnings(t);
  const stderr = stderrLines(t);
  const { server, runner, live, releases } = await piRun(t, "runner-close-browser-");

  await runner.close();

  const closedAt = { live: live(), releases: releases().length, records: await recordsOf(server) };
  const charged = (records) => chargesOf(records).filter((charge) => charge.final === true);
  assert.deepEqual(closedAt.live, [], "the session was let go by the time close() resolved");
  assert.equal(closedAt.releases, 1, "released once, before close() resolved");
  assert.equal(charged(closedAt.records).length, 1, `its release was charged on the run's ledger before close() resolved: ${JSON.stringify(chargesOf(closedAt.records))}`);
  assert.deepEqual(said.filter((line) => /beforeRelease failed/.test(line)), [], "no tool host's beforeRelease was refused");
  assert.deepEqual(cutsOf(closedAt.records), [], "the release finished: no cut on the run");
  assert.deepEqual(uncountedOf(stderr), [], "every charge was counted: the close's seal is no lost count");

  // Nothing more is let go or written after close() resolved.
  await new Promise((resolve) => setTimeout(resolve, AFTER_CLOSE_MS));
  assert.equal(releases().length, 1, "still released once");
  assert.equal(charged(await recordsOf(server)).length, 1, "still charged once");
  assert.deepEqual(said.filter((line) => /beforeRelease failed/.test(line)), [], "and no beforeRelease failed after close() either");
});

test("pi: a vendor's release that never answers is cut at the release's bound: the session's time to the cut is charged, not final, and the run says its release was cut; the next runner's claim gives back what the cut left held, and its release bills only the rest", { timeout: 120_000 }, async (t) => {
  const { RELEASE_MARGIN_MS } = await import("../dist/runner/loop-contract.js");
  const bound = CLEANUP_MS + RELEASE_MARGIN_MS;
  const hold = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "release-hold-")), "let-go");
  const { server, runner, live, releases, again } = await piRun(t, "runner-close-browser-cut-", { runnerOptions: { cleanupMs: CLEANUP_MS }, launch: { max_cost_usd: 1 }, env: { FAUX_BROWSER_RELEASE_HOLD: hold } });

  const began = Date.now();
  await runner.close();
  const took = Date.now() - began;

  assert.ok(existsSync(`${hold}.asked`), "the vendor was asked to release the session");
  const asked = statSync(`${hold}.asked`).mtimeMs;
  assert.ok(took < bound + 4_000, `close() returned within the release's bound (${bound} ms) and the loop's teardown: ${took} ms`);
  const records = await recordsOf(server);
  const cuts = cutsOf(records);
  assert.equal(cuts.length, 1, `the run says its release was cut, once: ${JSON.stringify(cuts)}`);
  assert.ok(cuts[0].finished < cuts[0].hooks, `a host's release had not finished: ${JSON.stringify(cuts[0])}`);
  const charges = chargesOf(records);
  assert.deepEqual(charges.filter((charge) => charge.final), [], `no release was confirmed, so nothing billed final: ${JSON.stringify(charges)}`);
  const cut = charges.at(-1);
  assert.ok(cut && Date.parse(cut.at) >= asked, `the cut charged the session's time through the cut, past the vendor's ask: ${JSON.stringify({ charges, asked: new Date(asked).toISOString() })}`);
  assert.equal(live().length, 1, "the vendor still holds the session");
  const heldAtClose = browserHolds(records);

  // The next runner claims the run: what the cut's claim left held is given back by the claim's reopen, and the release
  // it resumes, once the vendor answers, bills only the time after the cut.
  const next = again();
  await until(async () => (await server.runs.get(RUN)).runner === "runner-b", "the next runner claimed the run");
  writeFileSync(hold, "");
  const final = await until(async () => chargesOf(await recordsOf(server)).find((charge) => charge.final), "the resumed release was billed");
  const after = await recordsOf(server);
  const left = browserHolds(after);
  for (const held of heldAtClose) assert.ok(!left.some((one) => JSON.stringify(one) === JSON.stringify(held)), `the cut's claim's hold was given back: ${JSON.stringify({ heldAtClose, left })}`);
  assert.equal(releases().length >= 1 && live().length, 0, "the session was let go");
  // Every second once: the charges add up to the session's time, or to Browserbase's one-minute minimum when that is
  // more, the release's own charge being the time after the cut and the top-up to the minimum.
  const all = chargesOf(after);
  const billedS = Math.round(all.reduce((total, charge) => total + charge.seconds, 0) * 1000) / 1000;
  const lifeS = (Date.parse(final.at) - Date.parse(all[0].at) + all[0].seconds * 1000) / 1000;
  assert.ok(billedS === 60 || (billedS > 60 && Math.abs(billedS - lifeS) < 1), `each second billed once: ${JSON.stringify({ billedS, lifeS, all })}`);
  assert.equal(all.filter((charge) => charge.final).length, 1, "one final charge");
  await next.close();
});

test("pi: a cut releases the session of the run's labels that nobody held, which the let-go never reached behind a release that never answers: recorded before its release is sent, released once, and its time charged once, absorbed", { timeout: 120_000 }, async (t) => {
  const hold = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "release-hold-")), "let-go");
  t.after(() => writeFileSync(hold, ""));
  const { dir, server, runner, releases } = await piRun(t, "runner-close-cut-unheld-", { runnerOptions: { cleanupMs: CLEANUP_MS }, launch: { max_cost_usd: 1 }, env: { FAUX_BROWSER_RELEASE_HOLD: hold, FAUX_BROWSER_UNHELD: "600", FAUX_BROWSER_UNHELD_LISTED: "1" }, opened: false });
  const made = readFileSync(join(dir, "faux-browser.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((row) => row.op === "unheld-made");
  assert.ok(made, "the faux vendor made a session nobody holds beside the run's own");

  await runner.close();

  assert.ok(existsSync(`${hold}.asked`), "the run's own session's release was sent and never answered");
  const records = await recordsOf(server);
  assert.equal(cutsOf(records).length, 1, "the run says its release was cut");
  assert.equal(releases().filter((row) => row.id === made.id).length, 1, `the session nobody held was released once: ${JSON.stringify(releases())}`);
  const owed = records.entries.filter((entry) => entry.kind === "agentrun.browser_unheld_owed" && entry.data?.id === made.id);
  assert.equal(owed.length, 1, "it was recorded on the run's root before its release was sent");
  const charged = chargesOf(records).filter((charge) => charge.tag === `unheld:${made.id}`);
  assert.equal(charged.length, 1, `its time was charged once: ${JSON.stringify(chargesOf(records))}`);
  assert.equal(charged[0].final, true);
  assert.ok(charged[0].seconds >= 600, `from when its vendor made it: ${charged[0].seconds} s`);
  const said = records.entries.filter((entry) => entry.kind === "agentrun.browsers_unheld" && entry.data?.released?.includes(made.id));
  assert.equal(said.length, 1, "the run's root says it once");
  writeFileSync(hold, "");
});

test("pi: a cut reaches every conversation of the run: a subagent's browser session, its release never answering, is charged through the cut", { timeout: 120_000 }, async (t) => {
  const hold = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "release-hold-")), "let-go");
  const { server, runner, live } = await piRun(t, "runner-close-subagent-cut-", { runnerOptions: { cleanupMs: CLEANUP_MS }, launch: { max_cost_usd: 1 }, env: { FAUX_BROWSER_RELEASE_HOLD: hold }, origin: subagentOrigin, tools: ["browser", "subagent"], ready: 3 });
  t.after(() => writeFileSync(hold, ""));

  await runner.close();

  assert.ok(existsSync(`${hold}.asked`), "the vendor was asked to release the subagent's session");
  const records = await recordsOf(server);
  assert.equal(cutsOf(records).length, 1, `the release was cut: ${JSON.stringify(cutsOf(records))}`);
  const charges = chargesOf(records);
  const asked = statSync(`${hold}.asked`).mtimeMs;
  const cut = charges.filter((charge) => !charge.final && Date.parse(charge.at) >= asked);
  assert.equal(cut.length, 1, `the subagent's session was charged through the cut: ${JSON.stringify({ charges, asked: new Date(asked).toISOString() })}`);
  assert.notEqual(cut[0].conversation, ROOT_CONVERSATION_ID, "its conversation is the subagent's, not the run's own");
  assert.equal(charges.filter((charge) => charge.conversation === ROOT_CONVERSATION_ID).length, 0, "the run's own conversation opened no session");
  assert.equal(live().length, 1, "the vendor still holds the session");
});

test("pi: the reserve a cut's charge holds again on a claim that reopened the session is given back, never booked, when that claim ends before the release's charge lands", { timeout: 180_000 }, async (t) => {
  // runner-a's close is cut: the session's time to the cut is charged. runner-b reopens the run, holding the session's
  // reserve from its reopen (its time since the cut and a stretch), and its close is cut too: its charge books that time
  // and holds the reserve again, at one stretch, owed. runner-c's claim then finds that hold open, with no charge of the
  // session's release on the ledger yet.
  const hold = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "release-hold-")), "let-go");
  const { server, runner, again } = await piRun(t, "runner-close-reserve-cut-", { runnerOptions: { cleanupMs: CLEANUP_MS }, launch: { max_cost_usd: 1 }, env: { FAUX_BROWSER_RELEASE_HOLD: hold } });
  t.after(() => writeFileSync(hold, ""));
  await runner.close();
  const second = again("runner-b");
  await until(async () => (await server.runs.get(RUN)).runner === "runner-b", "runner-b claimed the run");
  const reopened = await until(async () => {
    const records = await recordsOf(server);
    return records.entries.some((entry) => entry.kind === "runner.request" && entry.data?.tool === "browser" && entry.data.hold === true && entry.data.owed === true) && records;
  }, "runner-b's reopen held the session's reserve");
  const heldBefore = new Set(reopened.entries.filter((entry) => entry.kind === "runner.request").map((entry) => `${entry.conversationId}:${entry.data.turn}`));
  await second.close();

  const atClose = await recordsOf(server);
  assert.equal(cutsOf(atClose).length, 2, `both closes were cut: ${JSON.stringify(cutsOf(atClose))}`);
  const heldAgain = atClose.entries.filter((entry) => entry.kind === "runner.request" && entry.data?.tool === "browser" && entry.data.hold === true && entry.data.owed === true && !heldBefore.has(`${entry.conversationId}:${entry.data.turn}`));
  assert.equal(heldAgain.length, 1, `runner-b's cut held the session's reserve again, owed: ${JSON.stringify(heldAgain.map((entry) => entry.data))}`);
  const key = `${heldAgain[0].conversationId}:${heldAgain[0].data.turn}`;
  assert.ok(browserHolds(atClose).some((data) => data.turn === heldAgain[0].data.turn), "still held when runner-b's claim ended");

  const third = again("runner-c");
  await until(async () => (await server.runs.get(RUN)).runner === "runner-c", "runner-c claimed the run");
  const settled = await until(async () => (await recordsOf(server)).entries.find((entry) => entry.kind === "runner.turn" && `${entry.conversationId}:${entry.data.turn}` === key), "runner-c's reopen settled the hold");
  assert.deepEqual([settled.data.usd, settled.data.givenBack, settled.data.rule], [0, true, undefined], `given back at $0, not booked: ${JSON.stringify(settled.data)}`);
  writeFileSync(hold, "");
  const final = await until(async () => chargesOf(await recordsOf(server)).find((charge) => charge.final), "the release was billed");
  assert.equal(typeof final.usd, "number");
  await third.close();
});

/** The entries a commit writes, as kind and data. */
const entriesOf = (batches) => batches.flatMap((batch) => batch.filter((write) => write.type === "entry").map((write) => ({ kind: write.value.kind, data: write.value.data })));
/** A browser session's reserve held again, owed (the step a claim's reopen of the session writes). */
const owedHold = (entry) => entry.kind === "runner.request" && entry.data?.tool === "browser" && entry.data.hold === true && entry.data.owed === true;

/** `journal`, whose first commit that `matches` is held at the store, once the loop's gate has taken it, until `go`
 *  resolves; `held` resolves once it is. `seen` lists each commit's entries, in order. Every other commit passes. */
function holdingJournal(journal, matches, go, held, seen) {
  let holding = true;
  return new Proxy(journal, {
    get(target, key) {
      if (key === "commit") {
        return async (batches, receive, context) => {
          seen.push(entriesOf(batches).map((entry) => entry.kind));
          if (holding && entriesOf(batches).some(matches)) {
            holding = false;
            held();
            await go;
          }
          return target.commit(batches, receive, context);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `createLoop`, each of whose loops calls `stopped(reason)` once its own stop() has begun (its synchronous part done). */
const observedStops = (createLoop, stopped) => (deps) => {
  const loop = createLoop(deps);
  return new Proxy(loop, {
    get(target, key) {
      if (key === "stop") {
        return (reason) => {
          const stopping = target.stop(reason);
          stopped(reason);
          return stopping;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

test("pi: a close whose shutdown seals the journal while a claim's open is still committing (its reopen's hold under way) still has the release cut, its charge booked and the cut recorded; the stopped claim's recovery sends no model request, and the next claim resumes the turn, each request billed once", { timeout: 180_000 }, async (t) => {
  // runner-a's close is cut, as above. runner-b's claim reopens the session: its owed hold is held at the store, past the
  // loop's gate, while runner-b's close stops its loop for the shutdown (the stop seals the journal at once). The claim's
  // open goes on once the hold lands, its next commit made after the seal; the release still runs, is cut, and books.
  const hold = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "release-hold-")), "let-go");
  let go = () => {};
  const going = new Promise((resolve) => (go = resolve));
  let held = () => {};
  const holding = new Promise((resolve) => (held = resolve));
  let shutDown = () => {};
  const shutting = new Promise((resolve) => (shutDown = resolve));
  const seen = [];
  t.after(() => go());
  // The model holds every request after the snapshot's until runner-c's claim, which it answers.
  let answering = false;
  const origin = (requests) => {
    const holding = holdingOrigin([{ call: "snapshot" }], requests);
    const answers = scriptedOrigin([{ call: "snapshot" }, { say: "all done" }], requests);
    return (url, init) => (answering ? answers(url, init) : holding(url, init));
  };
  const { server, runner, again, requests } = await piRun(t, "runner-close-open-sealed-", {
    runnerOptions: { cleanupMs: CLEANUP_MS },
    launch: { max_cost_usd: 1 },
    env: { FAUX_BROWSER_RELEASE_HOLD: hold },
    origin,
    price: () => PRICE,
    journalOf: (claim, journal) => (claim.runner === "runner-b" ? holdingJournal(journal, owedHold, going, held, seen) : journal),
    loopOf: (name, createLoop) => (name === "runner-b" ? observedStops(createLoop, (reason) => reason.kind === "shutdown" && shutDown()) : createLoop),
  });
  t.after(() => writeFileSync(hold, ""));
  const said = warnings(t);
  await runner.close();
  const second = again("runner-b");
  await holding;
  const closedAt = Date.now();
  const closing = second.close();
  await shutting;
  go();
  await closing;

  const atClose = await recordsOf(server);
  const context = JSON.stringify({ cuts: cutsOf(atClose), commits: seen, said: said.filter((line) => /beforeRelease|releaseCut|Session|cut could not/.test(line)) });
  assert.equal(cutsOf(atClose).length, 2, `runner-b's release was cut and its cut recorded, as runner-a's: ${context}`);
  const holds = atClose.entries.filter((entry) => owedHold({ kind: entry.kind, data: entry.data }));
  assert.equal(holds.length, 2, `runner-b's reopen held the session's reserve, and its cut's charge held it again: ${context}`);
  const charges = chargesOf(atClose);
  assert.equal(charges.filter((charge) => !charge.final && Date.parse(charge.at) >= closedAt).length, 1, `runner-b's cut charged the session through the cut: ${JSON.stringify({ charges, closedAt: new Date(closedAt).toISOString() })}`);
  assert.deepEqual(unbookedCharges(atClose), [], `every charge is booked on the run's ledger: ${JSON.stringify(charges)}`);
  // A release the cut left running fails once the run's Harness closes under it (each close's cut): no other refusal.
  assert.deepEqual(said.filter((line) => /Session failed|releaseCut failed|cut could not be written/.test(line)), [], "no host's release, booking or cut was refused");

  // runner-c claims the run, the vendor and the model now answering: the turn resumes and the run ends on its answer.
  answering = true;
  writeFileSync(hold, "");
  const third = again("runner-c");
  const ended = await until(async () => {
    const row = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(row.state) && row.runner === null && row;
  }, "the run's end on runner-c");
  await third.close();
  const records = await recordsOf(server);
  const rows = await runTimeline(server, RUN, ctx);
  const shown = JSON.stringify({ ledger: modelLedger(records), rows: rows.map((row) => [row.kind, row.summary]) });
  assert.equal(ended.state, "ended", `the resumed turn answered: ${JSON.stringify({ state: ended.state, summary: ended.summary })}`);
  assert.deepEqual(rows.filter((row) => row.kind === "final_answer").map((row) => row.summary), ["all done"], shown);
  const ledger = modelLedger(records);
  assert.deepEqual(ledger.twice, [], `no step of the run is settled twice: ${shown}`);

  // The same run uninterrupted: the snapshot, then the answer.
  const whole = await piRun(t, "runner-close-open-whole-", { runnerOptions: { cleanupMs: CLEANUP_MS }, launch: { max_cost_usd: 1 }, origin: (asked) => scriptedOrigin([{ call: "snapshot" }, { say: "all done" }], asked), price: () => PRICE, opened: false });
  await until(async () => {
    const row = await whole.server.runs.get(RUN);
    return row.state === "ended" && row.runner === null;
  }, "the uninterrupted run's end");
  const wholeRecords = await recordsOf(whole.server);
  const wholeRows = await runTimeline(whole.server, RUN, ctx);
  assert.equal(modelLedger(wholeRecords).total, PRICE * 2, `the uninterrupted run: two requests: ${JSON.stringify(modelLedger(wholeRecords))}`);
  assert.equal(ledger.total, modelLedger(wholeRecords).total, `the run's model spend reads as the uninterrupted run's: ${shown}`);

  // runner-b's stop leaves the turn to the next claim: once its loop is stopped, no recovery of its claim sends a model
  // request (the release's drain runs pi's tasks, the turn's recovery among them), so nothing of the turn fails on the
  // closed session: no answer of the model written in runner-b's claim, no error answer on the run, no failed request on
  // its timeline. runner-c resumes the turn.
  assert.deepEqual(seen.flat().filter((kind) => kind === "pi.assistant"), [], `runner-b's claim wrote no answer of the model: ${JSON.stringify(seen)}`);
  const failed = records.entries.filter((entry) => entry.kind === "pi.assistant" && entry.model?.[0]?.stopReason === "error");
  assert.deepEqual(failed.map((entry) => entry.model[0].errorMessage), [], `no request of the run failed: ${shown}`);
  const errors = rows.filter((row) => row.kind === "error").map((row) => row.summary);
  assert.deepEqual(errors, [], `the run's timeline shows no failed request: ${shown}`);
  assert.deepEqual(wholeRows.filter((row) => row.kind === "error"), [], "nor does the uninterrupted run's");
  const started = records.entries.filter((entry) => entry.kind === "agentrun.request_started");
  assert.equal(started.length, requests.length, `a request started for each the model was sent, and no other: ${JSON.stringify({ started: started.length, sent: requests.length })}`);
  assert.equal(ledger.requests, requests.length, `a request booked for each the model was sent, and no other: ${shown}`);
  const usage = (all) => all.findLast((row) => row.kind === "usage")?.summary;
  // Its usage row counts the requests the model was sent: three (the two answered and runner-a's cut), the uninterrupted
  // run's two.
  assert.equal(requests.length, 3, shown);
  assert.match(usage(rows), / over 3 model requests /, usage(rows));
  assert.match(usage(wholeRows), / over 2 model requests /, usage(wholeRows));
});

/** The run's model requests on its ledger (each runner.request of no tool), how many, and what they settled at in
 *  all; `twice`: any step of the ledger settled more than once. */
const modelLedger = (records) => {
  const requests = records.entries.filter((entry) => entry.kind === "runner.request" && entry.data?.tool === undefined);
  const keys = new Set(requests.map((entry) => `${entry.conversationId}:${entry.data.turn}`));
  const turns = records.entries.filter((entry) => entry.kind === "runner.turn");
  const keyOf = (entry) => `${entry.conversationId}:${entry.data.turn}`;
  const total = Math.round(turns.filter((entry) => keys.has(keyOf(entry))).reduce((sum, entry) => sum + (entry.data.usd ?? 0), 0) * 1e9) / 1e9;
  const twice = [...new Set(turns.map(keyOf))].filter((key) => turns.filter((entry) => keyOf(entry) === key).length > 1);
  return { requests: requests.length, total, twice, settled: turns.filter((entry) => keys.has(keyOf(entry))).map((entry) => entry.data) };
};

/** Each browser charge of the run's root (BROWSER_CHARGED) whose money is not booked on the run's ledger: no step names
 *  its ref (browser-cost.ts chargeRef), or the step that does was never settled. */
const unbookedCharges = (records) => {
  const requests = records.entries.filter((entry) => entry.kind === "runner.request" && entry.data?.tool === "browser" && typeof entry.data.ref === "string");
  const settled = new Set(records.entries.filter((entry) => entry.kind === "runner.turn").map((entry) => `${entry.conversationId}:${entry.data.turn}`));
  return chargesOf(records).filter((charge) => typeof charge.usd === "number" && charge.usd > 0).filter((charge) => {
    const ref = `browser:${charge.tag}@${charge.at}${charge.final ? "/final" : ""}`;
    return !requests.some((entry) => entry.data.ref === ref && settled.has(`${entry.conversationId}:${entry.data.turn}`));
  });
};
const stoppedRun = async (server) => until(async () => { const row = await server.runs.get(RUN); return row.state !== "running" && row.state !== "queued" && row.state; }, "the run ended on its stop");

for (const [label, hung] of [["its release answers: the release's charge", false], ["its release never answers: the cut's charge", true]]) {
  test(`pi: a person's stop lets the run's browser go and books its charge on the run's ledger, as a shutdown does: ${label}`, { timeout: 120_000 }, async (t) => {
    const { sendCommand } = await import("../dist/runner/commands.js");
    const hold = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "release-hold-")), "let-go");
    const { server, runner } = await piRun(t, "runner-stop-books-", { runnerOptions: { cleanupMs: CLEANUP_MS }, launch: { max_cost_usd: 1 }, env: hung ? { FAUX_BROWSER_RELEASE_HOLD: hold } : {} });
    t.after(() => writeFileSync(hold, ""));
    const said = warnings(t);
    const stderr = stderrLines(t);
    await sendCommand(server, RUN, { kind: "stop", body: {} });
    const state = await stoppedRun(server);
    const records = await recordsOf(server);
    const charges = chargesOf(records);
    assert.ok(charges.some((charge) => charge.final !== hung), `the ${hung ? "cut's" : "release's"} charge is on the run's root: ${JSON.stringify({ state, charges })}`);
    assert.equal(cutsOf(records).length, hung ? 1 : 0, JSON.stringify(cutsOf(records)));
    assert.ok(charges.filter((charge) => charge.usd > 0).length >= 2, `the session's time was charged, priced: ${JSON.stringify(charges)}`);
    assert.deepEqual(unbookedCharges(records), [], `every charge is booked on the run's ledger: ${JSON.stringify({ charges, said: said.filter((line) => /browser|ledger|stopped/.test(line)) })}`);
    // A release the cut left running fails once the run's Harness closes under it: that is the cut, not a refusal.
    assert.deepEqual(said.filter((line) => /loop stopped \(command\)|releaseCut failed/.test(line) || (!hung && /beforeRelease failed/.test(line))), [], "no host's release or booking was refused by the stop");
    await runner.close();
    assert.deepEqual(uncountedOf(stderr), [], "every charge was counted: the stop's seal is no lost count");
  });
}

/** A vendor of --faux's desktops: create starts one, connect finds it, delete ends it. */
function fauxDesktops(faux) {
  const entry = faux.kinds.PROVIDERS.find((one) => one.id === "faux-desktop");
  const computers = new Map();
  let made = 0;
  return {
    id: "faux-desktop",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    async list(labels) {
      const held = [...computers.values()].filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: held.map((one) => ({ ref: { id: one.id, name: one.id }, labels: { ...one.labels }, deadline: new Date(Date.now() + 3_600_000), state: "running", network: "open" })) };
    },
    async create(spec) {
      const id = `d${++made}`;
      computers.set(id, { id, labels: { ...spec.labels }, desk: await faux.launch(entry, { kind: "desktop", keys: {} }) });
      return { ok: true, value: { id, name: id } };
    },
    async attach({ id }) {
      if (!computers.has(id)) return { ok: false, error: { code: "not_found", message: `no computer ${id}` } };
      return { ok: true, value: { id, name: id, spec: { image: "faux", user: "1000:1000", network: "open" } } };
    },
    async connect({ id }) {
      const one = computers.get(id);
      if (!one) return { ok: false, error: { code: "gone", message: `no computer ${id}` } };
      return { ok: true, value: { client: one.desk.client, hello: one.desk.hello, close: async () => {} } };
    },
    async watch() {
      return { ok: true, value: { input: async () => ({ ok: true, value: { done: 0 } }), close: async () => {} } };
    },
    async release(ref, how) {
      if (how === "delete") {
        await computers.get(ref.id)?.desk.release().catch(() => {});
        computers.delete(ref.id);
      }
      return { ok: true, value: undefined };
    },
  };
}


/** A claude-agent run (the faux harness) on a priced faux desktop, held in its turn after its first request, under a
 *  runner of `runnerOptions`; `hooks` makes the spec's beforeRelease from the one it built (the computer's settle). */
async function cliRun(t, prefix, { runnerOptions = {}, hooks = (registered) => registered } = {}) {
  const { dir, server, store } = await stores(t, prefix);
  const gw = await startFauxGateway();
  t.after(() => gw.close());
  // The turn's first request, then a hold with no request open (writing `<at>.held`) until `<at>` exists: never, here.
  const at = join(dir, "restart");
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: `Claude Code restarts before the note at ${at}.`, harness: "claude-agent", computer: { kind: "desktop", provider: "faux-desktop" }, tools: ["read"] } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "claude-agent", model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } } });
  await server.flush?.();
  const faux = fauxComputers();
  const vendor = fauxDesktops(faux);
  const computerDeps = { kinds: faux.kinds, keyTable: faux.keyTable, providers: { "faux-desktop": () => vendor }, spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open", cpus: 2, memoryMb: 4096 }), check: { readBackOf } };
  // The harness table loads a test's module only under a test runner (harness-table.ts): the flag is handed the runner.
  const env = { ...PRICES, ANTHROPIC_API_KEY: "fake-test-key", ANTHROPIC_BASE_URL: gw.url, AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim, computerDeps };
  const specOf = async (claim, run, given) => {
    const spec = await cliRunSpecFromLaunch(given, run, deps, claim);
    return { ...spec, lifecycle: { ...spec.lifecycle, beforeRelease: hooks(spec.lifecycle?.beforeRelease ?? []) } };
  };
  const runner = startRunner({
    store, name: "runner-a", ...TIMING, ...runnerOptions,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "claude-agent" ? createAdapterLoop((claim, run) => specOf(claim, run, given)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  await until(() => existsSync(`${at}.held`), "the turn holds after its first request");
  return { dir, server, runner };
}

test("claude-agent (faux harness): a runner's graceful close books the run's priced computer's last stretch before close() resolves, every hold settled, with no beforeRelease refused", { timeout: 120_000 }, async (t) => {
  const said = warnings(t);
  const { server, runner } = await cliRun(t, "runner-close-computer-");

  await runner.close();

  const closedAt = compute(await recordsOf(server));
  assert.ok(closedAt.holds >= 1, `the computer's time was held: ${JSON.stringify(closedAt)}`);
  assert.ok(closedAt.booked >= 1, `its time was booked before close() resolved: ${JSON.stringify(closedAt)}`);
  assert.deepEqual(closedAt.open, [], "every hold and booking was settled before close() resolved: none left open on the ledger");
  assert.deepEqual(said.filter((line) => /beforeRelease failed/.test(line)), [], "no tool host's beforeRelease was refused");
  assert.deepEqual(cutsOf(await recordsOf(server)), [], "the release finished: no cut on the run");

  await new Promise((resolve) => setTimeout(resolve, AFTER_CLOSE_MS));
  assert.deepEqual(compute(await recordsOf(server)), closedAt, "nothing more is booked after close() resolved");
  assert.deepEqual(said.filter((line) => /beforeRelease failed/.test(line)), [], "and no beforeRelease failed after close() either");
});


test("a tool host whose beforeRelease never resolves holds close() no longer than the release's bound: the computer's time is booked, and the run says its release was cut", { timeout: 60_000 }, async (t) => {
  const { RELEASE_MARGIN_MS } = await import("../dist/runner/loop-contract.js");
  const bound = CLEANUP_MS + RELEASE_MARGIN_MS;
  const { server, runner } = await cliRun(t, "runner-close-hung-", { runnerOptions: { cleanupMs: CLEANUP_MS }, hooks: (registered) => [...registered, () => new Promise(() => {})] });

  const began = Date.now();
  await runner.close();
  const took = Date.now() - began;

  assert.ok(took < bound + 4_000, `close() returned within the release's bound (${bound} ms) and the loop's teardown: ${took} ms`);
  const records = await recordsOf(server);
  const closedAt = compute(records);
  assert.ok(closedAt.booked >= 1, `the time known by the cut was booked: ${JSON.stringify(closedAt)}`);
  assert.deepEqual(closedAt.open, [], "every hold and booking the settle made was settled");
  const cuts = cutsOf(records);
  assert.equal(cuts.length, 1, `the run says its release was cut, once: ${JSON.stringify(cuts)}`);
  assert.equal(cuts[0].bound_ms, bound);
  assert.ok(cuts[0].after_ms >= bound, `cut at the bound: ${cuts[0].after_ms}`);
  assert.deepEqual([cuts[0].hooks, cuts[0].finished], [2, 1], "the settle finished, the hung host did not");
});

test("a release's cut whose timer comes before Date.now() reads its bound waits out the rest: the cut is never recorded before its bound", { timeout: 60_000 }, async (t) => {
  const { RELEASE_MARGIN_MS } = await import("../dist/runner/loop-contract.js");
  const bound = CLEANUP_MS + RELEASE_MARGIN_MS;
  // Timers run on the process's monotonic clock and Date.now() on the wall clock, which may read behind it when a timer
  // comes. Here the wall clock runs 1% slow, so a timer set for the bound by Date.now() comes before Date.now() reads it.
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + Math.floor((realNow() - base) * 0.99);
  t.after(() => (Date.now = realNow));
  const { server, runner } = await cliRun(t, "runner-close-slow-clock-", { runnerOptions: { cleanupMs: CLEANUP_MS }, hooks: (registered) => [...registered, () => new Promise(() => {})] });

  await runner.close();
  const cuts = cutsOf(await recordsOf(server));
  assert.equal(cuts.length, 1, `the run says its release was cut, once: ${JSON.stringify(cuts)}`);
  assert.equal(cuts[0].bound_ms, bound);
  assert.ok(cuts[0].after_ms >= bound, `cut at the bound by the clock the record reads: ${cuts[0].after_ms}`);
});

test("a release that takes just under a provider's cleanup bound is awaited, under a lease shorter than it, and what comes after it in the release is booked before close() resolves", { timeout: 60_000 }, async (t) => {
  // A tool host whose release takes just under the cleanup bound (a lost create's recovery), let go before the computer's
  // settle: the settle runs only once it is done. The lease less its margin (1 s) is shorter than that release: the
  // close's window is the cleanup bound's, from its start.
  const slow = () => new Promise((resolve) => setTimeout(resolve, CLEANUP_MS - 100));
  const { server, runner } = await cliRun(t, "runner-close-slow-", { runnerOptions: { cleanupMs: CLEANUP_MS, leaseMs: 2_000, renewEveryMs: 300, stopMarginMs: 1_000 }, hooks: (registered) => [slow, ...registered] });

  await runner.close();

  const records = await recordsOf(server);
  const closedAt = compute(records);
  assert.ok(closedAt.booked >= 1, `the computer's time was booked after the slow release: ${JSON.stringify(closedAt)}`);
  assert.deepEqual(closedAt.open, [], "every hold and booking was settled before close() resolved");
  assert.deepEqual(cutsOf(records), [], "nothing was cut");
});

/** A runner on `dir`'s store that claims what it can and records each claim, its loops ending at their stop. */
async function bystander(t, dir, name) {
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const claims = [];
  const runner = startRunner({
    store, name, ...TIMING, leaseMs: 4_000, renewEveryMs: 500, stopMarginMs: 1_000,
    createLoop: (deps) => {
      let end;
      const ended = new Promise((resolve) => (end = resolve));
      deps.signal.addEventListener("abort", () => end({ state: "interrupted" }), { once: true });
      return { start: async (claim) => (claims.push({ runId: claim.runId, at: Date.now() }), ended), command: async () => ({ taken: true }), stop: async () => end({ state: "interrupted" }) };
    },
  });
  t.after(async () => {
    await runner.close().catch(() => {});
    await store.close().catch(() => {});
  });
  return { runner, claims };
}

/** A model that calls the browser's snapshot and then answers only once `answering` resolves: its run ends then, its
 *  session's release asked at its end. */
const answeringOrigin = (answering) => (requests) => {
  const scripted = scriptedOrigin([{ call: "snapshot" }, { say: "Done." }], requests);
  return async (url, init = {}) => {
    const step = (JSON.parse(String(init.body ?? "{}")).messages ?? []).filter((message) => message.role === "assistant").length;
    if (step === 0) return scripted(url, init);
    requests.push(JSON.parse(String(init.body ?? "{}")));
    await answering;
    return scripted(url, init);
  };
};

test("pi: a run that ends in the close's drain, its browser's release never answering, has the cut's charge and record land when the drain's end stops it mid-release: the cut is set again by the close's window, and the shutdown's seal takes the release's commits", { timeout: 60_000 }, async (t) => {
  const { RELEASE_MARGIN_MS } = await import("../dist/runner/loop-contract.js");
  const { runnerStopBy } = await import("../dist/runner/runner.js");
  const said = warnings(t);
  const stderr = stderrLines(t);
  // A 4 s lease less its 1 s margin is a 3 s stop, after a 4 s drain: the close's window ends 7.5 s from its start, its
  // release cut at 6.5 s (CLEANUP_MS and its margin). The run ends 2.5 s into the drain, so a release bound from its own
  // start would be cut at 9 s, past the window; the drain's end at 4 s stops the run mid-release and seals its journal.
  const window = { leaseMs: 4_000, renewEveryMs: 500, stopMarginMs: 1_000, drainMs: 4_000, cleanupMs: CLEANUP_MS };
  const releaseBy = CLEANUP_MS + RELEASE_MARGIN_MS;
  assert.equal(runnerStopBy(0, window.drainMs, window.leaseMs, window.stopMarginMs, CLEANUP_MS), releaseBy + window.stopMarginMs);
  const hold = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "release-hold-")), "let-go");
  t.after(() => writeFileSync(hold, ""));
  let answer;
  const answering = new Promise((resolve) => (answer = resolve));
  const { server, runner, live } = await piRun(t, "runner-close-drain-release-", { runnerOptions: window, launch: { max_cost_usd: 1 }, env: { FAUX_BROWSER_RELEASE_HOLD: hold }, origin: answeringOrigin(answering) });

  const began = Date.now();
  const closing = runner.close();
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  answer();
  await until(() => existsSync(`${hold}.asked`), "the run's end asked the vendor to release its session, in the drain");
  const releaseFrom = statSync(`${hold}.asked`).mtimeMs - began;
  assert.ok(releaseFrom < window.drainMs, `the release began in the drain: ${releaseFrom} ms`);
  await closing;
  const took = Date.now() - began;

  assert.ok(took < releaseBy + window.stopMarginMs + 1_500, `the close ended inside its window (${releaseBy + window.stopMarginMs} ms): ${took} ms`);
  const records = await recordsOf(server);
  const cuts = cutsOf(records);
  assert.equal(cuts.length, 1, `the run says its release was cut, once: ${JSON.stringify(cuts)}`);
  // The release's own start comes a little before the vendor is asked, and the close's start a little after `began`, so the
  // cut's bound is up to that much longer than seen here; a whole bound from the release's start would be `releaseBy`.
  assert.ok(cuts[0].bound_ms <= releaseBy - releaseFrom + 1_000 && cuts[0].bound_ms < releaseBy, `cut where the close's window cuts the release, not a whole bound after its start: ${JSON.stringify({ cut: cuts[0], releaseFrom })}`);
  const asked = statSync(`${hold}.asked`).mtimeMs;
  const charges = chargesOf(records);
  assert.equal(charges.filter((charge) => !charge.final && Date.parse(charge.at) >= asked).length, 1, `the cut charged the session's time through the cut: ${JSON.stringify({ charges, asked: new Date(asked).toISOString() })}`);
  assert.deepEqual(charges.filter((charge) => charge.final), [], "no release was confirmed, so nothing billed final");
  assert.equal(live().length, 1, "the vendor still holds the session");
  assert.deepEqual(said.filter((line) => /could not be written|releaseCut failed|beforeRelease failed: (?!Harness is closed)/.test(line)), [], "nothing of the release was refused");
  assert.deepEqual(uncountedOf(stderr), [], "every charge was counted: the seal is no lost count");
});

test("pi: a person's stop in the close's drain, its browser's release never answering, has the cut's charge and record land inside the close's window, the run ending stopped: a stopping loop's release is cut by the window the drain's end sets", { timeout: 60_000 }, async (t) => {
  const { RELEASE_MARGIN_MS } = await import("../dist/runner/loop-contract.js");
  const { runnerStopBy } = await import("../dist/runner/runner.js");
  const { sendCommand } = await import("../dist/runner/commands.js");
  const said = warnings(t);
  const stderr = stderrLines(t);
  // As above: the close's window ends 7.5 s from its start, its release cut at 6.5 s. The stop comes 2.5 s into the
  // drain, so a release bound from its own start would be cut at 9 s, past the window. A stopping loop is sent no
  // shutdown stop at the drain's end: only the window the drain's end sets moves its cut.
  const window = { leaseMs: 4_000, renewEveryMs: 500, stopMarginMs: 1_000, drainMs: 4_000, cleanupMs: CLEANUP_MS };
  const releaseBy = CLEANUP_MS + RELEASE_MARGIN_MS;
  assert.equal(runnerStopBy(0, window.drainMs, window.leaseMs, window.stopMarginMs, CLEANUP_MS), releaseBy + window.stopMarginMs);
  const hold = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "release-hold-")), "let-go");
  t.after(() => writeFileSync(hold, ""));
  const { server, runner, live } = await piRun(t, "runner-close-stop-release-", { runnerOptions: window, launch: { max_cost_usd: 1 }, env: { FAUX_BROWSER_RELEASE_HOLD: hold } });

  const began = Date.now();
  const closing = runner.close();
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await sendCommand(server, RUN, { kind: "stop" });
  await until(() => existsSync(`${hold}.asked`), "the run's stop asked the vendor to release its session, in the drain");
  const releaseFrom = statSync(`${hold}.asked`).mtimeMs - began;
  assert.ok(releaseFrom < window.drainMs, `the release began in the drain: ${releaseFrom} ms`);
  await closing;
  const took = Date.now() - began;

  assert.ok(took < releaseBy + window.stopMarginMs + 1_500, `the close ended inside its window (${releaseBy + window.stopMarginMs} ms): ${took} ms`);
  assert.equal((await server.runs.get(RUN)).state, "stopped", "the person's stop is the run's end");
  const records = await recordsOf(server);
  const cuts = cutsOf(records);
  assert.equal(cuts.length, 1, `the run says its release was cut, once: ${JSON.stringify(cuts)}`);
  assert.ok(cuts[0].bound_ms <= releaseBy - releaseFrom + 1_000 && cuts[0].bound_ms < releaseBy, `cut where the close's window cuts the release, not a whole bound after its start: ${JSON.stringify({ cut: cuts[0], releaseFrom })}`);
  const asked = statSync(`${hold}.asked`).mtimeMs;
  const charges = chargesOf(records);
  assert.equal(charges.filter((charge) => !charge.final && Date.parse(charge.at) >= asked).length, 1, `the cut charged the session's time through the cut: ${JSON.stringify({ charges, asked: new Date(asked).toISOString() })}`);
  assert.equal(live().length, 1, "the vendor still holds the session");
  assert.deepEqual(said.filter((line) => /could not be written|releaseCut failed|beforeRelease failed: (?!Harness is closed)/.test(line)), [], "nothing of the release was refused");
  assert.deepEqual(uncountedOf(stderr), [], "every charge was counted: the seal is no lost count");
});

test("the close's window runs from its start: a drain, then a release that never ends, is cut where the providers' cleanup bound from the close's start ends, and the claim is renewed to the close's end, so no other runner claims the run before close() resolves", { timeout: 60_000 }, async (t) => {
  const { RELEASE_MARGIN_MS } = await import("../dist/runner/loop-contract.js");
  const { runnerStopBy } = await import("../dist/runner/runner.js");
  // A 4 s lease less its 1 s margin is a 3 s stop; a 4 s drain first. The release's window from the close's start is
  // CLEANUP_MS and its margin (6.5 s), the cut's booking the stop's margin after it (7.5 s): past the old 3 s stop after
  // the drain (7 s from the start), and past the lease, so the claim lives only by its renewals.
  const window = { leaseMs: 4_000, renewEveryMs: 500, stopMarginMs: 1_000, drainMs: 4_000, cleanupMs: CLEANUP_MS };
  const releaseBy = CLEANUP_MS + RELEASE_MARGIN_MS;
  assert.equal(runnerStopBy(0, window.drainMs, window.leaseMs, window.stopMarginMs, CLEANUP_MS), releaseBy + window.stopMarginMs);
  const { dir, server, runner } = await cliRun(t, "runner-close-window-", { runnerOptions: window, hooks: (registered) => [...registered, () => new Promise(() => {})] });
  const other = await bystander(t, dir, "runner-b");

  const began = Date.now();
  await runner.close();
  const took = Date.now() - began;

  assert.ok(took >= window.drainMs && took < releaseBy + window.stopMarginMs + 1_500, `the close ended inside its window from its start (${releaseBy + window.stopMarginMs} ms): ${took} ms`);
  const cuts = cutsOf(await recordsOf(server));
  assert.equal(cuts.length, 1, `the release was cut, once: ${JSON.stringify(cuts)}`);
  assert.ok(cuts[0].bound_ms <= releaseBy - window.drainMs + 200, `cut where the window from the close's start ends, not a whole bound after the drain: ${JSON.stringify(cuts[0])}`);
  // runner-a hands the run back once its loop ends, after the cut: runner-b may claim it then, never before. A claim
  // before the cut is one taken from a lease runner-a let lapse while it was still closing.
  const handedBack = began + releaseBy - 200;
  const early = other.claims.filter((claim) => claim.at < handedBack);
  assert.deepEqual(early, [], `no other runner claimed the run while runner-a held it (before ${handedBack - began} ms): ${JSON.stringify(other.claims.map((claim) => ({ ...claim, after: claim.at - began })))}`);
});

test("a lost create's recovery under way when a runner's close begins is waited for: the browser it finds is released before close() resolves", { timeout: 30_000 }, async (t) => {
  const { recoverCreate } = await import("@parcha/agentrun-computer");
  const { store } = await stores(t, "runner-close-recovery-");
  const runner = startRunner({ store, name: "runner-a", ...TIMING, cleanupMs: CLEANUP_MS, createLoop: () => assert.fail("no run to claim") });
  const released = [];
  // Found just under its bound: a vendor that lists the browser late.
  const recovering = recoverCreate("browser", () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: ["b-lost"] }), CLEANUP_MS - 100)), async (id) => (released.push(id), { ok: true, value: undefined }), async () => {}, CLEANUP_MS);

  await runner.close();

  assert.deepEqual(released, ["b-lost"], "the browser the recovery found was released before close() resolved");
  assert.match(await recovering, /was released/);
});

test("a recovery that never ends holds a runner's close only to its own bound, from when it began, and the release's margin", { timeout: 30_000 }, async (t) => {
  const { RELEASE_MARGIN_MS } = await import("../dist/runner/loop-contract.js");
  const { recoverCreate, recoveriesInFlight } = await import("@parcha/agentrun-computer");
  const { store } = await stores(t, "runner-close-recovery-hung-");
  const runner = startRunner({ store, name: "runner-a", ...TIMING, cleanupMs: CLEANUP_MS, createLoop: () => assert.fail("no run to claim") });
  // A search that does not answer until the test is over, deaf to its signal: the recovery outlives the close. It began
  // 1 s before the close.
  let answer;
  t.after(() => answer({ ok: true, value: [] }));
  void recoverCreate("browser", () => new Promise((resolve) => (answer = resolve)), async () => ({ ok: true, value: undefined }), async () => {}, CLEANUP_MS).catch(() => {});
  const [recovery] = recoveriesInFlight().slice(-1);
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const began = Date.now();
  await runner.close();
  const ended = Date.now();

  const until = recovery.by + RELEASE_MARGIN_MS;
  assert.ok(ended >= until - 50 && ended < until + 600, `the close waited to the recovery's own bound and the margin, ${until - began} ms after it began: ${ended - began} ms`);
});
