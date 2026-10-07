// Example 02: a charge that is cut in half is never sent twice, across a kill and across a freeze.
//
//   node examples/02-paid-effect/demo.ts kill|freeze [options]        (options: --help)
//
// A fake paid API (test/fixtures/paid-api.ts) counts every charge it receives. An agent on host A charges six invoices;
// the API holds the third charge in flight, and the demo takes host A away at that moment (`kill`: the host loses power;
// `freeze`: its mount hangs while the host looks alive). Host B's supervisor takes the run over, and the run finishes.
// The demo then compares what the API received with what the run's store says happened.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanup, instanceUid, DEMO_LEASE, exitStatus, fail, fault, followLog, note, parseOptions, preflight, report, say, shareWith, startedUnit, superviseLoop, superviseOnce, USAGE, waitFor,
  type HostSpec,
} from "../lib/demo.ts";
import type { HostHandle } from "@parcha/pi-durable-archil";
import { startPaidApi, type PaidApi } from "../../test/fixtures/paid-api.ts";
import { INVOICES } from "./app.ts";

if (process.argv.includes("--help")) {
  console.log(`usage: node demo.ts kill|freeze [options]\n${USAGE}`);
  process.exit(0);
}
const opts = parseOptions("paid", ["kill", "freeze"], process.argv.slice(2));

const dir = mkdtempSync(join(tmpdir(), "pda-paid-"));
shareWith(opts, dir);
const logFile = join(dir, "app.jsonl");
const app = fileURLToPath(new URL("./app.ts", import.meta.url));

let api: PaidApi | undefined;
const env: Record<string, string> = { EXAMPLE_LOG: logFile, NODE_NO_WARNINGS: "1" };
const runFlags = ["--app", app];
const hostA: HostSpec = { name: "host-a", mountRoot: opts.mountRoots.a, env, restart: false };
const hostB: HostSpec = { name: "host-b", mountRoot: opts.mountRoots.b, env, restart: true };

const handles: HostHandle[] = [];
let finished = false;
const log = followLog(logFile, (e) => {
  if (e.event === "open") note("agent", `generation ${e.generation} opened on ${e.host} as ${instanceUid(opts, e)}`);
  if (e.event === "dispatch") note("agent", `generation ${e.generation}: dispatching invoice ${e.invoice}`);
  if (e.event === "charged") note("agent", `generation ${e.generation}: invoice ${e.invoice} charged (API call #${e.apiCall})`);
});
let frozenUnit: string | null = null;
let started = false;
let announced = 0;
let watcher: ReturnType<typeof setInterval> | undefined;
try {
  const problems = preflight(opts);
  if (problems.length) fail(`this host cannot run the demo yet:\n  - ${problems.join("\n  - ")}`);
  api = await startPaidApi();
  const paid = api;
  // The third charge is held in flight: the API counts it and does not answer until it is released.
  const hold = paid.hold({ route: "charge", key: "charge-3" });
  env.PAID_API = paid.url;
  watcher = setInterval(() => {
    for (const r of paid.requests("charge").slice(announced)) note("paid API", `charge #${r.seq} received (key ${r.key})${r.holdId ? ", held: no answer yet" : ""}`);
    announced = paid.requests("charge").length;
  }, 100);
  say(`the paid API listens on ${paid.url}; it holds the third charge in flight`);
  say(`host A: start run ${opts.id}`);
  const a = superviseOnce(opts, hostA, ["--create", ...runFlags]);
  started = true;
  const handleA = startedUnit(a.lines);
  handles.push(handleA);
  await waitFor("the paid API to receive the third charge", () => hold.caught.length > 0, 120_000);

  if (opts.scenario === "kill") {
    say("the third charge is in flight. Host A loses power: its instance and its FUSE daemon are killed at once");
    fault("kill", String(handleA.unit));
  } else {
    say("the third charge is in flight. Host A's mount freezes: the FUSE daemon stops answering, the host looks alive");
    fault("freeze", String(handleA.unit));
    frozenUnit = String(handleA.unit);
  }

  say(`host B: a supervisor on another machine ${opts.scenario === "kill" ? "sees the dead client" : `waits for the lease (${DEMO_LEASE.expiryMs / 1000} s) to expire`}, revokes the claim and starts an instance`);
  const loop = superviseLoop(opts, hostB, "2s", runFlags);
  try {
    await waitFor("the run to finish on host B", () => log.events.find((e) => e.event === "done"), 240_000);
    const startedB = loop.lines.find((l) => l.action === "started");
    if (startedB?.handle) handles.push(startedB.handle as HostHandle);
  } finally {
    await loop.stop();
  }
  finished = true;

  if (frozenUnit) {
    say("host B is done. Thaw host A's mount: the old instance wakes up to a revoked claim");
    fault("thaw", frozenUnit);
    const exit = await waitFor("host A's instance to exit", () => {
      const s = exitStatus(frozenUnit!);
      return s.active !== "active" && s.active !== "deactivating" && s.active !== "activating" ? s : null;
    }, 60_000);
    note("host A", `exited with status ${exit.status}${exit.status === 75 ? " (fenced: its next write was refused)" : ""}`);
    if (exit.status !== 75) process.exitCode = 1;
  }

  // ---- compare the world outside with the run's own record --------------------------------------------------------------
  say("what the paid API received, against what the run recorded");
  const outcomes = (log.events.find((e) => e.event === "outcomes")?.outcomes ?? []) as { key: string; outcome: string }[];
  const received = paid.requests("charge");
  const problemsFound: string[] = [];
  console.log("    invoice  key         run's record   what the API saw");
  for (let invoice = 1; invoice <= INVOICES; invoice++) {
    const key = `charge-${invoice}`;
    const outcome = outcomes.find((o) => o.key === key)?.outcome ?? "missing";
    const calls = received.filter((r) => r.key === key);
    const seen = calls.length ? calls.map((r) => `#${r.seq} ${r.state}${r.writer ? ` (${r.writer})` : ""}`).join(", ") : "nothing";
    console.log(`    ${String(invoice).padEnd(8)} ${key.padEnd(11)} ${outcome.padEnd(14)} ${seen}`);
    if (calls.length > 1) problemsFound.push(`${key} was received ${calls.length} times`);
    if (outcome === "charged" && calls.length !== 1) problemsFound.push(`${key} says charged but the API has ${calls.length} calls`);
    if (outcome === "missing") problemsFound.push(`${key} has no recorded outcome`);
  }
  const interrupted = outcomes.filter((o) => o.outcome === "interrupted").length;
  console.log(`\n    API calls: ${received.length} (a clean run sends ${INVOICES}); charges the run recorded as interrupted: ${interrupted}`);
  if (received.length > INVOICES) problemsFound.push(`the API received ${received.length} calls for ${INVOICES} invoices`);
  if (interrupted !== 1) problemsFound.push(`expected the cut charge to be the one interrupted charge, found ${interrupted}`);
  if (problemsFound.length) {
    say(`AT-MOST-ONCE VIOLATED:\n    ${problemsFound.join("\n    ")}`);
    process.exitCode = 1;
  } else {
    say("at most once held: no charge was received twice, and the one cut in flight was reported interrupted, not sent again");
  }
} catch (error) {
  report(error);
} finally {
  log.stop();
  if (watcher) clearInterval(watcher);
  await api?.close();
  if (started) await cleanup(opts, handles, [hostA, hostB], finished);
  if (!opts.keep) rmSync(dir, { recursive: true, force: true });
}
// The process may still hold sockets from the supervisors' children; the demo is done.
process.exit(process.exitCode ?? 0);
