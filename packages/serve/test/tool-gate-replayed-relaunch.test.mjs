// A pi run's process that dies while a replay-safe call it let through is in flight is opened again by the server, and
// pi-durable's recovery runs that call again once the run resumes, racing the app's open hook (onOpen). The gate must
// already know, at that moment, that it let the call through: a deny on the rerun then says whether it took effect is
// not known, never "nothing was sent and nothing was charged". This drives the real launch: the server, the run's own
// process, its death, and its relaunch, so the hooks run in the order a reopened run's do; a preload makes the rerun win
// the race (load-after-rerun.mjs). A workflow's model node reruns its cut call the same way, and its app has no open
// hook that reads the gate's marks at all.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { NOT_RUN, RAN_UNKNOWN } from "../dist/tool-gate.js";
import { agent, flowAgent, follow, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true };
const LOAD_AFTER_RERUN = fixture("load-after-rerun.mjs");
const HELD = "http://public.example/?hold";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check()` holds, `what` naming it when it never does. */
async function until(check, what, ms = 55_000) {
  for (const end = Date.now() + ms; !(await check()); await sleep(20)) assert.ok(Date.now() < end, what);
}

/** A run of agent `definition` on a server whose fake network holds a fetch of HELD: once the gate has let the call
 *  through and it is on the wire, web_fetch is set to deny and the run's process is killed, so the server relaunches it.
 *  `preload`: the relaunched process's open hook waits for the rerun (load-after-rerun.mjs), the race's worst case every
 *  time; its `loaded` file says the hook ran. */
async function cutThenDenied(t, definition, input, { preload = false } = {}) {
  const hold = join(await scratch(t), "hold");
  withEnv(t, { FAUX_WEB_HOLD: hold });
  const server = await serve(t, GATE);
  assert.equal((await server.api("POST", "/agents", definition)).status, 201);
  const started = await server.api("POST", `/agents/${definition.definition.id}/runs`, { input });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  // The gate let the call through and it is on the wire: the fake network holds it.
  await until(() => existsSync(`${hold}.waiting`), "the call reached the network");
  assert.equal((await server.api("PUT", "/settings/tools", { web_fetch: { permission: "deny" } })).status, 200);
  const loaded = join(await scratch(t), "loaded");
  if (preload) withEnv(t, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${LOAD_AFTER_RERUN}`.trim(), AGENTRUN_TEST_LOAD_AFTER_ENTER: loaded });
  const { pid } = runRecordOf(server.data, runId).holder;
  process.kill(pid, "SIGKILL");
  await until(() => !processAlive(pid), "the run's process died");
  // Should the rerun be let through, it is not held: the test reads what the model was told, never a hang.
  await writeFile(hold, "");
  const { last } = await follow(server.api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal(last.final, true);
  return { view: (await server.api("GET", `/runs/${runId}`)).body, loaded };
}

/** What the model was told of the rerun says its outcome is not known, never that nothing was sent. */
function unknownNotNothing(told) {
  assert.ok(told.includes(RAN_UNKNOWN), `the rerun's deny says the outcome is not known: ${told}`);
  assert.ok(!told.includes(NOT_RUN), `never that nothing was sent: ${told}`);
}

test("a pi run whose process died during a web_fetch it let through, relaunched with web_fetch denied, tells the model whether the call took effect is not known", { timeout: 120_000 }, async (t) => {
  const ask = `Fetch ${HELD} once.`;
  const { view, loaded } = await cutThenDenied(t, agent("held", { harness: "pi", instructions: ask, tools: ["web_fetch"] }), { content: ask }, { preload: true });
  assert.ok(existsSync(loaded), "the relaunched process ran its open hook after the rerun");
  unknownNotNothing(view.result?.final_answer ?? "");
});

test("a workflow whose process died during its model node's web_fetch, relaunched with web_fetch denied, tells the node whether the call took effect is not known", { timeout: 120_000 }, async (t) => {
  const flow = {
    v: 2, name: "fetch-held",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Told: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Told", path: "told" },
    root: { node: "chain", steps: [{ node: "extract", label: "fetch", instructions: `Fetch ${HELD} once.`, out: "Told", as: "told", tools: ["web_fetch"] }] },
  };
  const { view } = await cutThenDenied(t, flowAgent("held-flow", flow, { tools: ["web_fetch"] }), { question: "What does the page say?" });
  unknownNotNothing(view.result?.output?.answer ?? JSON.stringify(view.result));
});
