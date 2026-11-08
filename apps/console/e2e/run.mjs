#!/usr/bin/env node
// Runs the console's real-browser flows against the built server: node apps/console/e2e/run.mjs [--only a,b] [--checkout DIR]
//   --checkout DIR  a built checkout whose packages/serve/dist to start (default: this one; run `npm run build` first)
//   --only a,b      only these flows, by name
// Chrome: CHROME_PATH (CI's Chrome for Testing) or E2E_CHROME. Each flow gets a server of its own and a fresh browser
// context, and must end within FLOW_MS. A flow marked pending names what it waits on and does not run. Exits 1 when a flow
// fails; a failure prints the server's output, keys redacted.
import { parseArgs } from "node:util";
import { launchBrowser, newContext, newPage, ROOT, startServer } from "./harness.mjs";
import { flows } from "./flows/index.mjs";

const FLOW_MS = 60_000;
const { values } = parseArgs({ options: { only: { type: "string" }, checkout: { type: "string" } } });
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
  const started = Date.now();
  let server, context;
  try {
    server = await startServer({ checkout, ...(flow.server ?? {}) });
    const opened = await newContext(browser, flow.origin?.(server) ?? server.origin, { allow: flow.allow ?? [] });
    context = opened.context;
    const { page, errors } = await newPage(context);
    await within(flow.run({ server, context, page, errors, blocked: opened.blocked, browser, origin: flow.origin?.(server) ?? server.origin }), FLOW_MS, flow.name);
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
  console.log(`${r.state.padEnd(7)} ${r.name}${r.ms !== undefined ? ` (${(r.ms / 1000).toFixed(1)} s)` : ""}${r.state === "PENDING" ? `: ${r.note}` : ""}`);
  if (r.state === "FAIL") console.log(`  ${r.note.replaceAll("\n", "\n  ")}\n  -- the server's output --\n  ${(r.log ?? "").replaceAll("\n", "\n  ")}`);
}
const count = (s) => results.filter((r) => r.state === s).length;
console.log(`${count("PASS")} passed, ${count("FAIL")} failed, ${count("PENDING")} pending`);
process.exit(count("FAIL") ? 1 : 0);
