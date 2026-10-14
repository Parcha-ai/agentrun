import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { startSite } from "./fixtures/site.mjs";

const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("two copies of the README quick start run at once against real Chromes, each printing the page's snapshot and leaving no profile behind", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const readme = fs.readFileSync(path.join(PACKAGE, "README.md"), "utf8");
  const section = readme.split(/^## /m).find((part) => part.startsWith("Quick start"));
  assert.ok(section, "the README has a Quick start section");
  const code = /```js\n([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(code, "the quick start is one js block");
  const site = await startSite();
  const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "readme-example-"));
  const chromes = () => fs.readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).filter((pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(dir); } catch { return false; } });
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    for (const pid of chromes()) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    await site.close();
    await rm(dir, { recursive: true, force: true });
  });
  const script = path.join(dir, "quick-start.mjs");
  fs.writeFileSync(script, code);
  fs.symlinkSync(path.join(PACKAGE, "..", "..", "node_modules"), path.join(dir, "node_modules"));
  const env = { ...process.env, TMPDIR: dir, CHROME_PATH: CHROME, ...(process.env.CI ? { PI_BROWSER_NO_SANDBOX: "1" } : {}) };
  const start = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, `${site.base}/a`], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const deadline = setTimeout(() => child.kill("SIGKILL"), 90_000);
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (status) => { clearTimeout(deadline); resolve({ status, out, err }); });
  });
  const runs = await Promise.all([start(), start()]);
  for (const run of runs) {
    assert.equal(run.status, 0, run.err.slice(-1500));
    assert.match(run.out, /The answer is forty-two/);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("pi-browser-")), [], "each run removed its own profile root");
});
