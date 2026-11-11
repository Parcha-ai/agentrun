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

const { inTree, installHoldOf, processIdentity, releaseHold, takeHold } = await import("../dist/harness-install.js");

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
  // A hold its installer left: a process of this host that is gone.
  const left = () => writeFileSync(installHoldOf(dir), JSON.stringify({ host: "this-host", pid: 1, startedAt: Date.now(), token: "left" }));
  const gone = { host: "this-host", isAlive: () => false };
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

test("this process's identity is read from the system where it shows one, the same each time; a pid that is gone has none", { skip: !existsSync("/proc/self/stat") && "no /proc here" }, async () => {
  const mine = processIdentity(process.pid);
  assert.match(mine ?? "", /^[0-9a-f-]+:\d+$/, "its boot and its start");
  assert.equal(processIdentity(process.pid), mine);
  assert.equal(processIdentity(2 ** 22 + 7), undefined, "no such process");
});
