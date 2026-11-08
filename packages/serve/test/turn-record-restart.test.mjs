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
  test(`${harness}: a cancel the server took before it went down ends the run cancelled on the next server, never as the turn it cut reads`, { timeout: 120_000 }, async (t) => {
    const dir = await scratch(t);
    const data = join(dir, "agents");
    const [signal, gate] = [join(dir, "admitted"), join(dir, "gate")];
    const script = `const { startServe } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
const server = await startServe({ data: ${JSON.stringify(data)}, port: 0, faux: ${JSON.stringify(FAUX)}, harnessTable: ${JSON.stringify(fauxTable(SLOW_EXIT_HARNESS))}, drainTimeout: "5s" });
process.stdout.write(JSON.stringify({ base: server.baseUrl, token: server.token }) + "\\n");`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, EXIT_GATE: gate } });
    t.after(() => child.kill("SIGKILL"));
    const out = await printed(child, /\n/);
    const { base, token } = JSON.parse(out.slice(0, out.indexOf("\n")));
    const first = client(base, token);
    assert.equal((await first("POST", "/agents", agent(harness, { harness, instructions: `Answer, then hold a request unanswered (signal ${signal}).` }))).status, 201);
    const started = await first("POST", `/agents/${harness}/runs`, { input: { content: "hi" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    for (const end = Date.now() + 60_000; !existsSync(signal) || !(await first("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "final_answer"); await sleep(50)) assert.ok(Date.now() < end, "the answer is in and the next request held");
    const cancel = await first("POST", `/runs/${runId}/cancel`, {});
    assert.deepEqual([cancel.status, cancel.body.cancel_requested], [202, true], JSON.stringify(cancel.body));
    // The server goes down at once, then the run's process, held on its SIGTERM, before anything carried the run back.
    child.kill("SIGKILL");
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve)));
    const { holder } = runRecordOf(data, runId);
    process.kill(holder.pid, "SIGKILL");
    for (const end = Date.now() + 10_000; !gone(holder.pid); await sleep(50)) assert.ok(Date.now() < end, "the run's process is gone");
    const next = await startServe({ data, port: 0, faux: FAUX, harnessTable: fauxTable(FAUX_HARNESS), drainTimeout: "5s" });
    t.after(() => next.close());
    const api = client(next.baseUrl, next.token);
    const seen = [];
    for (const end = Date.now() + 60_000; ; await sleep(50)) {
      const { body: view } = await api("GET", `/runs/${runId}`);
      if (seen.at(-1) !== view.status) seen.push(view.status);
      if (TERMINAL.includes(view.status)) break;
      assert.ok(Date.now() < end, `the next server ends the run: ${seen.join(" > ")}`);
    }
    await follow(api, runId, TERMINAL, { deadlineMs: 60_000 });
    const { body: view } = await api("GET", `/runs/${runId}`);
    assert.deepEqual([seen.find((s) => TERMINAL.includes(s)), view.status, view.result], ["cancelled", "cancelled", null], seen.join(" > "));
  });
}
