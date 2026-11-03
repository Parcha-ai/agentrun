// A server in a process of its own whose store read of a run after that run's end is written never comes back: it holds
// the window between the agent store's end (carryBack) and the run.ended notice open, for a test to kill the server in.
// argv: the data directory and the faux model. Prints the server's address; the token is in the data directory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@parcha/pi-durable-agent";
import { startServe } from "../../dist/index.js";

const [data, faux] = process.argv.slice(2);
const probe = openStore(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-")));
const proto = Object.getPrototypeOf(probe);
probe.close();
const { carryBack, readRun } = proto;
const ended = new Set();
proto.carryBack = function (runId, ...rest) {
  const out = carryBack.call(this, runId, ...rest);
  ended.add(runId);
  return out;
};
proto.readRun = function (runId, ...rest) {
  return ended.has(runId) ? new Promise(() => {}) : readRun.call(this, runId, ...rest);
};
const server = await startServe({ data, port: 0, faux, drainTimeout: "5s" });
console.log(`AGENTRUN_BASE_URL=${server.baseUrl}`);
