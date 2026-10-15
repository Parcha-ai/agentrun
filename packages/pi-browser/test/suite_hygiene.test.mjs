import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { processesNaming, scratch } from "./fixtures/scratch.mjs";

const fixture = (name) => path.join(import.meta.dirname, "fixtures", name);
const until = async (check, ms) => {
  for (const end = Date.now() + ms; !check(); await new Promise((resolve) => setTimeout(resolve, 50))) if (Date.now() > end) return false;
  return true;
};

const KILLS = {
  "the runner's SIGINT": ({ runner }) => process.kill(runner, "SIGINT"),
  "the runner's SIGTERM": ({ runner }) => process.kill(runner, "SIGTERM"),
  "a SIGKILL to the test file's process": ({ file }) => process.kill(file, "SIGKILL"),
  "a SIGKILL to the runner's whole process group": ({ runner }) => process.kill(-runner, "SIGKILL"),
};

async function killMidSuite(t, kill, chrome, slowReport = false) {
  const ready = path.join(await scratch(t, "hygiene-"), "ready.json");
  // A run() that inherits this file's NODE_TEST_CONTEXT takes itself for a nested call and runs no file.
  const { NODE_TEST_CONTEXT: _, ...outer } = process.env;
  const env = { ...outer, VICTIM_READY: ready, ...(chrome ? { VICTIM_CHROME: CHROME } : {}), ...(slowReport ? { VICTIM_SLOW_REPORT_MS: "1500" } : {}) };
  const runner = spawn(process.execPath, [fixture("hygiene-runner.mjs"), fixture("hygiene-victim.mjs"), path.join(import.meta.dirname, "preload.mjs")], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { try { process.kill(-runner.pid, "SIGKILL"); } catch {} });
  let stderr = "", exited = false;
  runner.stderr.on("data", (chunk) => { stderr += chunk; });
  runner.once("exit", () => { exited = true; });
  await until(() => fs.existsSync(ready) || exited, 60_000);
  assert.ok(fs.existsSync(ready), `the killed suite never got its child host (and Chrome) up${exited ? ", its runner exited" : ""}: ${stderr.slice(0, 2_000)}`);
  const victim = JSON.parse(fs.readFileSync(ready, "utf8"));
  const held = processesNaming(victim.root);
  assert.ok(held.some((p) => p.pid === victim.host), "the child host runs under the suite file's TMPDIR");
  if (chrome) assert.ok(held.some((p) => p.cmd.includes("--user-data-dir=")), "a Chrome runs under the suite file's TMPDIR");

  kill({ runner: runner.pid, file: victim.pid });
  const clean = await until(() => !fs.existsSync(victim.root) && processesNaming(victim.root).length === 0, 20_000);
  assert.ok(clean, `left behind: ${JSON.stringify({ root: fs.existsSync(victim.root) ? fs.readdirSync(victim.root) : null, processes: processesNaming(victim.root).map((p) => `${p.pid} ${p.cmd.slice(0, 120)}`) })}`);
}

const LINUX = process.platform === "linux" ? false : "child hosts are found by their environment, which is read from /proc";
for (const [how, kill] of Object.entries(KILLS)) {
  test(`a suite killed by ${how} leaves no process and no directory under its TMPDIR`, { skip: LINUX, timeout: 120_000 }, (t) => killMidSuite(t, kill, false));
  test(`a suite holding a real Chrome, killed by ${how}, leaves no Chrome and no directory under its TMPDIR`, { skip: LINUX || NO_CHROME, timeout: 120_000 }, (t) => killMidSuite(t, kill, true));
}
test("a killed suite's ready report is read only once it is whole, however slowly it is written", { skip: LINUX, timeout: 120_000 }, (t) => killMidSuite(t, KILLS["a SIGKILL to the test file's process"], false, true));

test("the victim refuses to start without VICTIM_READY, and writes nothing", async (t) => {
  // A plain `node --test` over the package runs every file under test/, this fixture included.
  const cwd = await scratch(t, "hygiene-unset-");
  const { VICTIM_READY: _ready, NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const run = spawnSync(process.execPath, [fixture("hygiene-victim.mjs")], { cwd, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 2, `exit ${run.status}, signal ${run.signal}: ${run.stderr.slice(0, 2_000)}`);
  assert.match(run.stderr, /VICTIM_READY/);
  assert.deepEqual(fs.readdirSync(cwd), [], "nothing written where it ran");
});

test("a scratch directory is removed after every other cleanup its test registered, failed or not", async (t) => {
  for (const fails of [false, true]) {
    let dir, seen;
    await t.test(fails ? "a failing test" : "a passing test", fails ? { todo: "throws on purpose" } : {}, async (inner) => {
      dir = await scratch(inner, "order-");
      inner.after(() => { seen = fs.existsSync(dir); });
      if (fails) throw new Error("on purpose");
    });
    assert.equal(seen, true, "the later cleanup still found the directory");
    assert.equal(fs.existsSync(dir), false, "the directory is gone once its test ended");
  }
});

test("a test file's TMPDIR leaves Chrome room for its singleton socket", () => {
  assert.ok(process.env.TMPDIR, "TMPDIR is unset: run this file through the package's preload (--import ./test/preload.mjs), as scripts/test.mjs does, which gives the file a short private TMPDIR");
  const socket = path.join(process.env.TMPDIR, "org.chromium.Chromium.XXXXXX", "SingletonSocket");
  assert.ok(Buffer.byteLength(socket) <= 107, `Chrome aborts when its singleton socket path passes 107 bytes: ${socket}`);
});
