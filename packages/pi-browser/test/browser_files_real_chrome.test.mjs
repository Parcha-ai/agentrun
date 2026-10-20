import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { pageTools, workspaceFiles } from "../dist/index.js";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { startSite, totp } from "./fixtures/site.mjs";

const LOOPBACK_ONLY = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const parse = (out) => JSON.parse(out.content[0].text);
const scratch = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), { timeout: 30_000 });
  return dir;
};
const until = async (check, ms, what) => {
  for (const end = Date.now() + ms; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`${what} within ${ms} ms`);
  }
};

test("workspace files go into a real page and downloads come back into the workspace; the shared fixture site behaves", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const site = await startSite();
  t.after(() => site.close(), { timeout: 30_000 });
  const root = scratch(t, "files-chrome-");
  const workspace = scratch(t, "files-chrome-ws-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK_ONLY] } });
  const signal = new AbortController().signal;
  let ref, driver;
  try {
    ref = await provider.create(spec("files-1"), signal);
    driver = await stagehandDriver()(await provider.attach(ref), signal, { batchTimeoutMs: 10_000 });
  } catch (error) { if (ref) await provider.release(ref); if (skipIncapable(t, error)) return; throw error; }
  t.after(async () => { await driver.close().catch(() => undefined); await provider.release(ref); }, { timeout: 30_000 });
  const port = {
    session: async () => ({ driver, tag: ref.tag, sessionId: ref.id, record: { lastUrl: null }, notice: null, interrupted: null, recorded: false, effects: null, downloads: provider.downloads }),
    dispatching: async () => {}, journal: async () => {}, mark: async () => {}, settle: async () => {}, ended: async () => false, dropped: async () => {},
  };
  const call = { callId: "c1", conversationId: 1, signal: undefined, label: "node", redact: (text) => text, evidence: { file: async () => null }, workspace, files: workspaceFiles(workspace) };
  const tools = pageTools();
  const goto = (route) => driver.run({ code: `await page.goto(${JSON.stringify(`${site.base}${route}`)}); return await page.title();` });
  const textOf = (selector) => driver.run({ code: `await page.waitForSelector(${JSON.stringify(selector)}, { timeout: 5000 }); return await page.locator(${JSON.stringify(selector)}).innerText();` });
  const submit = async (fields, button = "button[type=submit]") => {
    const fills = Object.entries(fields).map(([name, value]) => `await page.locator(${JSON.stringify(`input[name=${name}]`)}).fill(${JSON.stringify(value)});`).join(" ");
    await driver.run({ code: `${fills} await page.locator(${JSON.stringify(button)}).click(); return true;` });
  };

  await t.test("browser_upload puts a workspace file in the page's input: the page and the server both see its SHA-256", async () => {
    const bytes = randomBytes(64 * 1024);
    fs.writeFileSync(path.join(workspace, "scan.bin"), bytes);
    assert.equal(await goto("/upload"), "Upload");
    const out = parse(await tools.browser_upload({ path: "scan.bin", selector: "#file" }, port, call));
    assert.deepEqual(out.uploaded, { name: "scan.bin", bytes: bytes.length, sha256: sha(bytes) });
    assert.equal(await until(async () => (await textOf("#chosen")).trim() || null, 10_000, "the page hashed the chosen file"), `scan.bin ${bytes.length} ${sha(bytes)}`);
    await driver.run({ code: `await page.locator("#upload button").click(); return true;` });
    assert.equal(await until(() => textOf("#received"), 10_000, "the server echoed the upload"), `scan.bin ${bytes.length} ${sha(bytes)}`);
    assert.deepEqual(site.uploads(), [{ name: "scan.bin", bytes: bytes.length, sha256: sha(bytes) }]);
  });

  await t.test("a refused path never reaches the page", async () => {
    const out = await tools.browser_upload({ path: "../escape.bin", selector: "#file" }, port, call);
    assert.deepEqual([out.isError, parse(out).code], [true, "refused"]);
  });

  await t.test("browser_downloads copies a file the page downloaded into the workspace, with its SHA-256 in the manifest", async () => {
    assert.equal(await goto("/files"), "Files");
    await driver.run({ code: `await page.locator("#download").click(); return true;` });
    await until(async () => (await provider.downloads.list(ref)).some((file) => file.name === "report.csv"), 20_000, "Chrome finished the download");
    const out = parse(await tools.browser_downloads({}, port, call));
    assert.deepEqual(out.fetched.map((file) => [file.name, file.sha256]), [["report.csv", sha(site.files["report.csv"])]]);
    assert.deepEqual(fs.readFileSync(path.join(workspace, "downloads", "report.csv")), site.files["report.csv"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "downloads", "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files.map((row) => [row.path, row.sha256, row.session]), [["downloads/report.csv", sha(site.files["report.csv"]), ref.id]]);
  });

  await t.test("the fixture's one-step and two-step sign-ins land on the account page", async () => {
    assert.equal(site.credentials.username, "fixture-user");
    await goto("/login");
    await submit(site.credentials);
    assert.equal(await until(() => textOf("#who"), 10_000, "signed in"), "Signed in as fixture-user");
    assert.equal(await textOf("#account"), "fixture-user");
    await goto("/login2");
    await submit({ username: site.credentials.username });
    assert.equal(await until(() => driver.run({ code: "return await page.title();" }).then((title) => title === "Sign in, step 2" && title), 10_000, "step 2"), "Sign in, step 2");
    await submit({ password: site.credentials.password });
    assert.equal(await until(() => textOf("#who"), 10_000, "signed in"), `Signed in as ${site.credentials.username}`);
  });

  await t.test("the fixture's TOTP enrolment shows a base32 key, takes a code computed from it, then asks a code at sign-in", async () => {
    await goto("/totp-enrol");
    const key = (await textOf("#totp-secret")).trim();
    assert.match(key, /^[A-Z2-7]{32}$/);
    assert.equal(key, site.totpSecret());
    await submit({ code: totp(key) });
    assert.equal(await until(() => textOf("#enrolled"), 10_000, "enrolled"), "Two-factor sign-in is on.");
    await goto("/login");
    await submit(site.credentials);
    assert.equal(await until(() => driver.run({ code: "return await page.title();" }).then((title) => title === "Two-factor code" && title), 10_000, "the code step"), "Two-factor code");
    await submit({ code: totp(key) });
    assert.equal(await until(() => textOf("#who"), 10_000, "signed in"), `Signed in as ${site.credentials.username}`);
  });

  await t.test("the fixture's captcha refuses a script's click and takes a click from the browser's input", async () => {
    await goto("/captcha");
    await driver.run({ code: `await page.evaluate(() => document.getElementById("human").click()); return true;` });
    assert.equal(await until(() => textOf("#status").then((s) => s.startsWith("Only") && s), 5_000, "the script's click was refused"), "Only a person can press this.");
    assert.equal(site.human(), false);
    await driver.run({ code: `await page.locator("#human").click(); return true;` });
    assert.equal(await until(() => textOf("#status").then((s) => s.startsWith("Thanks") && s), 5_000, "the trusted click passed"), "Thanks, you are human.");
    assert.equal(site.human(), true);
  });
});
