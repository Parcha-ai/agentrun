// A run's host phase rows from its spec (AdapterRun.phase): a step of the host's own that the run's timeline shows as one
// `phase` row (pi-durable-agent's HOST_PHASE, "such as a box waiting for its image"). A spec says a phase while it is
// built, before the session opens (the claim's computer waiting on its image): the phase makes the run's root then, so the
// row is on the timeline a person reads WHILE the step runs, exactly once, and the spec's own writes for the root
// (onConversation) still land once. A step that fails after it keeps its row, and the run's end on that root reads the
// failure. One said after the root exists is written at once.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { HOST_PHASE } from "@parcha/pi-durable-agent/timeline";
import { Fenced, openSqliteStore } from "../dist/store/index.js";
import { runTimeline } from "../dist/store-reads/journal.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** A lease the next runner outwaits quickly, for a runner killed mid-claim. */
const SHORT = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
after(closeOpenSessions);
const BEFORE = "Preparing the computer's image: building it (python, git, curl, node, npm, rg)…";
const AFTER = "A step of the host's, said once the root exists.";
/** The run's end entry on its root (journal-kinds.ts KINDS.end). */
const END = "agentrun.end";
/** An entry the spec's onConversation writes in each conversation it is handed (a tool host's, as the browser's config). */
const MARK = "test.root-mark";

/** run-1's root entries of `kinds`, in order (none when it has no root). Read without making anything. */
async function rootEntries(store, kinds) {
  const row = await store.runs.get("run-1");
  const harness = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    if (!root) return [];
    const out = [];
    for (let cursor; ; ) {
      const page = await root.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) if (kinds.includes(entry.kind)) out.push(entry);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return out;
  } finally {
    await harness.close(BACKGROUND_CONTEXT).catch(() => {});
  }
}
const phaseRows = async (store) => (await rootEntries(store, [HOST_PHASE])).map((entry) => entry.data);

/** run-1's timeline rows as a person reads them (GET /v2/runs/{id}/timeline: store-reads' runTimeline over the store's
 *  entries). Read-only, so it reads while the runner holds the run. */
const liveRows = (store) => runTimeline(store, "run-1", BACKGROUND_CONTEXT);

/** `check()` truthy within `ms`, or a failure that names what never came. */
async function until(what, check, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await check();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A server and runner stores over one temp dir, run-1 queued; the runner (started by the case) closed after. */
async function world(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-loop-phase-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const w = { server, store, dir, runner: undefined };
  t.after(async () => {
    await w.runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Phases" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  return w;
}

const finished = (server) =>
  until("run-1 ends and is released", async () => {
    const row = await server.runs.get("run-1");
    return ["ended", "stopped", "failed"].includes(row.state) && row.runner === null && row;
  });

/** The spec's own lifecycle with one onConversation write: MARK on each conversation it is handed. */
const marked = (base) => ({
  ...base,
  lifecycle: {
    onConversation: [...(base.lifecycle?.onConversation ?? []), async (tx, conversationId) => void (await tx.appendEntry(conversationId, { kind: MARK, data: { conversationId } }))],
    beforeResume: base.lifecycle?.beforeResume ?? [],
    beforeRelease: base.lifecycle?.beforeRelease ?? [],
    ...(base.lifecycle?.personWait ? { personWait: base.lifecycle.personWait } : {}),
  },
});

test("a phase the spec says while it is built (before the root) is one phase row on the root; one said after is written at once", async (t) => {
  const w = await world(t);
  // A host tool that says a phase while the run runs: the root exists by then.
  const said = { name: "said", replaySafe: true, ask: false, run: async () => "said" };
  const spec = piAdapterSpec({ script: [{ call: "said" }, { say: "done" }], tools: { said }, hooks: quiet });
  const before = [];
  const loop = createAdapterLoop(async (claim, run) => {
    before.push(typeof run.phase);
    // Said while the spec is built: no root yet.
    run.phase?.(BEFORE);
    const base = await spec(claim, run);
    const tools = base.session.tools.map((tool) => (tool.name === "said" ? { ...tool, call: async () => (run.phase?.(AFTER), { text: "said" }) } : tool));
    return { ...base, agentId: "agent-1", session: { ...base.session, tools } };
  });
  w.runner = startRunner({ store: w.store, createLoop: loop, name: "runner-a", ...TIMING });
  assert.equal((await finished(w.server)).state, "ended");
  assert.deepEqual(before, ["function"], "the loop hands the spec a phase");
  const rows = await phaseRows(w.server);
  assert.deepEqual(rows.map((one) => one.summary), [BEFORE, AFTER], `one row each, the one said before the root first: ${JSON.stringify(rows)}`);
  for (const one of rows) assert.equal(typeof one.at, "number", "each at the time it was said");
  assert.ok(rows[0].at <= rows[1].at);
});

test("a long step after its phase (an image build): the row is on the person's timeline WHILE the step runs, once; the spec's own root write lands once and the run goes on", async (t) => {
  const w = await world(t);
  const spec = piAdapterSpec({ script: [{ say: "done" }], tools: {}, hooks: quiet });
  // The build, held by the case: the spec waits on it, as computerForClaim waits on Docker's image build.
  let finishBuild;
  const build = new Promise((resolve) => (finishBuild = resolve));
  // A case that fails while the build is held lets it go, so the runner closes at once (t.after runs last-in, first-out).
  t.after(() => finishBuild());
  let building = false;
  const loop = createAdapterLoop(async (claim, run) => {
    run.phase?.(BEFORE);
    building = true;
    await build;
    building = false;
    return marked({ ...(await spec(claim, run)), agentId: "agent-1" });
  });
  w.runner = startRunner({ store: w.store, createLoop: loop, name: "runner-a", ...TIMING });
  const shown = await until("the phase row on the timeline while the build runs", async () => {
    const rows = (await liveRows(w.server)).filter((row) => row.kind === "phase" && row.summary === BEFORE);
    return rows.length > 0 && rows;
  });
  assert.equal(building, true, "read while the build still runs");
  assert.equal(shown.length, 1, "one row");
  finishBuild();
  assert.equal((await finished(w.server)).state, "ended", "the run goes on once the image is ready, onto the root the phase made");
  assert.deepEqual((await phaseRows(w.server)).map((one) => one.summary), [BEFORE], "still exactly one row");
  const marks = await rootEntries(w.server, [MARK]);
  assert.equal(marks.length, 1, `the spec's onConversation wrote the root once, though the phase made it before the spec was known: ${JSON.stringify(marks)}`);
});

test("a runner lost after a phase made the root, before its spec was built: the next claim makes the spec's root write, once", async (t) => {
  const w = await world(t);
  const second = await openSqliteStore({ dataDir: w.dir, role: "runner" });
  let other;
  t.after(async () => {
    await other?.close().catch(() => {});
    await second.close().catch(() => {});
  });
  const spec = piAdapterSpec({ script: [{ say: "done" }], tools: {}, hooks: quiet });
  // The first claim's build never finishes: its runner is killed while the spec waits on it, the root made by its phase.
  let failBuild;
  const build = new Promise((_, reject) => (failBuild = reject));
  build.catch(() => undefined);
  t.after(() => failBuild(new Error("the test ended")));
  const first = createAdapterLoop(async (_claim, run) => {
    run.phase?.(BEFORE);
    await build;
    throw new Error("never built");
  });
  w.runner = startRunner({ store: w.store, createLoop: first, name: "runner-a", ...SHORT });
  await until("the phase row on the timeline while the build runs", async () => (await liveRows(w.server)).some((row) => row.kind === "phase" && row.summary === BEFORE));
  w.runner.kill();
  // The next claim finds the image built (no phase of its own) and goes on onto the root the first claim's phase made.
  const next = createAdapterLoop(async (claim, run) => marked({ ...(await spec(claim, run)), agentId: "agent-1" }));
  other = startRunner({ store: second, createLoop: next, name: "runner-b", ...TIMING });
  assert.equal((await finished(w.server)).state, "ended");
  assert.deepEqual((await phaseRows(w.server)).map((one) => one.summary), [BEFORE], "the first claim's row");
  const marks = await rootEntries(w.server, [MARK]);
  assert.equal(marks.length, 1, `the spec's onConversation wrote the root once, on the claim after the lost one: ${JSON.stringify(marks)}`);
});

test("a claim lost while the spec's owed root writes commit still lets the spec's resources go", async (t) => {
  const w = await world(t);
  const spec = piAdapterSpec({ script: [{ say: "done" }], tools: {}, hooks: quiet });
  let released = 0;
  let refused = false;
  const loop = createAdapterLoop(async (claim, run) => {
    run.phase?.(BEFORE);
    await until("the phase row on the timeline", async () => (await liveRows(w.server)).some((one) => one.kind === "phase" && one.summary === BEFORE), 10_000);
    const base = marked({ ...(await spec(claim, run)), agentId: "agent-1" });
    return {
      ...base,
      release: async () => {
        released += 1;
        await base.release?.();
      },
    };
  });
  // The store refuses the commit that makes the owed root write: the claim was lost (Fenced), as a lost lease reads.
  const losing = (deps) =>
    loop({
      ...deps,
      journal: (claim) =>
        new Proxy(deps.journal(claim), {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key !== "commit" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
            return async (batches, ...rest) => {
              if (!refused && JSON.stringify(batches).includes(MARK)) {
                refused = true;
                throw new Fenced(claim.runId, claim.epoch);
              }
              return value.call(target, batches, ...rest);
            };
          },
        }),
    });
  w.runner = startRunner({ store: w.store, createLoop: losing, name: "runner-a", ...TIMING });
  await until("the owed root write is refused", () => refused);
  await until("the spec's release is called", () => released > 0, 10_000);
  assert.equal(released, 1, "released once");
});

test("a step that fails after its phase (a failed image build) keeps its row, and the run's end on that root says why", async (t) => {
  const w = await world(t);
  const FAILED = "the image build failed: step 3 of the recipe exited 1";
  const loop = createAdapterLoop(async (_claim, run) => {
    run.phase?.(BEFORE);
    // The row is written before the build fails (the claim waits on the build, the row shows meanwhile).
    await until("the phase row is on the timeline", async () => (await liveRows(w.server)).some((one) => one.kind === "phase" && one.summary === BEFORE), 10_000);
    throw new Error(FAILED);
  });
  w.runner = startRunner({ store: w.store, createLoop: loop, name: "runner-a", ...TIMING });
  const row = await finished(w.server);
  assert.equal(row.state, "failed");
  assert.match(row.summary ?? "", /the image build failed/, `the row says why: ${JSON.stringify(row)}`);
  assert.deepEqual((await phaseRows(w.server)).map((one) => one.summary), [BEFORE], "the failed build keeps its row");
  const rows = await liveRows(w.server);
  assert.ok(rows.some((one) => one.kind === "phase" && one.summary === BEFORE), `the person's timeline keeps the phase row: ${JSON.stringify(rows)}`);
  // The run's end is on that root, after the row, with why: the journal reads the run failed, as its row does.
  const kept = await rootEntries(w.server, [HOST_PHASE, END]);
  assert.deepEqual(kept.map((entry) => entry.kind), [HOST_PHASE, END], `the row, then the end: ${JSON.stringify(kept)}`);
  assert.equal(kept[1].data.state, "failed");
  assert.match(String(kept[1].data.summary), /the image build failed/);
});
