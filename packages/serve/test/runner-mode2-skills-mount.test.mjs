// A Mode 2 run whose revision has skills, and whose computer mounts the run's folder from its Archil disk, lays its skills
// before the mount. A computer's FUSE mount of the folder takes Archil's write delegation, and while it holds, Archil
// refuses every write to the folder over its file API (409 OperationAborted: "another client holds a write delegation").
// The run's Workspace at the claim writes over that file API, so a lay after the mount is refused, the Workspace retries
// the 409 for its queue time, and the run fails ("mkdir .agents/skills: ... 409"). Both spec builders, pi's
// (adapterRunSpecFromLaunch) and the CLI harnesses' (cliRunSpecFromLaunch), are built here over the Archil fake, whose
// `delegate` stands in for the mount's delegation, taken by the run's computerForClaim and let go at its release:
//   - the claim lays the revision's skills, and the build writes nothing the delegation refuses;
//   - a second claim (epoch 2) of the same run, its folder already holding the skills (one edited by the run since),
//     mounts the folder again, writes no skill again and keeps the first claim's files as they are.
// On the old order (the lay after computerForClaim) the first test's build fails with the disk's 409, after the
// Workspace's 60 s queue.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { runKey } = await import("../dist/workspace/paths.js");
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { readBackOf } = await import("./fixtures/archil-readback.mjs");
const { fakeComputer } = await import("./workspace-fake-computer.mjs");
const { KINDS } = await import("./workspace-kinds-fixture.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const AGENT = "agent-1";
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const KEY = runKey(AGENT, RUN);
const SKILL = "---\nname: cite\ndescription: Cite every claim.\n---\nCite every claim.\n";
const SKILL_KEY = `${KEY}/.agents/skills/cite/SKILL.md`;
const stubRoute = async () => ({ model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" } });

/** The run's computer, an E2B sandbox, started by the runner's own computerForClaim (the run's folder mounted from its
 *  Archil disk, its Workspace then attached to the computer) on a fake provider: its create is the mount, which takes the
 *  disk's write delegation for the run's folder until the computer is released. The computer is fakeComputer over a
 *  local folder (`scratch`), so the attached Workspace's own writes (its .agentrun/tmp) go through the computer, as they
 *  do in a real one. `mounts` records where in the disk's calls each mount came. */
function sandboxOverArchil(disk, scratch, mounts) {
  const computer = fakeComputer(scratch);
  // What the provider reads back as mounted at /workspace: the Archil mount it was made with, under the claim's epoch.
  let mounted;
  let epoch;
  const provider = {
    id: "fake", version: "0", capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }), check: () => [],
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
      mounts[Number(id.slice(1)) - 1]?.letGo();
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

/** A Mode 2 run of a revision with one skill, over the Archil fake `disk`, in a fresh store. `claimNext(build)` claims it
 *  (a claim taken over a lapsed one when there was one) and builds its spec; `t.after` lets every spec go. */
async function mode2Run(t, { harness, disk }) {
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
    { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read", "write"], skills: { "cite/SKILL.md": "0".repeat(64) }, ...(harness ? { harness } : {}) }, skills: { "cite/SKILL.md": SKILL } },
  );
  const launch = { input: { content: "Do the thing." }, title: "t", place: { mode: "runner" }, computer: { kind: "sandbox", provider: "e2b" }, ...(harness ? { harness, model: { provider: "openai", modelId: "gpt-5" } } : { model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } }) };
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
  };
  return {
    mounts,
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
const putsOf = (disk, key) => disk.calls.filter((call) => call.op === "putObject" && (call.key === key || call.key.startsWith(`${key}/`)));

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`${name} in Mode 2: a revision's skills are laid on the disk before the computer's mount takes the write delegation`, async (t) => {
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk });
    await run.claimNext(build);
    assert.deepEqual(disk.refusedByDelegation, [], "no write to the run's folder was refused by the mount's delegation");
    assert.equal(Buffer.from(disk.files.get(SKILL_KEY) ?? []).toString("utf8"), SKILL, "the skill is on the disk");
    assert.equal(run.mounts.length, 1, "the computer mounted the run's folder once");
    const skillPut = disk.calls.findIndex((call) => call.op === "putObject" && call.key === SKILL_KEY);
    assert.ok(skillPut >= 0 && skillPut < run.mounts[0].at, `the skill was put before the mount (put at call ${skillPut}, the mount after call ${run.mounts[0].at})`);
  });

  test(`${name} in Mode 2: a second claim of the run (epoch 2) lays no skill again under the new mount, and keeps the first claim's`, async (t) => {
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk });
    // The first claim's lease lapses at once, and the first claim lets its computer go (its mount's delegation with it),
    // as a runner that lets a claim go does.
    const first = await run.claimNext(build, { leaseMs: 1 });
    assert.equal(first.claim.epoch, 1);
    const firstPuts = putsOf(disk, `${KEY}/.agents/skills`).length;
    assert.ok(firstPuts > 0, "the first claim laid the skill");
    // The run's own edit of its skill, which a later claim must never write over.
    disk.files.set(SKILL_KEY, Buffer.from(`${SKILL}Edited by the run.\n`));
    await first.spec.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await run.claimNext(build);
    assert.equal(second.claim.epoch, 2, "the run is claimed again, at epoch 2");
    assert.equal(run.mounts.length, 2, "each claim's computer mounted the run's folder");
    assert.deepEqual(disk.refusedByDelegation, [], "no write to the run's folder was refused by a mount's delegation");
    assert.equal(putsOf(disk, `${KEY}/.agents/skills`).length, firstPuts, "the second claim put nothing under .agents/skills");
    assert.equal(Buffer.from(disk.files.get(SKILL_KEY)).toString("utf8"), `${SKILL}Edited by the run.\n`, "the first claim's skill, as the run left it");
  });
}
