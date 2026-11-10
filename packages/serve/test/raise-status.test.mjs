// A run whose cap is raised at its pause reads queued from the moment the raise is taken, before PATCH /runs/{id}
// answers: its follow-up turn is still to go, and nothing waits on a person. Never input_required with no pending, which
// `agentrun runs wait` and the client's runs.wait take as a run that needs someone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { agent, client, follow, runDir, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

/** The output-priced faux model ($100 a million output tokens: a request's least is $0.1024) in a process that cannot
 *  exit until EXIT_GATE exists, so the raise lands while the paused run's process is still being let go. */
const SLOW_EXIT = new URL("./fixtures/faux-output-priced-slow-exit.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const ENDED = ["completed", "failed", "cancelled"];
const holderPid = (data, runId) => runRecordOf(data, runId).holder.pid;

// The guard's own read is one more request to the server. A test whose server goes away once the raise is answered (its
// follow-up's process kills it as it comes up: cap-raise's launch-kill test) opts out of it, and gets the raise's answer.
test("a raise answered by a server that then goes away is the raise's answer when the caller opts out of the raise guard", async (t) => {
  const server = createServer((req, res) => {
    // Gone once its answer is written, before any later request: as a server its follow-up's process killed.
    res.on("finish", () => setImmediate(() => (server.close(), server.closeAllConnections())));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ run_id: "r1", resumed: true, status: "queued", state: "working" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const api = client(`http://127.0.0.1:${server.address().port}`, "token");
  const raised = await api("PATCH", "/runs/r1", { max_cost_usd: 1 }, {}, { raiseCheck: false });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
});
