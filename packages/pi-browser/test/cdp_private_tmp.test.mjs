// Every Chrome the cdp provider starts gets a TMPDIR of its own, removed with the lease: what Chrome writes there (its singleton socket directory,
// its url_fetcher entries, which nothing removes when it is killed) never lands in the host's TMPDIR. A fake Chrome stands in for the real one, so
// this runs wherever Node does.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { cdpProvider, ProfileNotRemovedError } from "../dist/providers/cdp.js";
import { scratch } from "./fixtures/scratch.mjs";

const FAKE = path.join(import.meta.dirname, "fixtures", "fake-chrome.mjs");
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });
const signal = new AbortController().signal;
const NOT_ROOT = process.getuid?.() === 0 ? "root can remove anything" : false;

/** The TMPDIR of the test file, made empty for the test and put back after: what a leak is measured against. */
async function hostTmp(t) {
  const dir = await scratch(t, "host-tmp-");
  const outer = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(() => { if (outer === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = outer; });
  return dir;
}
const provider = (root, extra = {}) => cdpProvider({ chrome: { executablePath: FAKE, profileRoot: root, ...extra } });
const seen = (root, tag) => JSON.parse(readFileSync(path.join(root, tag, "fake-chrome.json"), "utf8"));

test("Chrome's temp writes land in a TMPDIR of its own, and a release leaves the host's TMPDIR as empty as it found it", async (t) => {
  const root = await scratch(t, "cdp-private-");
  const host = await hostTmp(t);
  const p = provider(root);
  const ref = await p.create(spec("cdp-tmp-1"), signal);
  const running = seen(root, "cdp-tmp-1");
  assert.notEqual(running.tmpdir, host, "Chrome was not given the host's TMPDIR");
  assert.equal(path.dirname(running.tmpdir), host, "its own directory is made under the host's TMPDIR, short enough for Chrome's socket");
  assert.deepEqual(readdirSync(host).filter((n) => !n.startsWith("pib-")), [], "while it runs, the host's TMPDIR holds only the lease's private directory");
  assert.ok(readdirSync(running.tmpdir).some((n) => n.includes("url_fetcher")), "Chrome's url_fetcher entry is in the private directory");
  await p.release(ref);
  assert.deepEqual(readdirSync(host), [], "nothing of Chrome's is left in the host's TMPDIR: no url_fetcher entry, no socket directory, no private directory");
  assert.equal(existsSync(path.join(root, "cdp-tmp-1")), false);
});

test("the host's environment reaches Chrome as before: only TMPDIR changes", async (t) => {
  const root = await scratch(t, "cdp-private-env-");
  await hostTmp(t);
  process.env.PI_PRIVATE_TMP_TEST = "kept";
  t.after(() => { delete process.env.PI_PRIVATE_TMP_TEST; });
  const p = provider(root);
  const ref = await p.create(spec("cdp-tmp-2"), signal);
  const env = seen(root, "cdp-tmp-2").env;
  assert.ok(env.includes("PI_PRIVATE_TMP_TEST") && env.includes("PATH") && env.includes("TMPDIR"));
  await p.release(ref);
});

test("a release by a provider that did not start the Chrome (a restarted process) removes the lease's private directory too", async (t) => {
  const root = await scratch(t, "cdp-private-restart-");
  const host = await hostTmp(t);
  const ref = await provider(root).create(spec("cdp-tmp-3"), signal);
  // The host process that started the Chrome is gone, and so is the Chrome: what is left is the lease's directories.
  const pid = Number(ref.id.split(":")[1]);
  process.kill(-pid, "SIGKILL");
  for (const end = Date.now() + 5_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) { try { process.kill(pid, 0); } catch { break; } }
  await provider(root).release(ref);
  assert.deepEqual(readdirSync(host), []);
});

test("a private directory that stays unremovable is reported by name with the profile's, and removed by the release that can", { skip: NOT_ROOT, timeout: 60_000 }, async (t) => {
  const root = await scratch(t, "cdp-private-locked-");
  const host = await hostTmp(t);
  const p = provider(root);
  const ref = await p.create(spec("cdp-tmp-4"), signal);
  const tmp = seen(root, "cdp-tmp-4").tmpdir;
  const fetcher = path.join(tmp, readdirSync(tmp).find((n) => n.includes("url_fetcher")));
  chmodSync(fetcher, 0o500);
  t.after(() => { try { chmodSync(fetcher, 0o700); } catch {} });
  const failure = await p.release(ref).then(() => null, (error) => error);
  assert.ok(failure instanceof ProfileNotRemovedError, String(failure));
  assert.ok(failure.dirs.includes(tmp) || failure.dirs.some((d) => d.startsWith(tmp)), `the private directory is named: ${failure.dirs}`);
  assert.equal(existsSync(path.join(root, "cdp-tmp-4")), false, "the profile itself was removed");
  chmodSync(fetcher, 0o700);
  await p.release(ref);
  assert.deepEqual(readdirSync(host), []);
});

test("a path to the host's TMPDIR too long to leave room for Chrome's socket is left as it is: Chrome gets the host's TMPDIR, and nothing is made", async (t) => {
  const root = await scratch(t, "cdp-private-long-");
  const outer = await hostTmp(t);
  const long = path.join(outer, "l".repeat(70));
  mkdirSync(long);
  process.env.TMPDIR = long;
  const p = provider(root);
  // The fake makes its entries in the long directory; they are the host's to see, so the test removes the lease and checks only what the provider owns.
  const ref = await p.create(spec("cdp-tmp-5"), signal);
  assert.equal(seen(root, "cdp-tmp-5").tmpdir, long);
  assert.deepEqual(readdirSync(long).filter((n) => n.startsWith("pib-")), [], "no private directory was made");
  await p.release(ref);
});

test("a marker in a profile that names a directory the provider did not make is never removed", async (t) => {
  const root = await scratch(t, "cdp-private-marker-");
  const host = await hostTmp(t);
  const decoy = path.join(host, "pib-ABCDEF");
  mkdirSync(decoy);
  writeFileSync(path.join(decoy, "precious"), "x");
  const profile = path.join(root, "cdp-tmp-6");
  mkdirSync(path.join(profile, "Default"), { recursive: true });
  writeFileSync(path.join(profile, ".pib-tmpdir"), decoy);
  await provider(root).release({ id: "local:2147483000:0:cdp-tmp-6", tag: "cdp-tmp-6" });
  assert.equal(existsSync(path.join(decoy, "precious")), true, "no owner file naming this lease: not ours");
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "precious"), "x");
  mkdirSync(path.join(profile, "Default"), { recursive: true });
  writeFileSync(path.join(profile, ".pib-tmpdir"), outside);
  await provider(root).release({ id: "local:2147483000:0:cdp-tmp-6", tag: "cdp-tmp-6" });
  assert.equal(existsSync(path.join(outside, "precious")), true, "a name that is not one of ours is never removed");
  // An owner file that names another lease's tag, and a directory that is not named as the provider names its own, even with this lease's tag in it.
  const other = path.join(host, "pib-GHIJKL");
  mkdirSync(other);
  writeFileSync(path.join(other, ".pib-owner"), "some-other-lease");
  writeFileSync(path.join(other, "precious"), "x");
  mkdirSync(path.join(profile, "Default"), { recursive: true });
  writeFileSync(path.join(profile, ".pib-tmpdir"), other);
  await provider(root).release({ id: "local:2147483000:0:cdp-tmp-6", tag: "cdp-tmp-6" });
  assert.equal(existsSync(path.join(other, "precious")), true, "an owner file naming another lease: not ours");
  const misnamed = path.join(host, "precious-dir");
  mkdirSync(misnamed);
  writeFileSync(path.join(misnamed, ".pib-owner"), "cdp-tmp-6");
  writeFileSync(path.join(misnamed, "precious"), "x");
  mkdirSync(path.join(profile, "Default"), { recursive: true });
  writeFileSync(path.join(profile, ".pib-tmpdir"), misnamed);
  await provider(root).release({ id: "local:2147483000:0:cdp-tmp-6", tag: "cdp-tmp-6" });
  assert.equal(existsSync(path.join(misnamed, "precious")), true, "a directory not named as the provider names its own is never removed");
});

test("a Chrome that exits before it opens its port leaves nothing in the host's TMPDIR", async (t) => {
  const root = await scratch(t, "cdp-private-exit-");
  const host = await hostTmp(t);
  process.env.FAKE_CHROME_EXIT = "3";
  t.after(() => { delete process.env.FAKE_CHROME_EXIT; });
  await assert.rejects(provider(root).create(spec("cdp-tmp-7"), signal), /exited before it opened its debugging port/);
  assert.deepEqual(readdirSync(host), []);
});

test("a Chrome that cannot be started leaves nothing in the host's TMPDIR", async (t) => {
  const root = await scratch(t, "cdp-private-nostart-");
  const host = await hostTmp(t);
  await assert.rejects(cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: root } }).create(spec("cdp-tmp-8"), signal));
  assert.deepEqual(readdirSync(host), []);
});

test("a Chrome still writing into its private directory when it is killed: the removal tries again until the directory is empty", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t, "cdp-private-writer-");
  const host = await hostTmp(t);
  process.env.FAKE_CHROME_WRITER = "1";
  t.after(() => { delete process.env.FAKE_CHROME_WRITER; });
  const p = provider(root);
  const ref = await p.create(spec("cdp-tmp-9"), signal);
  const tmp = seen(root, "cdp-tmp-9").tmpdir;
  const fetcher = path.join(tmp, readdirSync(tmp).find((n) => n.includes("url_fetcher")));
  for (const end = Date.now() + 10_000; readdirSync(fetcher).length < 200 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  await p.release(ref);
  assert.deepEqual(readdirSync(host), []);
});

test("a profile root removed before the release (a test's own cleanup running first) does not strand the private directory: the provider that made it still knows it", async (t) => {
  const root = await scratch(t, "cdp-private-first-");
  const host = await hostTmp(t);
  const p = provider(root);
  const ref = await p.create(spec("cdp-tmp-10"), signal);
  const pid = Number(ref.id.split(":")[1]);
  rmSync(path.join(root, "cdp-tmp-10"), { recursive: true, force: true }); // the profile, and the marker in it, are gone
  await p.release(ref);
  assert.deepEqual(readdirSync(host), [], "the private directory went with the release though the profile's marker was gone");
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "and the Chrome is gone");
});

test("a setup that fails after the private directory was made removes it: the host's TMPDIR is left as it was, and the create fails with the cause", async (t) => {
  const root = await scratch(t, "cdp-private-setup-");
  const host = await hostTmp(t);
  // The profile already holds a directory where the marker file goes, so writing the marker fails after the private directory exists.
  mkdirSync(path.join(root, "cdp-tmp-11", ".pib-tmpdir"), { recursive: true });
  const failure = await provider(root).create(spec("cdp-tmp-11"), signal).then(() => null, (error) => error);
  assert.ok(failure instanceof Error && /EISDIR|directory/.test(failure.message), String(failure));
  assert.deepEqual(readdirSync(host), [], "no private directory was left behind");
});

test("a setup that fails and cannot remove the private directory names it in the error", async (t) => {
  const root = await scratch(t, "cdp-private-setup2-");
  const host = await hostTmp(t);
  mkdirSync(path.join(root, "cdp-tmp-12", ".pib-tmpdir"), { recursive: true });
  const stuck = cdpProvider({ chrome: { executablePath: FAKE, profileRoot: root } }, { remove: async (dir) => { throw Object.assign(new Error(`EACCES: simulated, rm '${dir}'`), { code: "EACCES" }); } });
  const failure = await stuck.create(spec("cdp-tmp-12"), signal).then(() => null, (error) => error);
  assert.ok(failure instanceof ProfileNotRemovedError, String(failure));
  const [made] = readdirSync(host);
  assert.ok(failure.dirs.includes(path.join(host, made)), `the private directory is named: ${failure.dirs}`);
  assert.match(String(failure.original?.message ?? ""), /EISDIR/, "and the cause of the failed setup is kept as the error's original");
});
