// The Preferences a lease starts with. A saved profile is a browser the next session picks up, so Chrome is told to "continue where you left off"
// (session.restore_on_startup = 1): a session cookie (no Expires, like rack.session) survives a restart only that way. Every other key is kept.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { cdpProvider } from "../dist/providers/cdp.js";
import { scratch } from "./fixtures/scratch.mjs";

const FAKE = path.join(import.meta.dirname, "fixtures", "fake-chrome.mjs");
const spec = (tag, profile) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: { run: "r", label: "l" }, ...(profile ? { profile } : {}) });
const signal = new AbortController().signal;
const prefsOf = async (root, tag) => JSON.parse(await readFile(path.join(root, tag, "Default", "Preferences"), "utf8"));

test("a kept profile sets restore_on_startup and keeps every other key it had; its own download settings are still written", async (t) => {
  const root = await scratch(t, "cdp-prefs-");
  await mkdir(path.join(root, ".profiles", "work", "Default"), { recursive: true });
  await writeFile(path.join(root, ".profiles", "work", "Default", "Preferences"), JSON.stringify({ session: { restore_on_startup: 4, startup_urls: ["https://example.test/"] }, download: { extra: 1 }, savefile: { extra: 2 }, other: { keep: true } }));
  const provider = cdpProvider({ chrome: { executablePath: FAKE, profileRoot: root, sandbox: false } });
  for (const save of [false, true]) {
    const ref = await provider.create(spec(`prefs-${process.pid}-${save}`, { name: "work", save }), signal);
    try {
      const prefs = await prefsOf(root, ref.tag);
      assert.equal(prefs.session.restore_on_startup, 1, "continue where you left off");
      assert.deepEqual(prefs.session.startup_urls, ["https://example.test/"], "the session's other keys stay");
      assert.deepEqual([prefs.download.extra, prefs.savefile.extra, prefs.other.keep], [1, 2, true]);
      assert.equal(prefs.download.prompt_for_download, false);
      assert.match(prefs.download.default_directory, /\.downloads$/);
    } finally { await provider.release(ref); }
  }
});

test("a profile whose Preferences is not JSON still gets the setting; a session with no profile gets none", async (t) => {
  const root = await scratch(t, "cdp-prefs-");
  await mkdir(path.join(root, ".profiles", "odd", "Default"), { recursive: true });
  await writeFile(path.join(root, ".profiles", "odd", "Default", "Preferences"), "not json{");
  const provider = cdpProvider({ chrome: { executablePath: FAKE, profileRoot: root, sandbox: false } });
  const kept = await provider.create(spec(`prefs-${process.pid}-odd`, { name: "odd", save: false }), signal);
  try { assert.equal((await prefsOf(root, kept.tag)).session.restore_on_startup, 1); } finally { await provider.release(kept); }
  const plain = await provider.create(spec(`prefs-${process.pid}-plain`), signal);
  try {
    const prefs = await prefsOf(root, plain.tag);
    assert.equal(prefs.session, undefined, "a browser with no profile restores nothing: the default run is unchanged");
    assert.equal(prefs.download.prompt_for_download, false);
  } finally { await provider.release(plain); }
});

test("a kept profile's tab-restore files are removed before Chrome starts and nothing else of the profile is: its cookies, storage and extensions stay", async (t) => {
  const { access } = await import("node:fs/promises");
  const root = await scratch(t, "cdp-prefs-");
  const saved = path.join(root, ".profiles", "work", "Default");
  await mkdir(path.join(saved, "Sessions"), { recursive: true });
  await mkdir(path.join(saved, "Local Storage", "leveldb"), { recursive: true });
  for (const file of ["Sessions/Session_13300000000000000", "Sessions/Tabs_13300000000000000", "Current Session", "Current Tabs", "Last Session", "Last Tabs", "Cookies", "Local Storage/leveldb/000003.log", "Preferences"]) await writeFile(path.join(saved, file), file === "Preferences" ? "{}" : "x");
  const provider = cdpProvider({ chrome: { executablePath: FAKE, profileRoot: root, sandbox: false } });
  const exists = (file) => access(file).then(() => true, () => false);
  const ref = await provider.create(spec(`prefs-${process.pid}-tabs`, { name: "work", save: true }), signal);
  try {
    const lease = path.join(root, ref.tag, "Default");
    const gone = await Promise.all(["Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs"].map((f) => exists(path.join(lease, f))));
    assert.deepEqual(gone, [false, false, false, false, false], "no tab-restore file is left for Chrome to read");
    const kept = await Promise.all(["Cookies", "Local Storage/leveldb/000003.log"].map((f) => exists(path.join(lease, f))));
    assert.deepEqual(kept, [true, true], "the cookie store and the storage are untouched");
    assert.equal((await prefsOf(root, ref.tag)).session.restore_on_startup, 1, "and the session is still restored: the cookies come back");
  } finally { await provider.release(ref); }
});
