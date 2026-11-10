#!/usr/bin/env node
// Runs the console's real-browser flows against a target:
//   node apps/console/e2e/run.mjs [--only a,b] [--checkout DIR | --url URL [--setup-code-file FILE]]
//   --checkout DIR        a built checkout whose packages/serve/dist to start (default: this one; run `npm run build`
//                         first), with this Node (a checkout needing another Node runs under that one)
//   --url URL             a server already running, e.g. a QA server: only the flows that can share a server run (the
//                         rest are SKIP); set E2E_PASSWORD when its owner is already set
//   --setup-code-file F   with --url: a file holding the code its setup asks for (from its output), when no owner is set
//   --only a,b            only these flows, by name
//   --tap FILE            also write the results as TAP (version 13) to FILE, the target's commit in its header
// Chrome: CHROME_PATH (CI's Chrome for Testing) or E2E_CHROME. Each flow gets a server of its own and a fresh browser
// context, and must end within FLOW_MS. A flow marked pending names what it waits on and does not run. Exits 1 when a flow
// fails; a failure prints the server's output, keys redacted.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { apiOf, attachServer, launchBrowser, newContext, newPage, owner, ROOT, signIn, startServer } from "./harness.mjs";
import { flows } from "./flows/index.mjs";

const FLOW_MS = 60_000;
const { values } = parseArgs({ options: { only: { type: "string" }, checkout: { type: "string" }, url: { type: "string" }, "setup-code-file": { type: "string" }, tap: { type: "string" } } });
if (values.url && values.checkout) { console.error("--url and --checkout are two targets: give one"); process.exit(2); }
if (values["setup-code-file"] && !values.url) { console.error("--setup-code-file goes with --url"); process.exit(2); }
const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null;
const checkout = values.checkout ?? ROOT;
const chosen = flows.filter((f) => !only || only.has(f.name));
if (only) for (const name of only) if (!flows.some((f) => f.name === name)) { console.error(`no flow named ${name}`); process.exit(2); }

const within = (promise, ms, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

const browser = await launchBrowser();
const results = [];
for (const flow of chosen) {
  if (flow.pending) { results.push({ name: flow.name, state: "PENDING", note: flow.pending }); continue; }
  // `shares` may depend on what the run was given (a flow that needs the server's setup code only runs with it).
  const shares = typeof flow.shares === "function" ? flow.shares({ setupCodeFile: values["setup-code-file"] }) : flow.shares;
  if (values.url && !shares) { results.push({ name: flow.name, state: "SKIP", note: typeof flow.shares === "function" ? "needs a server not set up yet (--setup-code-file)" : "needs a server of its own (a --checkout target)" }); continue; }
  const started = Date.now();
  let server, context;
  try {
    // A flow's server options, or a function making them (a flow whose server must know its port first).
    if (values.url) server = attachServer({ url: values.url, setupCodeFile: values["setup-code-file"] });
    else server = await startServer({ checkout, ...(typeof flow.server === "function" ? await flow.server() : flow.server ?? {}) });
    const opened = await newContext(browser, flow.origin?.(server) ?? server.origin, { allow: flow.allow ?? [] });
    context = opened.context;
    const { page, errors } = await newPage(context);
    const origin = flow.origin?.(server) ?? server.origin;
    await within((async () => {
      // A flow that starts signed in: the owner set (through the API when it has none), then this page signed in.
      if (flow.signedIn) { await owner(server); await signIn(page, origin); }
      await flow.run({ server, context, page, errors, blocked: opened.blocked, icons: opened.icons, browser, origin, base: origin, api: apiOf(server) });
    })(), FLOW_MS, flow.name);
    if (opened.blocked.length && !flow.allowsBlocked) throw new Error(`requests left loopback: ${opened.blocked.join(", ")}`);
    if (errors.length && !flow.allowsErrors) throw new Error(`the page reported errors: ${errors.join(" | ")}`);
    results.push({ name: flow.name, state: "PASS", ms: Date.now() - started });
  } catch (error) {
    results.push({ name: flow.name, state: "FAIL", ms: Date.now() - started, note: String(error?.stack ?? error).split("\n").slice(0, 6).join("\n"), log: server?.log() });
  } finally {
    await context?.close().catch(() => {});
    await server?.stop().catch(() => {});
  }
}
await browser.close();

for (const r of results) {
  console.log(`${r.state.padEnd(7)} ${r.name}${r.ms !== undefined ? ` (${(r.ms / 1000).toFixed(1)} s)` : ""}${r.state === "PENDING" || r.state === "SKIP" ? `: ${r.note}` : ""}`);
  if (r.state === "FAIL") console.log(`  ${r.note.replaceAll("\n", "\n  ")}\n  -- the server's output --\n  ${(r.log ?? "").replaceAll("\n", "\n  ")}`);
}
const count = (s) => results.filter((r) => r.state === s).length;
console.log(`${count("PASS")} passed, ${count("FAIL")} failed, ${count("PENDING")} pending${count("SKIP") ? `, ${count("SKIP")} skipped (an attached server)` : ""}`);
if (values.tap) {
  const at = values.url ? `server ${values.url}` : `checkout ${spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || "(not a git checkout)"}`;
  const tap = ["TAP version 13", `# console real-browser flows, ${at}, node ${process.version}`, `1..${results.length}`];
  results.forEach((r, i) => {
    const line = `${r.state === "FAIL" ? "not ok" : "ok"} ${i + 1} - ${r.name}`;
    if (r.state === "PENDING" || r.state === "SKIP") tap.push(`${line} # SKIP ${r.state.toLowerCase()}: ${r.note}`);
    else tap.push(`${line} # time=${r.ms}ms`, ...(r.state === "FAIL" ? ["  ---", ...r.note.split("\n").map((l) => `  # ${l}`), "  ..."] : []));
  });
  tap.push(`# pass ${count("PASS")}`, `# fail ${count("FAIL")}`, `# skip ${count("PENDING") + count("SKIP")}`);
  writeFileSync(values.tap, `${tap.join("\n")}\n`);
}
process.exit(count("FAIL") ? 1 : 0);
