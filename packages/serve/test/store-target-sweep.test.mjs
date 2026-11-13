// store-target.mjs names each test schema t_<file tag>_<pid>_<n> and sweeps, once per process, the schemas an earlier run
// of the same file left. Two runs of one file can go on at once (the store set beside a mutant run, two builders): a sweep
// drops only the schemas of a process that is no longer running, never those of another run in flight.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { client, dropSchema, freshSchema, postgresOnly, schemaTag } from "./store-target.mjs";

test("a sweep drops the schemas of a run of this file that has ended, never those of one still running", postgresOnly("the test schemas' sweep"), async (t) => {
  // A process that has ended: its pid named in a schema left behind.
  const ended = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await once(ended, "exit");
  // A process still running (this test's own runner, which outlives the test): another run of the file in flight.
  const running = process.ppid;
  const left = `t_${schemaTag}_${ended.pid}_1`;
  const inFlight = `t_${schemaTag}_${running}_1`;
  const c = await client();
  t.after(async () => {
    await dropSchema(inFlight);
    await dropSchema(left);
    await c.end();
  });
  for (const schema of [left, inFlight]) await c.query(`CREATE SCHEMA ${schema}`);
  // This process's first schema runs the sweep.
  await dropSchema(await freshSchema());
  const present = (await c.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)", [[left, inFlight]])).rows.map((row) => row.nspname);
  assert.deepEqual(present, [inFlight], "the ended run's schema dropped, the running one's kept");
});
