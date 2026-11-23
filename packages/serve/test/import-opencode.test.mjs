import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openCodeFiles, readOpenCode, readOpenCodeDb, readOpenCodeStorage } from "../dist/import-opencode.js";
import { buildLegacy, buildV1, buildV2, T0 } from "./fixtures/opencode/fixture.mjs";

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), "import-opencode-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const at = (ms) => new Date(T0 + ms).toISOString();
const byId = (sessions) => Object.fromEntries(sessions.map((session) => [session.id, session]));
/** The sum of a session's requests' tokens. */
const total = ({ turns }) => turns.reduce((sum, turn) => {
  if (turn.role !== "assistant" || !turn.usage) return sum;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) sum[key] += turn.usage[key];
  return sum;
}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const said = ({ turns }) => turns.map((turn) => [turn.role, turn.role === "toolResult" ? `${turn.callId}:${turn.text}:${turn.isError}` : turn.text]);

// ses_A and ses_B as the 1.x database and the JSON storage both hold them: one reading, wherever it was kept.
function assertV1(sessions, fileOf) {
  const { ses_A: a, ses_B: b, ...rest } = byId(sessions);
  assert.deepEqual(Object.keys(rest), []);
  assert.deepEqual(
    { ...a, turns: undefined },
    {
      source: "opencode", id: "ses_A", file: fileOf("ses_A"), cwd: "/fixture/project", model: "openai/gpt-5",
      startedAt: at(1000), endedAt: at(30_000), state: "completed", costUsd: 0.875,
      firstPrompt: "Fix the parser please.", titleText: "Fix the parser please.", sourceTitle: "Fix the parser",
      child: false, turns: undefined, users: 2, activeMs: 29_000, copies: 0, effort: "high",
    },
  );
  assert.deepEqual(said(a), [
    ["user", "Fix the parser please."],
    ["assistant", "Reading the file."],
    ["toolResult", "call_1:export const a = 1;:false"],
    ["assistant", "Fixed."],
    ["toolResult", "call_2:exit 1:true"],
    ["user", "Now add a test."],
    ["assistant", "Added."],
  ]);
  const [, first, , second, , , third] = a.turns;
  assert.deepEqual(first.calls, [{ type: "toolCall", id: "call_1", name: "read", arguments: { filePath: "/fixture/project/a.ts" } }]);
  assert.deepEqual([first.model, first.effort, first.costUsd, first.at], ["anthropic/claude-sonnet-4-5", "high", 0.25, T0 + 2000]);
  // Each step its own usage: the message's tokens are only its last step's.
  assert.deepEqual(first.usage, { input: 100, output: 25, cacheRead: 0, cacheWrite: 200 });
  assert.deepEqual(second.usage, { input: 30, output: 50, cacheRead: 500, cacheWrite: 0 });
  assert.equal(second.calls[0].name, "bash");
  // An older message whose output holds its reasoning, as its total says.
  assert.deepEqual([third.model, third.effort, third.usage], ["openai/gpt-5", undefined, { input: 100, output: 300, cacheRead: 600, cacheWrite: 0 }]);
  assert.deepEqual(total(a), { input: 230, output: 375, cacheRead: 1100, cacheWrite: 200 });
  assert.equal(a.turns[2].name, "read");

  assert.deepEqual([b.child, b.parent, b.sourceTitle, b.costUsd, b.firstPrompt, b.model], [true, "ses_A", undefined, 0.0625, "Find the tests.", "anthropic/claude-haiku-4-5"]);
  assert.deepEqual(total(b), { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
}

test("a 1.x opencode.db: each step a request with its own usage, a subagent's session under its parent, malformed rows passed over", async (t) => {
  const db = join(await folder(t), "opencode.db");
  await buildV1(db);
  assertV1(await readOpenCodeDb(db), () => db);
});

test("the JSON storage OpenCode kept before SQLite reads as its database does", async (t) => {
  const storage = join(await folder(t), "storage");
  await buildLegacy(storage);
  assertV1(await readOpenCodeStorage(storage), (id) => join(storage, "session", "prj_fixture", `${id}.json`));
});

test("a 2.x opencode.db: its own tables first, 1.x history not yet moved, a fork's copied rows counted once", async (t) => {
  const db = join(await folder(t), "opencode.db");
  await buildV2(db);
  const { ses_C: c, ses_D: d, ses_F: f, ...rest } = byId(await readOpenCodeDb(db));
  assert.deepEqual(Object.keys(rest), []);
  assert.deepEqual(
    { ...c, turns: undefined },
    {
      source: "opencode", id: "ses_C", file: db, cwd: "/fixture/v2", model: "anthropic/claude-opus-4-5",
      startedAt: at(100_500), endedAt: at(111_000), state: "stopped", costUsd: 0.875,
      firstPrompt: "Port the reader to v2.", titleText: "Port the reader to v2.", sourceTitle: "Port the reader",
      child: false, turns: undefined, users: 2, activeMs: 10_500, copies: 0, effort: "max",
    },
  );
  assert.deepEqual(said(c), [
    ["user", "Port the reader to v2."],
    ["assistant", "Looking."],
    ["toolResult", "call_v2a:const x = 1;:false"],
    ["assistant", "Done porting."],
    ["toolResult", "call_v2b:exit 1:true"],
    ["assistant", "Ported the reader."],
    ["user", "Stop."],
  ]);
  assert.deepEqual(c.turns[1].calls, [{ type: "toolCall", id: "call_v2a", name: "read", arguments: { filePath: "x.ts" } }]);
  assert.deepEqual(c.turns.filter((turn) => turn.role === "assistant").map((turn) => [turn.usage, turn.costUsd]), [
    [{ input: 50, output: 14, cacheRead: 1000, cacheWrite: 20 }, 0.5],
    [{ input: 5, output: 30, cacheRead: 1070, cacheWrite: 0 }, 0.25],
    [{ input: 200, output: 100, cacheRead: 0, cacheWrite: 0 }, 0.125],
  ]);
  assert.deepEqual(total(c), { input: 255, output: 144, cacheRead: 2070, cacheWrite: 20 });

  assert.deepEqual([d.model, d.cwd, d.costUsd, total(d)], ["openai/gpt-5", "/fixture/old", 0, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }]);
  assert.deepEqual([f.copies, f.users, f.costUsd, said(f), total(f)], [3, 0, 0.03125, [["assistant", "Forked."]], { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }]);
});

test("a listing reads the same sessions without their turns", async (t) => {
  const db = join(await folder(t), "opencode.db");
  await buildV2(db);
  const full = await readOpenCodeDb(db);
  // The effort most requests ran at is read from the turns: none in a listing, as with the other sources.
  assert.deepEqual(await readOpenCodeDb(db, { turns: false }), full.map(({ effort: _effort, ...session }) => ({ ...session, turns: [] })));
});

test("OpenCode's files under a home: its databases and its JSON storage, never a link nor a database's WAL", async (t) => {
  const home = await folder(t);
  const data = join(home, ".local", "share", "opencode");
  await buildV1(join(data, "opencode.db"));
  await buildLegacy(join(data, "storage"));
  await writeFile(join(data, "opencode-beta.db"), "");
  await writeFile(join(data, "opencode.db-wal"), "");
  await symlink(join(data, "opencode.db"), join(data, "opencode-linked.db"));
  assert.deepEqual(await openCodeFiles(home), { dbs: [join(data, "opencode-beta.db"), join(data, "opencode.db")], storage: join(data, "storage") });
  // A data folder of its own (OPENCODE_DATA_DIR, XDG_DATA_HOME/opencode), when the caller names one.
  const elsewhere = join(home, "elsewhere");
  await mkdir(elsewhere);
  await buildV1(join(elsewhere, "opencode.db"));
  assert.deepEqual(await openCodeFiles(home, elsewhere), { dbs: [join(elsewhere, "opencode.db")] });
  assert.deepEqual(await openCodeFiles(join(home, "nobody")), { dbs: [] });

  // A session both in the database and in the storage it was moved from is the database's, once; an unreadable
  // database is passed over.
  const sessions = await readOpenCode(home);
  assert.deepEqual(sessions.map((session) => [session.id, session.file]), [["ses_A", join(data, "opencode.db")], ["ses_B", join(data, "opencode.db")]]);
});
