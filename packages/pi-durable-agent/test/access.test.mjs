import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { copyFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  AgentHomeError, carryBack, createAgentHome, durableProfileStore, homeRevision, prepareRun, readAgentHome, refreshAgentHome, seedRun, startRun,
} from "../dist/index.js";
import { ctx, DEFINITION, openSession, Profiles, scratch } from "./support.mjs";

const SHA_1 = "1f0c9e2b7d4a8e3c5b6a7f8d9e0c1b2a3d4e5f60";
const SHA_2 = "9a8b7c6d5e4f30211203f4e5d6c7b8a990a1b2c3";
const SKILLS = { "cite/SKILL.md": "# Cite\n", "cite/refs/style.md": "APA\n" };
const refused = (code, pattern) => (error) => error instanceof AgentHomeError && error.code === code && (!pattern || pattern.test(error.message));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A home on a "disk": its own files under agent/, its runs under runs/<id>, reached only through an access whose
 *  claim hands out agent/ and whose runStore copies a released store out, read-only, as a disk's object read would. */
async function diskHome() {
  const root = await scratch();
  const agentDir = path.join(root, "agent");
  const made = await createAgentHome(agentDir, { definition: DEFINITION, skills: SKILLS, sha: SHA_1 });
  const home = { dir: path.join(root, "not-a-local-home"), identity: made.identity };
  const claims = [];
  const copies = [];
  const access = {
    claim: async (fn) => (claims.push(agentDir), fn(agentDir)),
    runStore: async (run) => {
      const copy = path.join(await scratch(), "released.sqlite");
      await copyFile(path.join(root, run.path, "store", "run.sqlite"), copy);
      chmodSync(copy, 0o444);
      copies.push({ copy, sha256: sha256(readFileSync(copy)), mtimeMs: statSync(copy).mtimeMs });
      return copy;
    },
  };
  const runDir = (id) => ({ storePath: path.join(root, "runs", id, "store", "run.sqlite"), workDir: path.join(root, "runs", id, "work") });
  return { root, agentDir, home, access, claims, copies, runDir };
}

/** The documents of a run store and the files of its workspace, to compare two seedings. */
async function seeded({ storePath, workDir }) {
  const session = await openSession(storePath);
  const profiles = {};
  for (const key of ["acme", "globex"]) {
    const value = await session.snapshot(Profiles, key, ctx);
    if (value) profiles[key] = value;
  }
  await session.close(ctx);
  const files = {};
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const at = path.join(dir, e.name); if (e.isDirectory()) walk(at); else files[path.relative(workDir, at)] = readFileSync(at, "utf8"); } };
  walk(workDir);
  return { profiles, files };
}

/** A run on the disk home that signs in to acme, seeded through prepareRun and seedRun. */
async function signedInRun(disk, runId) {
  const seed = await prepareRun(disk.home, { runId, host: "worker-1", access: disk.access });
  await seedRun(disk.runDir(runId), seed);
  const session = await openSession(disk.runDir(runId).storePath);
  await durableProfileStore(session).resolve("acme", async () => "ctx_1");
  await session.close(ctx);
  return seed;
}

test("a home on a disk: prepareRun, seedRun into the disk's runs/<id>, carryBack, each through the access, one claim per carry back", async () => {
  const disk = await diskHome();
  const seed = await signedInRun(disk, "r1");
  assert.deepEqual([seed.runId, seed.sha, seed.leases, seed.agent], ["r1", SHA_1, [], { instructions: DEFINITION.instructions, tools: DEFINITION.tools }]);
  assert.equal(existsSync(disk.home.dir), false, "nothing is read or written at the handle's own directory");
  disk.claims.length = 0;
  assert.deepEqual(await carryBack(disk.home, { runId: "r1" }, { outcome: "completed", access: disk.access }), { changed: true, profiles: ["acme"], released: [] });
  assert.deepEqual(disk.claims, [disk.agentDir], "exactly one claim, of agent/");
  const state = await readAgentHome(disk.home, { access: disk.access });
  assert.deepEqual(state.profiles.acme, { provider: "browserbase", ref: "ctx_1", state: "ready" });
  assert.deepEqual([state.runs.r1.path, state.runs.r1.sha, state.runs.r1.outcome], ["runs/r1", SHA_1, "completed"]);
  assert.equal(await homeRevision(disk.home, { access: disk.access }), await homeRevision({ dir: disk.agentDir, identity: disk.home.identity }), "the claimed directory's head");
  assert.deepEqual(await carryBack(disk.home, { runId: "r1" }, { outcome: "completed", access: disk.access }), { changed: false, profiles: [], released: [] }, "once per run");
});

test("the run store a carry back is given is only read: its bytes, its time and its directory stay as they were", async () => {
  const disk = await diskHome();
  await signedInRun(disk, "r1");
  await carryBack(disk.home, { runId: "r1" }, { outcome: "completed", access: disk.access });
  assert.equal(disk.copies.length, 1);
  const [{ copy, sha256: before, mtimeMs }] = disk.copies;
  assert.equal(sha256(readFileSync(copy)), before);
  assert.equal(statSync(copy).mtimeMs, mtimeMs);
  assert.deepEqual(readdirSync(path.dirname(copy)), ["released.sqlite"], "no -wal, -shm or -journal beside it");
});

test("a claim that fails with a retryable error leaves the home as it was, and the run carries back later", async () => {
  const disk = await diskHome();
  await signedInRun(disk, "r1");
  const before = { state: await readAgentHome(disk.home, { access: disk.access }), revision: await homeRevision(disk.home, { access: disk.access }) };
  const busy = Object.assign(new Error("the disk path is claimed elsewhere"), { code: "HELD", retryable: true });
  const failing = { ...disk.access, claim: async () => { throw busy; } };
  await assert.rejects(carryBack(disk.home, { runId: "r1" }, { outcome: "completed", access: failing }), (error) => error === busy);
  assert.deepEqual(await readAgentHome(disk.home, { access: disk.access }), before.state);
  assert.equal(await homeRevision(disk.home, { access: disk.access }), before.revision);
  assert.equal((await carryBack(disk.home, { runId: "r1" }, { outcome: "completed", access: disk.access })).changed, true);
});

test("prepareRun alone writes nothing under runs/: it records the run and takes its leases in the home", async () => {
  const disk = await diskHome();
  await signedInRun(disk, "first");
  await carryBack(disk.home, { runId: "first" }, { outcome: "completed", access: disk.access });
  const listed = readdirSync(path.join(disk.root, "runs"));
  const seed = await prepareRun(disk.home, { runId: "p1", host: "worker-1", access: disk.access });
  assert.deepEqual(readdirSync(path.join(disk.root, "runs")), listed, "no runs/p1");
  assert.deepEqual(seed.leases, ["acme"]);
  assert.deepEqual(seed.profiles, { acme: { provider: "browserbase", ref: "ctx_1", state: "ready" } });
  assert.deepEqual(seed.skills, SKILLS);
  const state = await readAgentHome(disk.home, { access: disk.access });
  assert.equal(state.runs.p1.path, "runs/p1");
  assert.equal(state.leases.acme.runId, "p1");
  await assert.rejects(prepareRun(disk.home, { runId: "p1", host: "worker-1", access: disk.access }), refused("exists"));
  await assert.rejects(prepareRun(disk.home, { runId: "p2", host: "worker-1", sha: SHA_2, access: disk.access }), refused("stale"));
});

test("seedRun twice on one directory gives the same store and skills, and leaves nothing beside the store", async () => {
  const disk = await diskHome();
  const seed = await prepareRun(disk.home, { runId: "twice", host: "worker-1", access: disk.access });
  const dir = disk.runDir("twice");
  await seedRun(dir, seed);
  const first = await seeded(dir);
  await seedRun(dir, seed);
  assert.deepEqual(await seeded(dir), first);
  assert.deepEqual(first.files, { ".agents/skills/cite/SKILL.md": "# Cite\n", ".agents/skills/cite/refs/style.md": "APA\n" });
  assert.deepEqual(readdirSync(path.dirname(dir.storePath)), ["run.sqlite"]);
});

test("a seedRun that fails midway leaves no store, and a retry on the same directory gives a whole one", async () => {
  const disk = await diskHome();
  await signedInRun(disk, "first");
  await carryBack(disk.home, { runId: "first" }, { outcome: "completed", access: disk.access });
  const seed = await prepareRun(disk.home, { runId: "retry", host: "worker-1", access: disk.access });
  const dir = disk.runDir("retry");
  mkdirSync(path.dirname(path.dirname(dir.storePath)), { recursive: true });
  writeFileSync(path.dirname(dir.storePath), "in the way");
  await assert.rejects(seedRun(dir, seed));
  assert.ok(existsSync(path.join(dir.workDir, ".agents/skills/cite/SKILL.md")), "the skills were written before it failed");
  assert.equal(existsSync(dir.storePath), false, "no store, so nothing half-made is there");
  await rm(path.dirname(dir.storePath));
  await seedRun(dir, seed);
  assert.deepEqual(await seeded(dir), { profiles: { acme: { provider: "browserbase", ref: "ctx_1", state: "ready" } }, files: { ".agents/skills/cite/SKILL.md": "# Cite\n", ".agents/skills/cite/refs/style.md": "APA\n" } });
});

test("seedRun refuses a seed that hands a sign-in to a run that does not lease it, and writes nothing", async () => {
  const disk = await diskHome();
  const seed = await prepareRun(disk.home, { runId: "tampered", host: "worker-1", access: disk.access });
  const dir = disk.runDir("tampered");
  await assert.rejects(seedRun(dir, { ...seed, profiles: { acme: { provider: "browserbase", ref: "ctx_stolen", state: "ready" } } }), refused("invalid", /sign-in of acme, which it does not lease/));
  assert.equal(existsSync(path.join(disk.root, "runs", "tampered")), false);
});

test("a startRun whose seeding fails leaves no run directory, no run record and no lease, as before", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: SKILLS, sha: SHA_1 });
  const first = await startRun(home, { runId: "first", host: "test" });
  const session = await openSession(first.storePath);
  await durableProfileStore(session).resolve("acme", async () => "ctx_1");
  await session.close(ctx);
  await carryBack(home, first, { outcome: "completed" });
  await refreshAgentHome(home, { sha: SHA_2, definition: DEFINITION, skills: { x: "a file", "x/y.md": "and a file under it" } });
  const before = await readAgentHome(home);
  await assert.rejects(startRun(home, { runId: "broken", host: "test" }));
  assert.equal(existsSync(path.join(home.dir, "runs", "broken")), false);
  assert.deepEqual(await readAgentHome(home), before, "no run record and no lease");
  assert.deepEqual((await readdir(path.join(home.dir, "runs"))).sort(), ["first"]);
});
