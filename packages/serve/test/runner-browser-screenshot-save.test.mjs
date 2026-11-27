// A browser screenshot's save_as writes a file into the run's files, so the run's gate holds it to write's setting, as it
// holds computer_screenshot's. A pi run through the runner, its dispatch and the spec builder, with the faux browser and
// a scripted model that calls screenshot with save_as and then stops. An agent given write gets the capture saved in the
// run's folder, the same bytes the browser filed as evidence; one not given write is refused at the gate, before the
// browser is asked: no capture is filed and no file is written. The model's second request carries the screenshot's
// answer: the test waits for that request, never for time.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { runFolder } = await import("../dist/workspace/paths.js");

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const AGENT = "agent-1";
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
/** Test keys, no real ones. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const SAVE_AS = "shots/walk-1.png";
after(closeOpenSessions);

/** The tool results the model was sent in `body`, in order: each one's text and whether it is an error. */
const resultsIn = (body) => (body?.messages ?? [])
  .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  .filter((part) => part.type === "tool_result")
  .map((part) => ({ text: typeof part.content === "string" ? part.content : (part.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join(""), isError: part.is_error === true }));

/** One pi run whose agent is given `tools`, its model calling screenshot with save_as: the screenshot's answer and the
 *  run's folder. */
async function screenshotRun(t, tools) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-browser-save-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries(BROWSERBASE)) await putSealedKey(server, SEAL_KEY, name, value);
  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Browse.", tools } });
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: { input: { content: "Browse." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, plane: { browser: "browserbase" } } });
  await server.flush?.();

  const requests = [];
  let second;
  const answered = new Promise((resolve) => (second = resolve));
  const origin = scriptedOrigin([{ call: "screenshot", args: { save_as: SAVE_AS } }, { say: "done" }], requests);
  const fetch = async (url, init) => {
    const response = await origin(url, init);
    if (requests.length === 2) second(requests[1]);
    return response;
  };
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch };
  const deps = {
    env: { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY,
    routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }),
  };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  const [shot] = resultsIn(await answered);
  return { shot, work: runFolder(dir, AGENT, RUN) };
}

test("an agent given write: the browser screenshot's save_as is saved in the run's folder, the same bytes as the capture filed as evidence", { timeout: 120_000 }, async (t) => {
  const { shot, work } = await screenshotRun(t, ["read", "write", "browser"]);
  assert.ok(shot && !shot.isError, `the screenshot answered: ${JSON.stringify(shot)}`);
  assert.match(shot.text, new RegExp(`saved: ${SAVE_AS}`), shot.text);
  const saved = readFileSync(join(work, SAVE_AS));
  const evidence = readdirSync(join(work, "evidence")).filter((name) => name.endsWith("-screenshot.png"));
  assert.equal(evidence.length, 1, `one capture filed: ${evidence.join(", ")}`);
  assert.deepEqual(saved, readFileSync(join(work, "evidence", evidence[0])), "the saved file is the filed capture, byte for byte");
});

test("an agent not given write is refused the browser screenshot's save_as at the run's gate: the browser is not asked, nothing is filed or written", { timeout: 120_000 }, async (t) => {
  const { shot, work } = await screenshotRun(t, ["read", "browser"]);
  assert.ok(shot?.isError, `refused: ${JSON.stringify(shot)}`);
  assert.match(shot.text, /not given write/, shot.text);
  assert.match(shot.text, /screenshot with save_as/, shot.text);
  assert.equal(existsSync(join(work, SAVE_AS)), false, "no file was written");
  assert.equal(existsSync(join(work, "evidence")), false, "no capture was filed: the browser was never asked");
});
