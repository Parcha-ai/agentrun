// A run on a desktop that parks for a tool's approval keeps its desktop (computer-kept.ts), through the runner, the pi
// spec and the adapter loop as they really run: the park says the desktop is kept for 10 minutes; an approval within
// them resumes the run on the same desktop (no second create, no replaced row, no server note to the model); one after
// them resumes on a new desktop, said once with why, the kept one let go; a stop while parked lets it go at once.
//
// The desktop is --faux's machine (faux-computers.ts) behind a loopback vendor that keeps its computers across claims,
// as a vendor's account does: nothing is rented. The clock the keep is read by is the test's.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { KEEP_MS, keptKeyOf } = await import("../dist/workspace/computer-kept.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const DESKTOP = { kind: "desktop", provider: "faux-desktop" };
const FAUX = fauxComputers();
after(closeOpenSessions);

const HOLD = "The desktop is kept for 10 minutes while you decide.";
const SAME = "It's the same desktop, as the wait left it.";
const LAPSED = "The desktop wasn't kept: 10 minutes passed.";
const ROW = "AgentRun: Your computer was replaced. The earlier one is gone, with its screen and refs. Look at the screen again before acting.";
const NOTES = /AgentRun server note: your computer was replaced[^<]*/g;

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A vendor of --faux's desktops that keeps them across claims: create starts one under the spec's labels, attach and
 *  connect find it, delete ends it. Every create and release is recorded. */
function fauxVendor() {
  const entry = FAUX.kinds.PROVIDERS.find((one) => one.id === "faux-desktop");
  const computers = new Map();
  const calls = [];
  let made = 0;
  const provider = {
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
      calls.push(["create", id]);
      computers.set(id, { id, labels: { ...spec.labels }, desk: await FAUX.launch(entry, { kind: "desktop", keys: {} }) });
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
    async release(ref, how) {
      calls.push(["release", ref.id, how]);
      if (how === "delete") {
        await computers.get(ref.id)?.desk.release().catch(() => {});
        computers.delete(ref.id);
      }
      return { ok: true, value: undefined };
    },
  };
  return { provider, computers, calls };
}

/** run-1 on a desktop whose tools ask (the `desktop` key), run by a runner on the pi spec with a scripted model: a
 *  screenshot, then an answer. Rests parked on the screenshot's ask. */
async function parkedRun(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-park-keeps-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: DESKTOP, tools: ["read"], toolSettings: { desktop: { permission: "ask" } } } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } } });
  // Someone can answer an ask (server-approvers.ts APPROVERS_KEY), so it parks.
  await server.settings.put("approvers", { approvers: true });
  await server.flush?.();
  const requests = [];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin([{ call: "computer_screenshot", args: {} }, { say: "done" }], requests), price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 100 };
  const vendor = fauxVendor();
  const clock = { offset: 0 };
  const computerDeps = { kinds: FAUX.kinds, keyTable: FAUX.keyTable, providers: { "faux-desktop": () => vendor.provider }, spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open" }), check: { readBackOf }, now: () => Date.now() + clock.offset };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped", "parked"].includes(now.state) && now.runner === null && now;
  }, "the run rests");
  assert.equal(row.state, "parked", JSON.stringify(row));
  const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const [ask] = records.entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
  assert.ok(ask, "parked on the screenshot's ask");
  return { server, vendor, clock, requests, ask };
}

/** Until the run ends; its row and its timeline's summaries. */
async function ends(one, state = "ended") {
  const row = await until(async () => {
    const now = await one.server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run ends");
  assert.equal(row.state, state, JSON.stringify(row));
  return (await runTimeline(one.server, RUN, ctx)).map((entry) => entry.summary ?? "");
}

const creates = (vendor) => vendor.calls.filter(([verb]) => verb === "create").map(([, id]) => id);
const deletes = (vendor) => vendor.calls.filter(([verb, , how]) => verb === "release" && how === "delete").map(([, id]) => id);
const notes = (requests) => requests.map((body) => (JSON.stringify(body).match(NOTES) ?? []).length);
/** The vendor's deletes, once they are `want`: the run's row reads ended before its claim's release has answered. */
async function deleted(vendor, want, what) {
  await until(async () => deletes(vendor).length >= want.length, what, 10_000).catch(() => undefined);
  assert.deepEqual(deletes(vendor), want, what);
}

test("a desktop run parked on a tool's approval and approved within 10 minutes goes on on the same desktop: no second create, not called a new one, no note to the model", { timeout: 120_000 }, async (t) => {
  const one = await parkedRun(t);
  assert.deepEqual(creates(one.vendor), ["d1"]);
  assert.deepEqual(deletes(one.vendor), [], "kept at the park");
  assert.ok(await one.server.settings.get(keptKeyOf(RUN)), "its keep is on the server");
  one.clock.offset = 60_000;
  await one.server.command(RUN, { kind: "approve", body: { approval: one.ask.callId } });
  const said = await ends(one);
  assert.deepEqual(creates(one.vendor), ["d1"], "the same desktop: no create at the resume");
  await deleted(one.vendor, ["d1"], "let go at the run's end");
  assert.equal(said.filter((summary) => summary === HOLD).length, 1, `the park said it is kept: ${JSON.stringify(said)}`);
  assert.equal(said.filter((summary) => summary.endsWith(SAME)).length, 1, "the resume said it is the same one");
  assert.deepEqual(said.filter((summary) => summary.startsWith("AgentRun: Your computer")), [], "no replaced row");
  assert.deepEqual(notes(one.requests).filter(Boolean), [], "no server note to the model");
  assert.equal(await one.server.settings.get(keptKeyOf(RUN)), undefined, "the keep taken");
});

test("a desktop run approved after 10 minutes goes on on a new desktop: the kept one let go, said once with why, the model told once", { timeout: 120_000 }, async (t) => {
  const one = await parkedRun(t);
  one.clock.offset = KEEP_MS + 1_000;
  await one.server.command(RUN, { kind: "approve", body: { approval: one.ask.callId } });
  const said = await ends(one);
  assert.deepEqual(creates(one.vendor), ["d1", "d2"], "a new desktop");
  await deleted(one.vendor, ["d1", "d2"], "the kept one let go before it, the new one at the end");
  assert.equal(said.filter((summary) => summary.includes(`${LAPSED} It's a new desktop`)).length, 1, `said once, with why: ${JSON.stringify(said)}`);
  assert.deepEqual(said.filter((summary) => summary.startsWith("AgentRun: Your computer")), [ROW], "the replaced row once");
  assert.deepEqual(notes(one.requests).filter(Boolean), [1], "the model told once");
});

test("a stop while parked lets the kept desktop go at once", { timeout: 120_000 }, async (t) => {
  const one = await parkedRun(t);
  assert.deepEqual(deletes(one.vendor), [], "kept at the park");
  await one.server.command(RUN, { kind: "stop" });
  await ends(one, "stopped");
  assert.deepEqual(creates(one.vendor), ["d1"]);
  await deleted(one.vendor, ["d1"], "let go by the stop's claim");
  await until(async () => one.vendor.computers.size === 0, "nothing left running", 10_000);
  assert.equal(await one.server.settings.get(keptKeyOf(RUN)), undefined);
});

test("a denial while parked goes on on the same desktop, the call refused: the run's end then lets it go", { timeout: 120_000 }, async (t) => {
  const one = await parkedRun(t);
  await one.server.command(RUN, { kind: "deny", body: { approval: one.ask.callId, note: "not now" } });
  const said = await ends(one);
  assert.deepEqual(creates(one.vendor), ["d1"], "no new desktop");
  await deleted(one.vendor, ["d1"], "let go at the run's end");
  assert.deepEqual(said.filter((summary) => summary.startsWith("AgentRun: Your computer")), []);
});
