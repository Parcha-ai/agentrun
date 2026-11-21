// What a first-use install's checks read of the tree on disk, in a process that lives on across installs (a runner), and
// the one hold that keeps installs on one data one at a time (harness-install.ts):
//   - inTree reads the tree as it is now: a package linked into the tree, then replaced by an install at the same path, is
//     the install's, not the link's old target (Node's own resolver keeps that target for the life of the process);
//   - it answers as Node's resolver does, for the packages an install checks;
//   - a hold that cannot be read is held while it is young and taken over once it is old, never an error;
//   - takers over one stale hold: one holds it; a release lets go of its own hold alone.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const { inTree, installHoldOf, pidNamespace, processIdentity, releaseHold, takeHold } = await import("../dist/harness-install.js");

const scratch = (t, name) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `harness-install-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A package `name` at `dir`: an ESM module whose index says `said`. */
function pkg(dir, name, said) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }));
  writeFileSync(join(dir, "index.js"), `export const said = ${JSON.stringify(said)};\n`);
}

test("a package linked into the tree, then replaced at the same path by an install, is read from the install: never the link's old target", (t) => {
  const root = scratch(t, "relink");
  const elsewhere = join(root, "elsewhere", "probe");
  pkg(elsewhere, "probe", "linked");
  const tree = join(root, "tree");
  const home = join(tree, "node_modules", "probe");
  mkdirSync(dirname(home), { recursive: true });
  symlinkSync(elsewhere, home);
  // Linked: it counts by where its link points, and that is in its package.
  assert.equal(inTree(tree, "probe"), realpathSync(join(elsewhere, "index.js")), "the linked package counts by where its link points");
  // The install: a whole package in place of the link, at the same path.
  const staging = join(tree, "node_modules", ".probe-new");
  pkg(staging, "probe", "installed");
  unlinkSync(home);
  renameSync(staging, home);
  assert.equal(inTree(tree, "probe"), realpathSync(join(home, "index.js")), "read as it is now: the install's own file");
});

test("inTree answers as Node's resolver does for the packages an install checks: the SDK, and the MCP library's server and types", () => {
  // The repository's own tree holds both, never read before in this process.
  const repo = new URL("../../../", import.meta.url).pathname;
  const node = createRequire(join(repo, "package.json"));
  for (const specifier of ["@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk/types.js"]) {
    assert.equal(inTree(repo, specifier), realpathSync(node.resolve(specifier)), specifier);
  }
  assert.equal(inTree(repo, "@modelcontextprotocol/sdk/not-exported.js"), undefined, "a subpath the package does not export");
  assert.equal(inTree(repo, "not-a-package-here"), undefined, "a package not in the tree");
});

test("a package of the tree whose file resolves outside its own folder does not count", (t) => {
  const tree = scratch(t, "outside");
  const home = join(tree, "node_modules", "escapes");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "escapes", version: "1.0.0", main: "index.js" }));
  // Its entry a link to a file elsewhere: what the import would load is not this package's.
  writeFileSync(join(tree, "elsewhere.js"), "module.exports = 1;\n");
  symlinkSync(join(tree, "elsewhere.js"), join(home, "index.js"));
  assert.equal(inTree(tree, "escapes"), undefined);
});

test("a hold that cannot be read is held while it is young, and taken over once it is old: never an error", async (t) => {
  const dir = join(scratch(t, "hold-unread"), "harnesses", "fake");
  mkdirSync(dirname(installHoldOf(dir)), { recursive: true });
  writeFileSync(installHoldOf(dir), "");
  assert.equal(await takeHold(dir), undefined, "young: its installer may still be writing it");
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(installHoldOf(dir), old, old);
  const token = await takeHold(dir);
  assert.equal(typeof token, "string", "old: taken over");
  assert.equal(JSON.parse(readFileSync(installHoldOf(dir), "utf8")).token, token, "the hold is this taker's, written whole");
});

test("takers over one stale hold: exactly one holds it, and the hold left is its; a release lets go of its own hold alone", async (t) => {
  const dir = join(scratch(t, "hold-race"), "harnesses", "fake");
  mkdirSync(dirname(installHoldOf(dir)), { recursive: true });
  // A hold its installer left: a process of this host that is gone (pid 1 here). The takers are this process, which lives:
  // a taker's fresh hold is its live installer's, never one left (a liveness that read every pid gone would have a later
  // taker reap the winner's hold, as left, and both hold it).
  const left = () => writeFileSync(installHoldOf(dir), JSON.stringify({ host: "this-host", pid: 1, startedAt: Date.now(), token: "left" }));
  const gone = { host: "this-host", isAlive: (pid) => pid !== 1 };
  for (let round = 0; round < 10; round++) {
    left();
    const tokens = (await Promise.all(Array.from({ length: 8 }, () => takeHold(dir, gone)))).filter(Boolean);
    assert.equal(tokens.length, 1, `round ${round}: one taker holds it: ${tokens}`);
    assert.equal(JSON.parse(readFileSync(installHoldOf(dir), "utf8")).token, tokens[0], `round ${round}: the hold is the one taker's`);
    await releaseHold(dir, "another's token");
    assert.equal(JSON.parse(readFileSync(installHoldOf(dir), "utf8")).token, tokens[0], "another's release leaves it");
    await releaseHold(dir, tokens[0]);
    assert.throws(() => readFileSync(installHoldOf(dir)), { code: "ENOENT" }, "its own release lets it go");
  }
});

test("a taker's fresh hold is never taken over by a later taker while its installer lives: one look after another, one holds it", async (t) => {
  const dir = join(scratch(t, "hold-after"), "harnesses", "fake");
  mkdirSync(dirname(installHoldOf(dir)), { recursive: true });
  writeFileSync(installHoldOf(dir), JSON.stringify({ host: "this-host", pid: 1, startedAt: Date.now(), token: "left" }));
  const taker = { host: "this-host", isAlive: (pid) => pid !== 1 };
  const first = await takeHold(dir, taker);
  assert.equal(typeof first, "string", "the left hold is taken over");
  assert.equal(await takeHold(dir, taker), undefined, "a later look finds the first taker's live hold: held");
  assert.equal(JSON.parse(readFileSync(installHoldOf(dir), "utf8")).token, first);
});

test("a hold whose installer on this host is still alive is held past the install's timeout: only its stop lets another install start", async (t) => {
  const dir = join(scratch(t, "hold-overdue"), "harnesses", "fake");
  mkdirSync(dirname(installHoldOf(dir)), { recursive: true });
  // An install started long ago, its npm still running (killed at its own timeout, then given its grace to exit): the
  // process that wrote the hold, by its pid and its identity (its boot and start), is still the one with that pid.
  const overdue = Date.now() - 60 * 60_000;
  writeFileSync(installHoldOf(dir), JSON.stringify({ host: "this-host", pid: 4242, identity: "boot-1:100", startedAt: overdue, token: "running" }));
  assert.equal(await takeHold(dir, { host: "this-host", isAlive: () => true, identity: () => "boot-1:100" }), undefined, "its installer is alive: held");
  assert.equal(JSON.parse(readFileSync(installHoldOf(dir), "utf8")).token, "running", "the hold is still its installer's");
  // Another host's installer can't be asked: past the bound (the timeout and npm's stop), its hold is taken over.
  const token = await takeHold(dir, { host: "another-host", isAlive: () => assert.fail("another host's process is never asked") });
  assert.equal(typeof token, "string", "another host's hold past the bound: taken over");
});

test("a hold whose pid now belongs to another process (a restarted container's) is taken over: the pid alone never keeps it", async (t) => {
  const dir = join(scratch(t, "hold-reused"), "harnesses", "fake");
  mkdirSync(dirname(installHoldOf(dir)), { recursive: true });
  writeFileSync(installHoldOf(dir), JSON.stringify({ host: "this-host", pid: 4242, identity: "boot-1:100", startedAt: Date.now(), token: "killed" }));
  // pid 4242 is alive, but started at another time: not the installer that wrote the hold.
  const token = await takeHold(dir, { host: "this-host", isAlive: () => true, identity: () => "boot-1:900" });
  assert.equal(typeof token, "string", "its pid reused: taken over at once");
  assert.equal(JSON.parse(readFileSync(installHoldOf(dir), "utf8")).token, token);
});

test("a hold that names no identity, or whose installer's can't be read, is held while its pid lives within the install's bound, then taken over", async (t) => {
  const dir = join(scratch(t, "hold-no-identity"), "harnesses", "fake");
  mkdirSync(dirname(installHoldOf(dir)), { recursive: true });
  const hold = (startedAt) => writeFileSync(installHoldOf(dir), JSON.stringify({ host: "this-host", pid: 4242, startedAt, token: "old" }));
  const taker = { host: "this-host", isAlive: () => true, identity: () => undefined };
  hold(Date.now());
  assert.equal(await takeHold(dir, taker), undefined, "young, its pid alive: held");
  hold(Date.now() - 60 * 60_000);
  assert.equal(typeof (await takeHold(dir, taker)), "string", "past the bound: taken over, so a reused pid never holds it for good");
});

test("a hold from another pid namespace on the same hostname (another container on the same data) is never judged by this one's process table: held within the install's bound", async (t) => {
  const dir = join(scratch(t, "hold-namespace"), "harnesses", "fake");
  mkdirSync(dirname(installHoldOf(dir)), { recursive: true });
  writeFileSync(installHoldOf(dir), JSON.stringify({ host: "this-host", pidns: "pid:[1]", pid: 4242, identity: "boot-1:100", startedAt: Date.now(), token: "theirs" }));
  // Here pid 4242 is gone (or another process): read in this namespace, it would look dead.
  const here = { host: "this-host", pidns: "pid:[2]", isAlive: () => assert.fail("another namespace's pid is never asked here"), identity: (pid) => (pid === process.pid ? undefined : assert.fail("another namespace's pid is never read here")) };
  assert.equal(await takeHold(dir, here), undefined, "young: held, as another host's");
  assert.equal(JSON.parse(readFileSync(installHoldOf(dir), "utf8")).token, "theirs");
  writeFileSync(installHoldOf(dir), JSON.stringify({ host: "this-host", pidns: "pid:[1]", pid: 4242, identity: "boot-1:100", startedAt: Date.now() - 60 * 60_000, token: "theirs" }));
  assert.equal(typeof (await takeHold(dir, here)), "string", "past the install's bound: taken over");
});

test("this process's identity is read from the system where it shows one, the same each time; a pid that is gone has none", { skip: !existsSync("/proc/self/stat") && "no /proc here" }, async () => {
  const mine = processIdentity(process.pid);
  assert.match(mine ?? "", /^[0-9a-f-]+:\d+$/, "its boot and its start");
  assert.equal(processIdentity(process.pid), mine);
  assert.equal(processIdentity(2 ** 22 + 7), undefined, "no such process");
  assert.match(pidNamespace() ?? "", /^pid:\[\d+\]$/, "this process's pid namespace");
});

test("an explicit hold path shares stale-owner exclusion and releases only that path's owner", async t => {
  const root = scratch(t, "explicit-hold"), dir = join(root, "harnesses", "fake");
  const holdPath = join(root, "connection.lock");
  mkdirSync(dirname(installHoldOf(dir)), { recursive: true });
  writeFileSync(installHoldOf(dir), "unrelated install hold");
  writeFileSync(holdPath, JSON.stringify({ host: "this-host", pid: 1, startedAt: Date.now(), token: "left" }));
  const options = { holdPath, timeoutMs: Infinity, host: "this-host", isAlive: pid => pid !== 1 };
  const tokens = (await Promise.all(Array.from({ length: 8 }, () => takeHold(dir, options)))).filter(Boolean);
  assert.equal(tokens.length, 1, "only one concurrent command recovers the dead owner");
  assert.equal(JSON.parse(readFileSync(holdPath, "utf8")).token, tokens[0]);
  await releaseHold(dir, "not-the-owner", { holdPath });
  assert.equal(JSON.parse(readFileSync(holdPath, "utf8")).token, tokens[0]);
  await releaseHold(dir, tokens[0], { holdPath });
  assert.equal(existsSync(holdPath), false);
  assert.equal(readFileSync(installHoldOf(dir), "utf8"), "unrelated install hold");
});

test("an unlimited explicit hold never expires a live local owner when process birth identity is unavailable", async t => {
  const root = scratch(t, "explicit-hold-alive"), dir = join(root, "harnesses", "fake");
  const holdPath = join(root, "connection.lock");
  writeFileSync(holdPath, JSON.stringify({ host: "this-host", pidns: "pid:[1]", pid: 4242, startedAt: Date.now() - 86_400_000, token: "running" }));
  const options = { holdPath, timeoutMs: Infinity, host: "this-host", pidns: "pid:[1]", identity: () => undefined, recoverUnknownOwner: false };
  assert.equal(await takeHold(dir, { ...options, isAlive: () => true }), undefined);
  const token = await takeHold(dir, { ...options, isAlive: pid => pid !== 4242 });
  assert.equal(typeof token, "string", "the dead process is recoverable even with no time limit");
  await releaseHold(dir, token, { holdPath });
});

const beforeBoot = "00000000-0000-4000-8000-000000000001";
const currentBoot = "00000000-0000-4000-8000-000000000002";

test("an unlimited hold from this host's previous kernel boot is recoverable even when its PID namespace changed", async t => {
  const dir = scratch(t, "hold-prior-boot"), holdPath = join(dir, "connection.lock");
  writeFileSync(holdPath, JSON.stringify({ host: "this-host", pidns: "pid:[1]", pid: 4242, identity: `${beforeBoot}:100`, startedAt: Date.now(), token: "prior-boot" }));
  const token = await takeHold(dir, {
    holdPath, timeoutMs: Infinity, host: "this-host", pidns: "pid:[2]",
    identity: pid => pid === process.pid ? `${currentBoot}:200` : assert.fail("a foreign PID is never inspected"),
    isAlive: () => assert.fail("a foreign PID is never inspected"),
  });
  assert.equal(typeof token, "string", "the prior kernel boot cannot still own the lock");
  assert.equal(JSON.parse(readFileSync(holdPath, "utf8")).token, token);
  await releaseHold(dir, token, { holdPath });
});

for (const example of [
  { name: "same-boot foreign namespace", host: "this-host", identity: `${currentBoot}:100`, own: `${currentBoot}:200` },
  { name: "foreign host", host: "another-host", identity: `${beforeBoot}:100`, own: `${currentBoot}:200` },
  { name: "unknown owner boot", host: "this-host", own: `${currentBoot}:200` },
  { name: "unknown current boot", host: "this-host", identity: `${beforeBoot}:100` },
  { name: "malformed owner boot", host: "this-host", identity: "boot-before:100", own: `${currentBoot}:200` },
  { name: "malformed current boot", host: "this-host", identity: `${beforeBoot}:100`, own: "boot-now:200" },
  { name: "malformed start ticks", host: "this-host", identity: `${beforeBoot}:unknown`, own: `${currentBoot}:200` },
  { name: "trailing identity data", host: "this-host", identity: `${beforeBoot}:100\n`, own: `${currentBoot}:200` },
]) test(`an unlimited hold with ${example.name} remains protected`, async t => {
  const dir = scratch(t, "hold-uncertain-boot"), holdPath = join(dir, "connection.lock");
  writeFileSync(holdPath, JSON.stringify({ host: example.host, pidns: "pid:[1]", pid: 4242, identity: example.identity, startedAt: Date.now() - 86_400_000, token: "protected" }));
  assert.equal(await takeHold(dir, {
    holdPath, timeoutMs: Infinity, host: "this-host", pidns: "pid:[2]",
    identity: pid => pid === process.pid ? example.own : assert.fail("a foreign PID is never inspected"),
    isAlive: () => assert.fail("a foreign PID is never inspected"),
  }), undefined);
  assert.equal(JSON.parse(readFileSync(holdPath, "utf8")).token, "protected");
});

test("finite installer holds retain their existing foreign-namespace timeout policy across kernel boots", async t => {
  const dir = scratch(t, "hold-finite-boot"), holdPath = join(dir, "connection.lock");
  writeFileSync(holdPath, JSON.stringify({ host: "this-host", pidns: "pid:[1]", pid: 4242, identity: `${beforeBoot}:100`, startedAt: Date.now(), token: "bounded" }));
  assert.equal(await takeHold(dir, {
    holdPath, host: "this-host", pidns: "pid:[2]",
    identity: pid => pid === process.pid ? `${currentBoot}:200` : assert.fail("a foreign PID is never inspected"),
    isAlive: () => assert.fail("a foreign PID is never inspected"),
  }), undefined);
  assert.equal(JSON.parse(readFileSync(holdPath, "utf8")).token, "bounded");
});

for (const [name, text] of [
  ["empty", ""], ["malformed JSON", "{"],
  ["missing host", JSON.stringify({ pid: 4242, startedAt: 1, token: "unknown" })],
  ["invalid PID", JSON.stringify({ host: "this-host", pid: -1, startedAt: 1, token: "unknown" })],
  ["invalid timestamp", JSON.stringify({ host: "this-host", pid: 4242, startedAt: -1, token: "unknown" })],
  ["missing token", JSON.stringify({ host: "this-host", pid: 4242, startedAt: 1 })],
  ["malformed identity", JSON.stringify({ host: "this-host", pid: 4242, startedAt: 1, identity: "not-a-process-identity", token: "unknown" })],
]) test(`a protected ${name} owner record is never recovered from age or an untrusted PID`, async t => {
  const dir = scratch(t, "unknown-owner"), holdPath = join(dir, "install.lock");
  writeFileSync(holdPath, text);
  const old = (Date.now() - 86_400_000) / 1000;
  utimesSync(holdPath, old, old);
  const token = await takeHold(dir, { holdPath, host: "this-host", timeoutMs: Infinity, recoverUnknownOwner: false,
    isAlive: () => false });
  assert.equal(token, undefined);
  assert.equal(readFileSync(holdPath, "utf8"), text);
});

test("strict owner proof never inspects a PID when only the current namespace is known", async t => {
  const dir = scratch(t, "unknown-owner-namespace"), holdPath = join(dir, "install.lock");
  const text = JSON.stringify({ host: "this-host", pid: 4242, startedAt: 1, token: "unknown-namespace" });
  writeFileSync(holdPath, text);
  const token = await takeHold(dir, { holdPath, host: "this-host", pidns: "pid:[2]", timeoutMs: Infinity, recoverUnknownOwner: false,
    identity: () => undefined, isAlive: () => assert.fail("an unproven namespace never authorizes inspecting this process table") });
  assert.equal(token, undefined);
  assert.equal(readFileSync(holdPath, "utf8"), text);
});
