// A pi run's process that dies while a replay-safe call it let through is in flight is opened again by the server, and
// pi-durable's recovery runs that call again as the run resumes: before the server's own open hook. The gate must
// already know, at that moment, that it let the call through: a deny on the rerun then says whether it took effect is
// not known, never "nothing was sent and nothing was charged". This drives the real launch: the server, the run's own
// process, its death, and its relaunch, so the hooks run in the order a reopened run's do.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { NOT_RUN, RAN_UNKNOWN } from "../dist/tool-gate.js";
import { agent, follow, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true };
const HELD = "http://public.example/?hold";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check()` holds, `what` naming it when it never does. */
async function until(check, what, ms = 55_000) {
  for (const end = Date.now() + ms; !(await check()); await sleep(20)) assert.ok(Date.now() < end, what);
}

test("a pi run whose process died during a web_fetch it let through, relaunched with web_fetch denied, tells the model whether the call took effect is not known", { timeout: 120_000 }, async (t) => {
  const hold = join(await scratch(t), "hold");
  withEnv(t, { FAUX_WEB_HOLD: hold });
  const server = await serve(t, GATE);
  const ask = `Fetch ${HELD} once.`;
  assert.equal((await server.api("POST", "/agents", agent("held", { harness: "pi", instructions: ask, tools: ["web_fetch"] }))).status, 201);
  const started = await server.api("POST", "/agents/held/runs", { input: { content: ask } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;

  // The gate let the call through and it is on the wire: the fake network holds it.
  await until(() => existsSync(`${hold}.waiting`), "the call reached the network");
  assert.equal((await server.api("PUT", "/settings/tools", { web_fetch: { permission: "deny" } })).status, 200);
  const { pid } = runRecordOf(server.data, runId).holder;
  process.kill(pid, "SIGKILL");
  await until(() => !processAlive(pid), "the run's process died");
  // Should the rerun be let through, it is not held: the test reads what the model was told, never a hang.
  await writeFile(hold, "");

  const { last } = await follow(server.api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(last.final, true);
  const answer = (await server.api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";
  assert.ok(answer.includes(RAN_UNKNOWN), `the rerun's deny says the outcome is not known: ${answer}`);
  assert.ok(!answer.includes(NOT_RUN), `never that nothing was sent: ${answer}`);
});
