// A file a reader cannot read is no empty session: parseHome hands it back (failures), or throws when the caller takes
// none, and the known-answer CLI exits non-zero, one stderr line a file, its key alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseHome, READERS } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, SESSION, subagentFile, tempHome, writeJsonl } from "./fixtures.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sha = (text) => createHash("sha256").update(text).digest("hex");
const PROMPT = "Fixture words that must never be printed.";
// Root reads a file whatever its mode: there, no file is unreadable this way.
const skip = process.getuid?.() === 0 ? "a mode-000 file is readable as root" : false;

async function home(t) {
  const dir = await tempHome(t);
  const top = await writeJsonl(claudeFile(dir), [claudeUser({ uuid: "u1", text: PROMPT, i: 0 }), claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 20), i: 1 })]);
  const child = await writeJsonl(subagentFile(dir), [claudeUser({ uuid: "s1", text: PROMPT, i: 2, sidechain: true }), claudeAnswer({ uuid: "s2", msg: "msg_s", req: "req_s", usage: anthropicUsage(1, 2), i: 3, sidechain: true })]);
  await writeJsonl(codexFile(dir), [codexMeta("thread-1"), codexContext(1), codexUser(PROMPT, 2), codexAnswer("Fixture answer.", 3), codexTokens(openaiUsage(100, 60, 7, 3), openaiUsage(100, 60, 7, 3), 4)]);
  for (const file of [top, child]) {
    await chmod(file, 0o000);
    t.after(() => chmod(file, 0o600).catch(() => {}));
  }
  return dir;
}
const KEYS = { top: sha(`.claude/projects/-work-fixture/${SESSION}.jsonl`), child: sha(`.claude/projects/-work-fixture/${SESSION}/subagents/agent-a1.jsonl`) };

test("parseHome hands back each file it could not read, by key, and totals the rest", { skip }, async (t) => {
  const dir = await home(t);
  const failures = [];
  const sessions = await parseHome(dir, { catalog: false, failures });
  assert.deepEqual(sessions.map(({ source }) => source), ["codex"]);
  assert.deepEqual(failures.map(({ key, source }) => ({ key, source })), [{ key: KEYS.top, source: "claude-code" }, { key: KEYS.child, source: "claude-code" }]);
  for (const failure of failures) assert.equal(failure.error.code, "EACCES");
});

test("parseHome with no failures list throws rather than leave an unreadable file out", { skip }, async (t) => {
  const dir = await home(t);
  await assert.rejects(parseHome(dir, { catalog: false }), (error) => error.failures?.length === 2);
});

test("--known-answer exits 1 with one stderr line per unreadable file, its key alone, and prints no partial answer", { skip }, async (t) => {
  const dir = await home(t);
  const result = spawnSync(process.execPath, [CLI, dir, "--known-answer"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const lines = result.stderr.trim().split("\n");
  assert.equal(lines.length, 2, result.stderr);
  for (const [line, key] of [[lines[0], KEYS.top], [lines[1], KEYS.child]]) assert.match(line, new RegExp(`^agentrun-import: cannot read claude-code ${key} \\(EACCES\\)$`));
  for (const text of [PROMPT, "work-fixture", SESSION, dir]) assert.equal(result.stderr.includes(text), false, `stderr holds no ${text}`);
});

test("an OpenCode database that cannot be opened is a failure, never an OpenCode history of no sessions", async (t) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = await tempHome(t);
  const data = join(dir, ".local", "share", "opencode");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "opencode.db"), "not a database, not even close to one");
  const failures = [];
  assert.deepEqual(await parseHome(dir, { sources: ["opencode"], catalog: false, failures }), []);
  assert.deepEqual(failures.map(({ key, source }) => ({ key, source })), [{ key: sha(".local/share/opencode/opencode.db"), source: "opencode" }]);
  await assert.rejects(parseHome(dir, { sources: ["opencode"], catalog: false }), (error) => error.failures?.length === 1);
  // OPENCODE_DB may name a database of any name: one that does not open fails the same way.
  await writeFile(join(dir, "history.sqlite"), "not a database either");
  const named = [];
  await parseHome(dir, { sources: ["opencode"], catalog: false, failures: named, env: { XDG_DATA_HOME: join(dir, "elsewhere"), OPENCODE_DB: join(dir, "history.sqlite") } });
  assert.deepEqual(named.map(({ key }) => key), [sha("history.sqlite")]);
});

test("a read that fails partway leaves the state as it was: a retry with the same state gives the fresh pass's totals", async (t) => {
  const dir = await tempHome(t);
  await writeJsonl(claudeFile(dir), [
    claudeUser({ uuid: "u1", text: PROMPT, i: 0 }),
    claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 20), i: 1 }),
    claudeUser({ uuid: "u2", text: "More.", i: 2 }),
    claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(5, 6), i: 3 }),
  ]);
  // Claude Code's reader, failing after it has noted three records: an I/O error midway through the file.
  const real = READERS["claude-code"];
  const failing = {
    ...real,
    read: (locator, cursor, options) => {
      let noted = 0;
      const seen = {
        has: (key) => options.seen.has(key),
        add(key) {
          if (++noted > 3) throw Object.assign(new Error("injected"), { code: "EIO" });
          options.seen.add(key);
          return this;
        },
      };
      return real.read(locator, cursor, { ...options, seen });
    },
  };
  const state = {};
  const failures = [];
  assert.deepEqual(await parseHome(dir, { sources: ["claude-code"], readers: { "claude-code": failing }, state, failures, catalog: false }), []);
  assert.equal(failures.length, 1);
  const retry = await parseHome(dir, { sources: ["claude-code"], state, catalog: false });
  const fresh = await parseHome(dir, { sources: ["claude-code"], catalog: false });
  assert.equal(fresh[0].calls, 2);
  assert.deepEqual(retry, fresh);
});

test("an OpenCode storage session with a file or folder that cannot be read is a failure, never a session of fewer messages; a malformed record is passed over", { skip }, async (t) => {
  const { join } = await import("node:path");
  const { buildLegacy } = await import("./fixtures/opencode/fixture.mjs");
  const dir = await tempHome(t);
  const storage = join(dir, ".local", "share", "opencode", "storage");
  await buildLegacy(storage);
  // The fixture's malformed parts ("[]", "{not json") are no failure.
  const clean = [];
  const whole = await parseHome(dir, { sources: ["opencode"], catalog: false, failures: clean });
  assert.deepEqual(clean, []);
  assert.deepEqual(whole.map(({ id }) => id), ["ses_A"]);
  const key = sha(".local/share/opencode/storage/session/prj_fixture/ses_A.json");
  for (const path of ["part/msg_A2/prt_A2c.json", "message/ses_A/msg_A3.json", "part/msg_A2", "message/ses_A", "session/prj_fixture/ses_A.json"]) {
    const at = join(storage, path);
    await chmod(at, 0);
    try {
      const failures = [];
      const rows = await parseHome(dir, { sources: ["opencode"], catalog: false, failures });
      assert.deepEqual(failures.map(({ key, source }) => ({ key, source })), [{ key, source: "opencode" }], path);
      assert.equal(rows.some(({ id }) => id === "ses_A"), false, `${path}: no totals of part of the session`);
    } finally {
      await chmod(at, path.endsWith(".json") ? 0o644 : 0o755);
    }
  }
});
