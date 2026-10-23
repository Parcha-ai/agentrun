// The local Chrome's arguments: its DevTools socket allows exactly the Stagehand extension's Origin, and a directory that cannot be
// resolved refuses the launch rather than allowing every Origin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromeArgs, extensionDirectory, extensionOrigin } from "../dist/providers/chrome-args.js";

const origins = (args) => args.filter((arg) => arg.startsWith("--remote-allow-origins="));

test("Chrome is started with one allowed Origin, the extension's, never every Origin", () => {
  const args = chromeArgs({ userDataDir: "/tmp/profile", viewport: { width: 800, height: 600 }, headless: true, sandbox: true });
  assert.deepEqual(origins(args), [`--remote-allow-origins=${extensionOrigin()}`]);
  assert.equal(args.some((arg) => arg.includes("*") && arg.startsWith("--remote-allow-origins")), false);
  assert.match(extensionOrigin(), /^chrome-extension:\/\/[a-p]{32}$/);
});

test("the extension's id is Chrome's for an unpacked extension: the SHA-256 of its real path, a symlink resolved, its digits written a to p", (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "chrome-args-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "extension");
  fs.mkdirSync(real);
  const link = path.join(root, "linked");
  fs.symlinkSync(real, link);
  const expected = `chrome-extension://${[...createHash("sha256").update(fs.realpathSync(real)).digest("hex").slice(0, 32)].map((d) => String.fromCharCode(97 + parseInt(d, 16))).join("")}`;
  assert.equal(extensionOrigin(real), expected);
  assert.equal(extensionOrigin(link), expected, "a symlinked directory names the same extension");
  assert.ok(fs.existsSync(extensionDirectory()), "Stagehand's own extension directory is there");
});

test("a directory that cannot be resolved refuses the launch with its reason, and never opens the socket to every Origin", () => {
  const missing = path.join(os.tmpdir(), "no-such-stagehand-extension-dir");
  assert.throws(() => extensionOrigin(missing), (error) => error.failure?.code === "browser_unavailable" && error.message.includes(missing) && /ENOENT/.test(error.message));
});

test("the public ./providers/chrome-args export is exactly what the cdp provider starts Chrome with", async (t) => {
  const { chromeArgs: published, extensionOrigin: publishedOrigin } = await import("@parcha/pi-browser/providers/chrome-args");
  const { cdpProvider } = await import("../dist/providers/cdp.js");
  const { scratch } = await import("./fixtures/scratch.mjs");
  const root = await scratch(t, "chrome-args-launch-");
  const provider = cdpProvider({ chrome: { executablePath: path.join(import.meta.dirname, "fixtures", "fake-chrome.mjs"), profileRoot: root, sandbox: false } });
  const spec = { tag: `args-${process.pid}`, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} };
  const ref = await provider.create(spec, new AbortController().signal);
  t.after(() => provider.release(ref));
  const recorded = fs.readdirSync(root, { recursive: true }).find((file) => String(file).endsWith("fake-chrome.json"));
  const { argv } = JSON.parse(fs.readFileSync(path.join(root, String(recorded)), "utf8"));
  const userDataDir = argv.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
  assert.deepEqual(argv, [...published({ userDataDir, viewport: spec.viewport, headless: true, sandbox: false }), "about:blank"]);
  assert.ok(argv.includes(`--remote-allow-origins=${publishedOrigin()}`));
});
