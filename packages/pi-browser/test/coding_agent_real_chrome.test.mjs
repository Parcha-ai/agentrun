import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { startSite } from "./fixtures/site.mjs";
import { startAgent, turn } from "./coding-agent/rig.mjs";
import { scratchSync } from "./fixtures/scratch.mjs";

const processes = () => fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p)).flatMap((pid) => {
  try { return [{ pid: Number(pid), args: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\0 ]+/) }]; } catch { return []; }
});
/** Test files run in parallel, so a process scan also sees other files' Chromes: a test with a private TMPDIR names
 *  exactly the Chromes its own agent launched. */
const chromesIn = (dir) => processes().filter((p) => p.args.some((a) => a.startsWith("--user-data-dir=") && a.slice("--user-data-dir=".length).startsWith(dir + path.sep)));
const OUTER_TMP = process.env.TMPDIR || os.tmpdir();
/** The directory is removed by the scratch hook that runs after every other cleanup of the test, once whatever still names it is killed; a test
 *  never removes it itself, because a Chrome may still be writing into it when its own hook would run. */
function privateTmp(t) {
  const outer = process.env.TMPDIR;
  const dir = scratchSync(t, "chrome-scope-");
  process.env.TMPDIR = dir;
  t.after(() => { if (outer === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = outer; }, { timeout: 30_000 });
  return dir;
}
/** A Chrome of the same command-line shape as another test file's; it must be running and seen by the scan before the
 *  test goes on, or a decoy that died would leave the test checking nothing. */
async function startDecoy(t) {
  const profile = path.join(OUTER_TMP, `pi-browser-decoy-${process.pid}-${Date.now()}`, "profile");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", "--", `--user-data-dir=${profile}`, "--remote-debugging-port=1"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"), { timeout: 30_000 });
  const seen = () => child.exitCode === null && processes().some((p) => p.pid === child.pid && p.args.includes(`--user-data-dir=${profile}`));
  await until(seen, 5_000).catch(() => { throw new Error("the decoy Chrome never appeared in the process scan, so this test would check nothing"); });
  assert.equal(child.exitCode, null, "the decoy is still running");
  return child;
}
const portOf = (p) => Number(p.args.find((a) => a.startsWith("--remote-debugging-port="))?.split("=")[1]);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, ms = 10_000) => { for (const end = Date.now() + ms; !check(); ) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); } };

async function rig(t, flags = {}) {
  const site = await startSite();
  t.after(() => site.close(), { timeout: 30_000 });
  // A CI runner's Chrome cannot start its sandbox (the reason Stagehand adds --no-sandbox when `CI` is set); a
  // developer's own Chrome keeps it.
  const env = { PI_BROWSER_CHROME: CHROME, PATH: process.env.PATH ?? "", ...(process.env.CI ? { PI_BROWSER_NO_SANDBOX: "1" } : {}) };
  const agent = await startAgent(t, { extension: { env }, flags });
  return { site, agent };
}

test("the default provider starts its own Chrome, which reads a page through the tools and is gone after browser_release", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const tmp = privateTmp(t);
  const { site, agent } = await rig(t);
  await startDecoy(t);
  let results;
  try {
    results = await agent.run(turn(["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }]));
  } catch (error) { if (skipIncapable(t, error)) return; throw error; }
  if (results[0].isError && skipIncapable(t, { message: results[0].text })) return;
  assert.equal(results[0].isError, false, results[0].text);
  assert.match(results[0].text, /Page A/);
  const mine = chromesIn(tmp);
  assert.ok(mine.length > 0, "a Chrome was started");
  const main = mine.find((p) => !p.args.some((a) => a.startsWith("--type=")));
  assert.notEqual(portOf(main), 9222, "never the always-on browser's port");
  assert.ok(/--user-data-dir=.*pi-browser-[^/]+\/[A-Za-z0-9_.-]+$/.test(main.args.find((a) => a.startsWith("--user-data-dir="))), "its own profile directory under a temporary root");
  assert.ok(main.args.includes("--headless=new"), "headless unless the person asks for a window");
  const [read, shot] = await agent.run(turn(["browser_read"]), turn(["screenshot", { type: "jpeg", quality: 40 }]));
  assert.match(read.text, /The answer is forty-two/);
  assert.ok(shot.result.content.some((part) => part.type === "image"));
  const receipt = fs.readFileSync(path.join(agent.work, ".pi/browser/evidence/browser/0001-browser_read.md"), "utf8");
  assert.match(receipt, new RegExp(`\\nfinal_url: ${site.base}/a\\n`));
  const [released] = await agent.run(turn(["browser_release"]));
  assert.equal(JSON.parse(released.text).released, true);
  await until(() => mine.every((p) => !alive(p.pid)));
  assert.deepEqual(chromesIn(tmp), [], "no Chrome of this run is left");
});

test("ending the session closes the Chrome the agent left open, and its profile directory goes with it", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const tmp = privateTmp(t);
  const { site, agent } = await rig(t);
  await startDecoy(t);
  let results;
  try {
    results = await agent.run(turn(["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }]));
  } catch (error) { if (skipIncapable(t, error)) return; throw error; }
  if (results[0].isError && skipIncapable(t, { message: results[0].text })) return;
  assert.equal(results[0].isError, false, results[0].text);
  const mine = chromesIn(tmp);
  const profile = mine.flatMap((p) => p.args).find((a) => a.startsWith("--user-data-dir=")).split("=")[1];
  assert.ok(fs.existsSync(profile));
  await agent.dispose();
  await until(() => mine.every((p) => !alive(p.pid)));
  assert.ok(!fs.existsSync(path.dirname(profile)), "the temporary profile root is removed");
});

test("a resumed session kills the Chrome a crashed process left running, by its own process, and opens a fresh one", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const tmp = privateTmp(t);
  const { site, agent: first } = await rig(t);
  await startDecoy(t);
  let results;
  try {
    results = await first.run(turn(["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }]));
  } catch (error) { if (skipIncapable(t, error)) return; throw error; }
  if (results[0].isError && skipIncapable(t, { message: results[0].text })) return;
  assert.equal(results[0].isError, false, results[0].text);
  const orphan = chromesIn(tmp);
  assert.ok(orphan.length > 0);
  // The first process never shuts down; a second one opens its session file.
  const env = { PI_BROWSER_CHROME: CHROME, PATH: process.env.PATH ?? "", ...(process.env.CI ? { PI_BROWSER_NO_SANDBOX: "1" } : {}) };
  const second = await startAgent(t, { extension: { env }, sessionFile: first.sessionFile(), dir: first.root, cwd: first.work });
  await until(() => orphan.every((p) => !alive(p.pid)));
  const [fresh] = await second.run(turn(["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }]));
  assert.equal(fresh.isError, false, fresh.text);
  assert.match(fresh.text, /Page A/);
});

test("a Chrome the person named that does not exist is refused by name, never replaced by another", { timeout: 60_000 }, async (t) => {
  const tmp = privateTmp(t);
  const agent = await startAgent(t, { extension: { env: { PI_BROWSER_CHROME: "/nonexistent/chrome", PATH: process.env.PATH ?? "" } } });
  await startDecoy(t);
  const [snap] = await agent.run(turn(["snapshot"]));
  assert.equal(snap.isError, true);
  const answer = JSON.parse(snap.text);
  assert.equal(answer.code, "browser_unavailable");
  assert.match(answer.message, /\/nonexistent\/chrome, does not exist/);
  assert.deepEqual(chromesIn(tmp), [], "no Chrome was started by this agent");
  assert.deepEqual(fs.readdirSync(tmp).filter((d) => d.startsWith("pi-browser-")), [], "and it made no profile root to start one in");
});

test("browserbase is asked for by flag and refused, naming the key, when none is set", { timeout: 60_000 }, async (t) => {
  const agent = await startAgent(t, { extension: { env: { PATH: process.env.PATH ?? "" } }, flags: { "browser-provider": "browserbase" } });
  const [snap] = await agent.run(turn(["snapshot"]));
  assert.equal(snap.isError, true);
  const answer = JSON.parse(snap.text);
  assert.equal(answer.code, "auth");
  assert.match(answer.message, /BROWSERBASE_API_KEY/);
  assert.doesNotMatch(answer.message, /bb_(live|test)_/);
});

/** A process that names `dir` on its command line and keeps adding files to it until it is killed: a Chrome still writing into its profile when a test's
 *  own cleanup reaches the directory. Resolves once it is writing. */
function lateWriter(t, dir) {
  const writer = spawn(process.execPath, ["-e", `
    const fs = require("node:fs"), path = require("node:path");
    const dir = process.argv[1];
    fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
    for (let i = 0; i < 3000; i += 1) fs.writeFileSync(path.join(dir, "Default", "old-" + i), "x");
    process.stdout.write("writing\\n");
    let n = 0, last = 0;
    for (;;) { const now = performance.now(); if (now - last < 25) continue; last = now; try { fs.writeFileSync(path.join(dir, "Default", "new-" + n++), "x"); } catch {} }
  `, dir], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { try { writer.kill("SIGKILL"); } catch {} }, { timeout: 30_000 });
  return new Promise((resolve, reject) => { writer.stdout.once("data", () => resolve(writer)); writer.once("exit", () => reject(new Error("the writer ended without writing"))); });
}

test("a directory a process is still writing into when the test ends is removed by the teardown, which kills what names it first", { timeout: 60_000 }, async (t) => {
  const tmp = privateTmp(t);
  const writer = await lateWriter(t, path.join(tmp, "pib-late"));
  assert.equal(writer.exitCode, null, "the writer is running as the test ends");
});
