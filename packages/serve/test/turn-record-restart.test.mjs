// A cancel is a run's end from its 202 on (turn-record.test.mjs). A server that took one and went down before it carried
// the run's end back leaves the cancel's mark: the next server ends the run cancelled, never as its cut turn reads. The
// first server runs in a process of its own, so it dies as a crash kills it; the run's process cannot exit on its SIGTERM
// (faux-harness-slow-exit.mjs) until the test kills it, so the first server never sees it go.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, printed, runDir, runRecordOf, scratch } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const SLOW_EXIT_HARNESS = new URL("./fixtures/faux-harness-slow-exit.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const TERMINAL = ["completed", "failed", "cancelled"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

for (const harness of ["claude-agent", "codex"]) {
}
