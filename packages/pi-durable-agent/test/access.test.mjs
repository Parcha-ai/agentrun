import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import fsPromises, { copyFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import {
  AgentHomeError, carryBack, createAgentHome, durableProfileStore, homeRevision, prepareRun, readAgentHome, refreshAgentHome, seedRun, startRun,
  undoPrepare,
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

const T0 = Date.parse("2026-10-16T09:00:00.000Z");
const BROKEN = { x: "a file", "x/y.md": "and a file under it" };

/** A local home whose acme profile a first run signed in to, then run-a holding acme's lease for one second from T0,
 *  then the skills changed to a set no run can be seeded with. */
async function leasedThenBroken() {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: SKILLS, sha: SHA_1 });
  const first = await startRun(home, { runId: "first", host: "test", now: T0 - 10_000 });
  const signIn = await openSession(first.storePath);
  await durableProfileStore(signIn).resolve("acme", async () => "ctx_1");
  await signIn.close(ctx);
  await carryBack(home, first, { outcome: "completed", now: T0 - 5_000 });
  const a = await startRun(home, { runId: "run-a", host: "test", now: T0, leaseMs: 1_000 });
  await refreshAgentHome(home, { sha: SHA_2, definition: DEFINITION, skills: BROKEN });
  return { home, a };
}

test("a failed start gives back the expired lease it took, exactly, and the run that held it still saves its profile", async () => {
  const { home, a } = await leasedThenBroken();
  const leaseA = (await readAgentHome(home)).leases.acme;
  assert.deepEqual(leaseA, { runId: "run-a", expiresAt: new Date(T0 + 1_000).toISOString() });
  await assert.rejects(startRun(home, { runId: "run-b", host: "test", now: T0 + 2_000 }), /ENOTDIR|EEXIST|not a directory/i);
  const state = await readAgentHome(home);
  assert.deepEqual(state.leases.acme, leaseA, "run-a's lease, its run id and its expiry, as they were");
  assert.equal(state.runs["run-b"], undefined, "and no record of run-b");
  const session = await openSession(a.storePath);
  await session.commit(async (tx) => { Object.assign(await tx.doc(Profiles, "acme", null), { verifiedAt: "2026-10-16T09:00:03.000Z" }); }, ctx);
  await session.close(ctx);
  assert.deepEqual(await carryBack(home, a, { outcome: "completed", now: T0 + 3_000 }), { changed: true, profiles: ["acme"], released: ["acme"] });
  assert.equal((await readAgentHome(home)).profiles.acme.verifiedAt, "2026-10-16T09:00:03.000Z");
});

test("a local start that fails is undone under the same hold of the home: another process waiting for the lock cannot get in between", { timeout: 60_000 }, async () => {
  const { home } = await leasedThenBroken();
  const before = await readAgentHome(home);
  const lock = path.join(home.dir, "owner.lock");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { DatabaseSync } = await import("node:sqlite");
    let sawBusy = false;
    console.log("polling");
    for (const end = Date.now() + 30_000; Date.now() < end; ) {
      const db = new DatabaseSync(${JSON.stringify(lock)}, { timeout: 0 });
      try { db.exec("PRAGMA locking_mode = EXCLUSIVE"); db.exec("BEGIN EXCLUSIVE"); db.exec("COMMIT"); }
      catch { db.close(); sawBusy = true; await new Promise((r) => setTimeout(r, 1)); continue; }
      if (!sawBusy) { db.close(); await new Promise((r) => setTimeout(r, 1)); continue; }
      console.log("held");
      await new Promise((r) => setTimeout(r, 6_500));
      db.close();
      process.exit(0);
    }
    process.exit(3);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  const polling = new Promise((resolve) => child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("polling")) resolve(); }));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await polling;
  await assert.rejects(startRun(home, { runId: "run-b", host: "test", now: T0 + 2_000 }));
  assert.equal(await exited, 0, "the other process got the lock, once the start had let it go");
  assert.match(out, /held/);
  const after = await readAgentHome(home);
  assert.equal(after.runs["run-b"], undefined, "no record");
  assert.deepEqual(after.leases, before.leases, "the leases as they were");
  assert.equal(existsSync(path.join(home.dir, "runs", "run-b")), false);
});

test("a start whose undo fails too throws both failures, never only one", async () => {
  const { home } = await leasedThenBroken();
  const real = fsPromises.rm;
  const blocked = path.join("runs", "run-c");
  fsPromises.rm = async (target, options) => {
    if (String(target).endsWith(blocked)) throw Object.assign(new Error("EACCES: the run directory cannot be removed"), { code: "EACCES" });
    return real(target, options);
  };
  syncBuiltinESMExports();
  let error;
  try {
    error = await startRun(home, { runId: "run-c", host: "test", now: T0 + 2_000 }).then(() => null, (e) => e);
  } finally {
    fsPromises.rm = real;
    syncBuiltinESMExports();
  }
  assert.ok(error instanceof AggregateError, String(error));
  assert.equal(error.errors.length, 2);
  assert.match(error.errors[0].message, /ENOTDIR|EEXIST|not a directory/i, "the seed's failure");
  assert.match(error.errors[1].message, /the run directory cannot be removed/, "and the undo's");
  assert.match(error.message, /run-c failed to start .* and undoing the start failed too/);
  assert.equal((await readAgentHome(home)).runs["run-c"], undefined, "the part of the undo that could run, ran");
});

test("a host's start that fails is undone with undoPrepare inside the host's own claim: the prior lease back, no record", async () => {
  const disk = await diskHome();
  await signedInRun(disk, "first");
  await carryBack(disk.home, { runId: "first" }, { outcome: "completed", access: disk.access });
  const a = await prepareRun(disk.home, { runId: "run-a", host: "worker-1", now: T0, leaseMs: 1_000, access: disk.access });
  await seedRun(disk.runDir("run-a"), a);
  const leaseA = (await readAgentHome(disk.home, { access: disk.access })).leases.acme;
  const b = await prepareRun(disk.home, { runId: "run-b", host: "worker-2", now: T0 + 2_000, access: disk.access });
  assert.deepEqual(b.prior.leases, { acme: leaseA }, "the seed keeps what it replaced");
  disk.claims.length = 0;
  await undoPrepare(disk.home, b, { access: disk.access });
  assert.deepEqual(disk.claims, [disk.agentDir], "one claim");
  const state = await readAgentHome(disk.home, { access: disk.access });
  assert.deepEqual(state.leases.acme, leaseA);
  assert.equal(state.runs["run-b"], undefined);
  assert.ok(state.runs["run-a"], "run-a's record stays");
});

test("a retried undo of an earlier start of the same run id touches nothing, and the newer start keeps its record, its leases and its sign-in", async () => {
  const disk = await diskHome();
  await signedInRun(disk, "first");
  await carryBack(disk.home, { runId: "first" }, { outcome: "completed", access: disk.access });
  const a1 = await prepareRun(disk.home, { runId: "again", host: "worker-1", now: T0, access: disk.access });
  assert.deepEqual(await undoPrepare(disk.home, a1, { access: disk.access }), { undone: true });
  const a2 = await prepareRun(disk.home, { runId: "again", host: "worker-1", now: T0 + 5_000, access: disk.access });
  const before = await readAgentHome(disk.home, { access: disk.access });
  assert.equal(before.leases.acme.runId, "again");
  assert.deepEqual(await undoPrepare(disk.home, a1, { access: disk.access }), { undone: false }, "the first start's undo, retried, is not this start's");
  assert.deepEqual(await readAgentHome(disk.home, { access: disk.access }), before, "the newer start's record and leases as they were");
  await seedRun(disk.runDir("again"), a2);
  const session = await openSession(disk.runDir("again").storePath);
  await session.commit(async (tx) => { Object.assign(await tx.doc(Profiles, "acme", null), { verifiedAt: "2026-10-16T09:00:06.000Z" }); }, ctx);
  await session.close(ctx);
  assert.deepEqual(await carryBack(disk.home, { runId: "again" }, { outcome: "completed", access: disk.access }), { changed: true, profiles: ["acme"], released: ["acme"] });
  assert.equal((await readAgentHome(disk.home, { access: disk.access })).profiles.acme.verifiedAt, "2026-10-16T09:00:06.000Z");
});

test("an undo restores only a lease exactly as its own start set it: when a newer start of the same id has an equal record, its lease is still left alone", async () => {
  const disk = await diskHome();
  await signedInRun(disk, "first");
  await carryBack(disk.home, { runId: "first" }, { outcome: "completed", access: disk.access });
  const a1 = await prepareRun(disk.home, { runId: "same", host: "worker-1", now: T0, leaseMs: 1_000, access: disk.access });
  await undoPrepare(disk.home, a1, { access: disk.access });
  await prepareRun(disk.home, { runId: "same", host: "worker-1", now: T0, leaseMs: 9_000, access: disk.access });
  const lease = (await readAgentHome(disk.home, { access: disk.access })).leases.acme;
  assert.deepEqual(lease, { runId: "same", expiresAt: new Date(T0 + 9_000).toISOString() });
  await undoPrepare(disk.home, a1, { access: disk.access });
  assert.deepEqual((await readAgentHome(disk.home, { access: disk.access })).leases.acme, lease, "the run id matches, the expiry does not: not this start's lease");
});
