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
const { listRunFiles, readRunFile, runBrowserState } = await import("../dist/run-reads-over-store.js");

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

const deps = (over = {}) => ({ env: {}, runWorkspace: async () => null, ...over });

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

// ---- readRunFile ----------------------------------------------------------------------------------------------------

test("readRunFile is 404 for a run with no folder", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  await assert.rejects(
    () => readRunFile(store, "run-1", "a.txt", {}, {}, new URL("http://x/"), deps()),
    (e) => e.code === "not_found" && /no such file/.test(e.message),
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
