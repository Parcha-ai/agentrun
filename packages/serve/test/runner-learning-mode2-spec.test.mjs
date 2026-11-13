// The runner's own spec builder supplies a run's end-of-run step (adapter-run-spec.ts adapterRunSpecFromLaunch endOfRun),
// moved off the dispatch (harness-loops.ts) so a Mode 2 run's learning folder is the one on the run's own Workspace — the
// claim's Archil disk — never this machine's local data directory. A Mode 2 learning run through the real adapter loop and
// this spec builder is checked against the seed in that folder: the Archil folder stands in for the disk as a local
// directory of its own (folderTestHooks.workspace, every place it is asked for recorded), so the test sees the run asked
// for the folder as { mode: "archil" } and the proposal is the disk's seed's; the local learning path holds a decoy, and a
// read of it would make the proposal hold a change it does not.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { seedOf } = await import("../dist/learning.js");
const { folderTestHooks } = await import("../dist/learn/folder.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");
const { specFor } = await import("./runner-spec-support.mjs");

after(closeOpenSessions);

const SEAL_KEY = Buffer.alloc(32, 7);
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
const scratch = (name) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));
const note = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\ntype: reference\n---\n${body}\n`;
const RETRY = note("Retry slowly", "Back off between retries", "Wait a little longer after each failed call.");
const RETRY_DECOY = note("Retry slowly", "Retry at once", "Call again straight away after a failure.");
const CHECK = note("Check first", "Read the input before acting", "Read the whole input once before the first call.");

/** A note on `data`'s learning folder main, through a real (not hooked) learning Workspace. */
async function landNote(data, agentId, file, text) {
  const folder = learningWorkspace({ mode: "local", data, agentId });
  try {
    const made = await learningCommit(folder.workspace, { kind: "person", action: "created", file, text, ifMatch: null });
    assert.equal(made.ok, true, JSON.stringify(made));
  } finally {
    await folder.end();
  }
}

test("a Mode 2 learning run through the pi spec builder checks its proposal against the learning folder on the run's Archil disk, never the local data directory", async (t) => {
  const local = scratch("agentrun-learning-local-");
  const diskFolder = scratch("agentrun-learning-disk-");
  const server = await openSqliteStore({ dataDir: local, role: "server" });
  const store = await openSqliteStore({ dataDir: local, role: "runner" });
  let runner;
  const control = archilControlFetch();
  t.after(async () => {
    delete folderTestHooks.workspace;
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    for (const dir of [local, diskFolder]) rmSync(dir, { recursive: true, force: true });
  });

  // The disk's learning folder holds retry-slowly.md at the seed; the local data directory a decoy with other content.
  await landNote(diskFolder, "agent-1", "retry-slowly.md", RETRY);
  await landNote(local, "agent-1", "retry-slowly.md", RETRY_DECOY);
  const seed = await seedOf(diskFolder, "agent-1");
  const decoy = await seedOf(local, "agent-1");
  const held = seed.notes["retry-slowly.md"];
  assert.ok(held?.includes("Wait a little longer"), "the disk's main holds its note");
  assert.notEqual(decoy.sha, seed.sha, "the decoy is another commit, with other content");

  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const launch = { input: { content: "Follow the script." }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, learning: { given: [], seed: seed.sha, section: "", seedNotes: 1 } };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await saveArchilSettings(server, ARCHIL_SETTINGS);
  // The agent's own disk, made by an earlier run (run-disk.ts): this run keeps its folder there.
  await storeAgentDisk(server, "agent-1", { diskId: ARCHIL_SETTINGS.diskId });
  await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await server.flush?.();

  // The run's Archil learning folder stands in for the disk as a real local Workspace on diskFolder: every place it is
  // asked for is recorded, so the test sees the spec builder asked for it as { mode: "archil" }. Set after the seed is read,
  // so the seed read above is the real one.
  const places = [];
  folderTestHooks.workspace = (place) => {
    places.push(place);
    return learningWorkspace({ mode: "local", data: place.mode === "archil" ? diskFolder : place.data, agentId: place.agentId });
  };

  // The run answers the job, then its end-of-run reflect turn re-proposes the seed's note (no change) and a new one.
  const reflected = `\`\`\`note retry-slowly.md\n${held}\`\`\`\n\n\`\`\`note check-first.md\n${CHECK}\`\`\`\n\nReflected.`;
  const provider = { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"x"}` };
  const routeOf = async () => ({ model: MODEL, provider, price: () => 0, fetch: scriptedOrigin([{ say: "The job's answer." }, { say: reflected }]) });
  const deps = {
    env: {}, data: local, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf,
    computerForClaim: async () => ({ release: async () => {} }),
    makeArchilDisk: () => new FakeArchilDisk(),
    mountControl: { baseUrl: control.baseUrl, fetch: control.fetch },
  };
  const loop = createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim));
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`run-1 did not end: ${JSON.stringify(row)}; places ${JSON.stringify(places)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // The spec builder asked for the run's learning folder as the Archil disk's, for this agent (Mode 2).
  assert.ok(places.some((place) => place.mode === "archil" && place.agentId === "agent-1"), `the learning folder was asked for as the run's Archil disk: ${JSON.stringify(places)}`);
  assert.ok(!places.some((place) => place.mode === "local"), `and never as the local data directory: ${JSON.stringify(places)}`);
  // The proposal is the disk's seed's: retry-slowly.md with the disk's very text is no change (a read of the local decoy,
  // whose retry-slowly.md is another text, would make it a change too), and check-first.md is the one new note.
  const kept = await server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "proposed", JSON.stringify(kept?.proposal));
  assert.deepEqual(kept.proposal.proposal?.notes, [{ file: "check-first.md", text: CHECK }], "checked against the disk's seed, not the local decoy");
});

test("a Mode 1 run supplies its end-of-run step from the spec builder only when it learns", async (t) => {
  const learns = await specFor(t, { body: { learning: true }, launch: { learning: { given: [], seed: "0".repeat(40), section: "", seedNotes: 1 } } });
  assert.equal(typeof learns.spec.endOfRun, "function", "a run that learns gets the end-of-run step from its spec");
  const plain = await specFor(t, {});
  assert.equal(plain.spec.endOfRun, undefined, "a run that does not learn gets none");
});
