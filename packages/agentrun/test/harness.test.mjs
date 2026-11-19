// `agentrun harness install goose`: the owner's install of Goose into the server's data (`<data>/harnesses/goose`), by the
// installed server's own installer (agentrun-serve install-harness, serve's harness-archive.ts). It installs Goose alone;
// a rerun with the pinned binary already in place downloads nothing and says so.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const GOOSE = process.env.AGENTRUN_TEST_GOOSE;

/** This test's environment: no key, and a dead proxy, so a download that was tried fails rather than leaving this machine. */
const envOf = (home) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTRUN_|ANTHROPIC_|OPENAI_|OPENROUTER_)/.test(name))),
  HOME: home,
  XDG_DATA_HOME: join(home, ".local", "share"),
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
});
const agentrun = (args, home) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: envOf(home), timeout: 60_000 });

function home(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-harness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("agentrun harness install names the harness it installs: goose alone", (t) => {
  const dir = home(t);
  const none = agentrun(["harness", "install"], dir);
  assert.equal(none.status, 2, none.stderr);
  const other = agentrun(["harness", "install", "codex"], dir);
  assert.equal(other.status, 2, other.stderr);
  assert.match(other.stderr, /goose/);
  assert.match(other.stderr, /codex/);
  const help = agentrun(["help", "harness"], dir);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /install/);
});

test("a rerun with the pinned Goose in place is a no-op: nothing is downloaded, and it says so", { skip: GOOSE ? false : "AGENTRUN_TEST_GOOSE is not set: it names the Goose 1.59.2 binary this test runs" }, (t) => {
  const dir = home(t);
  const data = join(dir, "data");
  mkdirSync(join(data, "harnesses", "goose"), { recursive: true });
  symlinkSync(GOOSE, join(data, "harnesses", "goose", "goose"));
  const done = agentrun(["harness", "install", "goose", "--data", data], dir);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Goose 1\.59\.2 is installed/);
  assert.match(done.stdout, /already/);
});
