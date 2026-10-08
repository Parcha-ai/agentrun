// Observed effects on a real local Chrome (the cdp provider, its own profile under TMPDIR, loopback pages only):
// spike S3's twelve fixtures under an observer that only journals, and under one that holds every effect and denies it,
// then the crash rows: a run cut after it submitted a form, and one cut before it sent anything.
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

test("the observer journals every effect of S3's twelve fixtures; under deny it holds every one and none reaches the server", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const server = await startServer();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK] } });
  const ref = await provider.create(spec("effects-matrix"), new AbortController().signal);
  t.after(async () => { await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); });
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close());

  for (const mode of ["journal", "deny"]) {
    const observer = await EffectObserver.open(target, mode === "deny" ? effectDecider("deny") : null);
    for (const c of CASES) {
      server.reset();
      const rows = new Map();
      const stop = observer.record((row) => { rows.set(row.requestId, row); });
      await driver.run({ code: JSON.stringify(c.steps) }).catch(() => undefined);
      await observer.flush();
      await sleep(300);
      stop();
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
/** Every Chrome still running on `profile`, by exact pid (a test that failed midway leaves none behind). */
function killChromes(profile) {
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let cmd = "";
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
    if (cmd.includes(`--user-data-dir=${profile}`)) try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
  }
}

/** The first process runs `script` until `cut(server)` holds, is SIGKILLed, and a second runs the rest. */
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
const failureOf = (result) => JSON.parse(result.text);

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
  const ref = await provider.create(spec("effects-journal"), new AbortController().signal);
  t.after(async () => { await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); });
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close());
  const order = [{ goto: "/c" }, { click: "#order" }];

  const failing = await EffectObserver.open(target, effectDecider("ask", { approveEffect: async () => true }));
  const stop = failing.record(() => { throw new Error("the journal write failed"); });
  await driver.run({ code: JSON.stringify(order) });
  await failing.flush();
  await sleep(300);
  stop();
  failing.close();
  assert.deepEqual(server.nonGet(), [], "an approved request whose row was not saved never reaches the server");

  server.reset();
  const slow = await EffectObserver.open(target, effectDecider("ask", { approveEffect: () => sleep(800).then(() => true) }));
  const rows = new Map();
  slow.record((row) => { rows.set(row.requestId, row); });
  await driver.run({ code: JSON.stringify(order) });
  await slow.flush();
  assert.deepEqual([...rows.values()].map((row) => `${label(row)} ${row.held}`), ["POST /api/order allowed"], "flush waited for the decision");
  slow.close();
});

test("a decision that never comes is a refusal: at the observer's limit, or at once when the call is cut", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const server = await startServer();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK] } });
  const ref = await provider.create(spec("effects-unanswered"), new AbortController().signal);
  t.after(async () => { await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); });
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close());
  const order = [{ goto: "/c" }, { click: "#order" }];
  const never = effectDecider("ask", { approveEffect: () => new Promise(() => {}) });

  for (const [name, limitMs, cut] of [["the limit", 600, null], ["a cut call", 120_000, 300]]) {
    server.reset();
    const observer = await EffectObserver.open(target, never, limitMs);
    const rows = new Map();
    observer.record((row) => { rows.set(row.requestId, row); });
    await driver.run({ code: JSON.stringify(order) });
    const signal = cut === null ? undefined : AbortSignal.timeout(cut);
    const started = Date.now();
    await observer.flush(signal);
    assert.ok(Date.now() - started < 10_000, `${name}: flush returned (${Date.now() - started} ms)`);
    assert.deepEqual([...rows.values()].map((row) => `${label(row)} ${row.held}`), ["POST /api/order denied"], `${name}: journaled as refused`);
    await sleep(300);
    assert.deepEqual(server.nonGet(), [], `${name}: nothing reached the server`);
    observer.close();
  }
});

test("a cut call's refusal holds for what its page sends after the cut, until the next run records", { skip: NO_CHROME, timeout: 240_000 }, async (t) => {
  const server = await startServer();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK] } });
  const ref = await provider.create(spec("effects-after-cut"), new AbortController().signal);
  t.after(async () => { await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); });
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close());
  // The host approves everything, slowly: only the cut stands between a request and the server.
  const observer = await EffectObserver.open(target, effectDecider("ask", { approveEffect: () => sleep(400).then(() => true) }));
  t.after(() => observer.close());
  const held = (rows) => [...rows.values()].map((row) => `${label(row)} ${row.held}`);

  const cutRows = new Map();
  observer.record((row) => { cutRows.set(row.requestId, row); });
  await driver.run({ code: JSON.stringify([{ goto: "/c" }, { click: "#order" }]) });
  await observer.flush(AbortSignal.timeout(100));
  // The cut run's page sends again after the flush returned.
  await driver.run({ code: JSON.stringify([{ click: "#order" }]) });
  await sleep(800);
  await observer.flush();
  assert.deepEqual(held(cutRows), ["POST /api/order denied", "POST /api/order denied"], "both refused: the one open at the cut and the one sent after it");
  assert.deepEqual(server.nonGet(), [], "nothing the cut run's page sent reached the server");

  const nextRows = new Map();
  observer.record((row) => { nextRows.set(row.requestId, row); });
  await driver.run({ code: JSON.stringify([{ click: "#order" }]) });
  await observer.flush();
  await sleep(300);
  assert.deepEqual(held(nextRows), ["POST /api/order allowed"], "the next run's request is decided again");
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
