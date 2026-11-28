#!/usr/bin/env node
// Runs the console's real-browser flows against a target:
//   node apps/console/e2e/run.mjs [--only a,b] [--lanes N] [--checkout DIR | --url URL [--setup-code-file FILE]]
//   --checkout DIR        a built checkout whose packages/serve/dist to start (default: this one; run `npm run build`
//                         first), with this Node (a checkout needing another Node runs under that one)
//   --url URL             a server already running, e.g. a QA server: only the flows that can share a server run (the
//                         rest are SKIP), one at a time; set E2E_PASSWORD when its owner is already set
//   --setup-code-file F   with --url: a file holding the code its setup asks for (from its output), when no owner is set
//   --only a,b            only these flows, by name
//   --lanes N             with a checkout: how many flows run at once (LANES by default); a flow marked `alone` runs
//                         after the rest, by itself
//   --tap FILE            also write the results as TAP (version 13) to FILE, the target's commit in its header
// Chrome: CHROME_PATH (CI's Chrome for Testing) or E2E_CHROME. Each flow gets a server of its own and a fresh browser
// context in the one browser, and must end within FLOW_MS. A flow marked pending names what it waits on and does not run.
// Results print in the flows' order once all have ended. Exits 1 when a flow fails; a failure prints the server's output,
// keys redacted.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { promiseHooks } from "node:v8";
import { apiOf, attachServer, DRAIN_MS, flowScope, launchBrowser, newContext, newPage, owner, ROOT, signIn, startServer, STOP_MS, strayed } from "./harness.mjs";
import { flows } from "./flows/index.mjs";

const FLOW_MS = 60_000;
/** How many flows run at once with a checkout. CI's runner has 4 vCPUs; each flow is its server, a browser page and this
 *  process, mostly waiting on one another. */
const LANES = 4;
/** How many times a server whose own port (freePort) was taken before it bound is started on another: its bind, not the
 *  flow, is tried again. */
const BINDS = 3;
const { values } = parseArgs({ options: { only: { type: "string" }, checkout: { type: "string" }, url: { type: "string" }, "setup-code-file": { type: "string" }, tap: { type: "string" }, lanes: { type: "string" } } });
if (values.url && values.checkout) { console.error("--url and --checkout are two targets: give one"); process.exit(2); }
if (values["setup-code-file"] && !values.url) { console.error("--setup-code-file goes with --url"); process.exit(2); }
if (values.lanes !== undefined && !/^[1-9]\d*$/.test(values.lanes)) { console.error("--lanes takes a whole number, 1 or more"); process.exit(2); }
// An attached server is one for all the flows: they take turns on it.
if (values.url && values.lanes !== undefined && values.lanes !== "1") { console.error("--url runs its flows one at a time (one server shared): --lanes goes with a checkout"); process.exit(2); }
const lanes = values.url ? 1 : Number(values.lanes ?? LANES);
const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null;
const checkout = values.checkout ?? ROOT;
const chosen = flows.filter((f) => !only || only.has(f.name));
/** The harness's own stop (harness-stop.test.mjs): a server drained inside STOP_MS, never killed. It starts its own
 *  server from the checkout, so it runs with a checkout target and not with --url; with --only, only when named. */
const STOP_CHECK = "harness-stop";
if (only) for (const name of only) if (name !== STOP_CHECK && !flows.some((f) => f.name === name)) { console.error(`no flow named ${name}`); process.exit(2); }

const within = (promise, ms, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

// A rejection nothing handles while a flow runs or after (a route handler that threw: Playwright leaves it unhandled)
// fails that flow, its server's output printed, instead of ending the whole run with no results. Flows run at once, so
// each rejection is traced to its own flow, in this order: a route handler's error was already handed to its flow by the
// harness (it ties each handler to the flow registering it); a promise made in a flow's async context (flowScope, its
// code and the Playwright calls it makes) is that flow's; a promise rejected in a flow's context is that flow's (node 24
// runs this handler in the context the promise was rejected in). One that traces to no flow (made and rejected in
// Playwright's or node's own callbacks) fails every flow running at that moment, since it cannot say which; with none
// running it ends the run.
const running = new Set();
const stopping = [];
const madeIn = new WeakMap();
promiseHooks.onInit((promise) => { const flow = flowScope.getStore(); if (flow) madeIn.set(promise, flow); });
process.on("unhandledRejection", (error, promise) => {
  if (error instanceof Object && strayed.has(error)) return;
  const flow = madeIn.get(promise) ?? flowScope.getStore();
  if (flow) return flow.stray(error);
  if (!running.size) throw error;
  for (const one of running) one.stray(error);
});

/** The server for `flow`: its options, or a function making them (a flow whose server must know its port first). A server
 *  given its own port (freePort) can find it taken at its bind, by another flow's server or another process: it is
 *  started again from new options (a new port), up to BINDS times. The flow has not run yet; nothing of it is tried again. */
async function serverOf(flow) {
  for (let bind = 1; ; bind++) {
    const options = typeof flow.server === "function" ? await flow.server() : flow.server ?? {};
    try {
      return await startServer({ checkout, ...options });
    } catch (error) {
      if (!options.port || bind >= BINDS || !new RegExp(`EADDRINUSE\\b.*:${options.port}\\b`).test(error.message)) throw error;
    }
  }
}

/** One flow, start to end, in its own async context: its result and what strayed into it (see unhandledRejection). */
async function runFlow(flow) {
  const started = Date.now();
  const strays = [];
  let fail;
  const stray = new Promise((_, reject) => { fail = reject; });
  stray.catch(() => {});
  const self = { name: flow.name, stray: (error) => { strays.push(error); fail(error); } };
  let server, context, result, unstopped, killed;
  const failed = (error) => ({ name: flow.name, state: "FAIL", ms: Date.now() - started, note: String(error?.stack ?? error).split("\n").slice(0, 6).join("\n"), log: server?.log() });
  running.add(self);
  await flowScope.run(self, async () => {
    try {
      if (values.url) server = attachServer({ url: values.url, setupCodeFile: values["setup-code-file"] });
      else server = await serverOf(flow);
      const opened = await newContext(browser, flow.origin?.(server) ?? server.origin, { allow: flow.allow ?? [] });
      context = opened.context;
      const { page, errors } = await newPage(context);
      const origin = flow.origin?.(server) ?? server.origin;
      await within(Promise.race([stray, (async () => {
        // A flow that starts signed in: the owner set (through the API when it has none), then this page signed in.
        if (flow.signedIn) { await owner(server); await signIn(page, origin); }
        await flow.run({ server, context, page, errors, blocked: opened.blocked, icons: opened.icons, browser, origin, base: origin, api: apiOf(server) });
      })()]), FLOW_MS, flow.name);
      if (opened.blocked.length && !flow.allowsBlocked) throw new Error(`requests left loopback: ${opened.blocked.join(", ")}`);
      if (errors.length && !flow.allowsErrors) throw new Error(`the page reported errors: ${errors.join(" | ")}`);
      result = { name: flow.name, state: "PASS", ms: Date.now() - started };
    } catch (error) {
      result = failed(error);
    } finally {
      await context?.close().catch(() => {});
      // The server stops while the next flow starts: one with a run still in its turn waits out its drain (DRAIN_MS,
      // inside the harness's SIGKILL at STOP_MS), and nothing of the next flow is its. Results print once every one has stopped, and
      // a stop that failed (the server would not die, left a process running, or its directory stayed) fails its flow,
      // as does one that had to be killed (SIGKILL): a run left in its turn outlasted the server's drain (DRAIN_MS).
      if (server) stopping.push(server.stop().then((how) => { if (how?.killed) killed = how.pid; }, (error) => { unstopped = error; }));
      running.delete(self);
    }
  });
  // One that comes after it passed (while it was closed, or later in the run), fails it too, as does a server that did
  // not stop or had to be killed: read once all have ended and stopped.
  return () => {
    const r = result.state === "PASS" && strays.length ? { ...failed(strays[0]), ms: result.ms } : result;
    const k = killed ? { killed } : {};
    const why = [
      ...(unstopped ? [`its server did not stop: ${unstopped.message}`] : []),
      ...(killed ? [`its server (pid ${killed}) was still running ${STOP_MS / 1000} s after SIGTERM and was killed (SIGKILL): a run left in its turn kept it draining (the harness passes --drain-timeout ${DRAIN_MS / 1000}s, which a flow's own server args may override)`] : []),
    ];
    if (!why.length) return r;
    const note = why.join("\n");
    return r.state === "PASS" ? { ...failed(new Error(note)), note, ms: r.ms, ...k } : { ...r, note: `${r.note}\n${note}`, ...k };
  };
}

const browser = await launchBrowser();
const ended = [];
const queued = { together: [], alone: [] };
chosen.forEach((flow, i) => {
  if (flow.pending) { ended[i] = () => ({ name: flow.name, state: "PENDING", note: flow.pending }); return; }
  // `shares` may depend on what the run was given (a flow that needs the server's setup code only runs with it).
  const shares = typeof flow.shares === "function" ? flow.shares({ setupCodeFile: values["setup-code-file"] }) : flow.shares;
  if (values.url && !shares) { ended[i] = () => ({ name: flow.name, state: "SKIP", note: typeof flow.shares === "function" ? "needs a server not set up yet (--setup-code-file)" : "needs a server of its own (a --checkout target)" }); return; }
  queued[flow.alone ? "alone" : "together"].push(i);
});
/** The flows at `list` (indexes into `chosen`), `n` at a time, each next one started as one ends, in their order. */
const inLanes = async (list, n) => {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) { const i = list[next++]; ended[i] = await runFlow(chosen[i]); }
  }));
};
// The stop check first, alone, on the same checkout as the flows: its result is one more row.
const stopCheck = values.url || (only && !only.has(STOP_CHECK)) ? [] : [await new Promise((resolve) => {
  const began = Date.now();
  let out = "";
  const child = spawn(process.execPath, ["--test", fileURLToPath(new URL("./harness-stop.test.mjs", import.meta.url))], { env: { ...process.env, AGENTRUN_E2E_CHECKOUT: checkout }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  child.on("close", (code, signal) => resolve(code === 0 ? { name: STOP_CHECK, state: "PASS", ms: Date.now() - began } : { name: STOP_CHECK, state: "FAIL", ms: Date.now() - began, note: `node --test harness-stop.test.mjs exited ${code ?? signal}`, log: out }));
})];
await inLanes(queued.together, lanes);
await inLanes(queued.alone, 1);
await Promise.all(stopping);
await browser.close();
const results = [...stopCheck, ...ended.map((result) => result())];

for (const r of results) {
  console.log(`${r.state.padEnd(7)} ${r.name}${r.ms !== undefined ? ` (${(r.ms / 1000).toFixed(1)} s)` : ""}${r.state === "PENDING" || r.state === "SKIP" ? `: ${r.note}` : ""}`);
  if (r.state === "FAIL") console.log(`  ${r.note.replaceAll("\n", "\n  ")}\n  -- the server's output --\n  ${(r.log ?? "").replaceAll("\n", "\n  ")}`);
}
const count = (s) => results.filter((r) => r.state === s).length;
// A server still running STOP_MS after SIGTERM (a run left in its turn, draining past DRAIN_MS) was killed: its flow
// failed above, and each kill is said here too, with its flow and its server.
const STOP_S = STOP_MS / 1000;
const kills = results.filter((r) => r.killed);
for (const r of kills) console.log(`KILLED  ${r.name}: its server (pid ${r.killed}) was still running ${STOP_S} s after SIGTERM and was killed (SIGKILL)`);
console.log(`${count("PASS")} passed, ${count("FAIL")} failed, ${count("PENDING")} pending${count("SKIP") ? `, ${count("SKIP")} skipped (an attached server)` : ""}${kills.length ? `, ${kills.length} ${kills.length === 1 ? "server" : "servers"} killed after ${STOP_S} s` : ""}`);
if (values.tap) {
  const at = values.url ? `server ${values.url}` : `checkout ${spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || "(not a git checkout)"}`;
  const tap = ["TAP version 13", `# console real-browser flows, ${at}, node ${process.version}`, `1..${results.length}`];
  results.forEach((r, i) => {
    const line = `${r.state === "FAIL" ? "not ok" : "ok"} ${i + 1} - ${r.name}`;
    if (r.state === "PENDING" || r.state === "SKIP") tap.push(`${line} # SKIP ${r.state.toLowerCase()}: ${r.note}`);
    else tap.push(`${line} # time=${r.ms}ms`, ...(r.state === "FAIL" ? ["  ---", ...r.note.split("\n").map((l) => `  # ${l}`), "  ..."] : []));
  });
  tap.push(...kills.map((r) => `# killed ${r.name}: server pid ${r.killed} still running ${STOP_S} s after SIGTERM (SIGKILL)`));
  tap.push(`# pass ${count("PASS")}`, `# fail ${count("FAIL")}`, `# skip ${count("PENDING") + count("SKIP")}`);
  writeFileSync(values.tap, `${tap.join("\n")}\n`);
}
process.exit(count("FAIL") ? 1 : 0);
