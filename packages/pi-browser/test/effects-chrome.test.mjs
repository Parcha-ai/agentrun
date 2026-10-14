import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EffectObserver, effectDecider } from "@parcha/pi-browser";
import { cdpProvider } from "../dist/providers/cdp.js";
import { cdpDriver } from "./effects/cdp-driver.mjs";
import { CASES, startServer } from "./effects/server.mjs";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";

const LOOPBACK = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });
const label = (row) => `${row.method} ${row.path}`;

const within = (promise, what, ms = 30_000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms).unref())]);

/** Tests wait on journal rows as events, never on a delay: how long the browser takes to send a request (a cross-origin
 *  POST waits for its preflight) or the host to decide one depends on the machine. */
function recorder(observer) {
  const rows = new Map();
  const waiting = [];
  const stop = observer.record((row) => { rows.set(row.requestId, row); for (const w of waiting.splice(0)) if (!w()) waiting.push(w); });
  const decided = () => [...rows.values()].filter((row) => row.held !== "pending");
  const until = (ready, ms = 30_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { const at = waiting.indexOf(check); if (at !== -1) waiting.splice(at, 1); reject(new Error(`the journal never got there in ${ms} ms: ${JSON.stringify([...rows.values()].map((row) => `${label(row)} ${row.held}`))}`)); }, ms);
    const check = () => { if (!ready()) return false; clearTimeout(timer); resolve(); return true; };
    if (!check()) waiting.push(check);
  });
  return { rows, decided, until, stop };
}

test("the observer journals every effect of S3's twelve fixtures; under deny it holds every one and none reaches the server", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const server = await startServer();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK] } });
  // Cleanup is registered before Chrome is launched: a launch that fails must still close the server, or the process
  // never exits.
  let ref = null;
  t.after(async () => { if (ref) await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); });
  ref = await provider.create(spec("effects-matrix"), new AbortController().signal);
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close());

  for (const mode of ["journal", "deny"]) {
    const observer = await EffectObserver.open(target, mode === "deny" ? effectDecider("deny") : null);
    for (const c of CASES) {
      // Chrome for Testing 155 under load sometimes drops a cross-origin fetch after its preflight (net::ERR_ABORTED):
      // the driver sees it, that attempt had no effect, and the case runs again (twice at most).
      const want = c.expected.length;
      let journal;
      let complete;
      for (let attempt = 0; ; attempt += 1) {
        server.reset();
        journal = recorder(observer);
        const aborts = driver.aborted();
        await driver.run({ code: JSON.stringify(c.steps) });
        await journal.until(() => journal.decided().length >= want, 10_000).catch(() => undefined);
        if (mode === "journal" && want) await server.nonGetReached(want, 10_000).catch(() => undefined);
        await observer.flush();
        journal.stop();
        complete = journal.decided().length >= want && (mode !== "journal" || server.nonGet().length >= want);
        if (complete || driver.aborted() === aborts || attempt === 2) break;
      }
      const { rows } = journal;
      assert.deepEqual([...rows.values()].map(label).sort(), c.expected, `${mode}, ${c.name}: the journal`);
      assert.deepEqual(server.nonGet(), mode === "deny" ? [] : c.expected, `${mode}, ${c.name}: what reached the server`);
      if (mode === "deny") assert.ok([...rows.values()].every((row) => row.held === "denied"), `${mode}, ${c.name}: every effect held and denied`);
      for (const row of rows.values()) assert.equal(Object.keys(row).sort().join(","), "at,held,irreversible,method,origin,path,requestId", "a row holds no body, header or query");
      await driver.closeOthers();
    }
    observer.close();
  }
});

const CHILD = fileURLToPath(new URL("./effects/child.mjs", import.meta.url));
const runChild = (env) => {
  const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (c) => { output += c; });
  proc.stderr.on("data", (c) => { output += c; });
  return { proc, output: () => output, exited: new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, output }))) };
};
function killChromes(profile) {
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let cmd = "";
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
    if (cmd.includes(`--user-data-dir=${profile}`)) try { process.kill(Number(pid), "SIGKILL"); } catch {}
  }
}

async function crash(t, { script, hold, cut, env = {} }) {
  const server = await startServer();
  const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-crash-"));
  t.after(async () => { killChromes(dir); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const base = { DB: path.join(dir, "run.sqlite"), BASE: server.base, PROFILE: dir, SCRIPT: JSON.stringify(script) };
  server.hold(hold);
  const first = runChild({ ...base, ...env, MODE: "first", OUT: path.join(dir, "first.json") });
  for (const deadline = Date.now() + 90_000; !cut(server, first.output()); await sleep(50)) {
    if (Date.now() > deadline) { first.proc.kill("SIGKILL"); assert.fail(`the first process never reached its cut: ${(await first.exited).output}`); }
  }
  first.proc.kill("SIGKILL");
  assert.equal((await first.exited).signal, "SIGKILL");
  server.release();
  const second = runChild({ ...base, MODE: "second", OUT: path.join(dir, "second.json") });
  const end = await second.exited;
  assert.equal(end.code, 0, end.output);
  return { server, ...JSON.parse(fs.readFileSync(path.join(dir, "second.json"), "utf8")) };
}
const failureOf = (result) => { try { return JSON.parse(result.text); } catch { throw new Error(`the tool result is not a failure envelope: ${JSON.stringify(String(result.text).slice(0, 300))}`); } };

test("a run cut after it submitted a form: the notice names the POST, the identical run is refused, the server counted one", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const submit = ["run", { code: JSON.stringify([{ goto: "/b" }, { click: "#submit" }, { waitLoad: true }]) }];
  const { server, results, sessions } = await crash(t, { script: [submit, submit, ["browser_release"]], hold: "/submit", cut: (s) => s.count("POST /submit") === 1 });
  assert.equal(results[0].isError, true, "pi reports the cut run interrupted and never reruns it");
  const refused = failureOf(results[1]);
  assert.equal(refused.code, "effect_unknown");
  assert.ok(refused.message.includes(`after it sent POST ${server.base}/submit;`), refused.message);
  assert.equal(server.count("POST /submit"), 1, "the form reached the server once");
  assert.deepEqual(sessions.sessions.map((s) => s.state), ["released"]);
});

test("a run cut before it sent anything that changes something: it is safe to run again, and the identical run goes through", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const read = ["run", { code: JSON.stringify([{ goto: "/d" }]) }];
  const { server, results } = await crash(t, { script: [read, read, ["browser_release"]], hold: "/d", cut: (s) => s.count("GET /d") >= 1 });
  assert.equal(results[0].isError, true);
  assert.equal(results[1].isError, false, results[1].text);
  assert.match(results[1].text, /was interrupted before it sent any request that changes anything; it is safe to run again/);
  assert.deepEqual(server.nonGet(), []);
});

test("a crash while a held request waits for its decision: the journal already names it, so the run is never called safe", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const submit = ["run", { code: JSON.stringify([{ goto: "/b" }, { click: "#submit" }, { waitLoad: true }]) }];
  const { server, results } = await crash(t, { script: [submit, submit, ["browser_release"]], hold: "/none", cut: (_s, out) => out.includes("AT approve"), env: { HANG_APPROVE: "1" } });
  const refused = failureOf(results[1]);
  assert.equal(refused.code, "effect_unknown", "not replay safe: the request was pending when the process died");
  assert.ok(refused.message.includes(`after it sent POST ${server.base}/submit;`), refused.message);
  assert.ok(server.count("POST /submit") <= 1, `at most one submission (${server.count("POST /submit")})`);
});

test("a held request leaves only once its journal row is saved, and flush returns only when every decision is journaled", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const server = await startServer();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK] } });
  // Cleanup is registered before Chrome is launched: a launch that fails must still close the server, or the process
  // never exits.
  let ref = null;
  t.after(async () => { if (ref) await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); });
  ref = await provider.create(spec("effects-journal"), new AbortController().signal);
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close());
  const order = [{ goto: "/c" }, { click: "#order" }];

  const failing = await EffectObserver.open(target, effectDecider("ask", { approveEffect: async () => true }));
  let attempted;
  const wrote = new Promise((resolve) => { attempted = resolve; });
  const stop = failing.record(() => { attempted(); throw new Error("the journal write failed"); });
  await driver.run({ code: JSON.stringify(order) });
  await within(wrote, "the request was never journaled");
  await failing.flush();
  stop();
  failing.close();
  assert.deepEqual(server.nonGet(), [], "an approved request whose row was not saved never reaches the server");

  server.reset();
  const slow = await EffectObserver.open(target, effectDecider("ask", { approveEffect: () => sleep(800).then(() => true) }));
  const journal = recorder(slow);
  await driver.run({ code: JSON.stringify(order) });
  // Once the request is seen (journaled pending), the host takes 800 ms to approve: flush must not return before it
  // has.
  await journal.until(() => journal.rows.size >= 1);
  await slow.flush();
  assert.deepEqual([...journal.rows.values()].map((row) => `${label(row)} ${row.held}`), ["POST /api/order allowed"], "flush waited for the decision");
  slow.close();
});

test("a decision that never comes is a refusal: at the observer's limit, or at once when the call is cut", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const server = await startServer();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK] } });
  // Cleanup is registered before Chrome is launched: a launch that fails must still close the server, or the process
  // never exits.
  let ref = null;
  t.after(async () => { if (ref) await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); });
  ref = await provider.create(spec("effects-unanswered"), new AbortController().signal);
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close());
  const order = [{ goto: "/c" }, { click: "#order" }];
  const never = effectDecider("ask", { approveEffect: () => new Promise(() => {}) });

  for (const [name, limitMs, cut] of [["the limit", 600, null], ["a cut call", 120_000, 300]]) {
    server.reset();
    const observer = await EffectObserver.open(target, never, limitMs);
    const journal = recorder(observer);
    await driver.run({ code: JSON.stringify(order) });
    await journal.until(() => journal.rows.size >= 1);
    const signal = cut === null ? undefined : AbortSignal.timeout(cut);
    const started = Date.now();
    await observer.flush(signal);
    assert.ok(Date.now() - started < 10_000, `${name}: flush returned (${Date.now() - started} ms)`);
    assert.deepEqual([...journal.rows.values()].map((row) => `${label(row)} ${row.held}`), ["POST /api/order denied"], `${name}: journaled as refused`);
    // A refused request that leaked would reach the server within moments: a bounded wait for an event that must not
    // happen, which load can only make miss a leak, never invent one.
    await assert.rejects(server.nonGetReached(1, 300), /expected non-GET/, `${name}: nothing reached the server`);
    observer.close();
  }
});

test("a cut call's refusal holds for what its page sends after the cut, until the next run records", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const server = await startServer();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK] } });
  // Cleanup is registered before Chrome is launched: a launch that fails must still close the server, or the process
  // never exits.
  let ref = null;
  t.after(async () => { if (ref) await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); });
  ref = await provider.create(spec("effects-after-cut"), new AbortController().signal);
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close());
  // The host approves everything, but only when the test says so: until then only the cut stands between a request and
  // the server (a host with a fixed answer time would race the cut on a loaded machine).
  let approve;
  const approval = new Promise((resolve) => { approve = resolve; });
  const observer = await EffectObserver.open(target, effectDecider("ask", { approveEffect: () => approval.then(() => true) }));
  t.after(() => observer.close());
  const held = (rows) => [...rows.values()].map((row) => `${label(row)} ${row.held}`);

  const cut = recorder(observer);
  await driver.run({ code: JSON.stringify([{ goto: "/c" }, { click: "#order" }]) });
  await cut.until(() => cut.rows.size >= 1);
  const call = new AbortController();
  const flushing = observer.flush(call.signal);
  call.abort();
  await flushing;
  await driver.run({ code: JSON.stringify([{ click: "#order" }]) });
  await cut.until(() => cut.decided().length >= 2);
  // The host answers, too late.
  approve();
  await observer.flush();
  assert.deepEqual(held(cut.rows), ["POST /api/order denied", "POST /api/order denied"], "both refused: the one open at the cut and the one sent after it");
  // A refused request that leaked would reach the server within moments: a bounded wait for an event that must not
  // happen, which load can only make miss a leak, never invent one.
  await assert.rejects(server.nonGetReached(1, 300), /expected non-GET/, "nothing the cut run's page sent reached the server");
  assert.deepEqual(server.nonGet(), []);

  const next = recorder(observer);
  await driver.run({ code: JSON.stringify([{ click: "#order" }]) });
  await next.until(() => next.decided().length >= 1);
  await server.nonGetReached(1);
  await observer.flush();
  assert.deepEqual(held(next.rows), ["POST /api/order allowed"], "the next run's request is decided again");
  assert.deepEqual(server.nonGet(), ["POST /api/order"]);
});

test("effect judgments are memoized per method, origin, path and the names the judge saw", async () => {
  // A pure function the Chrome suite reaches, but its fixtures cannot vary a request's field names on one path.
  const asked = [];
  const decide = effectDecider("deny", { judgeEffect: async (r) => { asked.push(r.formFields.join(",")); return { irreversible: r.formFields.includes("card") ? 0.95 : 0.1, telemetry: 0.9, queryOnly: 0 }; } });
  const request = (formFields) => ({ method: "POST", origin: "https://shop.test", path: "/api", queryKeys: [], formFields, pageTitle: null, trigger: null, task: null });
  assert.equal((await decide(request(["event"]))).allow, true);
  assert.equal((await decide(request(["card", "event"]))).allow, false, "a different body on the same path is judged on its own");
  assert.equal((await decide(request(["event"]))).allow, true);
  assert.deepEqual(asked, ["event", "card,event"]);
});
