// The runner process (runner/main.ts): its own connection to the store in the data directory, opened as a runner. It
// sets nothing up: on a data directory the server has not set up it is refused in words a person can act on, before it
// claims anything. Beside a server's store it claims a queued run, runs it to its end, and closes releasing its runs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runnerArgs, startRunnerProcess } from "../dist/runner/main.js";
import { openSqliteStore } from "../dist/store/index.js";
import { fauxLoops, until } from "./runner-support.mjs";

function dataDir(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-runner-data-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a runner on a data directory the server has not set up is refused before it claims anything", async (t) => {
  const faux = fauxLoops();
  await assert.rejects(startRunnerProcess({ dataDir: dataDir(t), createLoop: faux.createLoop }), (error) => {
    assert.equal(error.name, "RunnerRefused");
    assert.match(error.message, /not set up yet: start the server on this data directory first/);
    assert.equal(error.cause?.name, "SchemaVersionUnknown");
    return true;
  });
  assert.equal(faux.loops.length, 0, "no loop was started");
});

test("beside the server's store, a runner process claims a queued run, runs it to its end, and closes", async (t) => {
  const dir = dataDir(t);
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  await server.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const faux = fauxLoops({ turns: 2, turnMs: 10 });
  // The server's seal key handed over: a runner never makes one (seal-key.ts), and this store had no server start to.
  const process = await startRunnerProcess({ dataDir: dir, loops: 4, name: "runner-a", createLoop: faux.createLoop, env: { ...globalThis.process.env, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } });
  let closed = false;
  t.after(async () => {
    if (!closed) await process.close();
    await server.close();
  });

  await until(async () => (await server.runs.get("run-1")).state === "ended", "the run ends");
  await until(async () => (await server.runs.get("run-1")).runner === null, "its release");
  assert.equal(faux.loops[0].claim.runner, "runner-a");
  await process.close();
  closed = true;
  assert.deepEqual(process.runner.held(), [], "closed, it holds nothing");
  assert.equal((await server.runs.get("run-1")).state, "ended");
});

test("a runner's arguments: --data D [--loops N], and nothing else", () => {
  assert.deepEqual(runnerArgs(["--data", "/d"]), { dataDir: "/d" });
  assert.deepEqual(runnerArgs(["--data", "/d", "--loops", "12"]), { dataDir: "/d", loops: 12 });
  assert.throws(() => runnerArgs([]), /needs its data directory/);
  assert.throws(() => runnerArgs(["--data"]), /--data needs a value/);
  assert.throws(() => runnerArgs(["--data", "/d", "--loops", "0"]), /--loops is a whole number/);
  assert.throws(() => runnerArgs(["--data", "/d", "--file", "x.sqlite"]), /unknown argument "--file"/);
});
