// A runner in a process of its own, for command-wake-processes.test.mjs: it opens the store the test's server made (a
// SQLite data directory, or a Postgres schema on AGENTRUN_TEST_PG_URL) as a runner, holds the test's run with a computer
// whose client answers every call at once, and keeps the run going (its agent's one tool waits) until the parent says
// "stop". It says "ready" once started; its command poll is the runner's default, so only a wake hands a row on sooner.
import { openPostgresStore, openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { createAdapterLoop } from "../dist/runner/adapter-loop.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { STEADY_LEASE } from "./runner-support.mjs";

const place = JSON.parse(process.argv[2]);
const store = place.schema === undefined
  ? await openSqliteStore({ dataDir: place.dataDir, role: "runner" })
  : await openPostgresStore({ url: process.env.AGENTRUN_TEST_PG_URL, schema: place.schema, role: "runner" });
let letGo;
const working = new Promise((resolve) => (letGo = resolve));
const work = { name: "work", replaySafe: true, run: async () => (await working, "done working") };
const spec = piAdapterSpec({ script: [{ call: "work" }, { say: "done" }], tools: { work }, hooks: { beforeIntent: async () => {}, beforeResult: async () => {} } });
const client = { call: async (method, params) => ({ ok: true, value: { method, params } }), close() {} };
const runner = startRunner({
  store,
  createLoop: createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1", computer: { kind: "desktop", client } })),
  name: "runner-child",
  ...STEADY_LEASE,
  pollMs: 20,
});
process.send({ ready: true });
process.on("message", async (message) => {
  if (message !== "stop") return;
  letGo();
  await runner.close().catch(() => {});
  await store.close().catch(() => {});
  await closeOpenSessions();
  process.exit(0);
});
