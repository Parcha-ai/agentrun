// A server in a process of its own, held inside a window for a test to kill it in. argv: the data directory, the faux
// model and the window. `end` (the default): a store read of a run after its end is written never comes back, between
// the agent store's end (carryBack) and the run.ended notice. `reopen`: the process stops dead once a run's reopening is
// committed, before anything else of the continuation. Prints the server's address; the token is in the data directory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@parcha/pi-durable-agent";
import { startServe } from "../../dist/index.js";

const [data, faux, window = "end"] = process.argv.slice(2);
const probe = openStore(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-")));
const proto = Object.getPrototypeOf(probe);
probe.close();
const { carryBack, readRun, reopenRun } = proto;
if (window === "reopen") {
  proto.reopenRun = function (...args) {
    const out = reopenRun.apply(this, args);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return out;
  };
} else {
  const ended = new Set();
  proto.carryBack = function (runId, ...rest) {
    const out = carryBack.call(this, runId, ...rest);
    ended.add(runId);
    return out;
  };
  proto.readRun = function (runId, ...rest) {
    return ended.has(runId) ? new Promise(() => {}) : readRun.call(this, runId, ...rest);
  };
}
const server = await startServe({ data, port: 0, faux, drainTimeout: "5s" });
console.log(`AGENTRUN_BASE_URL=${server.baseUrl}`);
