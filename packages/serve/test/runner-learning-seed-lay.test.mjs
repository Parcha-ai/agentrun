// A learning run's claim lays its seed (the commit its learning start pinned, read once from the agent's learning folder)
// into the run's work under .learning/, through the run's Workspace, on both spec builders: pi's (adapterRunSpecFromLaunch)
// and the CLI harnesses' (cliRunSpecFromLaunch: claude-agent, codex). MEMORY.md, each active note and each active learned
// skill's files land at .learning/<path as the seed read gives it>, and the run's own read tool reads them. Mode 2 lays
// them on the run's Archil disk under the run's key. The lay only writes: what is there already stays. A run with no
// learning start lays nothing; a seed the folder no longer has lays nothing, logs one line, and the claim goes on.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { specFor } from "./runner-spec-support.mjs";
import { linkHarnesses } from "./support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { runFolder, runKey } = await import("../dist/workspace/paths.js");
const { learningWorkspace, ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { folderTestHooks } = await import("../dist/learn/folder.js");
const { seedOf } = await import("../dist/learning.js");
const { saveArchilSettings } = await import("../dist/archil-settings.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");

const AGENT = "agent-1";
const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const STAND_IN = new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url).pathname;
const NOTE = "---\nname: Retry slowly\ndescription: Back off between retries\ntype: reference\n---\nWait a little longer after each failed call.\n";
const SKILL = "---\nname: weekly-summary\ndescription: Summarize the week.\n---\nList the week's items, newest first.\n";
const scratch = (name) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));

/** Lands the seed in `data`'s learning folder for the agent (a note, and a learned skill unless `skill` is false), and
 *  answers its commit: the sha a run's learning start pins. */
async function landSeed(data, { skill = true } = {}) {
  const folder = learningWorkspace({ mode: "local", data, agentId: AGENT });
  try {
    for (const [file, text] of [["retry-slowly.md", NOTE], ...(skill ? [["skills/weekly-summary/SKILL.md", SKILL]] : [])]) {
      const made = await learningCommit(folder.workspace, { kind: "person", action: "created", file, text, ifMatch: null });
      assert.equal(made.ok, true, JSON.stringify(made));
    }
  } finally {
    await folder.end();
  }
  return (await seedOf(data, AGENT)).sha;
}

/** The run's learning start, as a launch carries it: the seed its learning pinned, nothing given whole. */
const startAt = (seed) => ({ given: [], seed, section: "", seedNotes: 1 });

/** A read through the spec's own read tool, as every harness's read reaches the run's Workspace. */
async function readThrough(spec, path) {
  const read = spec.session.tools.find((tool) => tool.name === "read");
  assert.ok(read, "the run has the read tool");
  return read.call({ path }, { callId: `c-${path}`, signal: new AbortController().signal });
}

/** pi's spec for a learning run claimed through runner-spec-support; `seed`: "landed" (the seed is in the folder),
 *  "gone" (the start pins a commit the folder does not have), or "none" (no learning start). `work`: files put in the
 *  run's work before the claim, by path. */
async function piSpec(t, { seed = "landed", work = {} } = {}) {
  const launch = {};
  const built = await specFor(t, {
    body: { learning: true, tools: ["read"] },
    launch,
    before: async (_server, _key, dir) => {
      if (seed === "landed") launch.learning = startAt(await landSeed(dir));
      if (seed === "gone") launch.learning = startAt("0".repeat(40));
      for (const [path, text] of Object.entries(work)) {
        const at = join(runFolder(dir, AGENT, RUN), path);
        mkdirSync(join(at, ".."), { recursive: true });
        writeFileSync(at, text);
      }
    },
  });
  return { ...built, workFolder: built.workFolder };
}

/** A CLI harness's spec for a learning run, built for its claim as the dispatch builds it (no session opened), the way
 *  runner-cli-spec's specOn does. `archil`: Mode 2 over that disk fake, the learning folder on "the disk" a local
 *  folder of its own (folderTestHooks), Archil's control plane a fake fetch. `log`: the spec's log lines. */
async function cliSpec(t, harness, { seed = "landed", archil } = {}) {
  const dir = scratch("runner-learning-seed-lay-");
  const diskFolder = archil ? scratch("runner-learning-seed-disk-") : undefined;
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let built;
  let harnessRun;
  t.after(async () => {
    delete folderTestHooks.workspace;
    await built?.release?.().catch(() => {});
    await harnessRun?.close(ctx).catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    for (const folder of [dir, diskFolder]) if (folder) rmSync(folder, { recursive: true, force: true });
  });
  // The seed lands where the run's place keeps the learning folder: Mode 2's on the disk (a stand-in folder), with a
  // decoy note of other text in the local data directory, which a Mode 2 run must never lay.
  const sha = seed === "landed" ? await landSeed(diskFolder ?? dir) : seed === "gone" ? "0".repeat(40) : undefined;
  if (archil) {
    const folder = learningWorkspace({ mode: "local", data: dir, agentId: AGENT });
    try {
      await learningCommit(folder.workspace, { kind: "person", action: "created", file: "retry-slowly.md", text: NOTE.replace("Wait a little longer", "Call again at once"), ifMatch: null });
    } finally {
      await folder.end();
    }
    folderTestHooks.workspace = (place) => learningWorkspace({ mode: "local", data: place.mode === "archil" ? diskFolder : place.data, agentId: place.agentId });
  }
  const model = harness === "claude-agent" ? { provider: "anthropic", modelId: "claude-haiku-4-5" } : { provider: "openai", modelId: "gpt-5" };
  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness, tools: ["read"], learning: true } });
  const launch = { input: { content: "Read your notes." }, title: "t", place: { mode: "runner" }, harness, model, ...(sha !== undefined ? { learning: startAt(sha) } : {}) };
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  const control = archil ? archilControlFetch() : undefined;
  if (archil) {
    await saveArchilSettings(server, ARCHIL_SETTINGS);
    await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  }
  await server.flush?.();
  // The data directory's harnesses: the pinned SDK and CLIs, linked as a first use installs them (no npm, no network).
  await linkHarnesses(dir);
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  let models = createModels();
  harnessRun = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const log = [];
  // Building the spec opens no session, so no model is called: the keys are fakes, the base URL this machine's loopback.
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: "http://127.0.0.1:9", [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }) };
  const deps = {
    env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("no pi route"), log: (line) => log.push(line),
    computerForClaim: async () => ({ release: async () => {} }),
    ...(archil ? { makeArchilDisk: () => archil, mountControl: { baseUrl: control.baseUrl, fetch: control.fetch } } : {}),
  };
  built = await cliRunSpecFromLaunch(launch, { harness: harnessRun, registry, setModels: (given) => (models = given) }, deps, claim);
  return { spec: built, dir, log, workFolder: runFolder(dir, AGENT, RUN) };
}

test("pi: a learning run's claim lays its seed under .learning/ (MEMORY.md, the note, the learned skill's file), and the run's read tool reads the note", async (t) => {
  const { spec, workFolder } = await piSpec(t);
  assert.equal(readFileSync(join(workFolder, ".learning", "retry-slowly.md"), "utf8"), NOTE);
  assert.equal(readFileSync(join(workFolder, ".learning", "skills", "weekly-summary", "SKILL.md"), "utf8"), SKILL, "a learned skill's files are laid too");
  assert.ok(existsSync(join(workFolder, ".learning", "MEMORY.md")), "the index");
  const read = await readThrough(spec, ".learning/retry-slowly.md");
  assert.equal(read.isError, false, read.text);
  assert.match(read.text, /Wait a little longer after each failed call\./);
});

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a learning run's claim lays its seed under .learning/, and the run's read tool reads the note`, async (t) => {
    const { spec, workFolder } = await cliSpec(t, harness);
    assert.equal(readFileSync(join(workFolder, ".learning", "retry-slowly.md"), "utf8"), NOTE);
    assert.equal(readFileSync(join(workFolder, ".learning", "skills", "weekly-summary", "SKILL.md"), "utf8"), SKILL);
    const read = await readThrough(spec, ".learning/retry-slowly.md");
    assert.equal(read.isError, false, read.text);
    assert.match(read.text, /Wait a little longer after each failed call\./);
  });
}

test("Mode 2: the seed from the disk's learning folder is laid on the run's Archil disk under the run's key, never in this machine's run folder", async (t) => {
  const disk = new FakeArchilDisk();
  const { workFolder } = await cliSpec(t, "codex", { archil: disk });
  const key = runKey(AGENT, RUN);
  assert.equal(disk.files.get(`${key}/.learning/retry-slowly.md`)?.toString("utf8"), NOTE, "the disk's seed, not the local decoy");
  assert.equal(disk.files.get(`${key}/.learning/skills/weekly-summary/SKILL.md`)?.toString("utf8"), SKILL);
  assert.equal(existsSync(join(workFolder, ".learning")), false, "nothing laid on this machine for a Mode 2 run");
});

test("the lay only writes: a .learning/ file already in the run's work (an earlier claim's, the run's own) stays as it is", async (t) => {
  const { workFolder } = await piSpec(t, { work: { ".learning/retry-slowly.md": "as the run left it\n", ".learning/kept.md": "the run's own\n" } });
  assert.equal(readFileSync(join(workFolder, ".learning", "retry-slowly.md"), "utf8"), "as the run left it\n", "not written over");
  assert.equal(readFileSync(join(workFolder, ".learning", "kept.md"), "utf8"), "the run's own\n", "nothing removed");
  assert.equal(readFileSync(join(workFolder, ".learning", "skills", "weekly-summary", "SKILL.md"), "utf8"), SKILL, "a missing one is laid");
});

test("a run with no learning start lays nothing under .learning/", async (t) => {
  const { workFolder } = await piSpec(t, { seed: "none" });
  assert.equal(existsSync(join(workFolder, ".learning")), false);
});

test("a seed the learning folder no longer has lays nothing, logs one line, and the claim goes on", async (t) => {
  const pi = await piSpec(t, { seed: "gone" });
  assert.ok(pi.spec.session, "pi's spec is still built");
  assert.equal(existsSync(join(pi.workFolder, ".learning")), false);
  const cli = await cliSpec(t, "codex", { seed: "gone" });
  assert.ok(cli.spec.session, "the CLI spec is still built");
  assert.equal(existsSync(join(cli.workFolder, ".learning")), false);
  const said = cli.log.filter((line) => /\.learning|learning seed|learned/.test(line));
  assert.equal(said.length, 1, JSON.stringify(cli.log));
  assert.match(said[0], /gone/);
});
