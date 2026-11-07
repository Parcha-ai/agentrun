// The disk: a run lives in its agent's folder, <dir>/disk/agents/<agent>/runs/<run>, never in the control plane's own
// files, and its row in store.sqlite holds its claim: an epoch each claim bumps, and its holder. A store an earlier
// version wrote (store version 1, its runs under <dir>/runs/) is refused, with no migration.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, openStore, openStoreReader } from "../dist/index.js";
import { scratch } from "./support.mjs";

const A = { kind: "agentic", instructions: "Research the company.", skills: {}, tools: ["read"] };
const nameOf = (id) => `${id.toLowerCase()}-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16)}`;

async function aStore() {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = await store.createAgent({ name: "Researcher" });
  await store.commitRevision(agent.id, A, { setCurrent: true });
  return { dir, store, agent };
}

test("a run's folder is on the disk, in its agent's folder: <dir>/disk/agents/<agent>/runs/<run>, with store/ and work/, and nothing under <dir>/runs", async () => {
  const { dir, store, agent } = await aStore();
  const run = await store.startRun({ agent: agent.id });
  const folder = path.join(dir, "disk", "agents", nameOf(agent.id), "runs", run.runId);
  assert.equal(run.dir, folder);
  assert.equal(run.storePath, path.join(folder, "store", "run.sqlite"));
  assert.equal(run.workspace, path.join(folder, "work"));
  assert.ok(existsSync(run.storePath) && statSync(run.workspace).isDirectory());
  assert.equal(store.runDir(run.runId), folder);
  assert.equal(store.runStorePath(run.runId), run.storePath);
  assert.equal(openStoreReader(dir).runStorePath(run.runId), run.storePath, "a reader names the same file");
  assert.equal(existsSync(path.join(dir, "runs")), false);
  assert.throws(() => store.runDir("no-such-run"), (error) => error instanceof AgentHomeError && error.code === "missing");
});

test("an agent's folder name tells ids that differ only in case apart", () => {
  assert.notEqual(nameOf("Researcher"), nameOf("researcher"));
});

test("a run's claim is on its row: each claim bumps its epoch and names its holder, in one statement; a new run has epoch 0 and no holder", async () => {
  const { dir, store, agent } = await aStore();
  const run = await store.startRun({ agent: agent.id });
  assert.deepEqual(store.runClaim(run.runId), { epoch: 0, holder: null });
  assert.equal(store.claimRun(run.runId, "run-process", 0), 1);
  assert.deepEqual(store.runClaim(run.runId), { epoch: 1, holder: "run-process" });
  assert.equal(store.claimRun(run.runId, "server", 1), 2);
  const db = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true });
  try {
    assert.deepEqual({ ...db.prepare("SELECT claim_epoch, claim_holder FROM runs WHERE id = ?").get(run.runId) }, { claim_epoch: 2, claim_holder: "server" });
  } finally {
    db.close();
  }
  assert.throws(() => store.claimRun("no-such-run", "server", 0), (error) => error instanceof AgentHomeError && error.code === "missing");
  assert.throws(() => store.claimRun(run.runId, "", 2), (error) => error instanceof AgentHomeError && error.code === "invalid");
});

test("two launchers racing for one run, both from the epoch they read: exactly one claims it, by the row alone; the other is refused as stale and its holder is never written", async () => {
  const { store, agent } = await aStore();
  const run = await store.startRun({ agent: agent.id });
  const { epoch } = store.runClaim(run.runId);
  const tries = ["first", "second"].map((holder) => {
    try {
      return { holder, epoch: store.claimRun(run.runId, holder, epoch) };
    } catch (error) {
      return { holder, refused: error instanceof AgentHomeError ? error.code : String(error) };
    }
  });
  assert.deepEqual(tries, [{ holder: "first", epoch: epoch + 1 }, { holder: "second", refused: "stale" }]);
  assert.deepEqual(store.runClaim(run.runId), { epoch: epoch + 1, holder: "first" });
  // A holder's identity changes under its own epoch only (its door, once it serves): never under one that moved on.
  store.setRunHolder(run.runId, epoch + 1, "first, serving");
  assert.throws(() => store.setRunHolder(run.runId, epoch, "late"), (error) => error instanceof AgentHomeError && error.code === "stale");
  assert.deepEqual(store.runClaim(run.runId), { epoch: epoch + 1, holder: "first, serving" });
});

test("a store an earlier version wrote (store version 1) is refused, by the writer and the reader, with no migration", async () => {
  const dir = await scratch();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY); PRAGMA user_version = 1");
  db.close();
  const old = (error) => error instanceof AgentHomeError && error.code === "format" && /kept its runs outside the disk \(store version 1\)/.test(error.message);
  assert.throws(() => openStore(dir), old);
  assert.throws(() => openStoreReader(dir), old);
});

test("a run's folder is never made through a symbolic link: a link at the agent's folder (or above it) refuses the start, and nothing is made where it points", async () => {
  const { dir, store, agent } = await aStore();
  const target = await scratch();
  mkdirSync(path.join(dir, "disk", "agents"), { recursive: true });
  symlinkSync(target, path.join(dir, "disk", "agents", nameOf(agent.id)));
  await assert.rejects(store.startRun({ agent: agent.id }), (error) => error instanceof AgentHomeError && error.code === "invalid" && /^disk\/agents\/[^/]+ is a symbolic link, and a run's folder is never made through one$/.test(error.message));
  assert.deepEqual(readdirSync(target), [], "nothing made where the link points");
  assert.equal(store.listRuns().length, 0, "no row");
});
