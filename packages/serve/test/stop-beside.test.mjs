// The CLI's stop of a server and the runner beside it (server.ts stopBeside, stoppingBeside), on fakes: the server's
// close runs even when the runner's close throws; a second stop changes nothing (a later server's record stays); and what
// a stop waits on is bounded by the runner's whole close, its drain and the wait after it for loops that stop late.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { stopBeside, stoppingBeside } = await import("../dist/server.js");
const { markRunning, stoppingOf } = await import("../dist/server-lock.js");

/** A data root of its own, its record saying a server runs (as a start writes it). */
function root(t) {
  const data = mkdtempSync(join(tmpdir(), "stop-beside-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  markRunning(data);
  return data;
}

/** A served server's stop as stopBeside reads it: its count, and a close that says it ran. */
const served = () => {
  const said = { closed: 0 };
  return { said, serve: { stopping: () => ({ runs: 0, boundMs: 0 }), close: async () => { said.closed += 1; } } };
};

test("a runner whose close throws still lets the server close: its store, listener and deliveries go", async (t) => {
  const data = root(t);
  const { said, serve } = served();
  const runner = { held: () => [], close: async () => { throw new Error("the runner's store would not close"); } };
  await assert.rejects(stopBeside(serve, runner, { data, drainMs: 0 }), /would not close/);
  assert.equal(said.closed, 1, "the server's close ran");
});

test("a second stop of a stopped server changes nothing: the next server's record stays running", async (t) => {
  const data = root(t);
  const { serve } = served();
  await stopBeside(serve, undefined, { data, drainMs: 0 });
  // The next server takes the root and says it runs; then the first's stop is called again.
  markRunning(data);
  await stopBeside(serve, undefined, { data, drainMs: 0 });
  assert.equal(stoppingOf(data), undefined, "no stopping mark over the next server's record");
  assert.deepEqual(JSON.parse(readFileSync(join(data, "server.state"), "utf8")).until, null, "the record says running");
});

test("what a stop waits on covers the runner's whole close: its drain, a second, and the wait for a loop that stops late", () => {
  const { serve } = served();
  const { runs, boundMs } = stoppingBeside(serve, { held: () => [{ runId: "run-1" }], close: async () => {} }, 3_000);
  assert.equal(runs, 1);
  assert.ok(boundMs >= 3_000 + 1_000 + 25_000, `the bound covers the drain, a second and the runner's late wait: ${boundMs} ms`);
});
