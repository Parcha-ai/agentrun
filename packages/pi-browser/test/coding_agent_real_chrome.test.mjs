// The adapter's default, as a person gets it: no provider is passed, so the coding agent starts a local Chrome of its own
// (its own profile directory and a free debugging port, never a browser the person is using), drives it through
// Stagehand, files what it reads, and leaves no Chrome behind once the browser is released or the session ends.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { startSite } from "./fixtures/site.mjs";
import { startAgent, turn } from "./coding-agent/rig.mjs";

const processes = () => fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p)).flatMap((pid) => {
  try { return [{ pid: Number(pid), args: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\0 ]+/) }]; } catch { return []; }
});
/** The Chromes whose profile is under `dir`. Test files run in parallel on one machine, so a scan of every process also sees the
 *  Chromes other files start; the adapter makes its profile root under TMPDIR, so a test that gives itself a private TMPDIR can
 *  name exactly the Chromes its own agent launched. */
const chromesIn = (dir) => processes().filter((p) => p.args.some((a) => a.startsWith("--user-data-dir=") && a.slice("--user-data-dir=".length).startsWith(dir + path.sep)));
/** The machine's temporary directory as the test process was started, before any test gives itself a private one. */
const OUTER_TMP = process.env.TMPDIR || os.tmpdir();
/** A private TMPDIR for one test (restored afterwards): everything its agent creates, profile root included, lives under it. */
function privateTmp(t) {
  const outer = process.env.TMPDIR;
  const dir = fs.mkdtempSync(path.join(OUTER_TMP, "chrome-scope-"));
  process.env.TMPDIR = dir;
  t.after(() => { if (outer === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = outer; });
  return dir;
}
/** A Chrome some other test file started while this test runs: files run in parallel, and its command line has the same shape. It
 *  must be running and seen by the process scan before the test goes on, or a decoy that died would leave the test checking nothing. */
async function startDecoy(t) {
  const profile = path.join(OUTER_TMP, `pi-browser-decoy-${process.pid}-${Date.now()}`, "profile");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", "--", `--user-data-dir=${profile}`, "--remote-debugging-port=1"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const seen = () => child.exitCode === null && processes().some((p) => p.pid === child.pid && p.args.includes(`--user-data-dir=${profile}`));
  await until(seen, 5_000).catch(() => { throw new Error("the decoy Chrome never appeared in the process scan, so this test would check nothing"); });
  assert.equal(child.exitCode, null, "the decoy is still running");
  return child;
}
/** Remove `dir` after the test's agents are shut down: `t.after` hooks run in the order they were registered, so this is called
 *  after the agent is started. Chrome may still be exiting, hence the retries. */
const removeLast = (t, dir) => t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const portOf = (p) => Number(p.args.find((a) => a.startsWith("--remote-debugging-port="))?.split("=")[1]);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, ms = 10_000) => { for (const end = Date.now() + ms; !check(); ) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); } };

async function rig(t, flags = {}) {
  const site = await startSite();
  t.after(() => site.close());
  // A CI runner's Chrome cannot start its sandbox (the same reason Stagehand adds --no-sandbox when `CI` is set); a
  // developer's own Chrome keeps it.
  const env = { PI_BROWSER_CHROME: CHROME, PATH: process.env.PATH ?? "", ...(process.env.CI ? { PI_BROWSER_NO_SANDBOX: "1" } : {}) };
  const agent = await startAgent(t, { extension: { env }, flags });
  return { site, agent };
}

test("the default provider starts its own Chrome, which reads a page through the tools and is gone after browser_release", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const tmp = privateTmp(t);
  const { site, agent } = await rig(t);
  removeLast(t, tmp);
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
  removeLast(t, tmp);
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
  removeLast(t, tmp);
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
  removeLast(t, tmp); // after the second agent's shutdown hook too
  await until(() => orphan.every((p) => !alive(p.pid)));
  const [fresh] = await second.run(turn(["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }]));
  assert.equal(fresh.isError, false, fresh.text);
  assert.match(fresh.text, /Page A/);
});

test("a Chrome the person named that does not exist is refused by name, never replaced by another", { timeout: 60_000 }, async (t) => {
  const tmp = privateTmp(t);
  const agent = await startAgent(t, { extension: { env: { PI_BROWSER_CHROME: "/nonexistent/chrome", PATH: process.env.PATH ?? "" } } });
  removeLast(t, tmp);
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
