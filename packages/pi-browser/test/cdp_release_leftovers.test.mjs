// A release that cannot remove what the browser leaves behind says so, naming every directory: a profile in the temp directory holds that
// session's cookies, and a release that returned quietly would leave them there for no one to find.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { cdpProvider, ProfileNotRemovedError, ProfileOwnershipUnclearError } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { scratch } from "./fixtures/scratch.mjs";

const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });

test("a profile that cannot be removed is reported by name, never swallowed; asked again it is tried again and reported again, and once it can be removed the release finishes", { skip: NO_CHROME || (process.getuid?.() === 0 ? "root can remove anything" : false), timeout: 90_000 }, async (t) => {
  const root = await scratch(t, "cdp-release-left-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  const ref = await provider.create(spec("cdp-left-1"), new AbortController().signal);
  const profile = path.join(root, "cdp-left-1");
  // A directory its files cannot be unlinked from: the removal fails however often it is tried.
  const locked = path.join(profile, "Default");
  chmodSync(locked, 0o500);
  t.after(() => { try { chmodSync(locked, 0o700); } catch {} }, { timeout: 30_000 });
  const failure = await provider.release(ref).then(() => null, (error) => error);
  assert.ok(failure instanceof ProfileNotRemovedError, String(failure));
  assert.equal(failure.code, "profile_not_removed");
  assert.equal(failure.dir, profile);
  assert.ok(failure.message.includes(profile), failure.message);
  assert.match(failure.message, /cookies/);
  assert.equal(existsSync(profile), true, "it is still there, and the release said so");
  // Chrome is gone either way, so the lease reads 'gone': that is not a release. Asked again with the directory still locked, the release
  // tries the removal again and says so again; it does not finish because the browser is gone.
  assert.equal(await provider.status(ref), "gone");
  const again = await provider.release(ref).then(() => null, (error) => error);
  assert.ok(again instanceof ProfileNotRemovedError, `the retry with the directory still locked: ${String(again)}`);
  assert.equal(again.dir, profile);
  assert.equal(existsSync(profile), true);
  // Once the directory can be emptied, asking again removes it and finishes.
  chmodSync(locked, 0o700);
  await provider.release(ref);
  assert.equal(existsSync(profile), false);
  await provider.release(ref);
});

test("Chrome's singleton socket directory that cannot be removed is reported by name too", { skip: NO_CHROME || (process.getuid?.() === 0 ? "root can remove anything" : false), timeout: 90_000 }, async (t) => {
  const root = await scratch(t, "cdp-release-socket-");
  const tmp = path.join(root, "tmp");
  mkdirSync(tmp);
  const outer = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  t.after(() => { process.env.TMPDIR = outer; }, { timeout: 30_000 });
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(root, "profiles") } });
  const ref = await provider.create(spec("cdp-socket-1"), new AbortController().signal);
  process.env.TMPDIR = outer;
  const socket = readlinkSync(path.join(root, "profiles", "cdp-socket-1", "SingletonSocket"));
  const socketDir = path.dirname(socket);
  chmodSync(socketDir, 0o500);
  t.after(() => { try { chmodSync(socketDir, 0o700); } catch {} }, { timeout: 30_000 });
  const failure = await provider.release(ref).then(() => null, (error) => error);
  assert.ok(failure instanceof ProfileNotRemovedError, String(failure));
  assert.equal(failure.dir, socketDir);
  assert.equal(existsSync(path.join(root, "profiles", "cdp-socket-1")), false, "the profile itself was removed");
  chmodSync(socketDir, 0o700);
  await provider.release(ref);
  assert.equal(existsSync(socketDir), false, "the link that named it went with the profile, and the release asked again still finds it");
});

for (const [what, executablePath, why] of [
  ["a Chrome that cannot be started", "/nonexistent/chrome", /ENOENT|could not be started|spawn/],
  ["a Chrome that exits before it opens its port", "/bin/false", /exited before it opened its debugging port/],
]) {
  test(`${what} whose leftover directory cannot be removed fails create with the leftover named and the launch's own reason kept`, { skip: process.getuid?.() === 0 ? "root can remove anything" : false, timeout: 60_000 }, async (t) => {
    const root = await scratch(t, "cdp-create-left-");
    const provider = cdpProvider({ chrome: { executablePath, profileRoot: root } });
    // The downloads directory of the lease about to be made already holds a file in a directory that cannot be emptied.
    const downloads = path.join(root, "cdp-create-1.downloads");
    const inner = path.join(downloads, "locked");
    mkdirSync(inner, { recursive: true });
    writeFileSync(path.join(inner, "file"), "x");
    chmodSync(inner, 0o500);
    t.after(() => { try { chmodSync(inner, 0o700); } catch {} }, { timeout: 30_000 });
    const failure = await provider.create(spec("cdp-create-1"), new AbortController().signal).then(() => null, (error) => error);
    assert.ok(failure instanceof ProfileNotRemovedError, String(failure));
    assert.equal(failure.dir, inner.replace(/\/locked$/, ""), "it names the downloads directory it could not remove");
    assert.match(failure.message, why, "and the reason the launch failed");
    assert.equal(existsSync(path.join(root, "cdp-create-1")), false, "the profile it made is gone");
  });
}

test("release of a lease whose profile directory is a link removes the link and leaves what it points to", { skip: NO_CHROME, timeout: 90_000 }, async (t) => {
  // A profile kept for later (a saved sign-in) is a link under the profile root: the release is the link's, never its target's.
  const root = await scratch(t, "cdp-release-link-");
  const kept = path.join(root, ".profiles", "work");
  mkdirSync(kept, { recursive: true });
  writeFileSync(path.join(kept, "marker"), "keep me");
  symlinkSync(kept, path.join(root, "cdp-link-1"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  const ref = await provider.create(spec("cdp-link-1"), new AbortController().signal);
  assert.ok(lstatSync(path.join(root, "cdp-link-1")).isSymbolicLink(), "the profile directory is the link");
  assert.ok(readdirSync(kept).includes("Default"), "Chrome used the directory the link points to");
  await provider.release(ref);
  assert.equal(existsSync(path.join(root, "cdp-link-1")), false, "the link is gone");
  assert.equal(readdirSync(kept).includes("marker"), true, "what it pointed to is still there, with its files");
  assert.ok(readdirSync(kept).includes("Default"), "and Chrome's own files in it");
});

test("every leftover is reported together: the profile and the socket directory that its link names", { skip: NO_CHROME || (process.getuid?.() === 0 ? "root can remove anything" : false), timeout: 90_000 }, async (t) => {
  const root = await scratch(t, "cdp-release-both-");
  const tmp = path.join(root, "tmp");
  mkdirSync(tmp);
  const outer = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  t.after(() => { process.env.TMPDIR = outer; }, { timeout: 30_000 });
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(root, "profiles") } });
  const ref = await provider.create(spec("cdp-both-1"), new AbortController().signal);
  process.env.TMPDIR = outer;
  const profile = path.join(root, "profiles", "cdp-both-1");
  const socketDir = path.dirname(readlinkSync(path.join(profile, "SingletonSocket")));
  const locked = path.join(profile, "Default");
  chmodSync(locked, 0o500);
  chmodSync(socketDir, 0o500);
  t.after(() => { for (const dir of [locked, socketDir]) { try { chmodSync(dir, 0o700); } catch {} } }, { timeout: 30_000 });
  const failure = await provider.release(ref).then(() => null, (error) => error);
  assert.ok(failure instanceof ProfileNotRemovedError, String(failure));
  // Both are named. When the path leaves room for it (Chrome's socket path may not pass 107 bytes, so how long this test's root is decides), the
  // socket directory is inside the lease's private TMPDIR, which cannot be removed either and is named with them; nothing else is.
  assert.ok(failure.dirs.includes(profile) && failure.dirs.includes(socketDir), `both are named: ${failure.dirs}`);
  assert.deepEqual([...failure.dirs].filter((dir) => dir !== profile && dir !== socketDir && dir !== path.dirname(socketDir)), [], "and nothing else is");
  assert.ok(failure.message.includes(profile) && failure.message.includes(socketDir), failure.message);
  // Removing what it could took the profile's link to the socket directory with it, so the provider remembers the directory: once both can be
  // emptied, one more release removes both.
  chmodSync(locked, 0o700);
  chmodSync(socketDir, 0o700);
  await provider.release(ref);
  assert.deepEqual([existsSync(profile), existsSync(socketDir)], [false, false]);
});

for (const [what, executablePath, why] of [
  ["a Chrome that cannot be started", "/nonexistent/chrome", /ENOENT|could not be started|spawn/],
  ["a Chrome that exits before it opens its port", "/bin/false", /exited before it opened its debugging port/],
]) {
  test(`${what}: the downloads directory is removed although the profile's removal fails, and both leftovers are named`, { skip: process.getuid?.() === 0 ? "root can remove anything" : false, timeout: 60_000 }, async (t) => {
    const root = await scratch(t, "cdp-create-both-");
    const provider = cdpProvider({ chrome: { executablePath, profileRoot: root } });
    // The profile directory about to be used holds a directory that cannot be emptied; its downloads directory holds only a file.
    const locked = path.join(root, "cdp-both-1", "Locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(path.join(locked, "file"), "x");
    chmodSync(locked, 0o500);
    t.after(() => { try { chmodSync(locked, 0o700); } catch {} }, { timeout: 30_000 });
    const downloads = path.join(root, "cdp-both-1.downloads");
    mkdirSync(downloads);
    writeFileSync(path.join(downloads, "file"), "x");
    const failure = await provider.create(spec("cdp-both-1"), new AbortController().signal).then(() => null, (error) => error);
    assert.ok(failure instanceof ProfileNotRemovedError, String(failure));
    assert.deepEqual(failure.dirs, [path.join(root, "cdp-both-1")], "the profile is named");
    assert.equal(existsSync(downloads), false, "the downloads directory was still removed");
    assert.match(failure.message, why);
  });
}

test("a release that does not own the browser and whose profile names a port that takes the probe and never answers leaves the profile and says so; once the port closes it is removed", { timeout: 30_000 }, async (t) => {
  const root = await scratch(t, "cdp-release-stalled-");
  // Accepts the browser probe and never answers it.
  const held = new Set();
  const stalled = net.createServer((socket) => { held.add(socket); socket.on("error", () => undefined); });
  await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  const { port } = stalled.address();
  t.after(() => { for (const socket of held) socket.destroy(); stalled.close(); }, { timeout: 30_000 });
  const profile = path.join(root, "stalled-1");
  mkdirSync(profile);
  writeFileSync(path.join(profile, "DevToolsActivePort"), `${port}\n/devtools/browser/held\n`);
  const provider = cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: root } });
  const ref = { id: `local:999999:${port}:stalled-1`, tag: "stalled-1" };
  const started = Date.now();
  const failure = await provider.release(ref).then(() => null, (error) => error);
  const took = Date.now() - started;
  assert.ok(failure instanceof ProfileOwnershipUnclearError, String(failure));
  assert.equal(failure.code, "profile_ownership_unclear");
  assert.equal(failure.dir, profile);
  assert.equal(failure.port, port);
  assert.ok(took >= 1_500 && took < 10_000, `the probe ended at its own deadline, after ${took} ms`);
  assert.equal(existsSync(path.join(profile, "DevToolsActivePort")), true, "a profile a live browser may still run on is left");
  for (const socket of held) socket.destroy();
  await new Promise((resolve) => stalled.close(resolve));
  await provider.release(ref);
  assert.equal(existsSync(profile), false, "with nothing on the port, the lease's profile is removed");
});

/** A stand-in for Chrome's exiting threads, writing into the profile until it is stopped: the directory holds thousands of small files, so a removal's
 *  pass over it takes a while, and a new file lands every fifth of a millisecond, so the directory is never empty when the removal reaches its rmdir
 *  (ENOTEMPTY) until the writer stops. It never makes the directory: once the profile is gone its writes fail. Resolves, once it is writing, with `stop`. */
function writerInto(t, profile) {
  const writer = spawn(process.execPath, ["-e", `
    const fs = require("node:fs"), path = require("node:path");
    const dir = ${JSON.stringify(profile)};
    for (let i = 0; i < 3000; i += 1) fs.writeFileSync(path.join(dir, "old-" + i), "x");
    process.stdout.write("writing\\n");
    let n = 0, last = 0;
    for (;;) { const now = performance.now(); if (now - last < 0.2) continue; last = now; try { fs.writeFileSync(path.join(dir, "new-" + n++), "x"); } catch {} }
  `], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { writer.kill("SIGKILL"); }, { timeout: 30_000 });
  return new Promise((resolve, reject) => {
    writer.stdout.once("data", () => resolve(() => writer.kill("SIGKILL")));
    writer.once("exit", () => reject(new Error("the writer ended without writing")));
  });
}

test("a profile a writer keeps adding files to while the release removes it is removed once the writing stops (the real filesystem; the retries are pinned by the controlled tests)", { skip: NO_CHROME, timeout: 90_000 }, async (t) => {
  const root = await scratch(t, "cdp-release-race-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  const ref = await provider.create(spec("cdp-race-1"), new AbortController().signal);
  const profile = path.join(root, "cdp-race-1");
  const stopWriting = await writerInto(t, profile);
  const releasing = provider.release(ref);
  releasing.catch(() => {});
  // The writer goes on until the removal has begun (a file the writer made first is gone) and for a while after. That it was still writing when the
  // removal reached the directory is up to the box (a writer starved of CPU lets the removal finish first, and that is a correct release too), so
  // nothing here depends on it: the retries themselves are pinned by the controlled tests above, and this one is the real filesystem as extra cover.
  while (existsSync(path.join(profile, "old-0"))) await sleep(2);
  await sleep(300);
  stopWriting();
  await releasing;
  assert.equal(existsSync(profile), false, "the profile is gone when release returns");
  assert.equal(await provider.status(ref), "gone");
});

/** A lease whose browser is not running (no such pid), over a profile directory the test made: a release of it only removes the directory. */
function leaseOver(root, tag) {
  mkdirSync(path.join(root, tag, "Default"), { recursive: true });
  writeFileSync(path.join(root, tag, "Default", "Cookies"), "x");
  return { id: `local:2147483000:0:${tag}`, tag };
}
/** A removal that fails with `code` for its first `times` calls, then removes for real; `calls` counts every call. */
function failingRemoval(code, times) {
  const removal = { calls: 0, remove: async (dir, options) => { removal.calls += 1; if (removal.calls <= times) throw Object.assign(new Error(`${code}: simulated, rm '${dir}'`), { code, syscall: "rmdir", path: dir }); await rm(dir, options); } };
  return removal;
}

test("a removal that fails with ENOTEMPTY is tried again: three failures, then the release finishes with the directory gone (a controlled failure, no clock)", { timeout: 30_000 }, async (t) => {
  const root = await scratch(t, "cdp-removal-retry-");
  const ref = leaseOver(root, "cdp-hook-1");
  const removal = failingRemoval("ENOTEMPTY", 3);
  const provider = cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: root } }, { remove: removal.remove });
  const began = performance.now();
  await provider.release(ref);
  // Each retry waits a little longer than the one before (100, 200, 300 ms): a wait never ends early, so this bound holds however loaded the box is.
  assert.ok(performance.now() - began >= 590, `${(performance.now() - began).toFixed(0)} ms for three retries`);
  assert.equal(removal.calls, 4, "three failed attempts and the one that worked");
  assert.equal(existsSync(path.join(root, "cdp-hook-1")), false);
});

test("a removal that is still ENOTEMPTY after the retries is reported by name: the first attempt and five more, no more", { timeout: 30_000 }, async (t) => {
  const root = await scratch(t, "cdp-removal-giveup-");
  const ref = leaseOver(root, "cdp-hook-2");
  const removal = failingRemoval("ENOTEMPTY", 1_000);
  const provider = cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: root } }, { remove: removal.remove });
  const failure = await provider.release(ref).then(() => null, (error) => error);
  assert.ok(failure instanceof ProfileNotRemovedError, String(failure));
  assert.equal(failure.cause.code, "ENOTEMPTY");
  assert.equal(removal.calls, 6, "one attempt and five retries");
  assert.equal(existsSync(path.join(root, "cdp-hook-2")), true);
});

test("a removal that fails with a code a retry cannot cure (EACCES) is tried once and reported", { timeout: 30_000 }, async (t) => {
  const root = await scratch(t, "cdp-removal-eacces-");
  const ref = leaseOver(root, "cdp-hook-3");
  const removal = failingRemoval("EACCES", 1_000);
  const provider = cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: root } }, { remove: removal.remove });
  const failure = await provider.release(ref).then(() => null, (error) => error);
  assert.ok(failure instanceof ProfileNotRemovedError, String(failure));
  assert.equal(removal.calls, 1);
});
