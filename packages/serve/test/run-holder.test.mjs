// A launch the row still names (LAUNCH_HOLDER) is found by the mark in its process's environment, on macOS through
// macOS's process table (ps -E, as pi-durable-disk reads it there; played here by procps over /proc), and never killed
// when it cannot be looked for: the take-back refuses, claims nothing and kills nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { processAlive as alive } from "@parcha/agentrun-kernel/host";
import { psTable } from "../../pi-durable-disk/dist/process-table.js";
import { localDisk } from "../dist/disk.js";
import { fenceHolder, holderOfClaim, holderState, killHolder, LAUNCH_HOLDER, launchedProcesses, RUN_LAUNCH_ENV, runHolderTestHooks } from "../dist/run-holder.js";
import { scratch } from "./support.mjs";

/** A process with `env` that starts a child with the same environment (a command of it, inheriting the mark), and says
 *  its child's pid on stdout. */
async function markedTree(t, env) {
  const parent = spawn(process.execPath, ["-e", `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...env } });
  const child = Number(await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
  t.after(() => {
    for (const pid of [child, parent.pid]) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  return { parent: parent.pid, child };
}

test("on macOS's process table (ps -E), a launch the row still names is found by its mark: the run's process, not a command of it that inherited the mark", { skip: process.platform !== "linux" && "procps plays macOS's ps over /proc", timeout: 30_000 }, async (t) => {
  const { linuxPs } = await import("../../pi-durable-disk/test/_macos.ts");
  runHolderTestHooks.table = psTable(linuxPs);
  t.after(() => delete runHolderTestHooks.table);
  const { parent } = await markedTree(t, { [RUN_LAUNCH_ENV]: "run-1:4" });
  assert.deepEqual(launchedProcesses("run-1", 4).map((holder) => holder.pid), [parent]);
  assert.equal(holderOfClaim("run-1", { epoch: 4, holder: LAUNCH_HOLDER })?.pid, parent);
  assert.deepEqual(launchedProcesses("run-1", 5), [], "another launch's mark");
});

test("a launch that cannot be looked for is never killed: the take-back refuses, claims nothing and kills nothing", { timeout: 30_000 }, async (t) => {
  const { parent } = await markedTree(t, { [RUN_LAUNCH_ENV]: "run-2:3" });
  runHolderTestHooks.table = { snapshot: () => ({ info: () => undefined, children: () => [], group: () => [], marked: () => false, withMark: () => { throw new Error("ps cannot be read"); }, commandLine: () => "?" }), bootId: () => undefined, walkMs: 0 };
  t.after(() => delete runHolderTestHooks.table);
  const claimed = [];
  const disk = localDisk(await scratch(t), { runClaim: () => ({ epoch: 3, holder: LAUNCH_HOLDER }), claimRun: (...args) => (claimed.push(args), 4) });
  await assert.rejects(disk.revoke("run-2"), /cannot be looked for .* never killed unidentified/);
  assert.deepEqual(claimed, [], "nothing claimed");
  assert.ok(alive(parent), "nothing killed");
});

test("a holder whose identity cannot be checked (the process listing fails) is never killed: the kill and the fence refuse, and the process lives", { timeout: 30_000 }, async (t) => {
  const { parent } = await markedTree(t, {});
  runHolderTestHooks.table = { snapshot: () => { throw new Error("ps cannot be read"); }, bootId: () => undefined, walkMs: 0 };
  t.after(() => delete runHolderTestHooks.table);
  const holder = { pid: parent, start: 1, boot: null };
  assert.throws(() => killHolder(holder), /cannot be checked/);
  await assert.rejects(fenceHolder(holder), /cannot be checked/);
  assert.ok(alive(parent), "nothing killed");
});

test("unknown never turns into gone by time alone: a listing that keeps failing never leads to a kill, however long", { timeout: 30_000 }, async (t) => {
  const { parent } = await markedTree(t, {});
  runHolderTestHooks.table = { snapshot: () => { throw new Error("ps cannot be read"); }, bootId: () => undefined, walkMs: 0 };
  t.after(() => delete runHolderTestHooks.table);
  const holder = { pid: parent, start: 1, boot: null };
  for (const end = Date.now() + 1_500; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) {
    assert.equal(holderState(holder), "unknown");
    assert.throws(() => killHolder(holder), /cannot be checked/);
  }
  assert.ok(alive(parent), "never killed");
});
