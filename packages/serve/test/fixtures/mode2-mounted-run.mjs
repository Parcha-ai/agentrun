// A Mode 2 run whose computer mounts the run's folder from its Archil disk, built through either spec builder over the
// Archil fake (fixtures/archil-fake.mjs): the computer is an E2B sandbox started by the runner's own computerForClaim on
// a fake provider, whose create takes the disk's write delegation for the run's folder (the FUSE mount's) and whose
// release lets it go. Shared by the tests of what the claim and the release write to the folder while the mount holds
// it (runner-mode2-skills-mount, runner-mode2-teardown-mount).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

const { openSqliteStore } = await import("../../dist/store/sqlite/store.js");
const { runKey } = await import("../../dist/workspace/paths.js");
const { saveArchilSettings, storeAgentDisk } = await import("../../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../../dist/store/seal.js");
const { OPENCODE_STANDIN_ENV } = await import("../../dist/adapters.js");
const { computerForClaim } = await import("../../dist/workspace/index.js");
const { putSealedKey } = await import("../../dist/server-keys.js");
const { FakeArchilDisk } = await import("./archil-fake.mjs");
const { readBackOf } = await import("./archil-readback.mjs");
const { fakeComputer } = await import("../workspace-fake-computer.mjs");
const { KINDS } = await import("../workspace-kinds-fixture.mjs");
const { archilControlFetch } = await import("../archil-control-fake.mjs");
const { seedOf } = await import("../../dist/learning.js");
const { folderTestHooks } = await import("../../dist/learn/folder.js");
const { learningWorkspace } = await import("../../dist/workspace/index.js");
const { learningCommit } = await import("../../dist/learn/commit.js");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = new URL("./fake-opencode-serve.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
export const RUN = "run-1";
export const AGENT = "agent-1";
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
export const KEY = runKey(AGENT, RUN);
export const SKILL = "---\nname: cite\ndescription: Cite every claim.\n---\nCite every claim.\n";
export const SKILL_KEY = `${KEY}/.agents/skills/cite/SKILL.md`;
const CORRECTION = "Wait a little longer after each failed call.";
const stubRoute = async () => ({ model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" } });

/** The run's computer, an E2B sandbox, started by the runner's own computerForClaim (the run's folder mounted from its
 *  Archil disk, its Workspace then attached to the computer) on a fake provider: its create is the mount, which takes the
 *  disk's write delegation for the run's folder until the computer is released. The computer is fakeComputer over a
 *  local folder (`scratch`), so the attached Workspace's own writes (its .agentrun/tmp) go through the computer, as they
 *  do in a real one. `mounts` records where in the disk's calls each mount came (`at`) and where its release let the
 *  delegation go (`releasedAt`). */
function sandboxOverArchil(disk, scratch, mounts) {
  const computer = fakeComputer(scratch);
  // What the provider reads back as mounted at /workspace: the Archil mount it was made with, under the claim's epoch.
  let mounted;
  let epoch;
  const provider = {
    id: "fake", version: "0", capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }), check: () => [],
    // E2B's descriptor says it prepares its image: the stand-in answers its template at once, as E2B's does.
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:test" }),
    list: async () => ({ ok: true, value: [] }),
    create: async (spec) => {
      assert.equal(spec.mount?.kind, "archil", "the run's folder is mounted from its Archil disk");
      mounted = readBackOf(spec.mount, epoch);
      const letGo = disk.delegate(KEY);
      mounts.push({ at: disk.calls.length, letGo });
      return { ok: true, value: { id: `c${mounts.length}`, name: `c${mounts.length}` } };
    },
    connect: async () => ({ ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } }),
    attach: async ({ id }) => ({ ok: true, value: { id, name: id, spec: { image: "i", user: "1000:1000", network: "none", mount: mounted } } }),
    release: async ({ id }) => {
      const mount = mounts[Number(id.slice(1)) - 1];
      if (mount) mount.releasedAt ??= disk.calls.length;
      mount?.letGo();
      return { ok: true, value: undefined };
    },
  };
  // The claim's own read-back check, under its epoch, as the runner's composer gives it.
  return (launch, store, given) => (epoch = launch.epoch, computerForClaim(launch, store, {
    ...given, kinds: KINDS, providers: { e2b: () => provider },
    spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }),
    check: { readBackOf, epoch: launch.epoch },
  }));
}

/** The agent's learning folder, holding one correction on its main, as a local folder that stands in for the one on the
 *  run's Archil disk (folderTestHooks.workspace): the seed's commit, for the launch's learning start. `read` counts the
 *  claim's reads of it. */
async function learningSeedIn(t, dir, read) {
  const folderData = join(dir, "learning-disk");
  mkdirSync(folderData);
  await seedOf(folderData, AGENT);
  const folder = learningWorkspace({ mode: "local", data: folderData, agentId: AGENT });
  try {
    const made = await learningCommit(folder.workspace, { runId: "run-0", reason: "feedback", files: [], correction: CORRECTION });
    assert.equal(made.ok, true, JSON.stringify(made));
  } finally {
    await folder.end();
  }
  const seed = (await seedOf(folderData, AGENT)).sha;
  folderTestHooks.workspace = (place) => {
    assert.equal(place.mode, "archil", "a Mode 2 run reads its learning folder on its Archil disk");
    read.count += 1;
    return learningWorkspace({ mode: "local", data: folderData, agentId: place.agentId });
  };
  t.after(() => delete folderTestHooks.workspace);
  return seed;
}

/** A Mode 2 run of a revision with one skill, over the Archil fake `disk`, in a fresh store (`learns`: a learning run whose
 *  seed holds a correction; `read` counts the claim's reads of its learning folder). `claimNext(build)` claims it (a claim taken over a lapsed one when there was
 *  one) and builds its spec; `t.after` lets every spec go. `mcp`: the run's MCP, its revision granted `grants` and
 *  pinned `pin`, `before(server)` registering the server, `deps` added to the claim's. */
export async function mode2Run(t, { harness, disk, learns = false, mcp }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mode2-skills-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const control = archilControlFetch();
  const opened = [];
  t.after(async () => {
    for (const { spec, harnessRun } of opened.reverse()) {
      await spec?.release?.().catch(() => {});
      await harnessRun.close(ctx).catch(() => {});
    }
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create(
    { id: AGENT, name: "Agent" },
    { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read", "write", ...(mcp?.grants ?? [])], skills: { "cite/SKILL.md": "0".repeat(64) }, computer: { kind: "sandbox", provider: "e2b" }, ...(harness ? { harness } : {}), ...(learns ? { learning: true } : {}) }, skills: { "cite/SKILL.md": SKILL }, ...(mcp?.pin ? { mcpPin: mcp.pin } : {}) },
  );
  await mcp?.before?.(server);
  const read = { count: 0 };
  const learning = learns ? { seed: await learningSeedIn(t, dir, read), section: "" } : undefined;
  const launch = { input: { content: "Do the thing." }, title: "t", place: { mode: "runner" }, ...(harness ? { harness, model: { provider: "openai", modelId: "gpt-5" } } : { model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } }), ...(learning ? { learning } : {}) };
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  await saveArchilSettings(server, ARCHIL_SETTINGS);
  await storeAgentDisk(server, AGENT, { diskId: ARCHIL_SETTINGS.diskId });
  await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await putSealedKey(server, SEAL_KEY, "E2B_API_KEY", "fake-test-key-e2b-0001");
  await server.flush?.();
  const scratch = join(dir, "computer");
  mkdirSync(scratch);
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }) };
  const mounts = [];
  const deps = {
    env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf: stubRoute,
    makeArchilDisk: () => disk,
    mountControl: { baseUrl: control.baseUrl, fetch: control.fetch },
    computerForClaim: sandboxOverArchil(disk, scratch, mounts),
    ...mcp?.deps,
  };
  return {
    mounts,
    read,
    /** The runner's data folder, where a Mode 1 run's local folder would be. */
    data: dir,
    /** The computer's folder: the fake computer's /workspace, a local folder that stands in for the mounted run's folder. */
    scratch,
    /** The claim's deps, as either spec builder is given them (a run's own process's runner takes them too). */
    deps,
    /** Claim the run (`leaseMs`: the claim's lease) and build its spec with `build`. */
    async claimNext(build, { leaseMs = 60_000 } = {}) {
      const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs });
      if (!claim) throw new Error("the run was not claimed");
      const registry = createRegistry();
      let models = createModels();
      const harnessRun = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
      const entry = { harnessRun };
      opened.push(entry);
      entry.spec = await build(launch, { harness: harnessRun, registry, setModels: (given) => (models = given) }, deps, claim);
      return { claim, spec: entry.spec };
    },
  };
}

/** The disk's puts at or under `key`. */
export const putsOf = (disk, key) => disk.calls.filter((call) => call.op === "putObject" && (call.key === key || call.key.startsWith(`${key}/`)));

