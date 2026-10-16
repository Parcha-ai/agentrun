import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { startSite } from "./fixtures/site.mjs";

const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = path.join(PACKAGE, "examples");
const listed = () => fs.readdirSync(EXAMPLES).filter((name) => name.endsWith(".mjs")).sort();
const NO_PDFTOTEXT = (() => { try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return false; } catch { return "needs poppler's pdftotext"; } })();

test("the README's Demos section names every example and every example it names exists", () => {
  const readme = fs.readFileSync(path.join(PACKAGE, "README.md"), "utf8");
  const section = readme.split(/^## /m).find((part) => part.startsWith("Demos"));
  assert.ok(section, "the README has a Demos section");
  const named = [...new Set([...section.matchAll(/\]\(examples\/([\w.-]+\.mjs)\)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(named, listed());
  for (const name of named) assert.ok(section.includes(`node packages/pi-browser/examples/${name}`), `${name} has its run command`);
});

test("an example is a runnable demo of 40 lines or fewer, never a placeholder", () => {
  assert.ok(listed().length >= 4);
  for (const name of listed()) {
    const text = fs.readFileSync(path.join(EXAMPLES, name), "utf8");
    assert.ok(text.split("\n").length <= 41, `${name} is over 40 lines`);
    assert.doesNotMatch(text, /skipped|not yet|TODO|placeholder/i, `${name} is a placeholder`);
    assert.match(text, /^\/\/ /, `${name} opens with what it shows`);
  }
});

/** Runs an example as a child, killed on a deadline; its Chromes (found by the directory their profile lives under) are killed with it. */
function sandbox(t) {
  const children = [];
  const state = { dir: null };
  const chromes = () => fs.readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).filter((pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(state.dir); } catch { return false; } });
  const ready = mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "examples-")).then((dir) => { state.dir = dir; });
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    for (const pid of chromes()) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    await rm(state.dir, { recursive: true, force: true });
  }, { timeout: 30_000 });
  const run = (name, args = [], env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(EXAMPLES, name), ...args], { cwd: PACKAGE, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: state.dir, CHROME_PATH: CHROME, ...(process.env.CI ? { PI_BROWSER_NO_SANDBOX: "1" } : {}), ...env } });
    children.push(child);
    const deadline = setTimeout(() => child.kill("SIGKILL"), 100_000);
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (status, signal) => { clearTimeout(deadline); resolve({ status, signal, out, err }); });
  });
  return { ready, run, chromes, get dir() { return state.dir; } };
}

test("one-script-three-providers runs on a local Chrome, names an unknown provider, and names the key a hosted provider lacks", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const site = await startSite();
  t.after(() => site.close(), { timeout: 30_000 });
  const box = sandbox(t);
  await box.ready;
  const local = await box.run("one-script-three-providers.mjs", [`${site.base}/a`], { PI_BROWSER_PROVIDER: "cdp" });
  assert.equal(local.status, 0, local.err.slice(-1500));
  assert.match(local.out, /^cdp: \[\S+\] RootWebArea: Page A/);
  assert.deepEqual(fs.readdirSync(box.dir).filter((name) => name.startsWith("pi-browser-")), [], "the profile root is gone");
  const noChrome = await box.run("one-script-three-providers.mjs", [], { PI_BROWSER_PROVIDER: "cdp", CHROME_PATH: path.join(box.dir, "no-such-chrome") });
  assert.notEqual(noChrome.status, 0, "a Chrome that cannot start fails the demo");
  assert.deepEqual(fs.readdirSync(box.dir).filter((name) => name.startsWith("pi-browser-")), [], "a failed start leaves no profile root");
  const unknown = await box.run("one-script-three-providers.mjs", [], { PI_BROWSER_PROVIDER: "nope" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.err, /PI_BROWSER_PROVIDER is nope; use cdp, browserbase or kernel/);
  for (const [provider, key] of [["browserbase", "BROWSERBASE_API_KEY"], ["kernel", "KERNEL_API_KEY"]]) {
    const refused = await box.run("one-script-three-providers.mjs", [], { PI_BROWSER_PROVIDER: provider, [key]: "", BB_API_KEY: "" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.err, new RegExp(`${key} is not set`));
  }
});

test("hold-an-irreversible-action holds the form post and the server never sees it", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const box = sandbox(t);
  await box.ready;
  const failed = await box.run("hold-an-irreversible-action.mjs", [], { CHROME_PATH: path.join(box.dir, "no-such-chrome") });
  assert.notEqual(failed.status, 0, failed.err.slice(-800));
  assert.equal(failed.signal, null, "a failed start still lets the process exit: its server is closed");
  assert.deepEqual(fs.readdirSync(box.dir).filter((name) => name.startsWith("pi-browser-")), [], "a failed start leaves no profile root");
  const run = await box.run("hold-an-irreversible-action.mjs");
  assert.equal(run.status, 0, run.err.slice(-1500));
  assert.match(run.out, /held POST \/: refused/);
  assert.match(run.out, /posts that reached the server: 0/);
});

test("crash-and-resume: the first run dies by SIGKILL with its Chrome still up, the second finds the same page and leaves no Chrome", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const box = sandbox(t);
  await box.ready;
  const env = { DEMO_DIR: path.join(box.dir, "state") };
  const first = await box.run("crash-and-resume.mjs", [], env);
  assert.equal(first.signal, "SIGKILL", first.err.slice(-1500));
  assert.ok(box.chromes().length > 0, "the Chrome outlived the killed process");
  const second = await box.run("crash-and-resume.mjs", [], env);
  assert.equal(second.status, 0, second.err.slice(-1500));
  assert.match(second.out, /title: set before the crash/);
  assert.equal(box.chromes().length, 0, "the second run released the Chrome");
});

test("read-a-pdf extracts the text of a PDF the fetch service would not convert", { skip: NO_PDFTOTEXT, timeout: 60_000 }, async (t) => {
  const box = sandbox(t);
  await box.ready;
  const run = await box.run("read-a-pdf.mjs");
  assert.equal(run.status, 0, run.err.slice(-1500));
  assert.match(run.out, /via: demo_fetch\n/);
  assert.match(run.out, /Invoice 4471 is due/);
});

test("the README's no-key command runs in an empty environment and prints the fake page's snapshot", { timeout: 100_000 }, async (t) => {
  const readme = fs.readFileSync(path.join(PACKAGE, "README.md"), "utf8");
  const section = readme.split(/^## /m).find((part) => part.startsWith("Try it without a key or a Chrome"));
  assert.ok(section, "the README has the section");
  const blocks = [...section.matchAll(/^```(\S*)\n([\s\S]*?)^```/gm)];
  const command = blocks.find((m) => m[1] === "sh")?.[2];
  const printed = blocks.find((m) => m[1] === "")?.[2];
  assert.ok(command && printed, "an sh block with the command and a plain block with its output");
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "no-key-home-"));
  t.after(() => rm(home, { recursive: true, force: true }), { timeout: 30_000 });
  const run = spawnSync("/usr/bin/env", ["-i", `PATH=${process.env.PATH}`, `HOME=${home}`, "sh", "-c", command], { cwd: PACKAGE, encoding: "utf8", timeout: 90_000 });
  assert.equal(run.status, 0, run.stderr.slice(-1500));
  assert.equal(run.stdout, printed, "the README shows what the command prints");
  assert.equal(run.stderr, "");
});
