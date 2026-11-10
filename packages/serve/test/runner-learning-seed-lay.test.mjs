// A learning run's claim lays its seed (the commit its learning start pinned, read once from the agent's learning folder)
// into the run's work through the run's Workspace, on both spec builders: pi's (adapterRunSpecFromLaunch) and the CLI
// harnesses' (cliRunSpecFromLaunch: claude-agent, codex), as main's start laid it (learning.ts pinSeed, minus the pin):
// - .learning/, made fresh: the served index (MEMORY.md) and each active note, each cut of the server's secrets (the
//   runner's own and every one the server keeps sealed, runner/store-secrets.ts storeSecrets: its saved keys, a trigger's
//   signing secret among the rest); the run's own read tool reads a note there;
// - each active learned skill at .agents/skills/<name>/ (its SKILL.md as a harness is served it), in the skill list the
//   harness is handed (pi's prompt; codex's native skills), unless a revision skill has its name;
// - Mode 2: both on the run's Archil disk under the run's key, from the disk's learning folder, nothing on this machine.
// A run with no learning start lays nothing; a seed the folder no longer has lays nothing, logs one line, and the claim
// goes on. The index laid names the active notes alone, as main's copy does: a line a hand edit left for a pending or a
// retired note is not in it, and neither note's file is laid.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { specFor } from "./runner-spec-support.mjs";
import { linkHarnesses } from "./support.mjs";
import { git, resnap } from "./learn-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { runFolder, runKey } = await import("../dist/workspace/paths.js");
const { learningWorkspace, ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { folderTestHooks, readSnapshot } = await import("../dist/learn/folder.js");
const { retire } = await import("../dist/learn/index.js");
const { agentFolderOf } = await import("../dist/files.js");
const { servedSkill } = await import("../dist/learn/skills.js");
const { seedOf } = await import("../dist/learning.js");
const { saveArchilSettings } = await import("../dist/archil-settings.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { seal } = await import("@parcha/pi-durable-agent");
const { archilControlFetch } = await import("./archil-control-fake.mjs");

const AGENT = "agent-1";
const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const STAND_IN = new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url).pathname;
/** A key saved on the server, plainly a test value, never a real one. */
const SAVED = { name: "SOME_SERVICE_KEY", value: "saved-value-for-the-cut-0001" };
const NOTE = "---\nname: Retry slowly\ndescription: Back off between retries\ntype: reference\n---\nWait a little longer after each failed call.\n";
const LEAKY = `---\nname: Use the key\ndescription: Call the service\ntype: reference\n---\nCall it with ${SAVED.value} in the header.\n`;
/** A webhook trigger's signing secret the store keeps (trigger_settings), with no shape a check knows: plainly a test
 *  value, and never one the run is handed. */
const HOOK = `plantedhookplain${"q8".repeat(12)}`;
const HOOKED = `---\nname: Sign the hook\ndescription: Sign each delivery\ntype: reference\n---\nSign it with ${HOOK} first.\n`;
/** Keeps HOOK as the webhook source's settings keep a trigger's secret (sealed-settings-store.ts), sealed under its AAD. */
const plantHook = (server) => server.triggerSettings.put({ adapter: "webhook", scope: "trg-1", field: "secret", sealed: seal(SEAL_KEY, Buffer.from(HOOK, "utf8"), "trigger_settings|webhook|trg-1|secret").toString("base64") });
const SKILL = "---\nname: weekly-summary\ndescription: Summarize the week.\n---\nList the week's items, newest first.\n";
const scratch = (name) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));
const skillAt = (work) => join(work, ".agents", "skills", "weekly-summary", "SKILL.md");

const PENDING = "---\nname: Ask first\ndescription: Ask which currency\ntype: reference\n---\nAsk which currency before converting.\n";
const RETIRED = "---\nname: Old way\ndescription: Round every amount\ntype: reference\n---\nRound every amount to the dollar.\n";

/** Lands the seed in `data`'s learning folder for the agent (a note, a learned skill, and `more` notes by file), and
 *  answers its commit: the sha a run's learning start pins. `held`: beside them a note pending its owner's OK (a run's
 *  merge held it) and a retired one (a person retired it), then MEMORY.md edited by hand to name both. */
async function landSeed(data, { note = NOTE, more = {}, held = false } = {}) {
  const folder = learningWorkspace({ mode: "local", data, agentId: AGENT });
  try {
    for (const [file, text] of [["retry-slowly.md", note], ["skills/weekly-summary/SKILL.md", SKILL], ...Object.entries(more), ...(held ? [["old-way.md", RETIRED]] : [])]) {
      const made = await learningCommit(folder.workspace, { kind: "person", action: "created", file, text, ifMatch: null });
      assert.equal(made.ok, true, JSON.stringify(made));
    }
    if (held) {
      const merged = await learningCommit(folder.workspace, { kind: "merge", runId: "run-learned", reason: "Learned.", files: [{ path: "ask-first.md", text: PENDING }], held: ["ask-first.md"], graded: {} });
      assert.equal(merged.ok, true, JSON.stringify(merged));
      const oid = (await readSnapshot(folder.workspace)).notes.find((one) => one.file === "old-way.md").oid;
      const retired = await learningCommit(folder.workspace, { kind: "person", action: "retired", file: "old-way.md", text: retire(RETIRED), ifMatch: oid });
      assert.equal(retired.ok, true, JSON.stringify(retired));
    }
  } finally {
    await folder.end();
  }
  if (held) {
    // MEMORY.md naming the pending and the retired note too, as only a hand edit could.
    const repo = join(agentFolderOf(data, AGENT), "learning");
    const index = readFileSync(join(repo, "MEMORY.md"), "utf8");
    writeFileSync(join(repo, "MEMORY.md"), `${index}- [Ask first](ask-first.md): Ask which currency\n- [Old way](old-way.md): Round every amount\n`);
    git(repo, ["commit", "-q", "-am", "the index by hand"]);
    await resnap(data, AGENT);
    const statuses = Object.fromEntries((await readSnapshotOf(data)).map(({ file, status }) => [file, status]));
    assert.deepEqual([statuses["ask-first.md"], statuses["old-way.md"], statuses["retry-slowly.md"]], ["pending", "retired", "active"]);
  }
  return (await seedOf(data, AGENT)).sha;
}

/** The notes of the agent's learning folder's snapshot, each with its status. */
async function readSnapshotOf(data) {
  const folder = learningWorkspace({ mode: "local", data, agentId: AGENT });
  try {
    return (await readSnapshot(folder.workspace)).notes;
  } finally {
    await folder.end();
  }
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
 *  "gone" (the start pins a commit the folder does not have), or "none" (no learning start). `skills`: the revision's
 *  own skills. `more`: more seed notes. */
async function piSpec(t, { seed = "landed", skills, more, held, plant } = {}) {
  const launch = {};
  return specFor(t, {
    body: { learning: true, tools: ["read"] },
    ...(skills ? { skills } : {}),
    keys: { [SAVED.name]: SAVED.value },
    launch,
    before: async (server, _key, dir) => {
      await plant?.(server);
      if (seed === "landed") launch.learning = startAt(await landSeed(dir, { more, held }));
      if (seed === "gone") launch.learning = startAt("0".repeat(40));
    },
  });
}

/** A CLI harness's spec for a learning run, built for its claim as the dispatch builds it (no session opened), the way
 *  runner-cli-spec's specOn does. `archil`: Mode 2 over that disk fake, the learning folder on "the disk" a local
 *  folder of its own (folderTestHooks), Archil's control plane a fake fetch. `log`: the spec's log lines. */
async function cliSpec(t, harness, { seed = "landed", archil, more, held = false, plant } = {}) {
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
  const sha = seed === "landed" ? await landSeed(diskFolder ?? dir, { more, held }) : seed === "gone" ? "0".repeat(40) : undefined;
  if (archil) {
    await landSeed(dir, { note: NOTE.replace("Wait a little longer", "Call again at once") });
    folderTestHooks.workspace = (place) => learningWorkspace({ mode: "local", data: place.mode === "archil" ? diskFolder : place.data, agentId: place.agentId });
  }
  const model = harness === "claude-agent" ? { provider: "anthropic", modelId: "claude-haiku-4-5" } : { provider: "openai", modelId: "gpt-5" };
  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness, tools: ["read"], learning: true } });
  const launch = { input: { content: "Read your notes." }, title: "t", place: { mode: "runner" }, harness, model, ...(sha !== undefined ? { learning: startAt(sha) } : {}) };
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  await plant?.(server);
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

// pi's cases each make their own run, store and learning folder (runner-spec-support), so they run at once. The CLI cases
// below stay in order: Mode 2's sets the one learning-folder hook (folderTestHooks) every claim reads.
describe("pi's claim", { concurrency: true }, () => {
  test("pi: a learning run's claim lays .learning/ (the index, the note), the learned skill into .agents/skills, names it in the prompt, and the read tool reads the note", async (t) => {
    const { spec, workFolder } = await piSpec(t);
    assert.equal(readFileSync(join(workFolder, ".learning", "retry-slowly.md"), "utf8"), NOTE);
    assert.ok(existsSync(join(workFolder, ".learning", "MEMORY.md")), "the served index");
    assert.equal(existsSync(join(workFolder, ".learning", "skills")), false, "a learned skill is no file of .learning/");
    assert.equal(readFileSync(skillAt(workFolder), "utf8"), servedSkill(SKILL), "the learned skill, as a harness is served it");
    assert.match(spec.session.system.join("\n"), /weekly-summary/, "pi's prompt names the learned skill");
    const read = await readThrough(spec, ".learning/retry-slowly.md");
    assert.equal(read.isError, false, read.text);
    assert.match(read.text, /Wait a little longer after each failed call\./);
  });

  test("a note holding a key saved on the server is laid cut of it", async (t) => {
    const { workFolder } = await piSpec(t, { more: { "use-the-key.md": LEAKY } });
    const laid = readFileSync(join(workFolder, ".learning", "use-the-key.md"), "utf8");
    assert.equal(laid.includes(SAVED.value), false, "the saved key's value is cut");
    assert.match(laid, /Call it with .* in the header\./, "the rest of the note is there");
  });

  test("a revision skill named like a learned one is the revision's: the learned one is not laid over it", async (t) => {
    const own = "---\nname: weekly-summary\ndescription: The revision's own.\n---\nOurs.\n";
    const { workFolder } = await piSpec(t, { skills: { "weekly-summary/SKILL.md": own } });
    assert.equal(readFileSync(skillAt(workFolder), "utf8"), own);
    assert.equal(readFileSync(join(workFolder, ".learning", "retry-slowly.md"), "utf8"), NOTE, "the notes are laid all the same");
  });

  test("a run with no learning start lays nothing: no .learning/, no learned skill", async (t) => {
    const { workFolder } = await piSpec(t, { seed: "none" });
    assert.equal(existsSync(join(workFolder, ".learning")), false);
    assert.equal(existsSync(skillAt(workFolder)), false);
  });
});

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a learning run's claim lays .learning/ and the learned skill, and the run's read tool reads the note`, async (t) => {
    const { spec, workFolder } = await cliSpec(t, harness);
    assert.equal(readFileSync(join(workFolder, ".learning", "retry-slowly.md"), "utf8"), NOTE);
    assert.equal(readFileSync(skillAt(workFolder), "utf8"), servedSkill(SKILL));
    const read = await readThrough(spec, ".learning/retry-slowly.md");
    assert.equal(read.isError, false, read.text);
    assert.match(read.text, /Wait a little longer after each failed call\./);
  });
}

test("Mode 2: the seed from the disk's learning folder lands on the run's Archil disk under the run's key, never on this machine", async (t) => {
  const disk = new FakeArchilDisk();
  const { workFolder } = await cliSpec(t, "codex", { archil: disk });
  const key = runKey(AGENT, RUN);
  // The fake keeps each file's bytes as a Uint8Array.
  const text = (path) => {
    const bytes = disk.files.get(`${key}/${path}`);
    return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
  };
  assert.equal(text(".learning/retry-slowly.md"), NOTE, "the disk's seed, not the local decoy");
  assert.equal(text(".agents/skills/weekly-summary/SKILL.md"), servedSkill(SKILL));
  assert.equal(existsSync(join(workFolder, ".learning")), false, "nothing laid on this machine for a Mode 2 run");
});

test("pi: a note holding a webhook trigger's signing secret the store keeps is laid cut of it", async (t) => {
  const { workFolder } = await piSpec(t, { more: { "sign-the-hook.md": HOOKED }, plant: plantHook });
  const laid = readFileSync(join(workFolder, ".learning", "sign-the-hook.md"), "utf8");
  assert.equal(laid.includes(HOOK), false, "the trigger's secret is cut");
  assert.match(laid, /Sign it with .* first\./, "the rest of the note is there");
});

test("codex: a note holding a webhook trigger's signing secret the store keeps is laid cut of it", async (t) => {
  const { workFolder } = await cliSpec(t, "codex", { more: { "sign-the-hook.md": HOOKED }, plant: plantHook });
  const laid = readFileSync(join(workFolder, ".learning", "sign-the-hook.md"), "utf8");
  assert.equal(laid.includes(HOOK), false, "the trigger's secret is cut");
  assert.match(laid, /Sign it with .* first\./, "the rest of the note is there");
});

test("a seed the learning folder no longer has lays nothing, logs one line, and the claim goes on", async (t) => {
  const pi = await piSpec(t, { seed: "gone" });
  assert.ok(pi.spec.session, "pi's spec is still built");
  assert.equal(existsSync(join(pi.workFolder, ".learning")), false);
  const cli = await cliSpec(t, "codex", { seed: "gone" });
  assert.ok(cli.spec.session, "the CLI spec is still built");
  assert.equal(existsSync(join(cli.workFolder, ".learning")), false);
  assert.equal(existsSync(skillAt(cli.workFolder)), false);
  const said = cli.log.filter((line) => /learn/.test(line));
  assert.equal(said.length, 1, JSON.stringify(cli.log));
  assert.match(said[0], /gone/);
});

/** Asserts the run's `.learning/` names and holds the active note alone: no line, and no file, for the pending or the
 *  retired note its MEMORY.md names. */
function laysActiveOnly(workFolder) {
  const index = readFileSync(join(workFolder, ".learning", "MEMORY.md"), "utf8");
  assert.match(index, /\(retry-slowly\.md\)/, index);
  assert.doesNotMatch(index, /ask-first\.md/, `no line for the pending note: ${index}`);
  assert.doesNotMatch(index, /old-way\.md/, `no line for the retired note: ${index}`);
  for (const file of ["ask-first.md", "old-way.md"]) assert.equal(existsSync(join(workFolder, ".learning", file)), false, `${file} is not laid`);
  assert.equal(readFileSync(join(workFolder, ".learning", "retry-slowly.md"), "utf8"), NOTE);
}

test("pi: the index laid names the active notes alone: a hand-edited MEMORY.md's line for a pending or a retired note is left out, and neither note is laid", async (t) => {
  laysActiveOnly((await piSpec(t, { held: true })).workFolder);
});

test("codex: the index laid names the active notes alone, as on pi", async (t) => {
  laysActiveOnly((await cliSpec(t, "codex", { held: true })).workFolder);
});
