// What a first-use install (harness-install.ts npmInstall) does with what it cannot remove. Removing an earlier install's
// leftovers, and the install it replaces, is housekeeping: the new install works in a fresh directory of its own, so
//   - a leftover beside the install that cannot be removed now (one an orphaned npm of a crashed server still writes
//     into, or one with a folder that can't be read) never fails the install: it stays for a later sweep;
//   - the install it replaces, gone aside once the new one is in place, never fails the install when it can't be removed;
//   - a failed install's own staging that can't be removed never hides why it failed;
//   - a leftover the install could not remove is swept by the next look at the installed harness (HarnessInstall's
//     needed or ensure, a server's start), once nothing writes into it: no install runs again until the pin changes, so
//     only that look makes the later sweep come. Never while another process holds the install.
// npm here is a script of the test's (npm_execpath), which writes the package into the staging directory it is given.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeAgentExecutable } from "@parcha/agentrun-harness-claude";
import { serve } from "./support.mjs";

const { HarnessInstall, installHoldOf, npmInstall, pidNamespace, processIdentity, releaseHold } = await import("../dist/harness-install.js");

const PACKAGE = "probe-harness";
const VERSION = "1.0.0";
// A folder its owner can't read stops nothing for root: those cases need another user.
const root = process.getuid?.() === 0 && "run as root, every folder can be read";

/** Every folder under `dir` made readable and writable again, so the test's own cleanup removes it. */
function unlock(dir) {
  const walk = (path) => {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st || !st.isDirectory()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(dir);
}

/** A scratch directory with the install's lock and package.json, an npm script that installs (or fails, saying why, and
 *  leaves a folder it can't read in its staging), and the entry an install checks: the package's file in place. */
function setup(t, name) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `harness-install-sweep-${name}-`));
  t.after(() => (unlock(dir), rmSync(dir, { recursive: true, force: true })));
  const locks = join(dir, "locks");
  mkdirSync(locks);
  writeFileSync(join(locks, "package.json"), JSON.stringify({ name: "harness", private: true, dependencies: { [PACKAGE]: VERSION } }));
  const lock = join(locks, "package-lock.json");
  writeFileSync(lock, JSON.stringify({ name: "harness", lockfileVersion: 3, packages: { "": { dependencies: { [PACKAGE]: VERSION } } } }));
  const npm = (file, body) => {
    const path = join(dir, file);
    writeFileSync(path, `const fs = require("node:fs"); const path = require("node:path");
const staging = process.argv[process.argv.indexOf("--prefix") + 1];
${body}`);
    return path;
  };
  const installs = npm("npm-installs.js", `const home = path.join(staging, "node_modules", ${JSON.stringify(PACKAGE)});
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ name: ${JSON.stringify(PACKAGE)}, version: ${JSON.stringify(VERSION)} }));`);
  const fails = npm("npm-fails.js", `const locked = path.join(staging, "node_modules", "half-written");
fs.mkdirSync(path.join(locked, "inside"), { recursive: true });
fs.chmodSync(locked, 0o300);
console.error("npm error 404 the registry has no such tarball");
process.exit(1);`);
  const entry = {
    id: "probe",
    label: "Probe",
    package: PACKAGE,
    lock,
    lacking: (at) => (existsSync(join(at, "node_modules", PACKAGE, "package.json")) ? undefined : `${PACKAGE}'s package.json`),
  };
  const harnesses = join(dir, "data", "harnesses");
  mkdirSync(harnesses, { recursive: true });
  return { dir, entry, install: join(harnesses, "probe"), harnesses, env: (script) => ({ PATH: process.env.PATH, npm_execpath: script }), installs, fails };
}

const installed = (install) => JSON.parse(readFileSync(join(install, "node_modules", PACKAGE, "package.json"), "utf8")).version;

test("a leftover beside the install that an orphaned npm still writes into never fails the install: it goes on in its own fresh directory", { timeout: 60_000 }, async (t) => {
  const { entry, install, harnesses, env, installs } = setup(t, "writer");
  // A crashed server's npm, orphaned: it keeps writing into its own staging directory beside the install while the next
  // server's install sweeps that directory (a few files each millisecond, as npm unpacking tarballs does).
  const leftover = join(harnesses, ".probe-crashed");
  mkdirSync(leftover);
  for (let i = 0; i < 2_000; i++) writeFileSync(join(leftover, `early-${i}`), "");
  const writer = spawn(process.execPath, ["-e", `const fs = require("node:fs"); const dir = process.argv[1];
let i = 0;
const parent = process.ppid;
// This test's own writer ends with the test process, whatever ends it.
setInterval(() => { if (process.ppid !== parent) process.exit(0); for (let k = 0; k < 3; k++) try { fs.writeFileSync(dir + "/late-" + i++, ""); } catch {} }, 1);
process.stdout.write("writing\\n");`, leftover], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => writer.kill("SIGKILL"));
  const gone = new Promise((resolve) => writer.once("exit", resolve));
  t.after(() => gone);
  await new Promise((resolve) => writer.stdout.once("data", resolve));
  await npmInstall(entry, install, { version: VERSION, platform: "any" }, { env: env(installs) });
  assert.equal(installed(install), VERSION, "the harness is in place");
  writer.kill("SIGKILL");
  await gone;
});

test("a leftover beside the install that can't be removed now never fails the install, and stays for a later sweep", { skip: root }, async (t) => {
  const { entry, install, harnesses, env, installs } = setup(t, "unreadable");
  // An earlier install cut short, with a folder in it that can't be read: the sweep can't walk or remove it.
  const leftover = join(harnesses, ".probe-cut-short");
  mkdirSync(join(leftover, "node_modules", "locked", "inside"), { recursive: true });
  chmodSync(join(leftover, "node_modules", "locked"), 0o300);
  // And one that can: it goes.
  const removable = join(harnesses, ".probe-removable");
  mkdirSync(join(removable, "node_modules"), { recursive: true });
  await npmInstall(entry, install, { version: VERSION, platform: "any" }, { env: env(installs) });
  assert.equal(installed(install), VERSION, "the harness is in place");
  assert.equal(existsSync(removable), false, "a leftover that can be removed is");
  assert.equal(existsSync(leftover), true, "the one that can't stays, for a later sweep");
  assert.deepEqual(readdirSync(harnesses).sort(), [".probe-cut-short", "probe"], "nothing else is left beside the install");
});

test("the install it replaces, which can't be removed once the new one is in place, never fails the install", { skip: root }, async (t) => {
  const { entry, install, harnesses, env, installs } = setup(t, "old");
  // What was there: an install by hand, with a folder in it that can't be read.
  mkdirSync(join(install, "node_modules", "locked", "inside"), { recursive: true });
  chmodSync(join(install, "node_modules", "locked"), 0o300);
  await npmInstall(entry, install, { version: VERSION, platform: "any" }, { env: env(installs) });
  assert.equal(installed(install), VERSION, "the new harness is in place");
  assert.equal(existsSync(join(install, "node_modules", "locked")), false, "the old one is out of the way");
  const aside = readdirSync(harnesses).filter((name) => name !== "probe");
  assert.equal(aside.length, 1, `the old one stays aside, for a later sweep: ${aside}`);
  assert.match(aside[0], /^\.probe-.+-old$/);
});

test("a failed install whose staging can't be removed says why npm failed, never why the staging stayed", { skip: root }, async (t) => {
  const { entry, install, env, fails } = setup(t, "hidden");
  await assert.rejects(npmInstall(entry, install, { version: VERSION, platform: "any" }, { env: env(fails) }), (error) => {
    assert.equal(error.code, "HARNESS_NOT_INSTALLED");
    assert.match(error.message, /npm exited 1: npm error 404 the registry has no such tarball/, error.message);
    return true;
  });
  assert.equal(existsSync(install), false, "nothing in place");
});

// ---- the later sweep: the next look at the installed harness ------------------------------------------------------------

const PINS = { version: VERSION, platform: "any" };
/** A server's installer of the test's harness into `install`, by npmInstall with the test's npm. */
const installer = (entry, install, env) => new HarnessInstall(entry, install, async () => PINS, (entry, dir, pins, signal) => npmInstall(entry, dir, pins, { signal, env }));

/** Resolves once `done()` is true; the bound caps the wait, it never orders anything. */
const until = async (done, what, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A crashed server's npm, orphaned, writing into its staging directory `dir` (a few files each millisecond, the
 *  directory made again when it is gone, as npm unpacking tarballs does), until `stop()`. */
async function orphanedNpm(t, dir) {
  const writer = spawn(process.execPath, ["-e", `const fs = require("node:fs"); const dir = process.argv[1];
let i = 0;
const parent = process.ppid;
// This test's own writer ends with the test process, whatever ends it.
setInterval(() => { if (process.ppid !== parent) process.exit(0); try { fs.mkdirSync(dir, { recursive: true }); for (let k = 0; k < 3; k++) fs.writeFileSync(dir + "/late-" + i++, ""); } catch {} }, 1);
process.stdout.write("writing\\n");`, dir], { stdio: ["ignore", "pipe", "inherit"] });
  const gone = new Promise((resolve) => writer.once("exit", resolve));
  t.after(() => (writer.kill("SIGKILL"), gone));
  await new Promise((resolve) => writer.stdout.once("data", resolve));
  return { stop: () => (writer.kill("SIGKILL"), gone) };
}

test("a leftover the install could not remove, its orphaned npm still writing, is swept by a later look at the installed harness once that npm has stopped", { timeout: 60_000 }, async (t) => {
  const { entry, install, harnesses, env, installs } = setup(t, "later");
  const leftover = join(harnesses, ".probe-crashed");
  mkdirSync(leftover);
  for (let i = 0; i < 2_000; i++) writeFileSync(join(leftover, `early-${i}`), "");
  const npm = await orphanedNpm(t, leftover);
  const first = installer(entry, install, env(installs));
  t.after(() => first.stop());
  await first.ensure();
  assert.equal(installed(install), VERSION, "the harness is in place");
  await npm.stop();
  assert.ok(existsSync(leftover), "the leftover is still there: its npm wrote on through the install's sweep");
  // No install runs again (the harness is in); the next server on this data looks at it.
  const later = installer(entry, install, env(installs));
  t.after(() => later.stop());
  assert.equal(await later.needed(), false, "installed: no run waits");
  await until(() => !existsSync(leftover), "the leftover gone after the later look");
  assert.deepEqual(readdirSync(harnesses), ["probe"], "nothing is left beside the install");
});

test("a leftover is never swept while another process holds the install; once it lets go, the next look sweeps it", { timeout: 60_000 }, async (t) => {
  const { entry, install, harnesses, env, installs } = setup(t, "held");
  await npmInstall(entry, install, PINS, { env: env(installs) });
  // Another process's install under way: its hold (its pid alive) and its staging directory beside the install.
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const otherGone = new Promise((resolve) => other.once("exit", resolve));
  t.after(() => (other.kill("SIGKILL"), otherGone));
  await new Promise((resolve) => other.once("spawn", resolve));
  const [identity, pidns] = [processIdentity(other.pid), pidNamespace()];
  writeFileSync(installHoldOf(install), JSON.stringify({ host: hostname(), ...(pidns ? { pidns } : {}), pid: other.pid, ...(identity ? { identity } : {}), startedAt: Date.now(), token: "other" }));
  const staging = join(harnesses, ".probe-other");
  mkdirSync(join(staging, "node_modules"), { recursive: true });
  for (const [how, look] of [["needed", (one) => one.needed()], ["ensure", (one) => one.ensure()]]) {
    const one = installer(entry, install, env(installs));
    await look(one);
    // Its close waits for any sweep it started.
    await one.stop();
    assert.ok(existsSync(staging), `${how}: the other install's staging stays while it holds the install`);
  }
  await releaseHold(install, "other");
  const later = installer(entry, install, env(installs));
  t.after(() => later.stop());
  await later.ensure();
  await until(() => !existsSync(staging), "the leftover gone after the look once the hold was let go");
  assert.deepEqual(readdirSync(harnesses), ["probe"], "nothing is left beside the install");
});

test("a server's start sweeps what an earlier install left beside a harness it finds installed", { timeout: 120_000, skip: !claudeAgentExecutable() && "no Claude Code CLI here to install" }, async (t) => {
  const first = await serve(t, { harnesses: true, runner: false });
  await first.stop();
  // What a crashed server's install left beside Claude Code, which that npm went on writing after the next install.
  const leftover = join(first.data, "harnesses", ".claude-agent-crashed");
  mkdirSync(join(leftover, "node_modules"), { recursive: true });
  writeFileSync(join(leftover, "node_modules", "half-written"), "");
  await serve(t, { data: first.data, runner: false });
  await until(() => !existsSync(leftover), "the leftover gone after the server's start");
});
