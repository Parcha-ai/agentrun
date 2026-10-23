import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  AgentHomeError, carryBack, createAgentHome, homeRevision, openAgentHome, readAgentHome, refreshAgentHome, setAlias, setBindings, startRun,
} from "../dist/index.js";
import { headOf } from "../dist/store.js";
import { DEFINITION, scratch } from "./support.mjs";

const PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_1 = "1f0c9e2b7d4a8e3c5b6a7f8d9e0c1b2a3d4e5f60";
const SHA_2 = "9a8b7c6d5e4f30211203f4e5d6c7b8a990a1b2c3";
const refused = (code, pattern) => (error) => error instanceof AgentHomeError && error.code === code && (!pattern || pattern.test(error.message));

test("an agent id given in the definition must be one URL segment; a minted id is one", async () => {
  const root = await scratch();
  const bad = ["has space", "-leading", ".leading", "_leading", "a/b", "a:b", "ü", "a".repeat(129), "", 7];
  for (const [index, id] of bad.entries()) {
    const dir = path.join(root, `bad-${index}`);
    await assert.rejects(createAgentHome(dir, { definition: { ...DEFINITION, id } }), refused("invalid", /does not match \^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,127\}\$/), String(id));
    assert.equal(existsSync(dir), false);
  }
  for (const [index, id] of ["a", "Agent.v2_research-9", "7", "x".repeat(128)].entries()) {
    const home = await createAgentHome(path.join(root, `good-${index}`), { definition: { ...DEFINITION, id } });
    assert.equal(home.identity.id, id);
  }
  const minted = await createAgentHome(path.join(root, "minted"), { definition: DEFINITION });
  assert.match(minted.identity.id, PATTERN);
  assert.match(minted.identity.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(await refreshAgentHome(minted, { sha: SHA_1, definition: { ...DEFINITION, id: minted.identity.id }, skills: {} }), { changed: true });
  await assert.rejects(refreshAgentHome(minted, { sha: SHA_2, definition: { ...DEFINITION, id: "another-agent" }, skills: {} }), refused("invalid", /not this agent's id/));
});

test("homeRevision is the agent store's head commit: every write moves it by one; reads and a same-sha refresh do not", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n" }, sha: SHA_1 });
  const steps = [];
  const step = async (name, write) => { await write(); steps.push([name, await homeRevision(home)]); };
  steps.push(["create", await homeRevision(home)]);
  await step("setAlias", () => setAlias(home, "host-a", "ext-1"));
  await step("setBindings", () => setBindings(home, "host-a", { browser: "local" }));
  let run;
  await step("startRun", async () => { run = await startRun(home, { runId: "r1", host: "host-a" }); });
  await step("carryBack", () => carryBack(home, run, { outcome: "completed" }));
  await step("refresh", () => refreshAgentHome(home, { sha: SHA_2, definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite v2\n" } }));
  await step("same-sha refresh", () => refreshAgentHome(home, { sha: SHA_2, definition: DEFINITION, skills: {} }));
  await step("second carryBack", () => carryBack(home, run, { outcome: "completed" }));
  await step("reads", async () => { await readAgentHome(home); await openAgentHome(home.dir); await homeRevision(home); });
  assert.deepEqual(steps, [
    ["create", 1], ["setAlias", 2], ["setBindings", 3], ["startRun", 4], ["carryBack", 5], ["refresh", 6],
    ["same-sha refresh", 6], ["second carryBack", 6], ["reads", 6],
  ]);
});

test("homeRevision refuses a directory that is not an agent home", async () => {
  const dir = await scratch();
  await assert.rejects(homeRevision({ dir, identity: { id: "x", name: "x", formatVersion: 1 } }), refused("missing"));
});

test("refresh with ifRevision is a compare-and-swap on homeRevision, checked before from and the same-sha no-op", async () => {
  const skills = { "cite/SKILL.md": "# Cite\n" };
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills, sha: SHA_1 });
  await setAlias(home, "host-a", "ext-1");
  const revision = await homeRevision(home);
  const before = await readAgentHome(home);
  const stale = (expected) => refused("stale", new RegExp(`at revision ${revision}, not ${expected} as the refresh expected; nothing was written`));
  await assert.rejects(refreshAgentHome(home, { sha: SHA_2, ifRevision: revision - 1, definition: DEFINITION, skills }), stale(revision - 1));
  await assert.rejects(refreshAgentHome(home, { sha: SHA_2, ifRevision: revision + 1, from: SHA_2, definition: DEFINITION, skills }), stale(revision + 1), "ifRevision is checked before from");
  await assert.rejects(refreshAgentHome(home, { sha: SHA_1, ifRevision: revision + 1, definition: DEFINITION, skills }), stale(revision + 1), "and before the same-sha no-op");
  for (const bad of [-1, 1.5, "3", null]) {
    await assert.rejects(refreshAgentHome(home, { sha: SHA_2, ifRevision: bad, definition: DEFINITION, skills }), refused("invalid", /not a home revision/), String(bad));
  }
  assert.equal(await homeRevision(home), revision, "the head did not move");
  assert.deepEqual(await readAgentHome(home), before, "nothing written");

  assert.deepEqual(await refreshAgentHome(home, { sha: SHA_2, ifRevision: revision, from: SHA_1, definition: DEFINITION, skills }), { changed: true });
  assert.equal(await homeRevision(home), revision + 1);
  assert.deepEqual(await refreshAgentHome(home, { sha: SHA_2, ifRevision: revision + 1, definition: DEFINITION, skills }), { changed: false }, "a matching revision at the same sha is the no-op");
  assert.deepEqual(await refreshAgentHome(home, { sha: SHA_1, definition: DEFINITION, skills }), { changed: true }, "without ifRevision, no check");
  assert.equal(await homeRevision(home), revision + 2);
});

/** A copy of `home`'s agent.sqlite in a fresh home directory, its durable_metadata rebuilt without pi's constraints
 *  (STRICT, NOT NULL, the singleton CHECK) so `corrupt` can put any value there. */
async function corrupted(home, corrupt) {
  const dir = await scratch();
  mkdirSync(path.join(dir, "runs"));
  copyFileSync(path.join(home.dir, "agent.sqlite"), path.join(dir, "agent.sqlite"));
  const db = new DatabaseSync(path.join(dir, "agent.sqlite"));
  db.exec(`CREATE TABLE kept AS SELECT * FROM durable_metadata; DROP TABLE durable_metadata;
    CREATE TABLE durable_metadata (singleton INTEGER PRIMARY KEY, next_id TEXT, next_seq); INSERT INTO durable_metadata SELECT * FROM kept; DROP TABLE kept`);
  corrupt(db);
  db.close();
  return { dir, identity: home.identity };
}
const nextSeqOf = (copy) => {
  const db = new DatabaseSync(path.join(copy.dir, "agent.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT next_seq FROM durable_metadata").get()?.next_seq; } finally { db.close(); }
};
const BAD_VALUES = [["null", null], ["zero", 0], ["negative", -3], ["fractional", 1.5], ["text", "7"]];

test("headOf refuses a missing row and any next_seq that is not a safe integer of at least 1", () => {
  const format = (error) => error instanceof AgentHomeError && error.code === "format" && /no usable head commit/.test(error.message);
  for (const row of [undefined, {}, { next_seq: undefined }, { next_seq: null }, { next_seq: "7" }, { next_seq: 1.5 }, { next_seq: 0 }, { next_seq: -3 },
    { next_seq: Number.NaN }, { next_seq: Number.POSITIVE_INFINITY }, { next_seq: 2 ** 53 }, { next_seq: 9007199254740993n }, { next_seq: true }]) {
    assert.throws(() => headOf(row), format, JSON.stringify(row, (_, v) => (typeof v === "bigint" ? `${v}n` : v)) ?? "undefined");
  }
  assert.deepEqual([headOf({ next_seq: 1 }), headOf({ next_seq: 5 }), headOf({ next_seq: 5n }), headOf({ next_seq: 2 ** 53 - 1 })], [0, 4, 4, 2 ** 53 - 2]);
});

test("homeRevision fails closed with format on a store whose durable_metadata is missing, rowless or holds a bad next_seq", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, sha: SHA_1 });
  const revision = await homeRevision(home);
  assert.equal(await homeRevision(await corrupted(home, () => {})), revision, "the rebuilt table alone reads as before");
  const cases = [
    ["no durable_metadata table", (db) => db.exec("DROP TABLE durable_metadata"), /no readable head commit/],
    ["no singleton row", (db) => db.exec("DELETE FROM durable_metadata"), /no usable head commit \(no durable_metadata row\)/],
    ["next_seq past 2^53 - 1", (db) => db.exec("UPDATE durable_metadata SET next_seq = 9007199254740993"), /no readable head commit/],
    ...BAD_VALUES.map(([name, value]) => [`next_seq ${name}`, (db) => db.prepare("UPDATE durable_metadata SET next_seq = ?").run(value), /no usable head commit \(next_seq /]),
  ];
  for (const [name, corrupt, message] of cases) {
    await assert.rejects(homeRevision(await corrupted(home, corrupt)), refused("format", message), name);
  }
});

test("a refresh with ifRevision on a store with a bad next_seq fails closed with format and writes nothing", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n" }, sha: SHA_1 });
  for (const [name, value] of BAD_VALUES) {
    const copy = await corrupted(home, (db) => db.prepare("UPDATE durable_metadata SET next_seq = ?").run(value));
    const before = await readAgentHome(copy);
    await assert.rejects(refreshAgentHome(copy, { sha: SHA_2, ifRevision: 1, definition: DEFINITION, skills: {} }), refused("format", /no usable head commit/), name);
    assert.deepEqual(await readAgentHome(copy), before, `${name}: nothing written`);
    assert.equal(nextSeqOf(copy), value, `${name}: the store's head is as it was`);
  }
});
