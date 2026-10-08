// The page tools on a real Chrome: the package's snapshot, run, screenshot and browser_read over the Stagehand driver
// and the cdp provider, on a pi-durable Harness over SQLite, driven by a scripted faux model in a child process
// (test/real-chrome/child.mjs) against a loopback site. Production's two `run` failure classes come back typed, and a
// form submitted by a `run` that a SIGKILL cut reaches the server once: the cut run is never rerun, the model is told,
// its identical repeat is refused, and the page the next process reattaches to shows the submission landed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { startSite } from "./fixtures/site.mjs";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "real-chrome", "child.mjs");
const chromeOf = (profileRoot) => {
  const out = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(profileRoot); } catch { return false; } });
  return out.map(Number);
};

function child(env, { killWhen } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, CHROME, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.stderr.on("data", (chunk) => { err += chunk; });
    killWhen?.then(() => proc.kill("SIGKILL"));
    proc.on("close", (code, signal) => resolve({ code, signal, out, err }));
  });
}

/** Whether this Chrome can load Stagehand's extension: the driver attached once, in this process, so a Chrome that
 *  refuses skips the test (or fails it under AGENTRUN_REQUIRE_LOCAL_CHROME=1) instead of failing inside the child. */
async function capable(t, dir) {
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(dir, "probe") } });
  const signal = new AbortController().signal;
  const ref = await provider.create({ tag: "probe", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} }, signal);
  try { await (await stagehandDriver()(await provider.attach(ref), signal)).close(); return true; }
  catch (error) { if (skipIncapable(t, error)) return false; throw error; }
  finally { await provider.release(ref); }
}

async function rig(t) {
  const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "real-chrome-"));
  // The slow page answers after the batch deadline: a timed-out batch keeps running in the browser until its command
  // ends (Stagehand's batch abort is checked between commands), so the next batch waits behind it, then runs.
  const site = await startSite({ slowMs: 5_000 });
  t.after(async () => {
    for (const pid of chromeOf(dir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await site.close();
    await rm(dir, { recursive: true, force: true });
  });
  const env = { DB: path.join(dir, "run.sqlite"), OUT: path.join(dir, "out.json"), PROFILE_ROOT: path.join(dir, "profiles") };
  return { capable: await capable(t, dir), dir, site, env, read: () => JSON.parse(fs.readFileSync(env.OUT, "utf8")) };
}

test("a run whose code throws is code_error and a run past the batch timeout is timeout, each with its retry flag", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const { capable: ok, site, env, read, dir } = await rig(t);
  if (!ok) return;
  const script = [["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }],
    ["run", { code: `throw new TypeError("fixture failure");` }],
    ["run", { code: `await page.goto(${JSON.stringify(`${site.base}/slow`)}); return "late";` }],
    ["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }],
    ["browser_read", {}]];
  const run = await child({ ...env, MODE: "second", SCRIPT: JSON.stringify(script), BATCH_TIMEOUT_MS: "3000" });
  assert.equal(run.code, 0, run.err.slice(-1500));
  const results = read().results;
  assert.equal(results[0].text, "Page A");
  const thrown = JSON.parse(results[1].text), slow = JSON.parse(results[2].text);
  assert.deepEqual([thrown.code, thrown.retryable, results[1].isError], ["code_error", true, true], results[1].text);
  assert.deepEqual([slow.code, slow.retryable, slow.effect, results[2].isError], ["timeout", true, "possibly_effected", true], results[2].text);
  assert.equal(results[3].text, "Page A", `the same session navigates once the slow page settles: ${results[3].text.slice(0, 500)}`);
  assert.match(results[4].text, /forty-two/, `and reads it: ${results[4].text.slice(0, 300)}`);
  assert.deepEqual(chromeOf(dir), [], "the release ended the local Chrome");
});

test("after a goto that never commits, browser_read and screenshot name the page the browser shows", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const { capable: ok, site, env, read, dir } = await rig(t);
  if (!ok) return;
  // The navigation starts and never commits (a 204; on Browserbase a PDF the browser downloads), so goto fails at its
  // start while page A stays loaded: every receipt filed afterwards is page A's, under page A's address.
  const script = [["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }],
    ["run", { code: `await page.goto(${JSON.stringify(`${site.base}/no-content`)}, { timeout: 1500 }); return "moved";` }],
    ["browser_read", {}],
    ["screenshot", {}]];
  const run = await child({ ...env, MODE: "second", SCRIPT: JSON.stringify(script) });
  assert.equal(run.code, 0, run.err.slice(-1500));
  const { results, filed } = read();
  const pageA = `${site.base}/a`;
  const urlLine = (text) => text.split("\n").find((line) => line.startsWith("url: "));
  assert.equal(results[1].isError, true, `the goto failed at navigation start: ${results[1].text.slice(0, 300)}`);
  assert.match(results[2].text, /forty-two/, `browser_read read page A: ${results[2].text.slice(0, 300)}`);
  assert.equal(urlLine(results[2].text), `url: ${pageA}`, "and names it");
  assert.equal(urlLine(results[3].text), `url: ${pageA}`, "so does the screenshot");
  assert.deepEqual(filed.map((receipt) => [receipt.tool, receipt.final_url]), [["browser_read", pageA], ["screenshot", pageA]], "each receipt is filed under page A");
  assert.deepEqual(chromeOf(dir), [], "the release ended the local Chrome");
});

test("a form submitted by a run a SIGKILL cut reaches the server once: the repeat is refused and the reattached page shows it landed", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const { capable: ok, site, env, read, dir } = await rig(t);
  if (!ok) return;
  const submit = `await page.locator("input[name=name]").fill("Ada Lovelace"); await page.getByRole("button", { name: "Submit" }).click(); await page.waitForSelector("#count"); return await page.locator("#count").innerText();`;
  const script = [["run", { code: `await page.goto(${JSON.stringify(`${site.base}/b`)}); return await page.title();` }], ["run", { code: submit }], ["run", { code: submit }], ["browser_read", { what: "text" }]];
  const landed = site.holdSubmissions();
  const first = await child({ ...env, MODE: "first", SCRIPT: JSON.stringify(script) }, { killWhen: landed });
  assert.equal(first.signal, "SIGKILL", `the first process was cut inside the submitting run: ${first.err.slice(-800)}`);
  assert.equal(site.submissions(), 1);
  site.release();
  assert.ok(chromeOf(dir).length > 0, "the local Chrome outlived the cut process, as a kept session does");

  const second = await child({ ...env, MODE: "second", SCRIPT: JSON.stringify(script) });
  assert.equal(second.code, 0, second.err.slice(-1500));
  const { results } = read();
  if (process.env.DEBUG_RESULTS) console.log("RESULTS", JSON.stringify(results.map((r) => ({ tool: r.tool, isError: r.isError, text: r.text.slice(0, 240) }))));
  assert.equal(site.submissions(), 1, "the cut run was not rerun and its repeat was refused: one submission in all");
  const [, cut, repeat, after] = results;
  assert.equal(cut.isError, true, "the cut run ended interrupted");
  const refused = JSON.parse(repeat.text.slice(repeat.text.indexOf("{")));
  assert.equal(refused.code, "effect_unknown", repeat.text);
  assert.match(after.text, /Submission 1 received for Ada Lovelace\./, `the reattached page is the one the cut run left: ${after.text.slice(0, 400)}`);
  assert.deepEqual(chromeOf(dir), [], "the release ended the local Chrome");
});
