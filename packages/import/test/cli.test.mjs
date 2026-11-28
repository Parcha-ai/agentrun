// The known-answer CLI: one JSONL line per session, sorted by key, numbers only. A key is the sha256 of the session
// file's path relative to the home; no content, title, directory or path is printed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HARNESS_OF, READERS, SOURCE_NAMES, SOURCES } from "../dist/index.js";
import { join } from "node:path";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, piAnswer, piFile, piMeta, piUser, SESSION, tempHome, writeJsonl } from "./fixtures.mjs";
import { buildLegacy, buildV2 } from "./fixtures/opencode/fixture.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sha = (text) => createHash("sha256").update(text).digest("hex");
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
const PROMPT = "Fixture words that must never be printed.";

async function home(t) {
  const dir = await tempHome(t);
  await writeJsonl(claudeFile(dir), [
    claudeUser({ uuid: "u1", text: PROMPT, i: 0 }),
    // A model no catalog lists: its cost is unknown.
    claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 20, 30, 40, 15), i: 1, model: "claude-unlisted-fixture" }),
  ]);
  await writeJsonl(codexFile(dir), [codexMeta("thread-1"), codexContext(1), codexUser(PROMPT, 2), codexAnswer("Fixture answer.", 3), codexTokens(openaiUsage(100, 60, 7, 3), openaiUsage(100, 60, 7, 3), 4)]);
  // pi prices each request itself: the session's cost is their sum.
  await writeJsonl(piFile(dir), [piMeta(), piUser(PROMPT, 1), piAnswer({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, 2, 0.25), piUser("Again.", 3), piAnswer({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }, 4, 0.5)]);
  return dir;
}

test("--known-answer prints one line per session, sorted by key, with the agreed fields and nothing else", async (t) => {
  const dir = await home(t);
  const result = run(dir, "--known-answer");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const keys = { "claude-code": sha(`.claude/projects/-work-fixture/${SESSION}.jsonl`), codex: sha(".codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-fixture.jsonl"), pi: sha(".pi/agent/sessions/--work-fixture--/2026-01-01T00-00-00_pi-session-1.jsonl") };
  assert.deepEqual(lines.map((line) => line.key), Object.values(keys).sort());
  for (const line of lines) {
    assert.deepEqual(Object.keys(line), ["key", "source", "tokens", "cost", "turns", "calls"]);
    assert.deepEqual(Object.keys(line.tokens), ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"]);
  }
  const by = Object.fromEntries(lines.map((line) => [line.source, line]));
  assert.deepEqual(by["claude-code"], { key: keys["claude-code"], source: "claude-code", tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 15 }, cost: null, turns: 1, calls: 1 });
  assert.deepEqual(by.codex.tokens, { input: 40, output: 7, cacheRead: 60, cacheWrite: 0, cacheWrite1h: 0 });
  assert.deepEqual([by.codex.turns, by.codex.calls], [1, 1]);
  assert.deepEqual(by.pi, { key: keys.pi, source: "pi", tokens: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, cacheWrite1h: 0 }, cost: 0.75, turns: 2, calls: 2 });
  for (const leak of [PROMPT, "Fixture answer", "/work/fixture", dir, SESSION, "thread-1", "pi-session-1"]) assert.ok(!result.stdout.includes(leak), `prints ${leak}`);
});

test("a source named twice in --sources is read once: each session prints one line", async (t) => {
  const dir = await home(t);
  const once = run(dir, "--sources", "codex", "--known-answer");
  const twice = run(dir, "--sources", "codex,codex", "--known-answer");
  assert.equal(twice.status, 0, twice.stderr);
  assert.equal(twice.stdout.trim().split("\n").length, 1);
  assert.equal(twice.stdout, once.stdout);
});

test("--sources picks the sources; an unknown one, or no --known-answer, is a usage error", async (t) => {
  const dir = await home(t);
  const only = run(dir, "--sources", "pi,codex", "--known-answer");
  assert.equal(only.status, 0, only.stderr);
  assert.deepEqual(only.stdout.trim().split("\n").map((line) => JSON.parse(line).source).sort(), ["codex", "pi"]);
  assert.equal(run(dir, "--sources", "nope", "--known-answer").status, 2);
  assert.equal(run(dir).status, 2);
  assert.equal(run("--known-answer").status, 2);
});

test("--threads and --read-ahead change how the home is read, not the answer; a bad value is a usage error", async (t) => {
  const dir = await home(t);
  const plain = run(dir, "--known-answer");
  assert.equal(plain.status, 0, plain.stderr);
  for (const args of [["--threads", "1"], ["--threads", "2", "--read-ahead", "0"], ["--threads", "3", "--read-ahead", "64k"], ["--read-ahead", "1G"]]) {
    const result = run(dir, ...args, "--known-answer");
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, plain.stdout, args.join(" "));
  }
  for (const args of [["--threads", "0"], ["--threads", "2.5"], ["--threads", "two"], ["--read-ahead", "-1"], ["--read-ahead", "1t"], ["--threads", "1k"], ["--threads", "65"]]) {
    const result = run(dir, ...args, "--known-answer");
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /usage: agentrun-import/, args.join(" "));
  }
});

test("--help and -h print the usage to stdout and exit 0; a bad argument is still exit 2", () => {
  for (const flag of ["--help", "-h"]) {
    for (const args of [[flag], ["/nowhere", flag, "--known-answer"]]) {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^usage: agentrun-import <home> \[--sources claude-code,codex,pi,opencode,copilot,cursor\] \[--threads N\] \[--read-ahead BYTES\[k\|m\|g\]\] --known-answer \| --cache\n/);
      assert.equal(result.stderr, "");
    }
  }
  const bad = run("--nope");
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /usage: agentrun-import/);
});

test("without pi-ai the CLI fails at startup, loudly: it never prints lines that silently price nothing", async (t) => {
  const dir = await home(t);
  // A loader hook that makes every @earendil-works/pi-ai specifier unresolvable, as an install without the peer.
  const hooks = `data:text/javascript,${encodeURIComponent('export async function resolve(s, c, next) { if (s.startsWith("@earendil-works/pi-ai")) { const e = new Error("Cannot find package " + s); e.code = "ERR_MODULE_NOT_FOUND"; throw e; } return next(s, c); }')}`;
  const register = `data:text/javascript,${encodeURIComponent(`import { register } from "node:module"; register(${JSON.stringify(hooks)}, ${JSON.stringify(pathToFileURL(CLI).href)});`)}`;
  const result = spawnSync(process.execPath, ["--import", register, CLI, dir, "--known-answer"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.notEqual(result.status, 0, "exits non-zero");
  assert.equal(result.stdout, "", "prints no line");
  assert.match(result.stderr, /@earendil-works\/pi-ai/);
});

test("the sources are a registry: each reader names its source, its harness and its name, and reads its own files", () => {
  assert.deepEqual(SOURCES, ["claude-code", "codex", "pi", "opencode", "copilot", "cursor"]);
  for (const source of SOURCES) {
    const reader = READERS[source];
    assert.equal(reader.source, source);
    assert.equal(HARNESS_OF[source], reader.harness);
    assert.equal(SOURCE_NAMES[source], reader.name);
    assert.equal(typeof reader.discover, "function");
    assert.equal(typeof reader.read, "function");
  }
});

test("an OpenCode home: a database session's key is the sha256 of relpath#id, a storage session's of its file", async (t) => {
  const dir = await tempHome(t);
  const data = join(dir, ".local", "share", "opencode");
  await buildV2(join(data, "opencode.db"));
  await buildLegacy(join(data, "storage"));
  const result = run(dir, "--sources", "opencode", "--known-answer");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const db = (id) => sha(`.local/share/opencode/opencode.db#${id}`);
  const tokens = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, cacheWrite1h: 0 });
  // Worked out by hand in fixtures/opencode/fixture.mjs. ses_B is ses_A's subagent: one line, both.
  const expected = [
    { key: db("ses_C"), source: "opencode", tokens: tokens(255, 144, 2070, 20), cost: 0.875, turns: 2, calls: 3 },
    { key: db("ses_D"), source: "opencode", tokens: tokens(7, 3), cost: 0, turns: 1, calls: 1 },
    { key: db("ses_F"), source: "opencode", tokens: tokens(1, 1), cost: 0.03125, turns: 0, calls: 1 },
    { key: db("ses_K"), source: "opencode", tokens: tokens(18, 5), cost: 0.9375, turns: 1, calls: 4 },
    // The storage's OpenCode (0.15.0) wrote output with its reasoning in it: prt_A2d's 20, not 20 + 5.
    { key: sha(".local/share/opencode/storage/session/prj_fixture/ses_A.json"), source: "opencode", tokens: tokens(240, 375, 1100, 200), cost: 0.9375, turns: 2, calls: 4 },
  ].sort((a, b) => (a.key < b.key ? -1 : 1));
  assert.deepEqual(lines, expected);
  for (const leak of ["ses_", "Port the reader", "/fixture/", dir]) assert.ok(!result.stdout.includes(leak), `prints ${leak}`);
});

test("pi-ai, which the bin imports statically, is a dependency of the package: npx runs the bin with no install of its own", async () => {
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.dependencies?.["@earendil-works/pi-ai"], "a dependency");
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-ai"], undefined, "not a peer");
});
