import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { EXPORTABLE_KINDS, projectForExport, readAgentHome, SECRET_KINDS } from "../dist/index.js";
import { DEFINED_KINDS } from "../dist/kinds.js";
import { buildSignedInHome, checkExportClean, FIXTURE_HOST, PRACTICE_ORIGIN, SIGN_IN_MARKER, signedInHomeSkip } from "./fixtures/signed-in-home.mjs";
import { scratch } from "./support.mjs";

const src = new URL("../src/", import.meta.url);
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? sources(new URL(`${entry.name}/`, dir)) : entry.name.endsWith(".ts") ? [new URL(entry.name, dir)] : []);
/** A store's bytes with its WAL's, where a commit may still sit. */
const storeBytes = (file) => Buffer.concat([readFileSync(file), ...(existsSync(`${file}-wal`) ? [readFileSync(`${file}-wal`)] : [])]);

test("every kind the package defines is on exactly one export list; the lists are disjoint, frozen and name only defined kinds", () => {
  assert.ok(Object.isFrozen(EXPORTABLE_KINDS) && Object.isFrozen(SECRET_KINDS));
  for (const kind of DEFINED_KINDS) {
    assert.equal(Number(EXPORTABLE_KINDS.includes(kind)) + Number(SECRET_KINDS.includes(kind)), 1, `${kind} is on exactly one list`);
  }
  for (const kind of [...EXPORTABLE_KINDS, ...SECRET_KINDS]) assert.ok(DEFINED_KINDS.includes(kind), `${kind} is a kind the package defines`);
  assert.deepEqual(EXPORTABLE_KINDS.filter((kind) => SECRET_KINDS.includes(kind)), []);
});

test("every document kind is defined through the two helpers that register it, so none escapes the export lists", () => {
  const calls = sources(src).flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\bdefineDoc(?:Family)?\s*[<(]/g)].map(() => path.basename(file.pathname)));
  assert.deepEqual(calls, ["kinds.ts", "kinds.ts"]);
});

test("projectForExport copies a listed kind, strips the host from a run, and drops every other kind", () => {
  const run = { path: "runs/r1", host: "laptop", startedAt: "2026-10-16T00:00:00.000Z", endedAt: "2026-10-16T00:01:00.000Z", outcome: "completed", finalAnswer: { answer: "42" }, cost: 0.5 };
  const projected = projectForExport("agent.runs", run);
  assert.deepEqual(projected, { path: "runs/r1", startedAt: "2026-10-16T00:00:00.000Z", endedAt: "2026-10-16T00:01:00.000Z", outcome: "completed", finalAnswer: { answer: "42" }, cost: 0.5 });
  projected.finalAnswer.answer = "changed";
  assert.deepEqual(run.finalAnswer, { answer: "42" }, "a deep copy");
  assert.equal(run.host, "laptop", "the stored record is left as it is");
  const identity = { id: "agt_1", name: "Researcher", formatVersion: 1 };
  assert.deepEqual(projectForExport("agent.identity", identity), identity);
  assert.notEqual(projectForExport("agent.identity", identity), identity);
  for (const kind of SECRET_KINDS) assert.equal(projectForExport(kind, { ref: SIGN_IN_MARKER, externalId: "x" }), undefined, kind);
  for (const kind of ["pi.agent", "browser.sessions", "agent.memory", "agent.runs.v2", ""]) assert.equal(projectForExport(kind, { a: 1 }), undefined, kind);
});

test("the signed-in fixture holds its marker in both stores, and no projection of the agent store keeps it or the host", { skip: signedInHomeSkip }, async () => {
  const { home, runId, agentStore, runStore } = await buildSignedInHome(await scratch());
  assert.equal(runStore, path.join(home.dir, "runs", runId, "store", "run.sqlite"));
  for (const file of [agentStore, runStore]) assert.ok(storeBytes(file).includes(SIGN_IN_MARKER), `${path.basename(file)} holds the marker`);
  const state = await readAgentHome(home);
  assert.deepEqual(state.profiles.practice, { provider: "browserbase", ref: SIGN_IN_MARKER, state: "ready", allowedOrigins: [PRACTICE_ORIGIN] });
  const documents = {
    "agent.identity": [state.identity], "agent.definition": [state.definition], "agent.source": state.source ? [state.source] : [], "agent.skills": Object.values(state.skills),
    "agent.aliases": Object.values(state.aliases), "agent.bindings": Object.values(state.bindings), "agent.runs": Object.values(state.runs),
    "agent.leases": Object.values(state.leases), "browser.profiles": Object.values(state.profiles),
  };
  assert.deepEqual(Object.keys(documents).sort(), [...DEFINED_KINDS].sort(), "every kind is projected");
  const exported = Object.entries(documents).flatMap(([kind, values]) => values.map((value) => projectForExport(kind, value))).filter((value) => value !== undefined);
  const text = JSON.stringify(exported);
  assert.ok(!text.includes(SIGN_IN_MARKER) && !text.includes(FIXTURE_HOST) && !text.includes(PRACTICE_ORIGIN), "no sign-in, host or profile origin");
  assert.ok(text.includes(`runs/${runId}`) && text.includes("Signed-in fixture"), "the run and the identity are kept");
  assert.throws(() => checkExportClean(agentStore), /holds the sign-in marker/);
});

test("checkExportClean passes one closed SQLite file and refuses one with a -wal, -shm or -journal beside it", async () => {
  const file = path.join(await scratch(), "export.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, outcome TEXT); INSERT INTO runs VALUES ('r1', 'completed')");
  db.close();
  assert.deepEqual(readdirSync(path.dirname(file)), ["export.sqlite"]);
  checkExportClean(file);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    writeFileSync(`${file}${suffix}`, "");
    assert.throws(() => checkExportClean(file), new RegExp(`export.sqlite${suffix} sits beside the export`));
    rmSync(`${file}${suffix}`);
  }
  checkExportClean(file);
});

test("checkExportClean reads bytes, not rows: a deleted sign-in left in a free page is refused", async () => {
  const file = path.join(await scratch(), "deleted.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA secure_delete = OFF");
  db.exec("CREATE TABLE profiles (key TEXT PRIMARY KEY, ref TEXT)");
  db.prepare("INSERT INTO profiles VALUES (?, ?)").run("practice", SIGN_IN_MARKER);
  db.exec("DELETE FROM profiles");
  assert.equal(db.prepare("SELECT count(*) AS n FROM profiles").get().n, 0, "no row holds the marker");
  db.close();
  assert.ok(readFileSync(file).includes(SIGN_IN_MARKER), "the deleted row's bytes are still in the file");
  assert.throws(() => checkExportClean(file), /holds the sign-in marker/);
});
