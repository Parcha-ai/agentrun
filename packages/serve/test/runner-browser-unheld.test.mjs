// The browsers of a run's labels that nobody holds, released as its claim lets the run go, through the real loop
// (startRunner over createDispatchLoop and the adapter spec, on a real store, the faux browser and a scripted model):
// a create whose reply was lost can leave a session no claim holds (one its recovery kept for a converge that answered
// another), which a vendor that ends its sessions itself runs to its lifetime otherwise. At the run's end, its stop,
// and its park (the claim's release), that session is released once, its time is in the run's cost
// once (a final BROWSER_CHARGED under its own tag), and the run's timeline says so; the session the run held goes by
// its own release, never a second one. Where the vendor lists that session as the run's own is released by its tag,
// that release ends it, and it is charged there under the same tag: once, also when the let-go's release lists it
// again, and the run's own session, which a vendor's list shows a moment past its release, is never charged as one
// nobody held. A reopen books the charge it made once. Beside it, what the let-go holds (browserHolds): a session the
// run's custody still holds, by its id, and every session of a tag whose create's answer was lost, and a session whose
// create is still in flight is left to it; another run's session and a later epoch's are never touched.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import fauxBrowser from "./fixtures/faux-browser.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
const browserComputer = await import("../dist/browser-computer.js");
const { unheldWords } = await import("../dist/browser-cost.js");
after(closeOpenSessions);

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 9);
const RUN = "run-1";
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
/** Test keys, no real ones. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const LAUNCH = { input: { content: "Browse." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, plane: { browser: "browserbase" } };
/** How long before the run's own session the unheld one was made (FAUX_BROWSER_UNHELD), in seconds. */
const AGE_S = 600;
/** Browserbase's list price, $0.12 an hour. */
const USD_PER_S = 0.12 / 3600;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** `names` set to `values` for the test, as they were after it. */
const withEnv = (t, values) => {
  const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [name, value] of Object.entries(before)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
};

/** run-1 on a new store, run by a runner on the adapter spec with a scripted free model, the faux browser making one
 *  unheld session beside the run's first (FAUX_BROWSER_UNHELD). `gate`: the model's second request waits for it (its
 *  promise) or for its abort. */
async function unheldRun(t, { script, gate, launch = LAUNCH, listed = "" }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-browser-unheld-"));
  const log = join(dir, "faux-browser.log");
  writeFileSync(log, "");
  withEnv(t, { FAUX_BROWSER_LOG: log, FAUX_BROWSER_UNHELD: String(AGE_S), FAUX_BROWSER_UNHELD_LISTED: listed });
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const runner = { current: undefined };
  t.after(async () => {
    await runner.current?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries(BROWSERBASE)) await putSealedKey(server, SEAL_KEY, name, value);
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Browse.", tools: ["browser"] } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const requests = [];
  const scripted = scriptedOrigin(script, requests);
  let asked = 0;
  const fetch = async (url, init = {}) => {
    if (gate && ++asked === 2) {
      await Promise.race([gate, new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }))]);
    }
    return scripted(url, init);
  };
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch, price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 100 };
  const deps = { env: { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  runner.current = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  /** The faux vendor's log lines. */
  const ops = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  /** The unheld session, once made: its id, and the session it came with (the run's own). */
  const unheld = () => until(() => ops().find((op) => op.op === "unheld-made"), "the unheld session is made");
  /** The run's journal at `epoch`, read as `state`. */
  const records = async (epoch, state) => journalRecords(server.journal({ runId: RUN, runner: "reader", epoch, until: 0, from: state }), ctx);
  const rest = (states) => until(async () => {
    const now = await server.runs.get(RUN);
    return states.includes(now.state) && now.runner === null && now;
  }, `the run rests ${states.join("|")}`);
  /** Whether the model's second request has been asked (and, with `gate`, waits). */
  const second = () => asked >= 2;
  return { server, runner, requests, ops, unheld, records, rest, second };
}

/** What the let-go did, read from the vendor's log and the run's root: the releases of the unheld session and of the
 *  run's own, the unheld one's charges, and its BROWSERS_UNHELD entries. */
function letGo(run, made, recs) {
  const releases = (id) => run.ops().filter((op) => op.op === "release" && op.id === id).length;
  const charged = recs.entries.filter((e) => e.kind === "agentrun.browser_charged" && e.data?.tag === `unheld:${made.id}`);
  // Every charge under a tag that names the session's id, whichever release made it (the run's own is charged under its
  // custody tag, which names no id).
  const chargesOf = (id) => recs.entries.filter((e) => e.kind === "agentrun.browser_charged" && String(e.data?.tag ?? "").includes(id));
  const said = recs.entries.filter((e) => e.kind === "agentrun.browsers_unheld");
  return { unheldReleases: releases(made.id), ownReleases: releases(made.with), charged, said, unheldCharges: chargesOf(made.id), ownUnheldCharges: chargesOf(made.with) };
}

/** The unheld session released once, its time charged once (final, under no call, from when it was made), said once;
 *  the run's own released once, by its own release. */
function assertLetGo(what, got, made) {
  assert.equal(got.unheldReleases, 1, `${what}: the unheld session ${made.id} was released once: ${JSON.stringify(got)}`);
  assert.equal(got.ownReleases, 1, `${what}: the run's own session ${made.with} was released once, by its own release`);
  assert.equal(got.charged.length, 1, `${what}: the unheld session's time was charged once: ${JSON.stringify(got.charged)}`);
  const [charge] = got.charged;
  assert.equal(charge.data.final, true);
  assert.equal(charge.data.call, null);
  assert.ok(charge.data.seconds >= AGE_S, `${what}: charged from when it was made, ${AGE_S} s or more before: ${charge.data.seconds} s`);
  assert.equal(eight(charge.data.usd), eight(charge.data.seconds * USD_PER_S), `${what}: at Browserbase's price: ${JSON.stringify(charge.data)}`);
  assert.equal(got.said.length, 1, `${what}: the run's root says it once`);
  assert.match(got.said[0].data.words, new RegExp(`^Released 1 browser a create race left running \\(${made.id}\\); this run did not hold it, and its time is in the run's cost\\.$`));
  assert.equal(got.unheldCharges.length, 1, `${what}: no other charge names ${made.id}: ${JSON.stringify(got.unheldCharges)}`);
  assert.equal(got.ownUnheldCharges.length, 0, `${what}: the run's own session ${made.with} is never charged as one nobody held`);
}

test("at the run's end, the session of the run's labels that nobody held, which the vendor did not list at its companion's release, is released by the let-go once and its time is in the run's cost once; the run's own goes by its own release, and the timeline says it", { timeout: 120_000 }, async (t) => {
  const run = await unheldRun(t, { script: [{ call: "snapshot" }, { say: "done" }] });
  const made = await run.unheld();
  const row = await run.rest(["ended", "failed", "stopped"]);
  assert.equal(row.state, "ended", JSON.stringify(row));
  const recs = await run.records(row.epoch, row.state);
  const got = letGo(run, made, recs);
  assertLetGo("the end", got, made);
  const browser = recs.entries.filter((e) => e.kind === "agentrun.browser_charged").reduce((sum, e) => sum + e.data.usd, 0);
  assert.equal(eight(row.costUsd ?? Number.NaN), eight(browser), `the run's cost holds every browser charge once, the unheld one's too: ${row.costUsd}`);
  const rows = await runTimeline(run.server, RUN, ctx, { settled: true });
  assert.ok(rows.some((one) => one.origin === "server" && /^AgentRun: Released 1 browser a create race left running/.test(one.summary ?? "")), `the timeline says it: ${JSON.stringify(rows.map((one) => one.summary))}`);
});

test("where the vendor lists the session a create race left as the run's own is released by its tag, that release ends it and its time is charged there once, under its own tag, and the let-go charges nothing more", { timeout: 120_000 }, async (t) => {
  const run = await unheldRun(t, { script: [{ call: "snapshot" }, { say: "done" }], listed: "tag" });
  const made = await run.unheld();
  const row = await run.rest(["ended", "failed", "stopped"]);
  assert.equal(row.state, "ended", JSON.stringify(row));
  const recs = await run.records(row.epoch, row.state);
  const got = letGo(run, made, recs);
  assertLetGo("the tag release", got, made);
  assert.ok(!run.ops().some((op) => op.op === "release-noop" && op.id === made.id), "the let-go's list no longer showed it: the tag release alone ended it");
  const browser = recs.entries.filter((e) => e.kind === "agentrun.browser_charged").reduce((sum, e) => sum + e.data.usd, 0);
  assert.equal(eight(row.costUsd ?? Number.NaN), eight(browser), `the run's cost holds every browser charge once: ${row.costUsd}`);
});

test("where the tag release ends that session and the let-go's list still shows it and the run's own as running, the let-go releases it again and charges nothing more, and never charges the run's own as one nobody held", { timeout: 120_000 }, async (t) => {
  const run = await unheldRun(t, { script: [{ call: "snapshot" }, { say: "done" }], listed: "stale" });
  const made = await run.unheld();
  const row = await run.rest(["ended", "failed", "stopped"]);
  assert.equal(row.state, "ended", JSON.stringify(row));
  const recs = await run.records(row.epoch, row.state);
  const got = letGo(run, made, recs);
  assertLetGo("the tag release and the let-go", got, made);
  assert.ok(run.ops().some((op) => op.op === "release-noop" && op.id === made.id), `the let-go's list showed it and released it again: ${JSON.stringify(run.ops().filter((op) => op.op?.startsWith("release")))}`);
  const browser = recs.entries.filter((e) => e.kind === "agentrun.browser_charged").reduce((sum, e) => sum + e.data.usd, 0);
  assert.equal(eight(row.costUsd ?? Number.NaN), eight(browser), `the run's cost holds every browser charge once: ${row.costUsd}`);
});

test("a reopen after the let-go charged the session nobody held books that charge once: the park's let-go charges it, the raise reopens the run, and its cost holds it once at the end", { timeout: 180_000 }, async (t) => {
  const run = await unheldRun(t, { script: [{ call: "snapshot" }, { call: "snapshot" }, { say: "done" }], launch: { ...LAUNCH, max_cost_usd: 0.019 } });
  const made = await run.unheld();
  const parked = await run.rest(["ended", "failed", "stopped", "parked"]);
  assert.equal(parked.state, "parked", JSON.stringify({ state: parked.state, summary: parked.summary }));
  const before = letGo(run, made, await run.records(parked.epoch, parked.state));
  assertLetGo("the park", before, made);
  const [charge] = before.charged;
  assert.ok(charge.data.usd > 0, JSON.stringify(charge.data));
  await sendCommand(run.server, RUN, { kind: "raise", body: { capUsd: 5 } });
  const row = await until(async () => {
    const now = await run.server.runs.get(RUN);
    return now.epoch > parked.epoch && ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run reopens and ends");
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  const recs = await run.records(row.epoch, row.state);
  const after = letGo(run, made, recs);
  assert.equal(after.unheldCharges.length, 1, `charged once across both claims: ${JSON.stringify(after.unheldCharges)}`);
  assert.equal(after.unheldReleases, 1, "released once");
  const browser = recs.entries.filter((e) => e.kind === "agentrun.browser_charged").reduce((sum, e) => sum + e.data.usd, 0);
  assert.equal(eight(row.costUsd ?? Number.NaN), eight(browser), `the run's cost holds the charge once after the reopen: ${row.costUsd} against ${browser}, the unheld one ${charge.data.usd}`);
});

test("at the run's stop, the session nobody held is released once and charged once, the run's own by its own release", { timeout: 120_000 }, async (t) => {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  t.after(() => open());
  const run = await unheldRun(t, { script: [{ call: "snapshot" }, { say: "done" }], gate });
  const made = await run.unheld();
  await until(run.second, "the model's second request is waiting");
  await sendCommand(run.server, RUN, { kind: "stop", body: {} });
  const row = await run.rest(["ended", "failed", "stopped"]);
  assert.equal(row.state, "stopped", JSON.stringify(row));
  assertLetGo("the stop", letGo(run, made, await run.records(row.epoch, row.state)), made);
});

test("at the run's park (its claim's release), the session nobody held is released once and charged once, the run's own by its own release", { timeout: 120_000 }, async (t) => {
  // A cap ($0.019) the first snapshot's hold fits ($0.018: two stretches of 270 s at Browserbase's $0.12 an hour) and the
  // second's does not (its two stretches beside the session's reserve): the run parks for room with its session open.
  const run = await unheldRun(t, { script: [{ call: "snapshot" }, { call: "snapshot" }, { say: "done" }], launch: { ...LAUNCH, max_cost_usd: 0.019 } });
  const made = await run.unheld();
  const row = await run.rest(["ended", "failed", "stopped", "parked"]);
  assert.equal(row.state, "parked", JSON.stringify({ state: row.state, summary: row.summary }));
  assertLetGo("the park", letGo(run, made, await run.records(row.epoch, row.state)), made);
});

test("the let-go holds a session its custody still holds by its id, and every session of a tag whose create's answer was lost; it releases the rest of its own run's and claim's, never another run's or a later epoch's", async (t) => {
  withEnv(t, { FAUX_BROWSER_LOG: "", FAUX_BROWSER_UNHELD: "" });
  const { computer: provider } = fauxBrowser({}, "browserbase");
  const run = { runId: "run-held", epoch: 3 };
  const browser = browserComputer.planeBrowser(provider, run);
  const held = await browser.open("held-tag", 60);
  const unheld = await browser.open("other-tag", 60);
  // A create whose answer was lost: its session exists under its tag, and the row has no id.
  const lost = await provider.create({ image: "chromium", lifetimeMs: 60_000, network: "open", labels: { "agentrun.run": "run-held", "agentrun.epoch": "3", "agentrun.session": "lost-tag" } }, { requestId: "lost" });
  // Another run's, at this epoch, and this run's at a later epoch.
  const another = await browserComputer.planeBrowser(provider, { runId: "run-other", epoch: 3 }).open("held-tag", 60);
  const later = await browserComputer.planeBrowser(provider, { runId: "run-held", epoch: 4 }).open("later-tag", 60);
  const swept = await browserComputer.releaseUnheldBrowsers(browser, async () => [{ tag: "held-tag", resourceId: held }, { tag: "lost-tag", resourceId: null }]);
  assert.deepEqual(swept.released.map((one) => one.id), [unheld], "only the session nothing held is released");
  assert.equal(swept.released[0].tag, "other-tag");
  assert.match(String(swept.released[0].createdAt), /^\d{4}-\d\d-\d\dT/, "with when the vendor made it");
  assert.deepEqual(swept.failed, []);
  assert.deepEqual(swept.creating, []);
  for (const [id, what] of [[held, "the held session"], [lost.value.id, "the lost create's session"], [another, "another run's"], [later, "a later epoch's"]]) {
    assert.equal((await provider.attach({ id })).ok, true, `${what} still runs`);
  }
  assert.equal((await provider.attach({ id: unheld })).ok, false, "the unheld one has ended");
  assert.deepEqual(browserComputer.browserHolds([{ tag: "a", resourceId: "id-a" }, { tag: "b", resourceId: null }]), { ids: new Set(["id-a"]), tags: new Set(["b"]) });
  assert.deepEqual(browserComputer.browserHolds([{ tag: "a", resourceId: "id-a" }], ["id-released"]), { ids: new Set(["id-released", "id-a"]), tags: new Set() }, "every id the custody held, released since or not");
});

test("the let-go leaves a session whose create this process still has in flight, says it, and releases it never; once the create answers, the session is the run's", async (t) => {
  withEnv(t, { FAUX_BROWSER_LOG: "", FAUX_BROWSER_UNHELD: "" });
  const { computer: faux } = fauxBrowser({}, "browserbase");
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  t.after(() => open());
  // The vendor has made the session; its answer has not reached the run yet.
  let madeId;
  const provider = { ...faux, async create(spec, context) { const made = await faux.create(spec, context); madeId = made.ok ? made.value.id : undefined; await gate; return made; } };
  const browser = browserComputer.planeBrowser(provider, { runId: "run-inflight", epoch: 1 });
  const opening = browser.open("inflight-tag", 60);
  await until(() => madeId, "the vendor made the session");
  // The run's custody holds nothing yet: its row has no id and the let-go's rows are read empty.
  const swept = await browserComputer.releaseUnheldBrowsers(browser, async () => []);
  assert.deepEqual(swept.released, [], "nothing released");
  assert.deepEqual(swept.creating, [madeId], "the in-flight create's session is left to it, and named");
  assert.equal((await faux.attach({ id: madeId })).ok, true, "it still runs");
  assert.equal(unheldWords(swept), `Left 1 browser to its create, still running (${madeId}).`);
  open();
  assert.equal(await opening, madeId, "the create answers with it");
  const after = await browserComputer.releaseUnheldBrowsers(browser, async () => [{ tag: "inflight-tag", resourceId: madeId }]);
  assert.deepEqual({ released: after.released, creating: after.creating }, { released: [], creating: [] }, "held by its row once it answered");
});
