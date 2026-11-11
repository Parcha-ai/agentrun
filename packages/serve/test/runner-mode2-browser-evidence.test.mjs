// A Mode 2 run's browser files what it reads where the run's own read finds it: on the run's disk, under the run's key,
// never in the run's local folder on the runner's machine. A pi run through the runner, its dispatch and the spec builder,
// with the server's Archil settings saved (the disk is the Archil fake), the faux browser and a scripted model: the model
// calls browser_read, then read on the path browser_read named. The run's read opens the page's text, and the file is on
// the disk and not on this machine. The model's third request carries read's answer: the test waits for that request, never
// for time.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
const { saveArchilSettings } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { runFolder, runKey } = await import("../dist/workspace/paths.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 5);
const RUN = "run-1";
const AGENT = "agent-1";
const KEY = runKey(AGENT, RUN);
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
/** Test keys, no real ones. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
/** Where the run's first read is filed. */
const FILED = "evidence/0001-browser_read.md";
after(closeOpenSessions);

/** The tool results the model was sent in `body`, in order: each one's text and whether it is an error. */
const resultsIn = (body) => (body?.messages ?? [])
  .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  .filter((part) => part.type === "tool_result")
  .map((part) => ({ text: typeof part.content === "string" ? part.content : (part.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join(""), isError: part.is_error === true }));

test("a Mode 2 run's browser_read files the page on the run's disk, and the run's read opens it there", { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mode2-browser-"));
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
  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Browse.", tools: ["read", "browser"] } });
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: { input: { content: "Browse." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, plane: { browser: "browserbase" } } });
  // Mode 2: the server's Archil settings, and its account key sealed under the runner's seal key, as the server saves them.
  await saveArchilSettings(server, ARCHIL_SETTINGS);
  await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await server.flush?.();

  const disk = new FakeArchilDisk();
  const control = archilControlFetch();
  // The model's requests; the third carries read's answer.
  const requests = [];
  let third;
  const answered = new Promise((resolve) => (third = resolve));
  const script = [{ call: "browser_read" }, { call: "read", args: { path: FILED } }, { say: "done" }];
  const origin = scriptedOrigin(script, requests);
  const fetch = async (url, init) => {
    const response = await origin(url, init);
    if (requests.length === 3) third(requests[2]);
    return response;
  };
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch };
  const deps = {
    env: { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY,
    routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }),
    makeArchilDisk: () => disk, mountControl: { baseUrl: control.baseUrl, fetch: control.fetch },
  };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });

  const [filed, read] = resultsIn(await answered);
  assert.ok(filed && !filed.isError, `browser_read answered: ${JSON.stringify(filed)}`);
  assert.ok(filed.text.includes(FILED), `browser_read names where it filed the page: ${filed.text.slice(0, 400)}`);
  assert.ok(read && !read.isError, `the run's read opens what browser_read filed: ${JSON.stringify(read)}`);
  const onDisk = disk.files.get(`${KEY}/${FILED}`);
  assert.ok(onDisk, `the page is on the run's disk, under the run's key: ${[...disk.files.keys()].join(", ")}`);
  assert.ok(read.text.includes(Buffer.from(onDisk).toString("utf8").split("\n").at(-1).trim().slice(0, 40)), `the read is that file: ${read.text.slice(0, 400)}`);
  assert.equal(existsSync(join(runFolder(dir, AGENT, RUN), FILED)), false, "and nothing of it in the run's local folder on this machine");
});
