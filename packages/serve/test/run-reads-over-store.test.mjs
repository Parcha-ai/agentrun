// The run READ routes over the one store (run-reads-over-store.ts): a run's files through its Workspace, and its browser
// state from its launch, revision and (the seam) its runner's live viewer. Over a real store in a temp dir and a real local
// Workspace, each answers the shape the route answers today.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { openSqliteStore } = await import("../dist/store/index.js");
const { localWorkspace } = await import("../dist/workspace/index.js");
const { launchBody } = await import("../dist/run-launch.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { listRunFiles, readRunFile, runBrowserState, runGraphView, runTimelines } = await import("../dist/run-reads-over-store.js");

const dirs = [];
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function freshStore(revisionBody = { instructions: "Answer.", tools: [] }) {
  const store = await openSqliteStore({ file: join(tempDir("agentrun-rr-"), "store.sqlite"), role: "server" });
  after(() => store.close().catch(() => undefined));
  await store.agents.create({ id: "a1", name: "Agent one" }, { id: "r1", kind: "agentic", body: revisionBody });
  return store;
}

const deps = (over = {}) => ({ env: {}, runWorkspace: async () => null, runView: async () => undefined, withheld: async () => false, context: BACKGROUND_CONTEXT, ...over });

// ---- listRunFiles ---------------------------------------------------------------------------------------------------

test("listRunFiles lists a run's files through its Workspace, path-sorted", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const work = tempDir("agentrun-ws-");
  mkdirSync(join(work, "b"));
  writeFileSync(join(work, "a.txt"), "A");
  writeFileSync(join(work, "b", "c.txt"), "C");
  const answer = await listRunFiles(store, "run-1", deps({ runWorkspace: async () => localWorkspace(work) }));
  assert.equal(answer.run_id, "run-1");
  assert.deepEqual(answer.files.map((f) => f.path), ["a.txt", "b/c.txt"]);
  assert.equal(answer.complete, true);
  assert.equal(answer.truncated, false);
});

test("listRunFiles lists none for a run with no folder", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const answer = await listRunFiles(store, "run-1", deps());
  assert.deepEqual(answer, { run_id: "run-1", files: [], complete: true, truncated: false });
});

test("listRunFiles refuses a withheld run (403) before reading any file", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const work = tempDir("agentrun-ws-withheld-");
  writeFileSync(join(work, "secret.txt"), "signed-in page");
  let read = false;
  await assert.rejects(
    () => listRunFiles(store, "run-1", deps({ withheld: async () => true, runWorkspace: async () => { read = true; return localWorkspace(work); } })),
    (e) => e.code === "forbidden",
  );
  assert.equal(read, false, "a withheld run's folder is never opened");
});

// ---- readRunFile ----------------------------------------------------------------------------------------------------

test("readRunFile is 404 for a run with no folder", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  await assert.rejects(
    () => readRunFile(store, "run-1", "a.txt", {}, {}, new URL("http://x/"), deps()),
    (e) => e.code === "not_found" && /no such file/.test(e.message),
  );
});

test("readRunFile refuses a withheld run (403) before streaming", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const work = tempDir("agentrun-ws-withheld2-");
  writeFileSync(join(work, "a.txt"), "signed-in page");
  await assert.rejects(
    () => readRunFile(store, "run-1", "a.txt", {}, {}, new URL("http://x/"), deps({ withheld: async () => true, runWorkspace: async () => localWorkspace(work) })),
    (e) => e.code === "forbidden",
  );
});

test("readRunFile refuses a path that escapes the run's own files", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const work = tempDir("agentrun-ws2-");
  await assert.rejects(() => readRunFile(store, "run-1", "../secret", {}, {}, new URL("http://x/"), deps({ runWorkspace: async () => localWorkspace(work) })));
});

// ---- runBrowserState ------------------------------------------------------------------------------------------------

test("runBrowserState is live with the viewer's link when the runner serves one", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const answer = await runBrowserState(store, "run-1", deps({ liveViewer: async () => ({ viewer: "/v2/runs/run-1/browser/live/v/abc#t=tok" }) }));
  assert.deepEqual(answer, { state: "live", viewer: "/v2/runs/run-1/browser/live/v/abc#t=tok" });
});

test("runBrowserState is off with a reason when the run has no browser tool", async () => {
  const store = await freshStore({ instructions: "Answer.", tools: [] });
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" }, { body: launchBody({ input: { content: "hi" }, title: "t", place: { mode: "runner" } }) });
  const answer = await runBrowserState(store, "run-1", deps());
  assert.deepEqual(answer, { state: "off", reason: "this run's agent has no browser tool" });
});

test("runBrowserState is off when a kept browser plane is unavailable here now", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" }, { body: launchBody({ input: { content: "hi" }, title: "t", place: { mode: "runner" }, plane: { browser: "browserbase" } }) });
  const answer = await runBrowserState(store, "run-1", deps({ env: {} }));
  assert.equal(answer.state, "off");
  assert.equal(typeof answer.reason, "string");
});

// ---- runGraphView ---------------------------------------------------------------------------------------------------

test("runGraphView is 404 for an agentic run (only a workflow run has a graph)", async () => {
  const store = await freshStore();
  await assert.rejects(
    () => runGraphView(store, "run-1", deps({ runView: async () => ({ kind: "agentic", status: "working", agent_id: "a1", revision: "r1", created_at: "2026-01-01T00:00:00.000Z", ended_at: null }) })),
    (e) => e.code === "not_found" && /only a workflow run has a graph/.test(e.message),
  );
});

test("runGraphView refuses a run whose output is withheld (403)", async () => {
  const store = await freshStore();
  await assert.rejects(
    () => runGraphView(store, "run-1", deps({ runView: async () => ({ kind: "workflow", status: "completed", agent_id: "a1", revision: "r1", created_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:01:00.000Z" }), withheld: async () => true })),
    (e) => e.code === "forbidden" && /nothing the run said is shown/.test(e.message),
  );
});

test("runGraphView is 404 for an unknown run", async () => {
  const store = await freshStore();
  await assert.rejects(
    () => runGraphView(store, "run-x", deps({ runView: async () => undefined })),
    (e) => e.code === "not_found",
  );
});

// ---- runTimelines (paging) ------------------------------------------------------------------------------------------

const row = (id, text) => ({ id, kind: "message", agent_label: null, summary: text, text });
const working = { status: "working", state: "working", cost: { usd: 0.5 }, poll_after_ms: 1000 };
/** A timeline reader whose rows and view are mutable fns, polling fast. `store` is unused (both are faked). */
const timeline = (state) => runTimelines({ context: BACKGROUND_CONTEXT, pollMs: 5, timelineRows: async () => state.rows, runView: async () => state.view });

test("a full read from after=0 resets with every row", async () => {
  const tl = timeline({ rows: [row("e1", "a"), row("e2", "b")], view: working });
  const page = await tl.page({}, "run-1", 0, 0, 100);
  assert.equal(page.reset, true);
  assert.deepEqual(page.rows.map((r) => r.id), ["e1", "e2"]);
  assert.equal(page.unchanged, false);
  assert.equal(page.has_more, false);
  assert.equal(page.final, false);
  assert.equal(page.status, "working");
  assert.deepEqual(page.cost, { usd: 0.5 }, "the page carries the run's whole Cost object, not a bare number");
});

test("a page's status is never ahead of its rows: a commit that lands as the status is read is in the rows the page carries", async () => {
  // The run's store as a parked call writes it: the call's row, then the park that makes the run wait. Here the park lands
  // while the page reads the run's view, as a commit can between two reads.
  const store = { rows: [row("e1", "You: add 2 and 3")], view: working };
  const tl = runTimelines({
    context: BACKGROUND_CONTEXT, pollMs: 5,
    // The rows as the store holds them when the read starts (a read is a snapshot), answered a moment later.
    timelineRows: async () => {
      const held = store.rows;
      await new Promise((resolve) => setImmediate(resolve));
      return held;
    },
    runView: async () => {
      store.rows = [...store.rows, row("e2", "add {a: 2, b: 3}")];
      store.view = { ...working, status: "input_required", state: "waiting" };
      return store.view;
    },
  });
  const page = await tl.page({}, "run-1", 0, 0, 100);
  assert.equal(page.status, "input_required");
  assert.equal(page.has_more, false);
  assert.deepEqual(page.rows.map((r) => r.id), ["e1", "e2"], "the waiting call's row comes with the waiting status");
});

test("a read from the cursor with no change is unchanged, no rows, no drops", async () => {
  const tl = timeline({ rows: [row("e1", "a"), row("e2", "b")], view: working });
  const first = await tl.page({}, "run-1", 0, 0, 100);
  const next = await tl.page({}, "run-1", first.next_after, 0, 100);
  assert.equal(next.unchanged, true);
  assert.deepEqual(next.rows, []);
  assert.deepEqual(next.drop, []);
  assert.equal(next.reset, false);
});

test("a new row after the cursor comes as a change, not a reset", async () => {
  const state = { rows: [row("e1", "a")], view: working };
  const tl = timeline(state);
  const first = await tl.page({}, "run-1", 0, 0, 100);
  state.rows = [row("e1", "a"), row("e2", "b")];
  const next = await tl.page({}, "run-1", first.next_after, 0, 100);
  assert.equal(next.reset, false);
  assert.equal(next.unchanged, false);
  assert.deepEqual(next.rows.map((r) => r.id), ["e2"]);
});

test("more changed rows than the limit sets has_more and returns the limit", async () => {
  const tl = timeline({ rows: [row("e1", "a"), row("e2", "b"), row("e3", "c")], view: working });
  const page = await tl.page({}, "run-1", 0, 0, 2);
  assert.equal(page.has_more, true);
  assert.equal(page.rows.length, 2);
});

test("a row no longer present comes as a drop from the cursor", async () => {
  const state = { rows: [row("e1", "a"), row("e2", "b")], view: working };
  const tl = timeline(state);
  const first = await tl.page({}, "run-1", 0, 0, 100);
  state.rows = [row("e1", "a")];
  const next = await tl.page({}, "run-1", first.next_after, 0, 100);
  assert.deepEqual(next.drop, ["e2"]);
});

test("the page is final when the run is terminal and settled", async () => {
  const tl = timeline({ rows: [row("e1", "a")], view: { status: "completed", state: "idle", cost: { usd: 1 }, poll_after_ms: 0 } });
  const page = await tl.page({}, "run-1", 0, 0, 100);
  assert.equal(page.final, true);
  assert.equal(page.status, "completed");
});
