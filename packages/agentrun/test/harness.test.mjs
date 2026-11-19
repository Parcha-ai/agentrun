// `agentrun harness install goose`: the owner's install of Goose into the server's data (`<data>/harnesses/goose`), by the
// installed server's own installer (agentrun-serve install-harness, serve's harness-archive.ts). By name it installs Goose
// alone; a rerun with the pinned binary already in place downloads nothing and says so. `--recipe FILE` installs a recipe's
// release, and `agentrun harness-check --recipe FILE` checks it (serve's harness-recipe.ts and harness-check.ts): a recipe
// that breaks one of the five rules is refused by its code before anything is downloaded.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("agentrun harness install --recipe and agentrun harness-check: a recipe that breaks a rule is refused by its code, and nothing is installed", (t) => {
  const dir = home(t);
  const data = join(dir, "data");
  const recipe = join(dir, "recipe.json");
  writeFileSync(recipe, JSON.stringify({ id: "my-agent", label: "My Agent", install: "curl -fsSL https://example.invalid/install.sh | sh" }));
  const install = agentrun(["harness", "install", "--recipe", recipe, "--data", data], dir);
  assert.equal(install.status, 1, install.stderr);
  assert.match(install.stderr, /^RECIPE_INSTALLS_ITSELF: /);
  const both = agentrun(["harness", "install", "goose", "--recipe", recipe, "--data", data], dir);
  assert.equal(both.status, 2, both.stderr);
  const report = join(dir, "report.json");
  const check = agentrun(["harness-check", "--recipe", recipe, "--data", data, "--report", report], dir);
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stdout, /harness-check: refused: RECIPE_INSTALLS_ITSELF/);
  assert.equal(JSON.parse(readFileSync(report, "utf8")).refused.code, "RECIPE_INSTALLS_ITSELF");
  assert.equal(existsSync(join(data, "harnesses")), false, "nothing installed");
  const bare = agentrun(["harness-check"], dir);
  assert.equal(bare.status, 2, bare.stderr);
  assert.match(bare.stderr, /--recipe FILE/);
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
