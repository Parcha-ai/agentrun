// What an import leaves out is counted by why, in words, on the dry run and the import alike, with the flag that brings
// a kind in; --include-deleted brings in the sessions of folders that no longer exist (a deleted worktree's), each folder
// its own agent, and nothing else the import leaves out.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "@parcha/pi-durable-agent";
import * as importing from "../dist/import.js";
import { claudeSession, piSession, sessionId } from "./fixtures/import-sessions.mjs";
import { scratch } from "./support.mjs";

const ENV = { PATH: "/usr/bin" };

/** A home with one live project, two deleted worktrees (three sessions), a temp project, a session still being written,
 *  and a file in Claude Code's folder that holds no session. */
async function home(t) {
  const root = await scratch(t);
  const at = join(root, "home");
  const temp = join(root, "tmp");
  const live = join(at, "code", "billing-api");
  mkdirSync(live, { recursive: true });
  mkdirSync(join(temp, "scratch"), { recursive: true });
  claudeSession(at, live, 1);
  claudeSession(at, join(at, "worktrees", "billing-api-retries"), 2);
  claudeSession(at, join(at, "worktrees", "billing-api-retries"), 3);
  claudeSession(at, join(at, "worktrees", "billing-api-docs"), 4);
  claudeSession(at, join(temp, "scratch"), 5);
  piSession(at, live, 6, { fresh: true });
  const empty = join(at, ".claude", "projects", "-x", "notes.jsonl");
  mkdirSync(join(at, ".claude", "projects", "-x"), { recursive: true });
  writeFileSync(empty, "");
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(empty, old, old);
  return { root, at, temp, live };
}

test("the left-out sessions are counted by why, the most first", async (t) => {
  const h = await home(t);
  const plan = await importing.planImport({ home: h.at, env: ENV, temp: h.temp });
  assert.deepEqual(importing.leftOutOf?.(plan.skipped), [
    { kind: "gone", count: 3, label: "3 sessions from folders that no longer exist" },
    { kind: "temp", count: 1, label: "1 session from temp folders" },
    { kind: "live", count: 1, label: "1 session still being written: it comes in next time" },
    { kind: "no-project", count: 1, label: "1 file that is not a session (no project folder in it)" },
  ]);
});

test("--include-deleted imports the sessions of folders that no longer exist, each folder its own agent, and leaves the rest out", async (t) => {
  const h = await home(t);
  const options = { home: h.at, env: ENV, temp: h.temp, deleted: true };
  const plan = await importing.planImport(options);
  assert.deepEqual(plan.projects.map((p) => [p.name, p.sessions.length]), [["billing-api", 1], ["billing-api-docs", 1], ["billing-api-retries", 2]]);
  assert.deepEqual(plan.skipped.map((s) => s.kind).sort(), ["live", "no-project", "temp"]);
  const store = openStore(join(h.root, "agents"));
  t.after(() => store.close());
  const report = await importing.runImport(store, plan, options);
  assert.deepEqual(report.agents.map((a) => [a.cwd, a.runs]), [[h.live, 1], [join(h.at, "worktrees", "billing-api-docs"), 1], [join(h.at, "worktrees", "billing-api-retries"), 2]]);
  assert.equal(store.readAgent(report.agents[2].id).revisions[0].body.instructions, "", "a folder that is gone has no instructions to read");
});

test("the CLI's dry run and import count what they leave out by why, with the flag that brings each kind in, and list each file only with --verbose", async (t) => {
  const h = await home(t);
  const all = [];
  const run = async (...args) => {
    const lines = [];
    assert.equal(await importing.importCommand(["--data", join(h.root, "agents"), ...args], "usage", { home: h.at, temp: h.temp, env: ENV, out: (line) => lines.push(line) }), 0);
    all.push(lines);
    return lines.filter((line) => line.startsWith("left out: "));
  };
  const counts = [
    "left out: 3 sessions from folders that no longer exist (--include-deleted imports them too)",
    "left out: 1 session from temp folders (--all imports it too)",
    "left out: 1 session still being written: it comes in next time",
    "left out: 1 file that is not a session (no project folder in it)",
  ];
  assert.deepEqual(await run("--dry-run"), counts);
  assert.deepEqual(await run("--dry-run", "--include-deleted"), counts.slice(1));
  assert.deepEqual(await run("--include-deleted"), counts.slice(1), "the import counts as its dry run does");
  assert.ok(all.flat().every((line) => !line.startsWith("skipped ")), "no file by file list unless asked");
  // The import above took the deleted folders' sessions: three files left out are left, each named.
  await run("--dry-run", "--verbose");
  assert.equal(all.at(-1).filter((line) => line.startsWith("skipped ")).length, 3, "--verbose names each one");
});

test("a session of two files is one session left out, and a deleted folder under the temp directory is a temp folder's, which only --all brings in", async (t) => {
  const root = await scratch(t);
  const at = join(root, "home");
  const temp = join(root, "tmp");
  mkdirSync(temp, { recursive: true });
  const file = claudeSession(at, join(at, "worktrees", "billing-api-retries"), 21);
  // The same session moved to another projects folder: two files, one session.
  const copy = join(at, ".claude", "projects", "-moved", `${sessionId(21)}.jsonl`);
  mkdirSync(join(at, ".claude", "projects", "-moved"), { recursive: true });
  copyFileSync(file, copy);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(copy, old, old);
  claudeSession(at, join(temp, "deleted-scratch"), 22);
  const plan = await importing.planImport({ home: at, env: ENV, temp });
  assert.deepEqual(plan.skipped.map((s) => s.kind).sort(), ["gone", "gone", "temp"], "two files of the gone session, one of the temp one");
  assert.deepEqual(importing.leftOutOf(plan.skipped), [
    { kind: "gone", count: 1, label: "1 session from folders that no longer exist" },
    { kind: "temp", count: 1, label: "1 session from temp folders" },
  ]);
  const deleted = await importing.planImport({ home: at, env: ENV, temp, deleted: true });
  assert.deepEqual(deleted.projects.map((p) => p.name), ["billing-api-retries"]);
  assert.deepEqual(deleted.skipped.map((s) => s.kind), ["temp"], "--include-deleted leaves the temp folder's session out, as its line said");
});
