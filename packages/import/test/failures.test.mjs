// A file a reader cannot read is no empty session: parseHome hands it back (failures), or throws when the caller takes
// none, and the known-answer CLI exits non-zero, one stderr line a file, its key alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, utimes } from "node:fs/promises";
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

test("a resumed read that fails gives up the records it held: copies in later files count, as in a fresh pass, and the next pass reads it from its start", async (t) => {
  const dir = await tempHome(t);
  const ORIGINAL = "00000000-0000-4000-8000-0000000000a1";
  const RESUMED = "00000000-0000-4000-8000-0000000000b2";
  const shared = [claudeUser({ uuid: "u1", text: PROMPT, i: 0, session: ORIGINAL }), claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 20), i: 1, session: ORIGINAL })];
  const original = await writeJsonl(claudeFile(dir, ORIGINAL), shared);
  const resumed = await writeJsonl(claudeFile(dir, RESUMED), [...shared.map((r) => ({ ...r, sessionId: RESUMED })), claudeUser({ uuid: "u2", text: "More.", i: 10, session: RESUMED })]);
  await utimes(original, 1_000, 1_000);
  await utimes(resumed, 2_000, 2_000);
  const real = READERS["claude-code"];
  // The original cannot be read this once (an I/O error), the copy can.
  const failing = { ...real, read: (locator, cursor, options) => (locator.file === original ? Promise.reject(Object.assign(new Error("injected"), { code: "EIO" })) : real.read(locator, cursor, options)) };
  const scan = (readers, state) => parseHome(dir, { sources: ["claude-code"], catalog: false, failures: [], ...(readers ? { readers: { "claude-code": readers } } : {}), ...(state ? { state } : {}) });
  const state = {};
  await scan(undefined, state);
  const failed = await scan(failing, state);
  assert.deepEqual(failed, await scan(failing), "the failed pass is the fresh pass with the same failure");
  assert.equal(failed[0].calls, 1, "the copy holds the shared request");
  const after = await scan(undefined, state);
  assert.deepEqual(after, await scan(), "the next pass is the fresh pass");
});
