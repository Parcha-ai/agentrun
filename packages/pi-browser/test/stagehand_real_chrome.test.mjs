import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cdpCall } from "../dist/core/cdp-call.js";
import { DEFAULT_BATCH_TIMEOUT_MS, stagehandDriver } from "../dist/driver/stagehand.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { COPY, STAGEHAND_EXTENSION } from "../dist/providers/worker-extension.js";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { scratch } from "./fixtures/scratch.mjs";
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
    // When each of the child's lines arrived, in order.
    const lines = [];
    let partial = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk;
      const parts = (partial + chunk).split("\n");
      partial = parts.pop();
      const at = Date.now();
      for (const text of parts) if (text) lines.push({ at, text });
    });
    proc.stderr.on("data", (chunk) => { err += chunk; });
    killWhen?.then(() => proc.kill("SIGKILL"));
    const began = Date.now();
    proc.on("close", (code, signal) => resolve({ code, signal, out, err, lines, ms: Date.now() - began }));
  });
}

/** The Stagehand extension the local Chrome under `profileRoot` holds, asked of the browser itself (its socket, from the
 *  DevToolsActivePort file Chrome writes in its profile). */
async function loadedStagehand(profileRoot) {
  const [profile] = fs.readdirSync(profileRoot).map((name) => path.join(profileRoot, name)).filter((dir) => fs.existsSync(path.join(dir, "DevToolsActivePort")));
  assert.ok(profile, `a Chrome is running on a profile under ${profileRoot}`);
  const [port, browserPath] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
  const session = await cdpCall(`ws://127.0.0.1:${port}${browserPath}`, "Extensions.getExtensions");
  try { return session.result.extensions.filter((e) => e.name === STAGEHAND_EXTENSION && e.enabled); } finally { session.close(); }
}

/** What a run's code logs once it is parked, for workerLogged to see. */
const PARKED = "stagehand_real_chrome: parked";
/** Resolves once the Stagehand extension's worker in the local Chrome under `profileRoot` logs `line` to its console: run code
 *  executes in that worker, so this is how a test sees where it got to. The browser's socket comes from the DevToolsActivePort
 *  file Chrome writes in its profile, waited for; enabling Runtime on the worker reports what it logged before, too. */
function workerLogged(profileRoot, line, withinMs = 120_000) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + withinMs;
    let socket = null, nextId = 0;
    const replies = new Map();
    // Every worker the extension starts is watched: the one running when the watch begins may be replaced (a restart, a reload).
    const watched = new Set();
    const send = (method, params = {}, sessionId) => new Promise((answer, fail) => {
      const id = ++nextId;
      replies.set(id, (reply) => (reply.error ? fail(new Error(`${method}: ${reply.error.message}`)) : answer(reply.result)));
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const done = (error) => { socket?.close(); clearTimeout(timer); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => done(new Error(`the extension's worker did not log "${line}" within ${withinMs} ms (${socket ? `${watched.size} worker(s) watched` : "no DevTools socket found"})`)), withinMs);
    const port = () => {
      if (!fs.existsSync(profileRoot)) return null;
      const profile = fs.readdirSync(profileRoot).map((name) => path.join(profileRoot, name)).find((dir) => fs.existsSync(path.join(dir, "DevToolsActivePort")));
      const [at, browserPath] = profile ? fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n") : [];
      return at && browserPath ? `ws://127.0.0.1:${at}${browserPath}` : null;
    };
    const watch = async () => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.method === "Target.targetCreated") {
          const target = message.params.targetInfo;
          if (target.type !== "service_worker" || !target.url.startsWith("chrome-extension://") || watched.has(target.targetId)) return;
          watched.add(target.targetId);
          send("Target.attachToTarget", { targetId: target.targetId, flatten: true })
            .then(({ sessionId }) => send("Runtime.enable", {}, sessionId)).catch(() => undefined);
        }
        if (message.method === "Runtime.consoleAPICalled" && message.params.args?.[0]?.value === line) done();
      });
      // Reports every target there is now as created, then each one as it comes.
      await send("Target.setDiscoverTargets", { discover: true });
    };
    const open = () => {
      const url = port();
      if (!url) { if (Date.now() < until) setTimeout(open, 50); return; }
      socket = new WebSocket(url);
      socket.addEventListener("message", (event) => { const reply = JSON.parse(String(event.data)); replies.get(reply.id)?.(reply); replies.delete(reply.id); });
      socket.addEventListener("open", () => { watch().catch(done); });
      socket.addEventListener("error", () => done(new Error(`the DevTools socket at ${url} failed`)));
    };
    open();
  });
}

/** From the child's last step to its DONE: the model's last turn, the release (the driver's close, then the session's) and
 *  the child's own close. */
function releaseMs(run) {
  const step = run.lines.findLast((line) => line.text.startsWith("STEP "));
  const done = run.lines.find((line) => line.text === "DONE");
  assert.ok(step && done, `the child stepped and finished: ${run.out.slice(-500)}`);
  return done.at - step.at;
}

/** The driver attaches once in this process, so a Chrome that cannot load the extension skips the test instead of
 *  failing inside the child. */
async function capable(t, dir) {
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(dir, "probe") } });
  const signal = new AbortController().signal;
  const ref = await provider.create({ tag: "probe", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} }, signal);
  try { await (await stagehandDriver()(await provider.attach(ref), signal)).close(); return true; }
  catch (error) { if (skipIncapable(t, error)) return false; throw error; }
  finally { await provider.release(ref); }
}

async function rig(t) {
  const dir = await scratch(t, "real-chrome-");
  // The slow page answers after the batch deadline: a timed-out batch keeps running until its command ends (Stagehand
  // checks its abort between commands), so the next batch waits behind it, then runs.
  const site = await startSite({ slowMs: 5_000 });
  t.after(async () => {
    for (const pid of chromeOf(dir)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }, { timeout: 30_000 });
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

test("run code written as an async arrow function runs and returns its value, and browser_read reads the page it opened in the same session", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const { capable: ok, site, env, read } = await rig(t);
  if (!ok) return;
  const script = [["run", { code: 'async () => {\n  return "hello world";\n}' }],
    ["run", { code: `async () => {\n  await page.goto(${JSON.stringify(`${site.base}/a`)}, { waitUntil: "domcontentloaded" });\n  return { title: await page.title(), url: page.url() };\n}` }],
    ["browser_read", { what: "markdown" }]];
  const run = await child({ ...env, MODE: "second", SCRIPT: JSON.stringify(script) });
  assert.equal(run.code, 0, run.err.slice(-1500));
  const results = read().results;
  assert.equal(results[0].text, "hello world");
  assert.deepEqual(JSON.parse(results[1].text), { title: "Page A", url: `${site.base}/a` });
  assert.match(results[2].text, /forty-two/, `browser_read reads page A, not a fresh browser: ${results[2].text.slice(0, 300)}`);
});

test("after a goto that never commits, browser_read and screenshot name the page the browser shows", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const { capable: ok, site, env, read, dir } = await rig(t);
  if (!ok) return;
  // The navigation starts and never commits (a 204; on Browserbase a PDF the browser downloads), so goto fails at its
  // start while page A stays loaded.
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
  // The submitting run never ends on its own: once it has clicked, its code waits on nothing that will come, so only the end of
  // its batch in the extension stops it. The cut must land while it is parked there with no command in flight: a command in
  // flight when the extension drops the dead client's browser session fails, which would end the batch by itself. The repeat
  // carries the same code, as a repeat does; it is refused unrun.
  const submit = `await page.locator("input[name=name]").fill("Ada Lovelace"); await page.getByRole("button", { name: "Submit" }).click(); console.log(${JSON.stringify(PARKED)}); await new Promise(() => {});`;
  const script = [["run", { code: `await page.goto(${JSON.stringify(`${site.base}/b`)}); return await page.title();` }], ["run", { code: submit }], ["run", { code: submit }], ["browser_read", { what: "text" }]];
  // Confined, as a production launch is: the lease's copy of the extension is what ends the dead client's batch (below).
  const confined = { ...env, CONFINE: "1" };
  // The cut lands once the run's code has said, from inside the extension, that its click is done: Stagehand's click returns
  // after its own follow-up commands, so no command is in flight from then on. The submission is let through as it lands: the
  // click's follow-up commands wait on the page's navigation, so holding its answer leaves a click command in flight, the cut
  // fails that command, and the batch ends by itself. That is the fast reattach this case used to see now and then without the
  // fix, which made it pass for the wrong reason.
  const landed = site.holdSubmissions().then(() => site.release());
  const first = await child({ ...confined, MODE: "first", SCRIPT: JSON.stringify(script) }, { killWhen: Promise.all([landed, workerLogged(env.PROFILE_ROOT, PARKED)]) });
  assert.equal(first.signal, "SIGKILL", `the first process was cut inside the submitting run: ${first.err.slice(-800)}`);
  assert.equal(site.submissions(), 1);
  assert.ok(chromeOf(dir).length > 0, "the local Chrome outlived the cut process, as a kept session does");
  // The browser runs the lease's copy, not Stagehand's own directory: a launch that fell back to it would pass for the wrong reason.
  const [extension, ...others] = await loadedStagehand(env.PROFILE_ROOT);
  assert.deepEqual([path.basename(extension?.path ?? ""), others.length], [COPY, 0], `Chrome holds one Stagehand extension, the lease's copy: ${JSON.stringify([extension, ...others])}`);

  // The dead client's batch would hold the extension's next init until its own deadline (the policy's batchTimeoutMs, here the
  // default, DEFAULT_BATCH_TIMEOUT_MS): the reattach would take about that long. The lease's copy ends that batch when the
  // extension sees its client gone, so the reattach is prompt. A third of the deadline lies between the two with room for a
  // loaded host.
  const second = await child({ ...confined, MODE: "second", SCRIPT: JSON.stringify(script) });
  assert.equal(second.code, 0, second.err.slice(-1500));
  assert.ok(second.ms < DEFAULT_BATCH_TIMEOUT_MS / 3, `the reattached process did not wait out the dead client's batch (${DEFAULT_BATCH_TIMEOUT_MS} ms): it took ${second.ms} ms`);
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

test("a CDP socket that dies under a live session: a read reconnects to the same session and runs; a run is not repeated and says how to go on", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const { capable: ok, site, env, read } = await rig(t);
  if (!ok) return;
  const goto = ["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }];

  // The socket dies just before the snapshot: the read comes back on the same session, page A still open.
  const readCut = await child({ ...env, MODE: "second", SCRIPT: JSON.stringify([goto, ["snapshot", {}]]), CUT_BEFORE: "1" });
  assert.equal(readCut.code, 0, readCut.err.slice(-1500));
  assert.match(readCut.out, /CUT [1-9]\d* sockets/, "the driver's socket was live when it was cut");
  const reads = read().results;
  assert.equal(reads[1].isError, false, `the snapshot reconnected and ran: ${reads[1].text.slice(0, 500)}`);
  assert.match(reads[1].text, /forty-two/, "the same session: page A, not a fresh blank one");
  // The release closes the reconnected driver while the session's release ends Chrome. Under Stagehand's first disconnect
  // bound (10 s): a close that waited on a Chrome already gone would run out its bounds instead.
  assert.ok(releaseMs(readCut) < 10_000, `the release did not wait on a Chrome already gone (${releaseMs(readCut)} ms)`);

  // The socket dies just before a run: it is not repeated (it may have acted), and the next read reconnects to page A.
  fs.rmSync(env.DB, { force: true });
  const runCut = await child({ ...env, MODE: "second", SCRIPT: JSON.stringify([goto, ["run", { code: "return await page.title();" }], ["snapshot", {}]]), CUT_BEFORE: "1" });
  assert.equal(runCut.code, 0, runCut.err.slice(-1500));
  const runs = read().results;
  const failure = JSON.parse(runs[1].text);
  assert.deepEqual([runs[1].isError, failure.retryable], [true, true], runs[1].text.slice(0, 500));
  assert.match(failure.message, /snapshot/, "it says to look before acting again");
  assert.doesNotMatch(failure.message, /unavailable for this run/);
  assert.equal(runs[2].isError, false, runs[2].text.slice(0, 500));
  assert.match(runs[2].text, /forty-two/);
  assert.ok(releaseMs(runCut) < 10_000, `the release did not wait on a Chrome already gone (${releaseMs(runCut)} ms)`);

  fs.rmSync(env.DB, { force: true });
  const gone = await child({ ...env, MODE: "second", SCRIPT: JSON.stringify([goto, ["snapshot", {}]]), CUT_BEFORE: "1", CUT_CLOSES: "1" });
  assert.equal(gone.code, 0, gone.err.slice(-1500));
  const refused = JSON.parse(read().results[1].text);
  assert.equal(refused.code, "browser_unavailable");
  assert.match(refused.message, /browser_relaunch/, refused.message);
});
