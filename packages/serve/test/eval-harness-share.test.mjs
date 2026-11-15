// Local template evals share one install of each harness's pin (harness-install.ts sharedInstaller, which template-eval.ts
// hands its scratch server and the runner beside it): the first eval installs it under a root of its own, and every eval
// after it, each on a data directory of its own, gets a link to that install, never a copy. The install's own checks
// (the entry's `lacking`) take the link as it is. A stand-in install, no npm and no network.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { PINS, standIn } from "./fixtures/eval-harness-stand-in.mjs";
import { scratch } from "./support.mjs";

const { claimInstallsStopped, HARNESS_INSTALLS, HarnessInstall, installDirOf, installForClaim, sharedInstaller } = await import("../dist/harness-install.js");

const CLAUDE = HARNESS_INSTALLS["claude-agent"];
const STAND_IN = new URL("./fixtures/eval-harness-stand-in.mjs", import.meta.url).pathname;

/** The regular files under `dir`, no link followed. */
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((one) => (one.isDirectory() ? filesUnder(join(dir, one.name)) : one.isFile() ? [join(dir, one.name)] : []));

/** One local eval's server, as startServe makes its first-use install of Claude Code on `data` with the eval's installer. */
const evalServer = (data, installer) => new HarnessInstall(CLAUDE, installDirOf(data, CLAUDE.id), async () => PINS, installer);

test("two local evals in a row install Claude Code once: the second's data holds a link to that install, no copy", async (t) => {
  const [root, first, second] = [await scratch(t), await scratch(t), await scratch(t)];
  const { installs, install } = standIn();
  const shared = installDirOf(root, `${CLAUDE.id}@${PINS.version}-${PINS.platform}`);
  for (const data of [first, second]) {
    await evalServer(data, sharedInstaller(root, install)).ensure();
    const dir = installDirOf(data, CLAUDE.id);
    assert.equal(CLAUDE.lacking(dir, PINS), undefined, "the install's own check takes the eval's harness as whole");
    assert.ok(lstatSync(dir).isSymbolicLink(), "the eval's harness is a link");
    assert.equal(realpathSync(dir), realpathSync(shared), "to the one shared install");
    assert.deepEqual(filesUnder(data), [], "the eval's data holds no file of the install");
  }
  assert.deepEqual(installs, [shared], "installed once, into the shared root");
});

test("two local evals at once install once, and neither reads the install before it is whole", async (t) => {
  const [root, first, second] = [await scratch(t), await scratch(t), await scratch(t)];
  const { installs, install } = standIn(300);
  await Promise.all([first, second].map((data) => evalServer(data, sharedInstaller(root, install)).ensure()));
  assert.equal(installs.length, 1, "one install for both");
  for (const data of [first, second]) assert.equal(CLAUDE.lacking(installDirOf(data, CLAUDE.id), PINS), undefined, "each eval's harness is whole once its install resolves");
});

test("two evals started at once, each in a process of its own, share one install by the server's own hold, and both are whole", async (t) => {
  const [root, first, second, logs] = [await scratch(t), await scratch(t), await scratch(t), await scratch(t)];
  const log = join(logs, "installs.log");
  writeFileSync(log, "");
  const run = (data) => promisify(execFile)(process.execPath, [STAND_IN, root, data, log, "1500"]);
  const said = await Promise.all([first, second].map(run));
  assert.deepEqual(said.map((one) => one.stdout.trim()), ["whole", "whole"]);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [installDirOf(root, `${CLAUDE.id}@${PINS.version}-${PINS.platform}`)], "one install, into the shared root");
});

test("what an install cut short left beside the shared install is swept by the next eval, under the install's hold", async (t) => {
  const [root, first, second] = [await scratch(t), await scratch(t), await scratch(t)];
  const { installs, install } = standIn();
  await evalServer(first, sharedInstaller(root, install)).ensure();
  // An eval killed while npm wrote its staging directory beside the shared install.
  const left = join(root, "harnesses", `.${CLAUDE.id}@${PINS.version}-${PINS.platform}-cut`);
  mkdirSync(join(left, "node_modules"), { recursive: true });
  writeFileSync(join(left, "node_modules", "half"), "");
  await evalServer(second, sharedInstaller(root, install)).ensure();
  await claimInstallsStopped();
  assert.equal(installs.length, 1, "nothing installed again");
  assert.ok(!existsSync(left), "the leftover is swept");
});

test("a shared root another user could write to is never read: the eval installs into its own data, as before", async (t) => {
  const [root, data] = [await scratch(t), await scratch(t)];
  // A tree that passes `lacking`, planted where the shared install would be, in a root anyone may write to.
  const planted = standIn();
  await planted.install(CLAUDE, installDirOf(root, `${CLAUDE.id}@${PINS.version}-${PINS.platform}`), PINS);
  chmodSync(root, 0o777);
  const { installs, install } = standIn();
  await evalServer(data, sharedInstaller(root, install)).ensure();
  const dir = installDirOf(data, CLAUDE.id);
  assert.deepEqual(installs, [dir], "installed into the eval's own data");
  assert.ok(!lstatSync(dir).isSymbolicLink(), "no link to the planted tree");
});

test("a relative root links to where the install is", async (t) => {
  const [base, data] = [await scratch(t), await scratch(t)];
  const { installs, install } = standIn();
  const cwd = process.cwd();
  process.chdir(base);
  t.after(() => process.chdir(cwd));
  await evalServer(data, sharedInstaller("evals", install)).ensure();
  const dir = installDirOf(data, CLAUDE.id);
  assert.equal(installs.length, 1);
  assert.equal(realpathSync(dir), realpathSync(installDirOf(join(base, "evals"), `${CLAUDE.id}@${PINS.version}-${PINS.platform}`)));
  assert.equal(CLAUDE.lacking(dir, PINS), undefined);
});

test("a run's claim on an eval's data with no install yet links the shared one, which an eval before it installed", async (t) => {
  const [root, first, second] = [await scratch(t), await scratch(t), await scratch(t)];
  const { installs, install } = standIn();
  const installer = sharedInstaller(root, install);
  await evalServer(first, installer).ensure();
  // The runner beside the eval's server installs for a claim through installForClaim, given the same installer.
  const dir = installDirOf(second, CLAUDE.id);
  await installForClaim(CLAUDE, dir, async () => PINS, { install: installer });
  await claimInstallsStopped();
  assert.equal(installs.length, 1, "the claim installed nothing");
  assert.ok(lstatSync(dir).isSymbolicLink(), "the claim's harness is a link");
  assert.equal(CLAUDE.lacking(dir, PINS), undefined);
});
